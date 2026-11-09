// imageops.js — detecção da tela, correção de perspectiva, realce e rotação.
// Funções puras (sem DOM). Nenhuma operação aqui "inventa" conteúdo: só
// reamostragem geométrica, curvas de tom e nitidez leve.

import { resizeArea } from './vision.js';

// ---------------------------------------------------------------------------
// Utilidades geométricas
// ---------------------------------------------------------------------------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** Ordena 4 pontos como [topo-esq, topo-dir, baixo-dir, baixo-esq]. */
export function orderQuad(q) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const s = q
    .map((p) => ({ p, a: Math.atan2(p[1] - cy, p[0] - cx) }))
    .sort((a, b) => a.a - b.a)
    .map((o) => o.p);
  // após ordenar por ângulo (sentido horário em coordenadas de tela), começa no de menor x+y
  let k = 0;
  for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[k][0] + s[k][1]) k = i;
  return [s[k], s[(k + 1) % 4], s[(k + 2) % 4], s[(k + 3) % 4]];
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Quadrilátero de área ~máxima inscrito no casco: diagonal mais longa + pontos mais afastados dela. */
function hullToQuad(hull) {
  if (hull.length < 4) return null;
  let a = 0;
  let c = 0;
  let best = -1;
  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const d = (hull[i][0] - hull[j][0]) ** 2 + (hull[i][1] - hull[j][1]) ** 2;
      if (d > best) {
        best = d;
        a = i;
        c = j;
      }
    }
  }
  const A = hull[a];
  const C = hull[c];
  let bPos = null;
  let bNeg = null;
  let dPos = 0;
  let dNeg = 0;
  for (const p of hull) {
    const s = (C[0] - A[0]) * (p[1] - A[1]) - (C[1] - A[1]) * (p[0] - A[0]);
    if (s > dPos) {
      dPos = s;
      bPos = p;
    }
    if (s < dNeg) {
      dNeg = s;
      bNeg = p;
    }
  }
  if (!bPos || !bNeg) return null;
  return orderQuad([A, bPos, C, bNeg]);
}

/** Ajusta uma reta (ponto + direção) por PCA. */
function fitLine(pts) {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p[0] - mx;
    const dy = p[1] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] };
}

function intersect(l1, l2) {
  const [x1, y1] = l1.p;
  const [dx1, dy1] = l1.d;
  const [x2, y2] = l2.p;
  const [dx2, dy2] = l2.d;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x2 - x1) * dy2 - (y2 - y1) * dx2) / den;
  return [x1 + t * dx1, y1 + t * dy1];
}

/** Refina cada lado ajustando uma reta aos pontos de borda próximos do lado. */
function refineQuad(q, boundary, tol) {
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const P = q[s];
    const Q = q[(s + 1) % 4];
    const L = dist(P, Q);
    if (L < 1) return q;
    const ux = (Q[0] - P[0]) / L;
    const uy = (Q[1] - P[1]) / L;
    const near = [];
    for (const b of boundary) {
      const vx = b[0] - P[0];
      const vy = b[1] - P[1];
      const t = vx * ux + vy * uy;
      if (t < 0.15 * L || t > 0.85 * L) continue;
      const dperp = Math.abs(vx * uy - vy * ux);
      if (dperp <= tol) near.push(b);
    }
    lines.push(near.length >= 8 ? fitLine(near) : { p: P, d: [ux, uy] });
  }
  const out = [];
  for (let s = 0; s < 4; s++) {
    const pt = intersect(lines[(s + 3) % 4], lines[s]);
    if (!pt) return q;
    out.push(pt);
  }
  return out;
}

/** Expande o quadrilátero a partir do centro (margem de segurança para não cortar texto). */
export function expandQuad(q, frac) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  return q.map(([x, y]) => [cx + (x - cx) * (1 + frac), cy + (y - cy) * (1 + frac)]);
}

function angleAt(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

export function validateQuad(q, w, h) {
  const area = polygonArea(q);
  const areaFrac = area / (w * h);
  // convexidade
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const sg = Math.sign(cr);
    if (sg === 0) return { ok: false };
    if (sign === 0) sign = sg;
    else if (sg !== sign) return { ok: false };
  }
  for (let i = 0; i < 4; i++) {
    const ang = angleAt(q[(i + 3) % 4], q[i], q[(i + 1) % 4]);
    if (ang < 55 || ang > 125) return { ok: false };
  }
  const wTop = dist(q[0], q[1]);
  const wBot = dist(q[3], q[2]);
  const hL = dist(q[0], q[3]);
  const hR = dist(q[1], q[2]);
  if (Math.max(wTop, wBot) / Math.max(1, Math.min(wTop, wBot)) > 1.8) return { ok: false };
  if (Math.max(hL, hR) / Math.max(1, Math.min(hL, hR)) > 1.8) return { ok: false };
  const aspect = (wTop + wBot) / Math.max(1, hL + hR);
  if (aspect < 0.35 || aspect > 3.2) return { ok: false };
  if (areaFrac < 0.08 || areaFrac > 0.985) return { ok: false };
  const m = 0.012 * Math.max(w, h);
  const touches = q.some(([x, y]) => x < m || y < m || x > w - 1 - m || y > h - 1 - m);
  return { ok: true, areaFrac, aspect, touches };
}

// ---------------------------------------------------------------------------
// Detecção da tela do notebook
// ---------------------------------------------------------------------------

function lumU8(rgba, w, h) {
  const n = w * h;
  const Y = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  return Y;
}

function boxBlurU8(Y, w, h, r) {
  const tmp = new Uint16Array(w * h);
  const out = new Uint8Array(w * h);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) s += Y[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += Y[row + Math.min(w - 1, x + r + 1)] - Y[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(s / (k * k));
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function sobelMag(Y, w, h) {
  const G = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Y[i - w + 1] + 2 * Y[i + 1] + Y[i + w + 1] - Y[i - w - 1] - 2 * Y[i - 1] - Y[i + w - 1];
      const gy = Y[i + w - 1] + 2 * Y[i + w] + Y[i + w + 1] - Y[i - w - 1] - 2 * Y[i - w] - Y[i - w + 1];
      G[i] = Math.hypot(gx, gy);
    }
  }
  return G;
}

function otsu(Y) {
  const hist = new Float64Array(256);
  for (let i = 0; i < Y.length; i++) hist[Y[i]]++;
  const total = Y.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/**
 * Dilatação/erosão binária com janela quadrada (separável), em O(1) por pixel:
 * conta quantos pixels "procurados" há na janela com uma soma deslizante.
 */
function morph(mask, w, h, r, dilate) {
  const want = dilate ? 1 : 0;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let cnt = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) if (mask[row + x] === want) cnt++;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = cnt > 0 ? want : 1 - want;
      const add = x + r + 1;
      const rem = x - r;
      if (add < w && mask[row + add] === want) cnt++;
      if (rem >= 0 && mask[row + rem] === want) cnt--;
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) if (tmp[y * w + x] === want) cnt++;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = cnt > 0 ? want : 1 - want;
      const add = y + r + 1;
      const rem = y - r;
      if (add < h && tmp[add * w + x] === want) cnt++;
      if (rem >= 0 && tmp[rem * w + x] === want) cnt--;
    }
  }
  return out;
}

/** Rotula componentes conexos (4-vizinhança) e devolve os maiores. */
function largestComponents(mask, w, h, count) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = next;
    let area = 0;
    while (sp) {
      const i = stack[--sp];
      area++;
      const x = i % w;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) {
        labels[i - 1] = next;
        stack[sp++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) {
        labels[i + 1] = next;
        stack[sp++] = i + 1;
      }
      if (i >= w && mask[i - w] && !labels[i - w]) {
        labels[i - w] = next;
        stack[sp++] = i - w;
      }
      if (i < w * (h - 1) && mask[i + w] && !labels[i + w]) {
        labels[i + w] = next;
        stack[sp++] = i + w;
      }
    }
    comps.push({ label: next, area });
    next++;
  }
  comps.sort((a, b) => b.area - a.area);
  const top = comps.slice(0, count);
  for (const c of top) {
    const pts = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (labels[i] !== c.label) continue;
        if (
          x === 0 ||
          y === 0 ||
          x === w - 1 ||
          y === h - 1 ||
          labels[i - 1] !== c.label ||
          labels[i + 1] !== c.label ||
          labels[i - w] !== c.label ||
          labels[i + w] !== c.label
        ) {
          pts.push([x, y]);
        }
      }
    }
    c.boundary = pts;
  }
  return top;
}

/** Força média do gradiente ao longo dos lados (a borda real da tela tem contraste forte). */
function edgeSupport(q, G, w, h) {
  const sides = [];
  for (let s = 0; s < 4; s++) {
    const P = q[s];
    const Q = q[(s + 1) % 4];
    let sum = 0;
    let n = 0;
    for (let k = 1; k < 40; k++) {
      const t = k / 40;
      const x = Math.round(P[0] + (Q[0] - P[0]) * t);
      const y = Math.round(P[1] + (Q[1] - P[1]) * t);
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
          const g = G[yy * w + xx];
          if (g > m) m = g;
        }
      }
      sum += m;
      n++;
    }
    sides.push(n ? sum / n : 0);
  }
  const mean = sides.reduce((a, b) => a + b, 0) / 4;
  return { mean, min: Math.min(...sides) };
}

function percentile(arr, p) {
  const hist = new Uint32Array(1024);
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (!max) return 0;
  const k = 1023 / max;
  for (let i = 0; i < arr.length; i++) hist[Math.floor(arr[i] * k)]++;
  const target = p * arr.length;
  let acc = 0;
  for (let b = 0; b < 1024; b++) {
    acc += hist[b];
    if (acc >= target) return b / k;
  }
  return max;
}

/**
 * Detecta o quadrilátero da tela do notebook numa imagem RGBA.
 * Estratégia: a área útil da tela costuma ser a maior região clara com borda
 * escura (moldura). Testa alguns limiares, pega o maior componente, ajusta um
 * quadrilátero ao casco convexo, refina os lados e pontua pelo contraste da borda.
 * Retorna { quad: [[x,y]×4], score, touches, areaFrac } ou null.
 */
export function detectScreenQuad(rgba, w, h) {
  // trabalha em ~640 px para ser rápido e estável
  const scale = Math.min(1, 640 / Math.max(w, h));
  let src = rgba;
  let sw = w;
  let sh = h;
  if (scale < 1) {
    sw = Math.round(w * scale);
    sh = Math.round(h * scale);
    src = resizeArea(rgba, w, h, sw, sh);
  }
  const Y0 = lumU8(src, sw, sh);
  const Y = boxBlurU8(Y0, sw, sh, 1);
  const G = sobelMag(Y, sw, sh);
  const gRef = Math.max(1, percentile(G, 0.97));
  const t0 = otsu(Y);
  const thresholds = [...new Set([t0, Math.round(t0 * 0.8), Math.round(t0 * 1.15), Math.round(t0 * 1.35)])].filter(
    (t) => t > 10 && t < 245,
  );
  const r = Math.max(2, Math.round(Math.min(sw, sh) * 0.012));
  let best = null;
  for (const T of thresholds) {
    let mask = new Uint8Array(sw * sh);
    for (let i = 0; i < mask.length; i++) mask[i] = Y[i] > T ? 1 : 0;
    // fecha buracos (texto escuro) e depois abre (separa pontes finas com o fundo)
    mask = morph(morph(mask, sw, sh, r, true), sw, sh, r, false);
    mask = morph(morph(mask, sw, sh, 2, false), sw, sh, 2, true);
    const comps = largestComponents(mask, sw, sh, 2);
    for (const c of comps) {
      if (c.area < 0.08 * sw * sh) continue;
      const hull = convexHull(c.boundary);
      let q = hullToQuad(hull);
      if (!q) continue;
      q = orderQuad(refineQuad(q, c.boundary, 0.03 * Math.hypot(sw, sh)));
      const v = validateQuad(q, sw, sh);
      if (!v.ok) continue;
      const fill = Math.min(1, c.area / polygonArea(q));
      if (fill < 0.75) continue;
      const e = edgeSupport(q, G, sw, sh);
      const edge = (0.5 * e.mean + 0.5 * e.min) / gRef;
      const score = edge * fill * fill * (0.5 + 0.5 * Math.sqrt(v.areaFrac)) * (v.touches ? 0.6 : 1);
      if (!best || score > best.score) best = { quad: q, score, touches: v.touches, areaFrac: v.areaFrac };
    }
  }
  if (!best || best.score < 0.12) return null;
  const inv = 1 / scale;
  best.quad = expandQuad(best.quad, 0.006).map(([x, y]) => [
    Math.max(0, Math.min(w - 1, x * inv)),
    Math.max(0, Math.min(h - 1, y * inv)),
  ]);
  return best;
}

// ---------------------------------------------------------------------------
// Homografia e retificação
// ---------------------------------------------------------------------------

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error('sistema singular');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homografia 3×3 (vetor de 9) que leva src[i] → dst[i]. */
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(A, b), 1];
}

export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

const COMMON_ASPECTS = [16 / 9, 16 / 10, 3 / 2, 4 / 3, 21 / 9];

/** Tamanho de saída a partir do quadrilátero (sem ampliar além do que a câmera captou). */
export function outputSizeForQuad(q, maxLong = 2560) {
  let ow = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let oh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  // A perspectiva encurta um dos lados; se a proporção estiver perto de uma
  // proporção comum de tela, usa a proporção comum.
  const r = ow / oh;
  for (const a of COMMON_ASPECTS) {
    if (Math.abs(r / a - 1) < 0.07) {
      oh = ow / a;
      break;
    }
  }
  const s = Math.min(1, maxLong / Math.max(ow, oh));
  return { w: Math.max(16, Math.round(ow * s)), h: Math.max(16, Math.round(oh * s)) };
}

/** Retifica o quadrilátero `quad` da imagem para um retângulo ow×oh (bilinear). */
export function warpQuad(rgba, w, h, quad, ow, oh) {
  const dst = [
    [0, 0],
    [ow - 1, 0],
    [ow - 1, oh - 1],
    [0, oh - 1],
  ];
  const H = homography(dst, quad); // saída → origem
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let v = 0; v < oh; v++) {
    for (let u = 0; u < ow; u++) {
      const d = H[6] * u + H[7] * v + H[8];
      let x = (H[0] * u + H[1] * v + H[2]) / d;
      let y = (H[3] * u + H[4] * v + H[5]) / d;
      if (x < 0) x = 0;
      else if (x > w - 1.001) x = w - 1.001;
      if (y < 0) y = 0;
      else if (y > h - 1.001) y = h - 1.001;
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * w + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + w * 4;
      const i11 = i01 + 4;
      const o = (v * ow + u) * 4;
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] + (rgba[i10 + c] - rgba[i00 + c]) * fx;
        const bot = rgba[i01 + c] + (rgba[i11 + c] - rgba[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Realce (conservador)
// ---------------------------------------------------------------------------

function channelPercentiles(rgba, n, lo, hi) {
  const res = [];
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = c; i < n * 4; i += 4 * 3) hist[rgba[i]]++; // amostra 1 a cada 3 pixels
    const total = hist.reduce((a, b) => a + b, 0);
    let acc = 0;
    let pLo = 0;
    let pHi = 255;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= lo * total) {
        pLo = v;
        break;
      }
    }
    acc = 0;
    for (let v = 255; v >= 0; v--) {
      acc += hist[v];
      if (acc >= (1 - hi) * total) {
        pHi = v;
        break;
      }
    }
    res.push([pLo, pHi]);
  }
  return res;
}

/** Estica os níveis por canal (também corrige o balanço de branco), com ganho limitado. */
function stretchLevels(rgba, w, h, maxGain) {
  const n = w * h;
  const p = channelPercentiles(rgba, n, 0.005, 0.995);
  const luts = p.map(([lo, hi]) => {
    let span = Math.max(1, hi - lo);
    if (255 / span > maxGain) {
      // limita o ganho: centraliza a janela em vez de esticar demais (evita ruído)
      const mid = (lo + hi) / 2;
      span = 255 / maxGain;
      lo = Math.max(0, mid - span / 2);
    }
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / span;
    return lut;
  });
  for (let i = 0; i < n * 4; i += 4) {
    rgba[i] = luts[0][rgba[i]];
    rgba[i + 1] = luts[1][rgba[i + 1]];
    rgba[i + 2] = luts[2][rgba[i + 2]];
  }
}

/** Uniformiza iluminação de fundos claros (vinheta, reflexo difuso). */
function flattenIllumination(rgba, w, h) {
  const n = w * h;
  const Y = lumU8(rgba, w, h);
  let sum = 0;
  for (let i = 0; i < n; i += 7) sum += Y[i];
  if (sum / Math.ceil(n / 7) < 120) return; // fundo escuro (modo noturno): não mexe
  const B = 24; // blocos de 24 px: máximo local ≈ cor do "papel"
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // usa o percentil ~90 aproximado pela média dos 2 maiores de uma amostragem
      let m1 = 0;
      let m2 = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y += 2) {
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x += 2) {
          const v = Y[y * w + x];
          if (v > m1) {
            m2 = m1;
            m1 = v;
          } else if (v > m2) m2 = v;
        }
      }
      bg[by * bw + bx] = (m1 + m2) / 2;
    }
  }
  // suaviza o mapa de fundo
  for (let pass = 0; pass < 3; pass++) {
    const t = bg.slice();
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx;
            const y = by + dy;
            if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
            s += t[y * bw + x];
            c++;
          }
        }
        bg[by * bw + bx] = s / c;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1.001, Math.max(0, y / B - 0.5));
    const y0 = fy | 0;
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1.001, Math.max(0, x / B - 0.5));
      const x0 = fx | 0;
      const tx = fx - x0;
      const a = bg[y0 * bw + x0];
      const b = bg[y0 * bw + Math.min(bw - 1, x0 + 1)];
      const c = bg[Math.min(bh - 1, y0 + 1) * bw + x0];
      const d = bg[Math.min(bh - 1, y0 + 1) * bw + Math.min(bw - 1, x0 + 1)];
      const local = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      const gain = Math.min(2.2, Math.max(0.85, 240 / Math.max(1, local)));
      const o = (y * w + x) * 4;
      rgba[o] *= gain;
      rgba[o + 1] *= gain;
      rgba[o + 2] *= gain;
    }
  }
}

/** Máscara de nitidez leve só na luminância (evita franjas coloridas). */
function unsharp(rgba, w, h, amount) {
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  // gaussiana 5 taps [1 4 6 4 1]/16 (σ ≈ 1)
  const tmp = new Float32Array(n);
  const B = new Float32Array(n);
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -2; t <= 2; t++) s += k[t + 2] * Y[row + Math.min(w - 1, Math.max(0, x + t))];
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -2; t <= 2; t++) s += k[t + 2] * tmp[Math.min(h - 1, Math.max(0, y + t)) * w + x];
      B[y * w + x] = s;
    }
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let d = amount * (Y[i] - B[i]);
    if (d > 40) d = 40;
    else if (d < -40) d = -40;
    rgba[j] += d;
    rgba[j + 1] += d;
    rgba[j + 2] += d;
  }
}

/**
 * Aplica o nível de realce escolhido (in-place).
 *  - 'nenhum': nada
 *  - 'leve':   níveis + nitidez suave (padrão)
 *  - 'forte':  uniformiza iluminação de fundos claros + níveis + nitidez
 */
export function enhance(rgba, w, h, level) {
  if (level === 'nenhum') return rgba;
  if (level === 'forte') flattenIllumination(rgba, w, h);
  stretchLevels(rgba, w, h, level === 'forte' ? 2.6 : 2.0);
  unsharp(rgba, w, h, level === 'forte' ? 0.8 : 0.5);
  return rgba;
}

/** Gira RGBA em múltiplos de 90° no sentido horário. */
export function rotate(rgba, w, h, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (q === 0) return { rgba, w, h };
  const nw = q % 2 ? h : w;
  const nh = q % 2 ? w : h;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx;
      let ny;
      if (q === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (q === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      const s = (y * w + x) * 4;
      const d = (ny * nw + nx) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return { rgba: out, w: nw, h: nh };
}

/**
 * Gera a imagem final de uma captura a partir do quadro original.
 * opts: { quad|null, enhance, rotation (quartos de volta), maxLong }
 */
export function renderCapture(rgba, w, h, opts) {
  let out;
  let ow;
  let oh;
  if (opts.quad) {
    const size = outputSizeForQuad(opts.quad, opts.maxLong ?? 2560);
    ow = size.w;
    oh = size.h;
    out = warpQuad(rgba, w, h, opts.quad, ow, oh);
  } else {
    const s = Math.min(1, (opts.maxLong ?? 2560) / Math.max(w, h));
    ow = Math.round(w * s);
    oh = Math.round(h * s);
    out = s < 1 ? resizeArea(rgba, w, h, ow, oh) : new Uint8ClampedArray(rgba);
  }
  if (opts.onWarped) opts.onWarped(out, ow, oh); // antes do realce (para medir reflexo/duplicatas)
  enhance(out, ow, oh, opts.enhance ?? 'leve');
  return rotate(out, ow, oh, opts.rotation ?? 0);
}
