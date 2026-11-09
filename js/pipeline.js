// pipeline.js — orquestra a análise completa, independente do ambiente.
//
// `source` abstrai o vídeo (no navegador: <video> + canvas; nos testes: ffmpeg):
//   source.duration, source.width, source.height
//   source.samples(times, longSide)  → async iterável de { t, rgba, w, h }
//   source.grab(t, longSide)         → Promise<{ rgba, w, h }>  (longSide 0 = resolução nativa)
// `hooks`:
//   progress(fase, fração, texto?)   encode(rgba, w, h, tipo) → Promise<any>   signal (AbortSignal)

import { luminance, makeFeature, makeDetail, sharpness, glareFraction, resizeArea } from './vision.js';
import { detectScreenQuad, renderCapture } from './imageops.js';
import { Segmenter, paramsFor, isChanged, isSameContent, compareContent } from './segmenter.js';

export const DEFAULT_OPTIONS = {
  sensitivity: 'normal', // 'baixa' | 'normal' | 'alta'
  perspective: true, // corrigir perspectiva automaticamente
  enhance: 'leve', // 'nenhum' | 'leve' | 'forte'
  dedupe: true, // marcar capturas repetidas como removidas
  maxLong: 2560, // maior lado da imagem final (não amplia)
  sampleFps: 0, // 0 = automático
};

export const ANALYSIS_LONG = 1280; // resolução das amostras (texto legível o bastante para comparar)
const DUP_W = 1280; // tamanho fixo para comparar capturas já retificadas
const DUP_H = 720;

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const e = new Error('Processamento cancelado');
    e.name = 'AbortError';
    throw e;
  }
}

/** Instantes de amostragem: 4/s em vídeos de até 5 min; depois limita a ~1200 amostras. */
export function planSampleTimes(duration, fps = 0) {
  const rate = fps > 0 ? fps : duration <= 300 ? 4 : Math.max(1.5, 1200 / duration);
  const dt = 1 / rate;
  const times = [];
  const start = Math.min(0.05, duration / 2);
  for (let t = start; t < duration - 0.05; t += dt) times.push(Math.round(t * 1000) / 1000);
  if (!times.length) times.push(Math.max(0, duration / 2));
  return { times, dt };
}

/** Representação de uma amostra usada para comparar conteúdo. */
export function describeFrame(rgba, w, h) {
  const Y = luminance(rgba, w, h);
  return {
    feat: makeFeature(rgba, w, h),
    detail: makeDetail(Y, w, h),
    sharp: sharpness(Y, w, h),
    glare: glareFraction(rgba, w, h),
  };
}

/** Fase 1 — amostra o vídeo e segmenta em estados estáveis. */
export async function analyze(source, opts, hooks = {}) {
  const P = paramsFor(opts.sensitivity);
  const { times, dt } = planSampleTimes(source.duration, opts.sampleFps);
  const seg = new Segmenter(P, dt);
  let k = 0;
  for await (const fr of source.samples(times, ANALYSIS_LONG)) {
    checkAbort(hooks.signal);
    seg.push({ t: fr.t, ...describeFrame(fr.rgba, fr.w, fr.h) });
    k++;
    hooks.progress?.('analise', k / times.length);
  }
  return { segments: seg.finish(), timeline: seg.timeline, dt, params: P, samples: k };
}

/**
 * Fase 2 — em volta do melhor instante do trecho, examina quadros vizinhos
 * (≈15/s) e escolhe o mais nítido, com menos reflexo e com a tela inteira
 * visível. Também devolve o quadrilátero da tela (normalizado 0..1).
 */
export async function refineSegment(source, seg, P, hooks = {}) {
  const center = seg.best.t;
  const lo = Math.max(seg.start, center - 0.3);
  const hi = Math.min(seg.end + 0.001, center + 0.3);
  const times = new Set([center]);
  for (let t = lo; t <= hi; t += 0.1) times.add(Math.round(t * 1000) / 1000);
  const tried = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    checkAbort(hooks.signal);
    const fr = await source.grab(t, ANALYSIS_LONG);
    const desc = describeFrame(fr.rgba, fr.w, fr.h);
    if (t !== center && isChanged(compareContent(seg.ref, desc, { tau: P.tau }), P)) continue; // outro conteúdo ou transição
    tried.push({ t, sharp: desc.sharp, glare: desc.glare, rgba: fr.rgba, w: fr.w, h: fr.h });
  }
  const maxSharp = Math.max(...tried.map((c) => c.sharp), 1e-6);
  const minGlare = Math.min(...tried.map((c) => c.glare));
  for (const c of tried) {
    c.score = (c.sharp / maxSharp) * (1 - Math.min(0.6, 6 * Math.max(0, c.glare - minGlare)));
  }
  tried.sort((a, b) => b.score - a.score);
  // A detecção da tela (mais cara) só nos 3 melhores: prefere o quadro com a tela inteira visível.
  const top = tried.slice(0, 3);
  for (const c of top) {
    const det = detectScreenQuad(c.rgba, c.w, c.h);
    c.quad = det ? det.quad.map(([x, y]) => [x / c.w, y / c.h]) : null;
    c.score *= det ? (det.touches ? 0.8 : 1) : 0.9;
  }
  top.sort((a, b) => b.score - a.score);
  const { t, quad, score } = top[0];
  return { t, quad, score };
}

/**
 * Extrai uma captura em resolução nativa no instante t.
 * `quadNorm` (opcional) evita detectar a tela de novo.
 */
export async function extractCapture(source, t, opts, hooks = {}, quadNorm = undefined) {
  const full = await source.grab(t, 0);
  let quadNormFinal = quadNorm;
  if (quadNormFinal === undefined) {
    const det = detectScreenQuad(full.rgba, full.w, full.h);
    quadNormFinal = det ? det.quad.map(([x, y]) => [x / full.w, y / full.h]) : null;
  }
  const quadPx = quadNormFinal ? quadNormFinal.map(([x, y]) => [x * full.w, y * full.h]) : null;
  let dup = null;
  const out = renderCapture(full.rgba, full.w, full.h, {
    quad: opts.perspective ? quadPx : null,
    enhance: opts.enhance,
    rotation: 0,
    maxLong: opts.maxLong,
    onWarped: (rgba, w, h) => {
      if (!opts.dedupe) return;
      const small = resizeArea(rgba, w, h, DUP_W, DUP_H);
      const d = describeFrame(small, DUP_W, DUP_H);
      dup = { feat: d.feat, detail: d.detail };
    },
  });
  const warnings = [];
  if (opts.perspective && !quadPx) warnings.push('tela não detectada — sem correção de perspectiva');
  return {
    t,
    quadAuto: quadNormFinal, // quadrilátero detectado (normalizado 0..1)
    quad: opts.perspective ? quadNormFinal : null, // quadrilátero em uso
    rotation: 0,
    enhance: opts.enhance,
    srcW: full.w,
    srcH: full.h,
    w: out.w,
    h: out.h,
    image: await hooks.encode(out.rgba, out.w, out.h, 'final'),
    original: await hooks.encode(full.rgba, full.w, full.h, 'original'),
    dup,
    warnings,
  };
}

/**
 * Marca duplicatas (mesmo conteúdo já capturado antes) como removidas.
 * Células "apagadas" por reflexo em uma das imagens não contam na comparação;
 * entre duas versões do mesmo conteúdo, fica a que tem menos área apagada.
 */
export function markDuplicates(captures, P) {
  const kept = [];
  const fmt = (t) => formatTime(t);
  for (const c of captures) {
    if (c.deleted || !c.dup) continue;
    let dupIdx = -1;
    let washA = 0;
    let washB = 0;
    for (let i = 0; i < kept.length; i++) {
      const d = compareContent(kept[i].dup, c.dup, { tau: P.tau, ignoreWashout: true, radius: 9 });
      const washedTotal = d.washed.reduce((s, v) => s + (v ? 1 : 0), 0);
      // muito apagado = não dá para afirmar que é o mesmo conteúdo
      if (washedTotal <= 0.35 * d.textured.reduce((s, v) => s + v, 0) && isSameContent(d, P, d.washed)) {
        dupIdx = i;
        washA = d.washed.reduce((s, v) => s + (v === 1 ? 1 : 0), 0);
        washB = d.washed.reduce((s, v) => s + (v === 2 ? 1 : 0), 0);
        break;
      }
    }
    if (dupIdx < 0) {
      kept.push(c);
      continue;
    }
    const k = kept[dupIdx];
    if (washA > washB) {
      k.deleted = true;
      k.reason = `repetida (versão com menos reflexo em ${fmt(c.t)})`;
      kept[dupIdx] = c;
    } else {
      c.deleted = true;
      c.reason = `repetida (mesmo conteúdo da captura de ${fmt(k.t)})`;
    }
  }
  return captures;
}

export function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Executa tudo: análise → refinamento → extração → duplicatas. */
export async function runPipeline(source, options, hooks = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const t0 = Date.now();
  const an = await analyze(source, opts, hooks);
  const P = an.params;
  const captures = [];
  for (let i = 0; i < an.segments.length; i++) {
    checkAbort(hooks.signal);
    const seg = an.segments[i];
    hooks.progress?.('refino', i / an.segments.length, `Escolhendo o melhor quadro ${i + 1} de ${an.segments.length}`);
    const best = await refineSegment(source, seg, P, hooks);
    hooks.progress?.('extracao', (i + 0.5) / an.segments.length, `Corrigindo imagem ${i + 1} de ${an.segments.length}`);
    const cap = await extractCapture(source, best.t, opts, hooks, best.quad);
    cap.segStart = seg.start;
    cap.segEnd = seg.end;
    cap.quality = best.score;
    captures.push(cap);
  }
  captures.sort((a, b) => a.t - b.t);
  if (opts.dedupe) markDuplicates(captures, P);
  for (const c of captures) delete c.dup; // libera memória
  hooks.progress?.('fim', 1);
  return {
    captures,
    timeline: an.timeline,
    segments: an.segments.map((s) => ({ id: s.id, start: s.start, end: s.end, best: s.best.t })),
    stats: { samples: an.samples, seconds: (Date.now() - t0) / 1000, dt: an.dt },
    params: P,
  };
}
