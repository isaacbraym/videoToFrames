// app.js — interface: Vídeo → Processar → Revisar → Enviar → Pronto.

import { openVideo, encodeImage, decodeImage } from './video-source.js';
import { runPipeline, extractCapture, DEFAULT_OPTIONS } from './pipeline.js';
import { renderCapture, detectScreenQuad, orderQuad } from './imageops.js';
import * as drive from './drive.js';
import { listPending, deleteSession, saveSession } from './store.js';
import { zipStore } from './zip.js';
import { sessionStamp, sessionFolderName, captureFileName, indexFileName, buildIndexText, parseFolderId, clock } from './naming.js';
import { createSession, uploadSession } from './uploader.js';
import { recognize, terminate as stopOcr } from './ocr.js';

const $ = (s) => document.querySelector(s);
const ls = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* sem armazenamento: segue */
    }
  },
};

const state = {
  input: null, // File ou URL (modo demonstração)
  inputName: '',
  source: null,
  abort: null,
  result: null,
  captures: [],
  processedAt: null,
  session: null,
  dest: ls.get('cf.dest', null),
  user: null,
  wakeLock: null,
};

// ---------------------------------------------------------------- utilidades

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), isError ? 6000 : 3000);
}

function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(0) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' KB';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const STEPS = ['video', 'process', 'review', 'upload', 'done'];
function show(view) {
  for (const v of STEPS) $(`#view-${v}`).hidden = v !== view;
  const idx = STEPS.indexOf(view);
  document.querySelectorAll('#steps li').forEach((li, i) => {
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', i < idx);
  });
  window.scrollTo({ top: 0 });
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch {
    /* opcional */
  }
}

function options() {
  return {
    ...DEFAULT_OPTIONS,
    sensitivity: $('#opt-sens').value,
    enhance: $('#opt-enh').value,
    maxLong: Number($('#opt-res').value),
    perspective: $('#opt-persp').checked,
    dedupe: $('#opt-dedupe').checked,
  };
}

const SETTINGS = ['opt-sens', 'opt-enh', 'opt-res', 'opt-persp', 'opt-dedupe', 'opt-ocr'];
function loadSettings() {
  const saved = ls.get('cf.settings', {});
  for (const id of SETTINGS) {
    const el = $('#' + id);
    if (!(id in saved)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(saved[id]);
    else el.value = saved[id];
  }
  for (const id of SETTINGS) {
    $('#' + id).addEventListener('change', () => {
      const s = {};
      for (const k of SETTINGS) {
        const e = $('#' + k);
        s[k] = e.type === 'checkbox' ? e.checked : e.value;
      }
      ls.set('cf.settings', s);
    });
  }
}

const encode = (rgba, w, h, kind) => encodeImage(rgba, w, h, 'image/jpeg', kind === 'final' ? 0.92 : 0.9);

// ---------------------------------------------------------------- 1. vídeo

function setInput(input, name, size) {
  state.input = input;
  state.inputName = name;
  const info = $('#video-info');
  info.hidden = false;
  info.innerHTML = `<b>${esc(name)}</b>${size ? ` · ${fmtBytes(size)}` : ''}<br><span class="muted">Pronto para processar.</span>`;
  $('#btn-process').disabled = false;
}

function initVideoStep() {
  const fileInput = $('#file');
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) setInput(f, f.name, f.size);
  });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) setInput(f, f.name, f.size);
    else toast('Solte um arquivo de vídeo.', true);
  });
  $('#btn-process').addEventListener('click', processVideo);
  $('#btn-cancel').addEventListener('click', () => state.abort && state.abort.abort());

  // Modo de demonstração/teste: ?demo=caminho/do/video.mp4 (mesma origem)
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && /^[\w./-]+$/.test(demo)) setInput(demo, demo.split('/').pop(), 0);
}

async function showPending() {
  const list = await listPending();
  const box = $('#pending');
  if (!list.length) {
    box.hidden = true;
    return;
  }
  const s = list[0];
  const done = s.items.filter((i) => i.driveId).length;
  box.hidden = false;
  box.innerHTML = `<b>Envio pendente:</b> ${esc(s.folderName)} (${done} de ${s.items.length} capturas enviadas).
    <div class="toolbar" style="margin-top:8px"><button class="primary" id="pend-resume">Retomar envio</button><button id="pend-drop">Descartar</button></div>`;
  $('#pend-resume').onclick = () => {
    state.session = s;
    state.dest = s.dest;
    show('upload');
    renderUploadPanel();
    showSendCard(`Envio pendente: ${done} de ${s.items.length} capturas já estão no Drive.`);
    $('#btn-retry').hidden = false;
    $('#btn-retry').textContent = 'Retomar envio';
  };
  $('#pend-drop').onclick = async () => {
    if (!confirm('Descartar este envio pendente? As capturas guardadas no aparelho serão apagadas.')) return;
    await deleteSession(s.id);
    showPending();
  };
}

// ---------------------------------------------------------------- 2. processamento

const PHASE_SPAN = { analise: [0, 0.72], refino: [0.72, 0.86], extracao: [0.86, 1], fim: [1, 1] };

async function processVideo() {
  if (!state.input) return;
  show('process');
  $('#prog-bar').style.width = '0%';
  $('#prog-text').textContent = 'Abrindo o vídeo…';
  $('#prog-eta').textContent = '';
  await keepAwake(true);
  state.abort = new AbortController();
  const started = performance.now();
  try {
    if (state.source) state.source.dispose();
    for (const c of state.captures) URL.revokeObjectURL(c.url);
    state.captures = [];
    state.source = await openVideo(state.input);
    const src = state.source;
    $('#prog-text').textContent = `Analisando ${clock(src.duration)} de vídeo (${src.width}×${src.height})…`;
    const res = await runPipeline(src, options(), {
      signal: state.abort.signal,
      encode,
      progress: (phase, frac, text) => {
        const [a, b] = PHASE_SPAN[phase] || [0, 1];
        const total = a + (b - a) * frac;
        $('#prog-bar').style.width = `${(total * 100).toFixed(1)}%`;
        if (phase === 'analise') $('#prog-text').textContent = `Analisando o vídeo… ${Math.round(frac * 100)}%`;
        else if (text) $('#prog-text').textContent = text;
        const el = (performance.now() - started) / 1000;
        if (total > 0.04 && total < 1) {
          const left = (el / total) * (1 - total);
          $('#prog-eta').textContent = `Faltam cerca de ${left < 60 ? Math.ceil(left / 5) * 5 + ' s' : Math.ceil(left / 60) + ' min'}.`;
        }
      },
    });
    state.result = res;
    state.processedAt = new Date();
    state.captures = res.captures.map((c, i) => ({ ...c, id: i + 1, url: URL.createObjectURL(c.image) }));
    renderReview();
    show('review');
    if (!state.captures.some((c) => !c.deleted)) {
      toast('Nenhum conteúdo parado foi encontrado. Tente a sensibilidade alta ou adicione quadros manualmente.', true);
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      show('video');
      toast('Processamento cancelado.');
    } else {
      console.error(e);
      show('video');
      toast(e.message || String(e), true);
    }
  } finally {
    state.abort = null;
    keepAwake(false);
  }
}

// ---------------------------------------------------------------- 3. revisão

function kept() {
  return state.captures.filter((c) => !c.deleted).sort((a, b) => a.t - b.t);
}

function renderReview() {
  const all = state.captures.sort((a, b) => a.t - b.t);
  const k = kept();
  const removed = all.length - k.length;
  const dur = state.source ? clock(state.source.duration) : '';
  $('#review-summary').innerHTML =
    `<b>${k.length} captura${k.length === 1 ? '' : 's'}</b> de um vídeo de ${dur}` +
    (removed ? ` · ${removed} removida${removed === 1 ? '' : 's'} (repetidas ou excluídas)` : '') +
    (state.result ? ` · análise em ${Math.round(state.result.stats.seconds)} s` : '') +
    `<br><span class="small muted">Toque numa imagem para ampliar, girar, ver o original ou ajustar o recorte.</span>`;
  $('#btn-to-upload').textContent = `Enviar ${k.length} captura${k.length === 1 ? '' : 's'} ao Google Drive`;
  $('#btn-to-upload').disabled = k.length === 0;

  const grid = $('#grid');
  grid.innerHTML = '';
  let n = 0;
  for (const c of all) {
    if (!c.deleted) n++;
    const card = document.createElement('article');
    card.className = 'cap' + (c.deleted ? ' deleted' : '');
    const badges = [];
    if (c.manual) badges.push('<span class="badge manual">manual</span>');
    if (!c.quad) badges.push('<span class="badge warn">sem correção de perspectiva</span>');
    if (c.rotation) badges.push(`<span class="badge">girada ${c.rotation * 90}°</span>`);
    card.innerHTML = `
      <button class="thumb" aria-label="Ampliar captura"><img loading="lazy" alt="" src="${c.url}"></button>
      <div class="meta">
        <span><span class="num">${c.deleted ? '—' : '#' + String(n).padStart(2, '0')}</span> <span class="time">${clock(c.t)}</span></span>
        <button data-act="toggle">${c.deleted ? 'Restaurar' : 'Remover'}</button>
      </div>
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
      ${c.deleted && c.reason ? `<div class="reason">${esc(c.reason)}</div>` : ''}`;
    card.querySelector('.thumb').onclick = () => openViewer(c);
    card.querySelector('[data-act="toggle"]').onclick = () => {
      c.deleted = !c.deleted;
      if (!c.deleted) c.reason = '';
      else c.reason = c.reason || 'removida por você';
      renderReview();
    };
    grid.appendChild(card);
  }
  drawTimeline();
}

function drawTimeline() {
  const cv = $('#timeline');
  const res = state.result;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 300;
  const H = cv.clientHeight || 84;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (!res || !state.source) return;
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const dur = state.source.duration || 1;
  const x = (t) => (t / dur) * W;
  const plotH = H - 16;
  // trechos estáveis
  ctx.fillStyle = col('--accent-soft');
  for (const s of res.segments) ctx.fillRect(x(s.start), 0, Math.max(1, x(s.end) - x(s.start)), plotH);
  // movimento e mudança
  const line = (key, color, scale, alpha) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    res.timeline.forEach((p, i) => {
      const y = plotH - Math.min(1, p[key] * scale) * (plotH - 4);
      if (i) ctx.lineTo(x(p.t), y);
      else ctx.moveTo(x(p.t), y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  line('motion', col('--muted'), 4, 0.5);
  line('change', col('--accent'), 3, 1);
  // capturas
  for (const c of state.captures) {
    ctx.fillStyle = c.deleted ? col('--danger') : col('--ok');
    ctx.fillRect(x(c.t) - 1.5, plotH + 2, 3, 12);
  }
}

async function rerender(c) {
  const src = await decodeImage(c.original);
  const quad = c.quad ? c.quad.map(([qx, qy]) => [qx * src.w, qy * src.h]) : null;
  const out = renderCapture(src.rgba, src.w, src.h, {
    quad,
    enhance: c.enhance,
    rotation: c.rotation,
    maxLong: options().maxLong,
  });
  c.image = await encode(out.rgba, out.w, out.h, 'final');
  c.w = out.w;
  c.h = out.h;
  URL.revokeObjectURL(c.url);
  c.url = URL.createObjectURL(c.image);
}

function initReviewStep() {
  $('#btn-restart').onclick = () => show('video');
  $('#btn-add-toggle').onclick = () => {
    const box = $('#manual');
    box.hidden = !box.hidden;
    const p = $('#player');
    if (!box.hidden && state.source && p.src !== state.source.url) p.src = state.source.url;
  };
  $('#timeline').addEventListener('click', (e) => {
    if (!state.source) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * state.source.duration;
    $('#manual').hidden = false;
    const p = $('#player');
    if (p.src !== state.source.url) p.src = state.source.url;
    p.currentTime = Math.max(0, Math.min(state.source.duration - 0.05, t));
  });
  $('#btn-capture-now').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Capturando…';
    try {
      const t = $('#player').currentTime;
      const cap = await extractCapture(state.source, t, options(), { encode });
      cap.manual = true;
      cap.id = Date.now();
      cap.url = URL.createObjectURL(cap.image);
      delete cap.dup;
      state.captures.push(cap);
      renderReview();
      toast(`Quadro de ${clock(t)} adicionado.`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Capturar este quadro';
    }
  };
  $('#btn-rotate-all').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      for (const c of kept()) {
        c.rotation = ((c.rotation || 0) + 1) % 4;
        await rerender(c);
      }
      renderReview();
    } finally {
      btn.disabled = false;
    }
  };
  $('#btn-zip').onclick = downloadZip;
  $('#btn-zip2').onclick = downloadZip;
  $('#btn-to-upload').onclick = () => {
    state.session = null;
    $('#send-card').hidden = true;
    show('upload');
    renderUploadPanel();
  };
  window.addEventListener('resize', () => !$('#view-review').hidden && drawTimeline());
}

function namesFor(list) {
  const stamp = sessionStamp(state.processedAt || new Date());
  return {
    stamp,
    folderName: sessionFolderName(state.processedAt || new Date(), state.inputName),
    items: list.map((c, i) => ({ c, index: i + 1, fileName: captureFileName(stamp, i + 1, c.t) })),
  };
}

async function downloadZip() {
  const list = kept();
  if (!list.length) return toast('Nenhuma captura para baixar.', true);
  const { stamp, folderName, items } = namesFor(list);
  const files = [];
  for (const it of items) files.push({ name: it.fileName, data: new Uint8Array(await it.c.image.arrayBuffer()) });
  const idx = buildIndexText({
    folderName,
    videoName: state.inputName,
    duration: state.source ? state.source.duration : 0,
    processedAt: state.processedAt || new Date(),
    items: items.map((it) => ({ index: it.index, t: it.c.t, fileName: it.fileName })),
    ocr: false,
  });
  files.unshift({ name: indexFileName(stamp), data: new TextEncoder().encode(idx) });
  const blob = new Blob([zipStore(files)], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${folderName}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---------------------------------------------------------------- visualizador

const viewer = { cap: null, showingOriginal: false, origUrl: null, corners: null, img: null, drag: -1 };

function openViewer(c) {
  viewer.cap = c;
  viewer.showingOriginal = false;
  const dlg = $('#viewer');
  $('#viewer-title').textContent = `Captura em ${clock(c.t)}${c.deleted ? ' (removida)' : ''}`;
  $('#viewer-img').src = c.url;
  $('#viewer-img').hidden = false;
  $('#corner-canvas').hidden = true;
  $('#viewer-actions').hidden = false;
  $('#corner-actions').hidden = true;
  $('#v-toggle').textContent = 'Ver original';
  $('#v-enh').value = c.enhance || 'leve';
  $('#v-delete').textContent = c.deleted ? 'Restaurar' : 'Remover';
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeViewer() {
  const dlg = $('#viewer');
  if (viewer.origUrl) URL.revokeObjectURL(viewer.origUrl);
  viewer.origUrl = null;
  if (dlg.open) dlg.close();
  renderReview();
}

async function viewerBusy(fn) {
  const box = $('#viewer-actions');
  box.classList.add('busy');
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    box.classList.remove('busy');
  }
}

function initViewer() {
  $('#viewer-close').onclick = closeViewer;
  $('#viewer').addEventListener('cancel', (e) => {
    e.preventDefault();
    closeViewer();
  });
  $('#v-toggle').onclick = () => {
    const c = viewer.cap;
    viewer.showingOriginal = !viewer.showingOriginal;
    if (viewer.showingOriginal && !viewer.origUrl) viewer.origUrl = URL.createObjectURL(c.original);
    $('#viewer-img').src = viewer.showingOriginal ? viewer.origUrl : c.url;
    $('#v-toggle').textContent = viewer.showingOriginal ? 'Ver corrigida' : 'Ver original';
  };
  $('#v-rotate').onclick = () =>
    viewerBusy(async () => {
      const c = viewer.cap;
      c.rotation = ((c.rotation || 0) + 1) % 4;
      await rerender(c);
      $('#viewer-img').src = c.url;
    });
  $('#v-enh').onchange = (e) =>
    viewerBusy(async () => {
      const c = viewer.cap;
      c.enhance = e.target.value;
      await rerender(c);
      $('#viewer-img').src = c.url;
    });
  $('#v-delete').onclick = () => {
    const c = viewer.cap;
    c.deleted = !c.deleted;
    c.reason = c.deleted ? 'removida por você' : '';
    closeViewer();
  };
  $('#v-corners').onclick = () => viewerBusy(startCorners);
  $('#c-cancel').onclick = endCorners;
  $('#c-apply').onclick = () =>
    viewerBusy(async () => {
      const c = viewer.cap;
      const { w, h } = viewer.img;
      c.quad = orderQuad(viewer.corners).map(([x, y]) => [x / w, y / h]);
      await rerender(c);
      endCorners();
    });
  $('#c-none').onclick = () =>
    viewerBusy(async () => {
      viewer.cap.quad = null;
      await rerender(viewer.cap);
      endCorners();
    });
  $('#c-auto').onclick = () =>
    viewerBusy(async () => {
      const c = viewer.cap;
      let q = c.quadAuto;
      if (!q) {
        const src = await decodeImage(c.original);
        const det = detectScreenQuad(src.rgba, src.w, src.h);
        q = det ? det.quad.map(([x, y]) => [x / src.w, y / src.h]) : null;
      }
      if (!q) throw new Error('Não encontrei a tela automaticamente. Ajuste os cantos à mão.');
      viewer.corners = q.map(([x, y]) => [x * viewer.img.w, y * viewer.img.h]);
      drawCorners();
    });

  const cv = $('#corner-canvas');
  const toImg = (e) => {
    const r = cv.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * viewer.img.w, ((e.clientY - r.top) / r.height) * viewer.img.h];
  };
  cv.addEventListener('pointerdown', (e) => {
    const p = toImg(e);
    const r = cv.getBoundingClientRect();
    const tol = (40 / r.width) * viewer.img.w;
    let best = -1;
    let bd = Infinity;
    viewer.corners.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (bd <= tol * 2) {
      viewer.drag = best;
      cv.setPointerCapture(e.pointerId);
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (viewer.drag < 0) return;
    const [x, y] = toImg(e);
    viewer.corners[viewer.drag] = [Math.max(0, Math.min(viewer.img.w - 1, x)), Math.max(0, Math.min(viewer.img.h - 1, y))];
    drawCorners();
  });
  const up = () => (viewer.drag = -1);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
}

async function startCorners() {
  const c = viewer.cap;
  const bmp = await createImageBitmap(c.original);
  viewer.img = { bmp, w: bmp.width, h: bmp.height };
  const q = c.quad || c.quadAuto;
  viewer.corners = q
    ? q.map(([x, y]) => [x * bmp.width, y * bmp.height])
    : [
        [bmp.width * 0.1, bmp.height * 0.1],
        [bmp.width * 0.9, bmp.height * 0.1],
        [bmp.width * 0.9, bmp.height * 0.9],
        [bmp.width * 0.1, bmp.height * 0.9],
      ];
  const cv = $('#corner-canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  $('#viewer-img').hidden = true;
  cv.hidden = false;
  $('#viewer-actions').hidden = true;
  $('#corner-actions').hidden = false;
  drawCorners();
}

function drawCorners() {
  const cv = $('#corner-canvas');
  const ctx = cv.getContext('2d');
  const { bmp, w } = viewer.img;
  ctx.drawImage(bmp, 0, 0);
  const q = viewer.corners;
  const lw = Math.max(2, w / 400);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.rect(0, 0, cv.width, cv.height);
  ctx.moveTo(q[0][0], q[0][1]);
  for (let i = 3; i >= 0; i--) ctx.lineTo(q[i][0], q[i][1]);
  ctx.closePath();
  ctx.fill('evenodd');
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = lw;
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  ctx.stroke();
  for (const p of q) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], lw * 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(77,163,255,0.35)';
    ctx.fill();
    ctx.stroke();
  }
}

function endCorners() {
  if (viewer.img && viewer.img.bmp.close) viewer.img.bmp.close();
  $('#corner-canvas').hidden = true;
  $('#viewer-img').hidden = false;
  $('#viewer-img').src = viewer.cap.url;
  $('#viewer-actions').hidden = false;
  $('#corner-actions').hidden = true;
}

// ---------------------------------------------------------------- 4. envio

function renderUploadPanel() {
  const configured = drive.isConfigured();
  $('#cfg-missing').hidden = configured;
  $('#drive-panel').hidden = !configured;
  if (!configured) return;
  $('#btn-pick').hidden = !drive.pickerAvailable();
  $('#acct').textContent = state.user ? `${state.user.displayName} (${state.user.emailAddress})` : drive.hasValidToken() ? 'Conectada' : 'Não conectada';
  $('#btn-signin').textContent = drive.hasValidToken() ? 'Trocar conta' : 'Entrar com Google';
  $('#dest-name').textContent = state.dest ? state.dest.name : 'Nenhuma escolhida (será usada a pasta automática)';
  const n = state.session ? state.session.items.length : kept().length;
  $('#btn-send').textContent = `Enviar ${n} captura${n === 1 ? '' : 's'}`;
  $('#btn-send').disabled = n === 0;
}

/** Garante o token. Precisa ser chamada de dentro do clique, antes de qualquer await. */
function ensureToken() {
  if (drive.hasValidToken()) return Promise.resolve();
  return drive.signIn().then(async () => {
    try {
      state.user = await drive.getUser();
    } catch {
      state.user = null;
    }
    renderUploadPanel();
  });
}

function setDest(f) {
  state.dest = { id: f.id, name: f.name };
  ls.set('cf.dest', state.dest);
  renderUploadPanel();
  toast(`Pasta de destino: ${f.name}`);
}

function showSendCard(text) {
  $('#send-card').hidden = false;
  $('#send-title').textContent = 'Enviando ao Google Drive';
  $('#send-text').textContent = text || '';
  $('#send-error').hidden = true;
  $('#btn-retry').hidden = true;
}

function initUploadStep() {
  $('#btn-signin').onclick = () => {
    if (drive.hasValidToken()) drive.signOut();
    ensureToken().catch((e) => toast(e.message, true));
  };
  $('#btn-pick').onclick = () =>
    ensureToken()
      .then(() => drive.pickFolder())
      .then(async (f) => {
        if (!f) return;
        await drive.checkFolder(f.id);
        setDest(f);
      })
      .catch((e) => toast(e.message, true));
  $('#btn-paste').onclick = () => {
    const text = prompt('Cole o link da pasta do Google Drive:');
    if (text === null) return;
    const id = parseFolderId(text);
    if (!id) return toast('Link de pasta inválido.', true);
    ensureToken()
      .then(() => drive.checkFolder(id))
      .then((f) => setDest(f))
      .catch((e) => toast(e.message, true));
  };
  $('#btn-auto').onclick = () =>
    ensureToken()
      .then(() => drive.ensureDefaultFolder())
      .then((f) => setDest(f))
      .catch((e) => toast(e.message, true));
  $('#btn-send').onclick = () => {
    const p = ensureToken(); // ainda dentro do clique
    p.then(startUpload).catch((e) => toast(e.message, true));
  };
  $('#btn-retry').onclick = () => {
    const p = ensureToken();
    p.then(() => runUpload()).catch((e) => toast(e.message, true));
  };
}

async function startUpload() {
  if (!state.dest) {
    const f = await drive.ensureDefaultFolder();
    setDest(f);
  } else {
    await drive.checkFolder(state.dest.id); // confirma acesso antes de começar
  }
  if (!state.session) {
    const list = kept();
    const { stamp, folderName, items } = namesFor(list);
    state.session = createSession({
      captures: items.map((it) => ({ t: it.c.t, image: it.c.image, fileName: it.fileName })),
      videoName: state.inputName,
      duration: state.source ? state.source.duration : 0,
      dest: state.dest,
      ocr: $('#opt-ocr').checked,
      stamp,
      folderName,
    });
    await saveSession(state.session);
  }
  await runUpload();
}

async function runUpload() {
  const s = state.session;
  if (!s) return;
  showSendCard('Começando…');
  $('#btn-send').disabled = true;
  await keepAwake(true);
  try {
    await uploadSession(s, {
      ocr: recognize,
      onProgress: ({ feito, total, texto }) => {
        $('#send-text').textContent = texto;
        $('#send-bar').style.width = `${Math.round((feito / Math.max(1, total)) * 100)}%`;
      },
    });
    await deleteSession(s.id);
    stopOcr();
    $('#done-text').innerHTML =
      `${s.items.length} captura${s.items.length === 1 ? '' : 's'} enviada${s.items.length === 1 ? '' : 's'} para <b>${esc(s.dest.name)}</b> › <b>${esc(s.folderName)}</b>` +
      (s.ocr ? ', com índice e transcrição de texto.' : ', com índice.') +
      (s.ocrError ? `<br><span class="small">O OCR não pôde ser usado (${esc(s.ocrError)}); o índice tem só a lista.</span>` : '');
    $('#done-link').href = s.sessionFolder.webViewLink || `https://drive.google.com/drive/folders/${s.sessionFolder.id}`;
    show('done');
  } catch (e) {
    console.error(e);
    const done = s.items.filter((i) => i.driveId).length;
    $('#send-title').textContent = 'O envio parou';
    $('#send-error').hidden = false;
    $('#send-error').textContent = `${e.message}\n${done} de ${s.items.length} capturas já estão no Drive. Tentar de novo continua de onde parou, sem duplicar.`;
    $('#btn-retry').hidden = false;
    $('#btn-retry').textContent = 'Tentar novamente';
  } finally {
    $('#btn-send').disabled = false;
    keepAwake(false);
  }
}

// ---------------------------------------------------------------- 5. fim

function initDoneStep() {
  $('#btn-new').onclick = () => {
    state.session = null;
    state.result = null;
    for (const c of state.captures) URL.revokeObjectURL(c.url);
    state.captures = [];
    $('#file').value = '';
    $('#video-info').hidden = true;
    $('#btn-process').disabled = true;
    state.input = null;
    show('video');
    showPending();
  };
}

// ---------------------------------------------------------------- início

loadSettings();
initVideoStep();
initReviewStep();
initViewer();
initUploadStep();
initDoneStep();
show('video');
showPending();
drive.preload().catch(() => {});

// Exposto só para testes automatizados no navegador.
window.__cf = { state };
