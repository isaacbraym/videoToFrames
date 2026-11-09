// uploader.js — envia uma sessão ao Drive de forma retomável e sem duplicar.
//
// Cada arquivo leva appProperties { cfSession, cfKey }. Se uma tentativa cair
// no meio (rede, aba fechada), a próxima consulta o Drive e pula o que já subiu.
// O estado é salvo no aparelho (IndexedDB) a cada passo.

import * as drive from './drive.js';
import { buildIndexText, buildLatestText, parseLatestHistory, formatSentAt, clock, LATEST_FILE_NAME } from './naming.js';
import { saveSession } from './store.js';

/** Cria o objeto de sessão a partir das capturas mantidas. */
export function createSession({ captures, videoName, duration, dest, ocr, stamp, folderName }) {
  return {
    id: `cf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    status: 'pendente',
    videoName,
    duration,
    stamp,
    folderName,
    ocr,
    dest,
    sessionFolder: null,
    attempts: 0,
    indexId: null,
    latestDone: false,
    items: captures.map((c, i) => ({
      key: `cap${String(i + 1).padStart(3, '0')}`,
      index: i + 1,
      t: c.t,
      fileName: c.fileName,
      blob: c.image,
      driveId: null,
      text: null,
    })),
  };
}

async function findOne(parentId, key, value) {
  const found = await drive.findByAppProperty(parentId, key, value);
  return found[0] || null;
}

/**
 * Envia (ou retoma) a sessão.
 * onProgress({ fase, feito, total, texto })   ocr(blob) → Promise<string> (opcional)
 */
export async function uploadSession(session, { onProgress = () => {}, ocr = null } = {}) {
  const retry = session.attempts > 0;
  session.attempts++;
  await saveSession(session);
  const items = session.items;
  const total = items.length;

  // 1) pasta da sessão (reaproveita se já existir)
  onProgress({ fase: 'pasta', feito: 0, total, texto: 'Preparando a pasta da sessão…' });
  if (session.sessionFolder) {
    try {
      const f = await drive.getFolder(session.sessionFolder.id);
      if (f.trashed) session.sessionFolder = null;
    } catch (e) {
      if (e.status === 404) session.sessionFolder = null;
      else throw e;
    }
  }
  if (!session.sessionFolder) {
    const existing = await findOne(session.dest.id, 'cfSession', session.id);
    session.sessionFolder =
      existing || (await drive.createFolder(session.folderName, session.dest.id, { cfSession: session.id }));
    await saveSession(session);
  }
  const folderId = session.sessionFolder.id;

  // 2) transcrição (OCR) — opcional, feita antes para ir no índice
  if (session.ocr && ocr) {
    for (const it of items) {
      if (it.text !== null) continue;
      onProgress({ fase: 'ocr', feito: it.index - 1, total, texto: `Lendo o texto da captura ${it.index} de ${total} (OCR)…` });
      try {
        it.text = await ocr(it.blob);
      } catch (e) {
        session.ocrError = e.message;
        session.ocr = false; // segue sem OCR em vez de travar o envio
        break;
      }
      await saveSession(session);
    }
  }

  // 3) imagens
  for (const it of items) {
    if (it.driveId) continue;
    onProgress({ fase: 'imagens', feito: it.index - 1, total, texto: `Enviando captura ${it.index} de ${total}…` });
    const key = `${session.id}:${it.key}`;
    if (retry) {
      const already = await findOne(folderId, 'cfKey', key);
      if (already) {
        it.driveId = already.id;
        await saveSession(session);
        continue;
      }
    }
    const res = await drive.uploadFile({
      blob: it.blob,
      name: it.fileName,
      mimeType: it.blob.type || 'image/jpeg',
      parentId: folderId,
      appProperties: { cfSession: session.id, cfKey: key },
      description: `Captura ${it.index} de ${total} • instante ${clock(it.t)} • vídeo ${session.videoName} • sessão ${session.folderName}`,
    });
    it.driveId = res.id;
    await saveSession(session);
  }
  onProgress({ fase: 'indice', feito: total, total, texto: 'Gravando o índice da sessão…' });

  // 4) índice / transcrição
  const indexText = buildIndexText({
    folderName: session.folderName,
    videoName: session.videoName,
    duration: session.duration,
    processedAt: new Date(session.createdAt),
    items,
    ocr: Boolean(session.ocr),
  });
  const indexBlob = new Blob([indexText], { type: 'text/plain;charset=utf-8' });
  const indexKey = `${session.id}:indice`;
  if (!session.indexId && retry) {
    const f = await findOne(folderId, 'cfKey', indexKey);
    if (f) session.indexId = f.id;
  }
  if (session.indexId) await drive.updateFileContent(session.indexId, indexBlob, 'text/plain');
  else {
    const f = await drive.uploadFile({
      blob: indexBlob,
      name: `${session.stamp}_000_indice.txt`,
      mimeType: 'text/plain',
      parentId: folderId,
      appProperties: { cfSession: session.id, cfKey: indexKey },
      description: `Índice${session.ocr ? ' e transcrição' : ''} da sessão ${session.folderName}`,
    });
    session.indexId = f.id;
  }
  await saveSession(session);

  // 5) arquivo fixo "_ULTIMA_SESSAO.txt" na pasta de destino
  if (!session.latestDone) {
    onProgress({ fase: 'ultima', feito: total, total, texto: 'Atualizando _ULTIMA_SESSAO.txt…' });
    const entry = {
      folderName: session.folderName,
      link: session.sessionFolder.webViewLink || '',
      videoName: session.videoName,
      count: total,
      sentAt: formatSentAt(new Date()),
      indexName: `${session.stamp}_000_indice.txt`,
    };
    const latest = await findOne(session.dest.id, 'cfLatest', '1');
    let previous = [];
    if (latest) {
      try {
        previous = parseLatestHistory(await drive.downloadText(latest.id));
      } catch {
        previous = [];
      }
    }
    const blob = new Blob([buildLatestText({ entry, previous })], { type: 'text/plain;charset=utf-8' });
    if (latest) await drive.updateFileContent(latest.id, blob, 'text/plain');
    else {
      await drive.uploadFile({
        blob,
        name: LATEST_FILE_NAME,
        mimeType: 'text/plain',
        parentId: session.dest.id,
        appProperties: { cfLatest: '1' },
        description: 'Aponta a sessão de capturas mais recente.',
      });
    }
    session.latestDone = true;
  }

  session.status = 'concluida';
  await saveSession(session);
  onProgress({ fase: 'fim', feito: total, total, texto: 'Concluído.' });
  return session;
}
