// naming.js — nomes de pastas/arquivos e textos de índice (funções puras).
// Os nomes são previsíveis e ordenáveis: data_hora_capNNN_tempo.jpg

const pad = (n, k = 2) => String(n).padStart(k, '0');

export function sessionStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}h${pad(date.getMinutes())}`;
}

export function slugify(name, max = 40) {
  const base = String(name || 'video')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (base || 'video').slice(0, max).replace(/-+$/, '');
}

export function sessionFolderName(date, videoName) {
  return `${sessionStamp(date)}_${slugify(videoName)}`;
}

export function timeTag(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${pad(m)}m${pad(s)}s`;
}

export function clock(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function captureFileName(stamp, index, t, ext = 'jpg') {
  return `${stamp}_cap${pad(index, 3)}_${timeTag(t)}.${ext}`;
}

export function indexFileName(stamp) {
  return `${stamp}_000_indice.txt`;
}

export const LATEST_FILE_NAME = '_ULTIMA_SESSAO.txt';

function fmtDate(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Texto do índice da sessão (lido pelo ChatGPT via conector do Drive).
 * items: [{ index, t, fileName, text? }]
 */
export function buildIndexText({ folderName, videoName, duration, processedAt, items, ocr }) {
  const lines = [];
  lines.push(`ÍNDICE DA SESSÃO: ${folderName}`);
  lines.push(`Vídeo de origem: ${videoName} (duração ${clock(duration)})`);
  lines.push(`Processado em: ${fmtDate(processedAt)} — processamento local no navegador; o vídeo não foi enviado.`);
  lines.push(`Capturas: ${items.length}, em ordem cronológica.`);
  lines.push('');
  if (ocr) {
    lines.push('ATENÇÃO: as transcrições abaixo foram geradas automaticamente por OCR e podem conter erros.');
    lines.push('As imagens (.jpg) desta pasta são a fonte fiel do conteúdo; em caso de dúvida, consulte a imagem.');
  } else {
    lines.push('As imagens (.jpg) desta pasta contêm o conteúdo; este arquivo só lista a ordem e os instantes.');
  }
  lines.push('');
  for (const it of items) {
    lines.push('='.repeat(60));
    lines.push(`[${pad(it.index, 3)}] instante ${clock(it.t)} — arquivo: ${it.fileName}`);
    if (ocr) {
      lines.push('-'.repeat(60));
      lines.push(it.text && it.text.trim() ? it.text.trim() : '(nenhum texto reconhecido)');
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Texto do arquivo fixo na pasta raiz que aponta a sessão mais recente. */
export function buildLatestText({ entry, previous }) {
  const hist = [entry, ...(previous || []).filter((p) => p.folderName !== entry.folderName)].slice(0, 50);
  const lines = [];
  lines.push('ÚLTIMA SESSÃO ENVIADA');
  lines.push(`Pasta: ${entry.folderName}`);
  if (entry.link) lines.push(`Link: ${entry.link}`);
  lines.push(`Vídeo: ${entry.videoName}`);
  lines.push(`Capturas: ${entry.count}`);
  lines.push(`Enviada em: ${entry.sentAt}`);
  lines.push(`Índice/transcrição: ${entry.indexName}`);
  lines.push('');
  lines.push('Como usar: abra a pasta acima; o arquivo de índice lista as capturas em ordem e traz o texto');
  lines.push('reconhecido de cada uma. As imagens .jpg são a fonte fiel.');
  lines.push('');
  lines.push('HISTÓRICO (mais recente primeiro)');
  for (const h of hist) lines.push(`- ${h.sentAt} | ${h.folderName} | ${h.count} capturas${h.link ? ' | ' + h.link : ''}`);
  lines.push('');
  lines.push('<!-- dados: ' + JSON.stringify(hist) + ' -->');
  return lines.join('\n');
}

/** Recupera o histórico gravado no arquivo de última sessão. */
export function parseLatestHistory(text) {
  const m = /<!-- dados: (.*) -->/.exec(text || '');
  if (!m) return [];
  try {
    const v = JSON.parse(m[1]);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function formatSentAt(d) {
  return fmtDate(d);
}

/** Extrai o ID de uma pasta a partir de um link do Drive ou do próprio ID. */
export function parseFolderId(input) {
  const s = String(input || '').trim();
  let m = /\/folders\/([a-zA-Z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  m = /[?&]id=([a-zA-Z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}
