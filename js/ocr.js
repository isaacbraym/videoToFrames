// ocr.js — transcrição de texto das capturas no próprio navegador (Tesseract.js).
// Carregado sob demanda (~2 MB de código + 1,4 MB do idioma português).
// O texto serve para o ChatGPT achar e ler as capturas pelo conector do Drive;
// a imagem continua sendo a fonte fiel.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não foi possível carregar o OCR (verifique a conexão).'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker('por');
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

/** Reconhece o texto de uma imagem (Blob). Retorna string (pode ser vazia). */
export async function recognize(blob) {
  const worker = await getWorker();
  const { data } = await worker.recognize(blob);
  return (data.text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function terminate() {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch {
    /* ignore */
  }
  workerPromise = null;
}
