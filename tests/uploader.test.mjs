// Testa o envio ao Drive contra um Drive simulado (fetch falso):
// pastas, nomes, índice, _ULTIMA_SESSAO.txt, novas tentativas e retomada sem duplicar.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as drive from '../js/drive.js';
import { createSession, uploadSession } from '../js/uploader.js';
import { parseLatestHistory } from '../js/naming.js';
import { zipStore, crc32 } from '../js/zip.js';

function fakeDrive() {
  const files = new Map([['DEST', { id: 'DEST', name: 'Minha pasta', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }]]);
  let next = 1;
  const failures = []; // { match: (method, url) => bool, status, times }
  const calls = [];
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    const u = new URL(url);
    calls.push(`${method} ${u.pathname}`);
    for (const f of failures) {
      if (f.times > 0 && f.match(method, u)) {
        f.times--;
        if (f.status === 'network') throw new TypeError('Failed to fetch');
        return json({ error: { message: 'falha simulada', errors: [{ reason: 'backendError' }] } }, f.status);
      }
    }
    const idm = /\/files\/([^/]+)$/.exec(u.pathname);
    if (method === 'GET' && u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q');
      const parent = /'([^']+)' in parents/.exec(q)[1];
      const [, key, value] = /key='([^']+)' and value='([^']+)'/.exec(q);
      const found = [...files.values()].filter(
        (f) => !f.trashed && f.parents?.includes(parent) && f.appProperties?.[key] === value,
      );
      return json({ files: found.map((f) => ({ id: f.id, name: f.name, webViewLink: `https://drive/${f.id}` })) });
    }
    if (method === 'GET' && idm) {
      const f = files.get(decodeURIComponent(idm[1]));
      if (!f) return json({ error: { message: 'File not found' } }, 404);
      if (u.searchParams.get('alt') === 'media') return new Response(f.content || '');
      return json({ ...f, capabilities: { canAddChildren: true }, webViewLink: `https://drive/${f.id}` });
    }
    if (method === 'POST' && u.pathname === '/drive/v3/files') {
      const meta = JSON.parse(init.body);
      const id = 'F' + next++;
      files.set(id, { id, ...meta });
      return json({ id, name: meta.name, webViewLink: `https://drive/${id}` });
    }
    if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const text = await init.body.text();
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(text)[1]);
      const content = text.split('\r\n\r\n').slice(2).join('\r\n\r\n').replace(/\r\n--[^\r\n]+--$/, '');
      const id = 'F' + next++;
      files.set(id, { id, ...meta, content });
      return json({ id, name: meta.name, webViewLink: `https://drive/${id}` });
    }
    if (method === 'PATCH' && idm) {
      const f = files.get(decodeURIComponent(idm[1]));
      f.content = await init.body.text();
      return json({ id: f.id, name: f.name });
    }
    return json({ error: { message: 'rota não simulada ' + method + ' ' + u.pathname } }, 400);
  }
  return { files, failures, calls, fetchImpl };
}

function makeSession(n = 3) {
  const captures = Array.from({ length: n }, (_, i) => ({
    t: 10 * (i + 1),
    image: new Blob([`imagem-${i + 1}`], { type: 'image/jpeg' }),
    fileName: `2026-11-08_14h32_cap${String(i + 1).padStart(3, '0')}_00m${10 * (i + 1)}s.jpg`,
  }));
  return createSession({
    captures,
    videoName: 'aula.mp4',
    duration: 95,
    dest: { id: 'DEST', name: 'Minha pasta' },
    ocr: true,
    stamp: '2026-11-08_14h32',
    folderName: '2026-11-08_14h32_aula',
  });
}

test('envio completo: pasta da sessão, imagens, índice com OCR e _ULTIMA_SESSAO.txt', async () => {
  const fake = fakeDrive();
  globalThis.fetch = fake.fetchImpl;
  drive._setTokenForTests('tok');
  const s = makeSession(3);
  await uploadSession(s, { ocr: async (blob) => `texto de ${await blob.text()}` });
  const all = [...fake.files.values()];
  const folder = all.find((f) => f.name === '2026-11-08_14h32_aula');
  assert.ok(folder, 'pasta da sessão criada');
  assert.deepEqual(folder.parents, ['DEST']);
  const imgs = all.filter((f) => f.parents?.[0] === folder.id && f.name.endsWith('.jpg')).map((f) => f.name).sort();
  assert.equal(imgs.length, 3);
  assert.equal(imgs[0], '2026-11-08_14h32_cap001_00m10s.jpg');
  const idx = all.find((f) => f.name === '2026-11-08_14h32_000_indice.txt');
  assert.match(idx.content, /texto de imagem-2/);
  assert.match(idx.content, /OCR/);
  const latest = all.find((f) => f.name === '_ULTIMA_SESSAO.txt');
  assert.deepEqual(latest.parents, ['DEST']);
  assert.equal(parseLatestHistory(latest.content)[0].folderName, '2026-11-08_14h32_aula');
  assert.equal(s.status, 'concluida');
});

test('erro 503 temporário é repetido automaticamente', async () => {
  const fake = fakeDrive();
  globalThis.fetch = fake.fetchImpl;
  drive._setTokenForTests('tok');
  fake.failures.push({ match: (m, u) => m === 'POST' && u.pathname.startsWith('/upload'), status: 503, times: 1 });
  const s = makeSession(2);
  await uploadSession(s, {});
  assert.equal([...fake.files.values()].filter((f) => f.name.endsWith('.jpg')).length, 2);
});

test('queda no meio do envio: retomar não duplica nada', async () => {
  const fake = fakeDrive();
  globalThis.fetch = fake.fetchImpl;
  drive._setTokenForTests('tok');
  const s = makeSession(4);
  // 1ª tentativa: a 3ª imagem "sobe" no Drive, mas a resposta se perde (erro 400 não repetível)
  let uploads = 0;
  const orig = fake.fetchImpl;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') === 'POST' && u.pathname === '/upload/drive/v3/files' && ++uploads === 3) {
      await orig(url, init); // o arquivo foi criado...
      return new Response(JSON.stringify({ error: { message: 'resposta perdida' } }), { status: 400 }); // ...mas o app não soube
    }
    return orig(url, init);
  };
  await assert.rejects(uploadSession(s, {}));
  assert.equal(s.items.filter((i) => i.driveId).length, 2);
  // 2ª tentativa
  globalThis.fetch = orig;
  await uploadSession(s, {});
  const jpgs = [...fake.files.values()].filter((f) => f.name.endsWith('.jpg'));
  assert.equal(jpgs.length, 4, 'sem duplicatas');
  assert.equal(new Set(jpgs.map((f) => f.name)).size, 4);
  assert.equal([...fake.files.values()].filter((f) => f.name === '2026-11-08_14h32_aula').length, 1, 'uma pasta só');
  assert.ok(s.items.every((i) => i.driveId));
});

test('segunda sessão atualiza o histórico de _ULTIMA_SESSAO.txt', async () => {
  const fake = fakeDrive();
  globalThis.fetch = fake.fetchImpl;
  drive._setTokenForTests('tok');
  await uploadSession(makeSession(1), {});
  const s2 = makeSession(1);
  s2.folderName = '2026-11-08_15h00_outra';
  await uploadSession(s2, {});
  const latest = [...fake.files.values()].filter((f) => f.name === '_ULTIMA_SESSAO.txt');
  assert.equal(latest.length, 1);
  assert.deepEqual(
    parseLatestHistory(latest[0].content).map((h) => h.folderName),
    ['2026-11-08_15h00_outra', '2026-11-08_14h32_aula'],
  );
});

test('zip: estrutura válida com nomes UTF-8 e CRC correto', () => {
  const enc = new TextEncoder();
  const files = [
    { name: 'índice.txt', data: enc.encode('olá') },
    { name: 'cap001.jpg', data: new Uint8Array([1, 2, 3, 4]) },
  ];
  const z = zipStore(files, new Date(2026, 10, 8, 14, 32));
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  const eocd = z.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2);
  assert.equal(dv.getUint32(14, true), crc32(enc.encode('olá')));
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926); // vetor de teste padrão do CRC-32
});
