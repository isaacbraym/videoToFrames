// drive.js — Google Drive via OAuth 2.0 (Google Identity Services, modelo de token).
//
// Escopo: drive.file — o app só enxerga arquivos/pastas que ele mesmo criou ou
// que você escolheu no seletor do Google (Picker). Não há acesso ao resto do Drive.
// O token fica só na memória da página e expira em ~1 hora.

import { CONFIG } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

let tokenClient = null;
let token = null;
let tokenExp = 0;
let pendingAuth = null;
const scripts = new Map();

export class AuthError extends Error {}

export function isConfigured() {
  return Boolean(CONFIG.GOOGLE_CLIENT_ID);
}

export function pickerAvailable() {
  return Boolean(CONFIG.GOOGLE_API_KEY && CONFIG.GOOGLE_APP_ID);
}

function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(
      src,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => {
          scripts.delete(src);
          reject(new Error(`Não foi possível carregar ${new URL(src).host}. Verifique a conexão.`));
        };
        document.head.appendChild(s);
      }),
    );
  }
  return scripts.get(src);
}

/** Carrega as bibliotecas do Google antecipadamente (o login precisa abrir no clique). */
export async function preload() {
  if (!isConfigured()) return;
  await loadScript('https://accounts.google.com/gsi/client');
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      const p = pendingAuth;
      pendingAuth = null;
      if (!p) return;
      if (resp.error) p.reject(new AuthError(`Autorização negada (${resp.error}).`));
      else {
        token = resp.access_token;
        tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 120) * 1000;
        p.resolve(token);
      }
    },
    error_callback: (err) => {
      const p = pendingAuth;
      pendingAuth = null;
      if (!p) return;
      const msg =
        err && err.type === 'popup_closed'
          ? 'A janela de login foi fechada.'
          : err && err.type === 'popup_failed_to_open'
            ? 'O navegador bloqueou a janela de login. Permita pop-ups para este site.'
            : 'Falha no login do Google.';
      p.reject(new AuthError(msg));
    },
  });
  if (pickerAvailable()) {
    loadScript('https://apis.google.com/js/api.js')
      .then(() => new Promise((r) => gapi.load('picker', r)))
      .catch(() => {});
  }
}

export function hasValidToken() {
  return Boolean(token) && Date.now() < tokenExp;
}

/**
 * Pede o token. DEVE ser chamada diretamente no clique do usuário (antes de
 * qualquer `await`), senão o navegador bloqueia a janela do Google.
 */
export function signIn() {
  if (!tokenClient) return Promise.reject(new Error('Login do Google ainda carregando. Tente de novo em instantes.'));
  if (pendingAuth) return pendingAuth.promise;
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pendingAuth = { promise, resolve, reject };
  tokenClient.requestAccessToken({ prompt: '' });
  return promise;
}

/** Só para testes automatizados (Drive simulado). */
export function _setTokenForTests(t, seconds = 3600) {
  token = t;
  tokenExp = Date.now() + seconds * 1000;
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null;
  tokenExp = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chamada à API com novas tentativas para limites de taxa, erros 5xx e rede. */
async function request(url, init = {}, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (!hasValidToken()) throw new AuthError('Sessão do Google expirada. Entre novamente.');
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (attempt >= retries) throw new Error('Sem conexão com o Google Drive.');
      await sleep(1000 * 2 ** attempt + Math.random() * 400);
      continue;
    }
    if (res.ok) return res;
    let detail = '';
    let reason = '';
    try {
      const j = await res.json();
      detail = j.error?.message || '';
      reason = j.error?.errors?.[0]?.reason || '';
    } catch {
      /* corpo vazio */
    }
    if (res.status === 401) {
      token = null;
      throw new AuthError('Sessão do Google expirada. Entre novamente.');
    }
    const retryable =
      res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit|userRateLimit/i.test(reason));
    if (retryable && attempt < retries) {
      await sleep(1000 * 2 ** attempt + Math.random() * 400);
      continue;
    }
    const err = new Error(`Google Drive: ${detail || res.statusText} (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
}

function qs(params) {
  return new URLSearchParams(params).toString();
}

export async function getUser() {
  const r = await request(`${API}/about?${qs({ fields: 'user(displayName,emailAddress)' })}`);
  return (await r.json()).user;
}

export async function getFolder(id) {
  const r = await request(
    `${API}/files/${encodeURIComponent(id)}?${qs({
      fields: 'id,name,mimeType,trashed,webViewLink,capabilities(canAddChildren)',
      supportsAllDrives: 'true',
    })}`,
  );
  return r.json();
}

/** Verifica se a pasta pode receber arquivos deste app. Mensagens claras para cada caso. */
export async function checkFolder(id) {
  try {
    const f = await getFolder(id);
    if (f.mimeType !== FOLDER_MIME) throw new Error('O link informado não é de uma pasta.');
    if (f.trashed) throw new Error('Essa pasta está na lixeira.');
    if (f.capabilities && f.capabilities.canAddChildren === false) throw new Error('Sua conta não pode adicionar arquivos nessa pasta.');
    return f;
  } catch (e) {
    if (e.status === 404) {
      const err = new Error(
        'O app ainda não tem acesso a essa pasta. Use "Escolher no Drive" uma vez para autorizá-la ' +
          '(a autorização vale depois em qualquer aparelho) ou use a pasta automática.',
      );
      err.status = 404;
      throw err;
    }
    throw e;
  }
}

export async function findByAppProperty(parentId, key, value) {
  const q = `'${parentId}' in parents and trashed = false and appProperties has { key='${key}' and value='${value}' }`;
  const r = await request(
    `${API}/files?${qs({ q, fields: 'files(id,name,webViewLink)', pageSize: '10', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`,
  );
  return (await r.json()).files || [];
}

export async function createFolder(name, parentId, appProperties) {
  const r = await request(`${API}/files?${qs({ fields: 'id,name,webViewLink', supportsAllDrives: 'true' })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties }),
  });
  return r.json();
}

/** Pasta raiz automática do app (criada uma única vez, reaproveitada depois). */
export async function ensureDefaultFolder() {
  const found = await findByAppProperty('root', 'cfRoot', '1');
  if (found.length) return found[0];
  return createFolder(CONFIG.DEFAULT_FOLDER_NAME, 'root', { cfRoot: '1' });
}

export async function uploadFile({ blob, name, mimeType, parentId, appProperties, description }) {
  const boundary = 'cf' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const meta = JSON.stringify({ name, mimeType, parents: [parentId], appProperties, description });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const r = await request(
    `${UPLOAD}/files?${qs({ uploadType: 'multipart', fields: 'id,name,webViewLink', supportsAllDrives: 'true' })}`,
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
  );
  return r.json();
}

export async function updateFileContent(fileId, blob, mimeType) {
  const r = await request(
    `${UPLOAD}/files/${encodeURIComponent(fileId)}?${qs({ uploadType: 'media', fields: 'id,name,webViewLink', supportsAllDrives: 'true' })}`,
    { method: 'PATCH', headers: { 'Content-Type': mimeType }, body: blob },
  );
  return r.json();
}

export async function downloadText(fileId) {
  const r = await request(`${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  return r.text();
}

/** Abre o seletor do Google Drive para escolher a pasta de destino. */
export async function pickFolder() {
  if (!pickerAvailable()) throw new Error('Seletor do Drive não configurado (falta a chave de API).');
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise((r) => gapi.load('picker', r));
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes(FOLDER_MIME);
    const picker = new google.picker.PickerBuilder()
      .setAppId(CONFIG.GOOGLE_APP_ID)
      .setOAuthToken(token)
      .setDeveloperKey(CONFIG.GOOGLE_API_KEY)
      .addView(view)
      .setTitle('Escolha a pasta onde as capturas serão salvas')
      .setCallback((data) => {
        const action = data[google.picker.Response.ACTION];
        if (action === google.picker.Action.PICKED) {
          const doc = data[google.picker.Response.DOCUMENTS][0];
          resolve({ id: doc[google.picker.Document.ID], name: doc[google.picker.Document.NAME] });
        } else if (action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
