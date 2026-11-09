// segmenter.js — divide o vídeo em "estados estáveis" de conteúdo.
//
// Cada amostra (≈4 por segundo) tem duas representações:
//   feat   (320 px, cor)       → MOVIMENTO: diferença para a amostra anterior,
//                                 tolerante a tremor. Diz se a imagem está parada.
//   detail (≈1280 px, cinza)   → CONTEÚDO: correlação por célula contra a
//                                 referência do trecho atual. Diz se o texto mudou.
// Um novo trecho só começa quando o conteúdo mudou E o novo estado ficou parado
// por `persist` amostras seguidas (descarta mão passando, cursor, transições).
// No fim: descarta trechos curtos demais, junta A-A e A-B-A (obstrução breve)
// e ordena os candidatos de cada trecho (mais nítido, com menos reflexo).

import { compareFeatures, compareDetail } from './vision.js';

// Limiares de conteúdo por sensibilidade (escala: 1 − correlação por célula).
//   tau:            diferença (níveis de cinza) para um pixel contar como alterado
//   cellT/minCells: quantas células precisam mudar para contar como conteúdo novo
//   strongCell:     uma única célula com mudança forte já basta (mensagem, alternativa)
//   dup*:           quando duas capturas são "a mesma" (no máx. dupMaxCells células diferentes,
//                   ex.: borda do recorte ou cursor; medido: iguais ≤ 0,09 global, diferentes ≥ 0,27)
export const SENSITIVITY = {
  baixa: { tau: 26, cellT: 0.4, minCells: 3, strongCell: 0.75, changeGlobal: 0.09, dupCellT: 0.45, dupMaxCells: 2, dupGlobal: 0.14 },
  normal: { tau: 20, cellT: 0.3, minCells: 2, strongCell: 0.5, changeGlobal: 0.06, dupCellT: 0.4, dupMaxCells: 1, dupGlobal: 0.1 },
  alta: { tau: 16, cellT: 0.2, minCells: 1, strongCell: 0.35, changeGlobal: 0.04, dupCellT: 0.3, dupMaxCells: 0, dupGlobal: 0.06 },
};

export const BASE_PARAMS = {
  motionGlobal: 0.03, // movimento abaixo disso = imagem parada
  motionLocal: 0.2,
  persist: 2, // amostras paradas seguidas exigidas para aceitar um novo estado
  minStableSec: 0.6, // trecho precisa de pelo menos isso de imagem parada
  abaMaxSec: 2.5, // A-B-A com B mais curto que isso = obstrução passageira
};

export function paramsFor(sensitivity) {
  return { ...BASE_PARAMS, ...(SENSITIVITY[sensitivity] || SENSITIVITY.normal) };
}

/** Compara o conteúdo de duas amostras { feat, detail }. */
export function compareContent(A, B, opts = {}) {
  const coarse = compareFeatures(A.feat, B.feat, { alignOnly: true }); // só o alinhamento grosso
  const k = A.detail.w / A.feat.w;
  const d = compareDetail(A.detail, B.detail, Math.round(coarse.dx * k), Math.round(coarse.dy * k), opts);
  return { ...d, coarse };
}

export function changedCells(d, T, ignore) {
  let n = 0;
  for (let c = 0; c < d.cells.length; c++) {
    if (d.textured[c] && !(ignore && ignore[c]) && d.cells[c] > T) n++;
  }
  return n;
}

/** Maior mudança entre as células internas (a borda da grade pega moldura/fundo, que oscilam com o tremor). */
function interiorMax(d) {
  const gx = d.gx || 8;
  const gy = d.gy || 6;
  let max = 0;
  for (let c = 0; c < d.cells.length; c++) {
    const x = c % gx;
    const y = Math.floor(c / gx);
    if (x === 0 || y === 0 || x === gx - 1 || y === gy - 1 || !d.textured[c]) continue;
    if (d.cells[c] > max) max = d.cells[c];
  }
  return max;
}

export function isChanged(d, P) {
  return changedCells(d, P.cellT) >= P.minCells || d.global > P.changeGlobal || interiorMax(d) >= P.strongCell;
}

export function isSameContent(d, P, ignore) {
  return changedCells(d, P.dupCellT, ignore) <= P.dupMaxCells && d.global < P.dupGlobal;
}

export class Segmenter {
  constructor(params, dt) {
    this.P = params;
    this.dt = dt;
    this.prev = null;
    this.cur = null;
    this.closed = [];
    this.timeline = [];
    this.run = []; // amostras paradas e com conteúdo novo, seguidas
    this.nextId = 1;
  }

  push(s) {
    const P = this.P;
    let stable = false;
    let motion = 0;
    if (this.prev) {
      const m = compareFeatures(this.prev.feat, s.feat, { maxShift: 8, lumaOnly: true });
      motion = m.global;
      stable = m.global < P.motionGlobal && m.local < P.motionLocal;
    }
    let change = 0;
    const cand = { t: s.t, sharp: s.sharp, glare: s.glare };
    if (!this.cur) {
      if (stable) this._open(s, [cand]);
    } else if (stable) {
      const d = compareContent(this.cur.ref, s, { tau: P.tau });
      change = d.global;
      if (isChanged(d, P)) {
        this.run.push(cand);
        if (this.run.length >= P.persist) {
          this._close(this.run[0].t);
          this._open(s, this.run);
        }
      } else {
        this.run = [];
        this.cur.cands.push(cand);
        this.cur.end = s.t;
      }
    } else {
      this.run = []; // em movimento: transição, tremor forte ou obstrução
    }
    this.timeline.push({ t: s.t, motion, change, stable, seg: this.cur ? this.cur.id : 0 });
    this.prev = { feat: s.feat };
  }

  _open(s, cands) {
    this.cur = {
      id: this.nextId++,
      start: cands[0].t,
      end: s.t,
      ref: { t: s.t, feat: s.feat, detail: s.detail },
      cands: cands.slice(),
    };
    this.run = [];
  }

  _close(endT) {
    if (!this.cur) return;
    this.cur.end = Math.max(this.cur.end, Math.min(endT, this.cur.end + 1));
    this.closed.push(this.cur);
    this.cur = null;
  }

  /** Fecha o último trecho e devolve os trechos finais, cada um com `best`. */
  finish() {
    if (this.cur) this._close(this.cur.end);
    const P = this.P;
    const segs = this.closed.filter((s) => s.cands.length * this.dt >= P.minStableSec - 1e-6);
    const same = (a, b) => isSameContent(compareContent(a.ref, b.ref, { tau: P.tau }), P);

    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i + 1 < segs.length; i++) {
        const a = segs[i];
        const b = segs[i + 1];
        if (same(a, b)) {
          a.cands.push(...b.cands);
          a.end = b.end;
          segs.splice(i + 1, 1);
          merged = true;
          break;
        }
        const c = segs[i + 2];
        if (c && b.end - b.start < P.abaMaxSec && same(a, c)) {
          a.cands.push(...c.cands);
          a.end = c.end;
          segs.splice(i + 1, 2);
          merged = true;
          break;
        }
      }
    }
    for (const s of segs) rankCandidates(s);
    return segs;
  }
}

/** Ordena candidatos: nitidez relativa ao trecho, penalizando reflexo acima do mínimo do trecho. */
export function rankCandidates(seg) {
  const maxSharp = Math.max(...seg.cands.map((c) => c.sharp), 1e-6);
  const minGlare = Math.min(...seg.cands.map((c) => c.glare));
  for (const c of seg.cands) {
    const glarePen = 1 - Math.min(0.6, 6 * Math.max(0, c.glare - minGlare));
    c.score = (c.sharp / maxSharp) * glarePen;
  }
  seg.cands.sort((a, b) => b.score - a.score);
  seg.best = seg.cands[0];
  return seg;
}
