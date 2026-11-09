import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionFolderName,
  captureFileName,
  indexFileName,
  sessionStamp,
  parseFolderId,
  buildIndexText,
  buildLatestText,
  parseLatestHistory,
  slugify,
} from '../js/naming.js';

const d = new Date(2026, 10, 8, 14, 32);

test('nomes ordenáveis e previsíveis', () => {
  assert.equal(sessionStamp(d), '2026-11-08_14h32');
  assert.equal(sessionFolderName(d, 'Gravação Aula 3.MOV'), '2026-11-08_14h32_gravacao-aula-3');
  assert.equal(captureFileName('2026-11-08_14h32', 7, 125.4), '2026-11-08_14h32_cap007_02m05s.jpg');
  assert.ok(indexFileName('X') < captureFileName('X', 1, 0), 'índice vem antes das capturas');
  assert.equal(slugify(''), 'video');
});

test('extrai ID da pasta de vários formatos', () => {
  const id = '1yOXcTn-HILgU85vlSxFJLakhjAcB-3EY';
  assert.equal(parseFolderId(`https://drive.google.com/drive/folders/${id}?usp=sharing`), id);
  assert.equal(parseFolderId(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(parseFolderId(id), id);
  assert.equal(parseFolderId('nada'), null);
});

test('índice com e sem OCR', () => {
  const items = [{ index: 1, t: 12, fileName: 'a.jpg', text: 'Questão 1' }];
  const withOcr = buildIndexText({ folderName: 'F', videoName: 'v.mp4', duration: 75, processedAt: d, items, ocr: true });
  assert.match(withOcr, /OCR/);
  assert.match(withOcr, /Questão 1/);
  assert.match(withOcr, /01:15/);
  const noOcr = buildIndexText({ folderName: 'F', videoName: 'v.mp4', duration: 75, processedAt: d, items, ocr: false });
  assert.doesNotMatch(noOcr, /Questão 1/);
});

test('histórico da última sessão sobrevive a atualizações', () => {
  const e1 = { folderName: 'A', videoName: 'a', count: 3, sentAt: '1', indexName: 'i' };
  const e2 = { folderName: 'B', videoName: 'b', count: 5, sentAt: '2', indexName: 'j' };
  const t1 = buildLatestText({ entry: e1, previous: [] });
  const t2 = buildLatestText({ entry: e2, previous: parseLatestHistory(t1) });
  const h = parseLatestHistory(t2);
  assert.deepEqual(
    h.map((x) => x.folderName),
    ['B', 'A'],
  );
  assert.match(t2.split('\n')[1], /Pasta: B/);
});
