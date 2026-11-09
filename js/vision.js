// vision.js — medidas de imagem usadas na análise do vídeo.
// Funções puras (sem DOM): rodam no navegador e nos testes em Node.
//
// Ideia central: cada amostra do vídeo vira uma "feature" pequena (≈320 px) com
// luminância (Y) e crominância (U, V) levemente borradas. Comparar duas features
// alinha o tremor da mão (translação), compensa a exposição automática do celular
// e mede, por célula de uma grade, a fração de pixels que mudou de verdade.
// Mudança espalhada = troca de conteúdo; mudança concentrada numa célula =
// alteração pequena e importante (alternativa marcada, mensagem nova).

export const FEATURE_LONG_SIDE = 320;

/** Luminância Rec.601 em Float32 a partir de RGBA. */
export function luminance(rgba, w, h) {
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    Y[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return Y;
}

/** Borra in-place com o núcleo separável [1 2 1]/4 (σ ≈ 0,7 px). */
export function blur121(A, w, h) {
  const tmp = new Float32Array(A.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    tmp[r] = (3 * A[r] + A[r + 1]) / 4;
    for (let x = 1; x < w - 1; x++) tmp[r + x] = (A[r + x - 1] + 2 * A[r + x] + A[r + x + 1]) / 4;
    tmp[r + w - 1] = (A[r + w - 2] + 3 * A[r + w - 1]) / 4;
  }
  for (let x = 0; x < w; x++) {
    A[x] = (3 * tmp[x] + tmp[x + w]) / 4;
    for (let y = 1; y < h - 1; y++) {
      const i = y * w + x;
      A[i] = (tmp[i - w] + 2 * tmp[i] + tmp[i + w]) / 4;
    }
    const last = (h - 1) * w + x;
    A[last] = (tmp[last - w] + 3 * tmp[last]) / 4;
  }
  return A;
}

function meanStd(A) {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < A.length; i++) {
    s += A[i];
    s2 += A[i] * A[i];
  }
  const m = s / A.length;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / A.length - m * m)) };
}

/**
 * Cria a feature de comparação a partir de um quadro RGBA (normalmente ~640 px).
 * Reduz por um fator inteiro com média de blocos (antisserrilhado) até ~longSide.
 */
export function makeFeature(rgba, w, h, longSide = FEATURE_LONG_SIDE) {
  const f = Math.max(1, Math.round(Math.max(w, h) / longSide));
  const fw = Math.floor(w / f);
  const fh = Math.floor(h / f);
  const n = fw * fh;
  const Y = new Float32Array(n);
  const U = new Float32Array(n);
  const V = new Float32Array(n);
  const inv = 1 / (f * f);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = 0; yy < f; yy++) {
        let j = ((y * f + yy) * w + x * f) * 4;
        for (let xx = 0; xx < f; xx++, j += 4) {
          r += rgba[j];
          g += rgba[j + 1];
          b += rgba[j + 2];
        }
      }
      r *= inv;
      g *= inv;
      b *= inv;
      const yl = 0.299 * r + 0.587 * g + 0.114 * b;
      const i = y * fw + x;
      Y[i] = yl;
      U[i] = b - yl;
      V[i] = r - yl;
    }
  }
  blur121(Y, fw, fh);
  blur121(Y, fw, fh);
  blur121(U, fw, fh);
  blur121(V, fw, fh);
  const sy = meanStd(Y);
  return {
    w: fw,
    h: fh,
    Y,
    U,
    V,
    meanY: sy.mean,
    stdY: sy.std,
    meanU: meanStd(U).mean,
    meanV: meanStd(V).mean,
  };
}

/**
 * Nitidez = variância do Laplaciano na região central (ignora 6% de cada borda).
 * Só é comparável entre quadros do MESMO conteúdo — e é assim que é usada.
 */
export function sharpness(Y, w, h) {
  const mx = Math.max(1, Math.round(w * 0.06));
  const my = Math.max(1, Math.round(h * 0.06));
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = my; y < h - my; y++) {
    let i = y * w + mx;
    for (let x = mx; x < w - mx; x++, i++) {
      const l = 4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - w] - Y[i + w];
      s += l;
      s2 += l * l;
      n++;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

/** Fração de pixels estourados (reflexo/brilho excessivo). */
export function glareFraction(rgba, w, h) {
  const n = w * h;
  let c = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (rgba[j] >= 250 && rgba[j + 1] >= 250 && rgba[j + 2] >= 250) c++;
  }
  return c / n;
}

/**
 * Procura a translação (dx, dy) que melhor alinha B sobre A (tremor da mão).
 * Busca completa (amostragem esparsa) seguida de refinamento ±1. Penaliza levemente
 * deslocamentos grandes para não "pular" entre linhas de texto repetitivas.
 */
export function alignShift(A, B, maxShift, gain = 1, off = 0, cx = 0, cy = 0) {
  const w = A.w;
  const h = A.h;
  const m = maxShift + Math.max(Math.abs(cx), Math.abs(cy)) + 2;
  const AY = A.Y;
  const BY = B.Y;
  const cost = (dx, dy, step) => {
    let s = 0;
    let n = 0;
    for (let y = m; y < h - m; y += step) {
      let i = y * w + m;
      let j = (y + dy) * w + m + dx;
      for (let x = m; x < w - m; x += step, i += step, j += step) {
        s += Math.abs(AY[i] - (gain * BY[j] + off));
        n++;
      }
    }
    return n ? s / n : 0;
  };
  const lambda = 0.04;
  // Busca completa em passo de 1 px, mas avaliando só 1 a cada 4×4 pixels:
  // texto tem linhas periódicas e uma busca grossa em passo 2 pode "pular" o
  // alinhamento certo e cair numa linha vizinha.
  const pen = (dx, dy) => lambda * (Math.abs(dx - cx) + Math.abs(dy - cy));
  let best = { dx: cx, dy: cy, c: Infinity };
  const coarseStep = maxShift > 3 ? 4 : 2;
  for (let dy = cy - maxShift; dy <= cy + maxShift; dy++) {
    for (let dx = cx - maxShift; dx <= cx + maxShift; dx++) {
      const c = cost(dx, dy, coarseStep) + pen(dx, dy);
      if (c < best.c) best = { dx, dy, c };
    }
  }
  if (coarseStep === 2) return best;
  let fine = { dx: best.dx, dy: best.dy, c: Infinity };
  for (let dy = best.dy - 1; dy <= best.dy + 1; dy++) {
    for (let dx = best.dx - 1; dx <= best.dx + 1; dx++) {
      if (Math.abs(dx - cx) > maxShift || Math.abs(dy - cy) > maxShift) continue;
      const c = cost(dx, dy, 2) + pen(dx, dy);
      if (c < fine.c) fine = { dx, dy, c };
    }
  }
  return fine;
}

/**
 * Feature de detalhe: só luminância, em resolução maior (~640 px), levemente
 * borrada. Usada para perceber troca de TEXTO com o mesmo layout, que em 320 px
 * vira só borrões de linhas iguais.
 */
export function makeDetail(Y, w, h) {
  const D = blur121(Float32Array.from(Y), w, h);
  const s = meanStd(D);
  return { w, h, Y: Uint8ClampedArray.from(D), mean: s.mean, std: s.std };
}

/**
 * Compara o CONTEÚDO de duas imagens em alta resolução (≈1280 px).
 * Para cada célula da grade procura o melhor deslocamento local (±radius px em
 * torno de cx, cy — compensa rotação/zoom da mão) e mede a correlação
 * normalizada (NCC), que ignora brilho/contraste. score = 1 − NCC.
 *  - células sem textura nas duas imagens não contam;
 *  - textura que apareceu/sumiu conta como mudança total (score 1).
 * Retorna { global (média nas células com conteúdo), local (pior célula), cells, textured }.
 */
export function compareDetail(A, B, cx = 0, cy = 0, opts = {}) {
  if (A.w !== B.w || A.h !== B.h) throw new Error('detalhes com tamanhos diferentes');
  const r = opts.radius ?? 6; // busca local por célula (px), absorve rotação/zoom
  const gx = opts.gx ?? 8;
  const gy = opts.gy ?? 6;
  const step = opts.step ?? 3;
  const texMin = opts.textureStd ?? 7;
  const tau = opts.tau ?? 20; // diferença mínima (níveis de cinza) para um pixel contar como alterado
  const areaFull = opts.areaFull ?? 0.15; // 15% da célula alterada = mudança total
  const nccWeight = opts.nccWeight ?? 0.8;
  const ignore = opts.ignore;
  const w = A.w;
  const h = A.h;
  // exposição global de B ajustada à de A
  const sa0 = A.std !== undefined ? A : meanStd(A.Y);
  const sb0 = B.std !== undefined ? B : meanStd(B.Y);
  const gain = sa0.std > 1 && sb0.std > 1 ? Math.min(2, Math.max(0.5, sa0.std / sb0.std)) : 1;
  const off = sa0.mean - gain * sb0.mean;
  const m = r + 1 + Math.max(Math.abs(cx), Math.abs(cy));
  const AY = A.Y;
  const BY = B.Y;
  const cells = gx * gy;
  const score = new Float32Array(cells);
  const textured = new Uint8Array(cells);
  let washed = new Uint8Array(cells); // 1 = A apagada (reflexo em A), 2 = B apagada
  const bright = new Float32Array(cells); // brilho de B − brilho de A, por célula
  const nccs = new Float32Array(cells);
  const spanX = w - 2 * m;
  const spanY = h - 2 * m;

  for (let gyi = 0; gyi < gy; gyi++) {
    const y0 = m + Math.floor((gyi * spanY) / gy);
    const y1 = m + Math.floor(((gyi + 1) * spanY) / gy);
    for (let gxi = 0; gxi < gx; gxi++) {
      const c = gyi * gx + gxi;
      const x0 = m + Math.floor((gxi * spanX) / gx);
      const x1 = m + Math.floor(((gxi + 1) * spanX) / gx);
      // estatística de A na célula
      let sa = 0;
      let saa = 0;
      let n = 0;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const v = AY[y * w + x];
          sa += v;
          saa += v * v;
          n++;
        }
      }
      const ma = sa / n;
      const va = Math.max(0, saa / n - ma * ma);
      const nccAt = (dx, dy) => {
        let sb = 0;
        let sbb = 0;
        let sab = 0;
        for (let y = y0; y < y1; y += step) {
          const ra = y * w;
          const rb = (y + dy) * w + dx;
          for (let x = x0; x < x1; x += step) {
            const a = AY[ra + x];
            const b = BY[rb + x];
            sb += b;
            sbb += b * b;
            sab += a * b;
          }
        }
        const mb = sb / n;
        const vb = Math.max(0, sbb / n - mb * mb);
        const cov = sab / n - ma * mb;
        return { ncc: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0, vb, mb };
      };
      // busca grossa (passo 2) + refinamento (±1)
      let best = { ncc: -2, vb: 0, mb: 0, dx: cx, dy: cy };
      for (let dy = cy - r; dy <= cy + r; dy += 2) {
        for (let dx = cx - r; dx <= cx + r; dx += 2) {
          const v = nccAt(dx, dy);
          if (v.ncc > best.ncc) best = { ...v, dx, dy };
        }
      }
      const bx = best.dx;
      const by = best.dy;
      for (let dy = by - 1; dy <= by + 1; dy++) {
        for (let dx = bx - 1; dx <= bx + 1; dx++) {
          if ((dx - bx) % 2 === 0 && (dy - by) % 2 === 0) continue;
          if (Math.abs(dx - cx) > r + 1 || Math.abs(dy - cy) > r + 1) continue;
          const v = nccAt(dx, dy);
          if (v.ncc > best.ncc) best = { ...v, dx, dy };
        }
      }
      const sA = Math.sqrt(va);
      const sB = Math.sqrt(best.vb);
      const texA = sA > texMin;
      const texB = sB > texMin;
      if (!texA && !texB) continue;
      textured[c] = 1;
      // "Desbotado" (reflexo): um lado ficou mais claro, com menos contraste,
      // mas com a MESMA estrutura (correlação positiva). Texto diferente não
      // passa nesse teste: muda a estrutura sem clarear/desbotar a célula.
      const mbN = gain * best.mb + off;
      const sBn = gain * sB;
      bright[c] = mbN - ma;
      nccs[c] = best.ncc;
      if (best.ncc > 0.25) {
        if (mbN - ma > 8 && sBn < 0.8 * sA) washed[c] = 2;
        else if (ma - mbN > 8 && sA < 0.8 * sBn) washed[c] = 1;
      }
      // Área alterada: fração de pixels fora do envelope 3×3 da outra imagem
      // (com a exposição de B ajustada à de A). Distingue o cursor (≈1% da
      // célula) de um destaque de linha ou mensagem nova (≥10%).
      let changed = 0;
      let total = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = y * w + x;
          const j = (y + best.dy) * w + x + best.dx;
          let aMin = 255;
          let aMax = 0;
          let bMin = 255;
          let bMax = 0;
          for (let ny = -w; ny <= w; ny += w) {
            for (let nx = -1; nx <= 1; nx++) {
              const va2 = AY[i + ny + nx];
              const vb2 = BY[j + ny + nx];
              if (va2 < aMin) aMin = va2;
              if (va2 > aMax) aMax = va2;
              if (vb2 < bMin) bMin = vb2;
              if (vb2 > bMax) bMax = vb2;
            }
          }
          const a = AY[i];
          const b = gain * BY[j] + off;
          const d = Math.max(a - (gain * bMax + off), gain * bMin + off - a, b - aMax, aMin - b);
          total++;
          if (d > tau) changed++;
        }
      }
      const area = total ? changed / total : 0;
      const areaScore = Math.min(1, area / areaFull);
      // Correlação só é confiável com textura de verdade nos dois lados; numa
      // célula quase vazia o cursor domina a variância e a NCC vira ruído.
      const nccOk = sA > 2.5 * texMin && sB > 2.5 * texMin;
      const nccScore = nccOk ? Math.min(1, Math.max(0, 1 - best.ncc)) : 0;
      score[c] = Math.max(areaScore, nccWeight * nccScore);
    }
  }
  // O reflexo é uma mancha suave: vizinhas de uma célula desbotada que também
  // clarearam (mesma estrutura) entram na máscara.
  if (washed.some((v) => v)) {
    const grown = washed.slice();
    for (let c = 0; c < cells; c++) {
      if (!washed[c]) continue;
      const cx0 = c % gx;
      const cy0 = Math.floor(c / gx);
      for (let ny = Math.max(0, cy0 - 1); ny <= Math.min(gy - 1, cy0 + 1); ny++) {
        for (let nx = Math.max(0, cx0 - 1); nx <= Math.min(gx - 1, cx0 + 1); nx++) {
          const n = ny * gx + nx;
          if (washed[n] || !textured[n] || nccs[n] <= 0.25) continue;
          if ((washed[c] === 2 && bright[n] > 3) || (washed[c] === 1 && bright[n] < -3)) grown[n] = washed[c];
        }
      }
    }
    washed = grown;
  }
  const skip = (c) => (ignore && ignore[c]) || (opts.ignoreWashout && washed[c]);
  let sum = 0;
  let used = 0;
  let max = 0;
  for (let c = 0; c < cells; c++) {
    if (!textured[c] || skip(c)) continue;
    sum += score[c];
    used++;
    if (score[c] > max) max = score[c];
  }
  return { global: used ? sum / used : 0, local: max, cells: score, textured, washed, gx, gy };
}

/** Fração de pixels estourados por célula da grade (mapa de reflexo). */
export function cellGlare(rgba, w, h, gx = 8, gy = 6) {
  const cnt = new Uint32Array(gx * gy);
  const sat = new Uint32Array(gx * gy);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(gy - 1, Math.floor((y * gy) / h));
    for (let x = 0; x < w; x++) {
      const c = cy * gx + Math.min(gx - 1, Math.floor((x * gx) / w));
      const j = (y * w + x) * 4;
      cnt[c]++;
      if (rgba[j] >= 245 && rgba[j + 1] >= 245 && rgba[j + 2] >= 245) sat[c]++;
    }
  }
  return Float32Array.from(cnt, (n, c) => (n ? sat[c] / n : 0));
}

/**
 * Compara duas features do mesmo tamanho.
 * Retorna:
 *  - global: fração média de pixels alterados (mudança espalhada)
 *  - local:  maior fração entre as células da grade (mudança concentrada)
 *  - dx, dy: translação usada no alinhamento
 */
export function compareFeatures(A, B, opts = {}) {
  if (A.w !== B.w || A.h !== B.h) throw new Error('features com tamanhos diferentes');
  const maxShift = opts.maxShift ?? 12;
  const [cx, cy] = opts.center ?? [0, 0];
  const tau = opts.tau ?? 22;
  const ck = opts.chroma ?? 1.6;
  const gx = opts.gx ?? 8;
  const gy = opts.gy ?? 6;
  const w = A.w;
  const h = A.h;
  const color = Boolean(A.U && B.U);

  // Compensa exposição automática (ganho/offset em Y) e balanço de branco (offset em U/V).
  let gain = A.stdY > 1 && B.stdY > 1 ? A.stdY / B.stdY : 1;
  gain = Math.min(2, Math.max(0.5, gain));
  const off = A.meanY - gain * B.meanY;

  const { dx, dy } = alignShift(A, B, maxShift, gain, off, cx, cy);
  if (opts.alignOnly) return { dx, dy };
  const m = maxShift + Math.max(Math.abs(cx), Math.abs(cy)) + 1;
  if (!color || opts.lumaOnly) {
    return finishCompare(diffLuma(A, B, w, h, m, dx, dy, gain, off, tau, gx, gy), dx, dy, opts.ignore);
  }

  const du = A.meanU - B.meanU;
  const dv = A.meanV - B.meanV;
  const x0 = m;
  const x1 = w - m;
  const y0 = m;
  const y1 = h - m;
  const cells = gx * gy;
  const cnt = new Uint32Array(cells);
  const chg = new Uint32Array(cells);
  const AY = A.Y;
  const AU = A.U;
  const AV = A.V;
  const BY = B.Y;
  const BU = B.U;
  const BV = B.V;
  const spanX = x1 - x0;
  const spanY = y1 - y0;

  // Comparação por "envelope": um pixel só conta como mudado se o seu valor
  // estiver fora do intervalo [mín, máx] da vizinhança 3×3 da outra imagem
  // (nos dois sentidos). Isso absorve deslocamentos de frações de pixel e
  // pequenas rotações/zoom sem esconder texto que apareceu ou sumiu.
  for (let y = y0; y < y1; y++) {
    const cy = Math.min(gy - 1, Math.floor(((y - y0) * gy) / spanY));
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const j0 = (y + dy) * w + x + dx;
      let aYmin = Infinity, aYmax = -Infinity, aUmin = Infinity, aUmax = -Infinity, aVmin = Infinity, aVmax = -Infinity;
      let bYmin = Infinity, bYmax = -Infinity, bUmin = Infinity, bUmax = -Infinity, bVmin = Infinity, bVmax = -Infinity;
      for (let ny = -w; ny <= w; ny += w) {
        for (let nx = -1; nx <= 1; nx++) {
          const ia = i + ny + nx;
          const jb = j0 + ny + nx;
          let v = AY[ia];
          if (v < aYmin) aYmin = v;
          if (v > aYmax) aYmax = v;
          v = AU[ia];
          if (v < aUmin) aUmin = v;
          if (v > aUmax) aUmax = v;
          v = AV[ia];
          if (v < aVmin) aVmin = v;
          if (v > aVmax) aVmax = v;
          v = BY[jb];
          if (v < bYmin) bYmin = v;
          if (v > bYmax) bYmax = v;
          v = BU[jb];
          if (v < bUmin) bUmin = v;
          if (v > bUmax) bUmax = v;
          v = BV[jb];
          if (v < bVmin) bVmin = v;
          if (v > bVmax) bVmax = v;
        }
      }
      // B normalizado para a exposição de A
      bYmin = gain * bYmin + off;
      bYmax = gain * bYmax + off;
      bUmin += du;
      bUmax += du;
      bVmin += dv;
      bVmax += dv;
      const a = AY[i];
      const au = AU[i];
      const av = AV[i];
      const b = gain * BY[j0] + off;
      const bu = BU[j0] + du;
      const bv = BV[j0] + dv;
      const d = Math.max(
        a - bYmax,
        bYmin - a,
        b - aYmax,
        aYmin - b,
        ck * Math.max(au - bUmax, bUmin - au, bu - aUmax, aUmin - bu, av - bVmax, bVmin - av, bv - aVmax, aVmin - bv),
      );
      const c = cy * gx + Math.min(gx - 1, Math.floor(((x - x0) * gx) / spanX));
      cnt[c]++;
      if (d > tau) chg[c]++;
    }
  }
  return finishCompare({ cnt, chg }, dx, dy, opts.ignore);
}

/** Mesma comparação por envelope, só na luminância (features de detalhe). */
function diffLuma(A, B, w, h, m, dx, dy, gain, off, tau, gx, gy) {
  const x0 = m;
  const x1 = w - m;
  const y0 = m;
  const y1 = h - m;
  const cnt = new Uint32Array(gx * gy);
  const chg = new Uint32Array(gx * gy);
  const AY = A.Y;
  const BY = B.Y;
  for (let y = y0; y < y1; y++) {
    const cyc = Math.min(gy - 1, Math.floor(((y - y0) * gy) / (y1 - y0)));
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const j0 = (y + dy) * w + x + dx;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (let ny = -w; ny <= w; ny += w) {
        for (let nx = -1; nx <= 1; nx++) {
          let v = AY[i + ny + nx];
          if (v < aMin) aMin = v;
          if (v > aMax) aMax = v;
          v = BY[j0 + ny + nx];
          if (v < bMin) bMin = v;
          if (v > bMax) bMax = v;
        }
      }
      bMin = gain * bMin + off;
      bMax = gain * bMax + off;
      const a = AY[i];
      const b = gain * BY[j0] + off;
      const d = Math.max(a - bMax, bMin - a, b - aMax, aMin - b);
      const c = cyc * gx + Math.min(gx - 1, Math.floor(((x - x0) * gx) / (x1 - x0)));
      cnt[c]++;
      if (d > tau) chg[c]++;
    }
  }
  return { cnt, chg };
}

function finishCompare({ cnt, chg }, dx, dy, ignore) {
  const cells = cnt.length;
  const fr = new Float32Array(cells);
  let sum = 0;
  let used = 0;
  let max = 0;
  for (let c = 0; c < cells; c++) {
    fr[c] = cnt[c] ? chg[c] / cnt[c] : 0;
    if (ignore && ignore[c]) continue;
    sum += fr[c];
    used++;
    if (fr[c] > max) max = fr[c];
  }
  return { global: used ? sum / used : 0, local: max, dx, dy, cells: fr };
}

/** Redimensiona RGBA por média de área (bom para reduzir; vizinho mais próximo ao ampliar). */
export function resizeArea(rgba, w, h, nw, nh) {
  const sx = w / nw;
  const sy = h / nh;
  // passo horizontal: w×h → nw×h
  const tmp = new Float32Array(nw * h * 4);
  for (let x = 0; x < nw; x++) {
    const a = Math.floor(x * sx);
    const b = Math.max(a + 1, Math.min(w, Math.floor((x + 1) * sx)));
    const inv = 1 / (b - a);
    for (let y = 0; y < h; y++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let al = 0;
      let j = (y * w + a) * 4;
      for (let k = a; k < b; k++, j += 4) {
        r += rgba[j];
        g += rgba[j + 1];
        bl += rgba[j + 2];
        al += rgba[j + 3];
      }
      const o = (y * nw + x) * 4;
      tmp[o] = r * inv;
      tmp[o + 1] = g * inv;
      tmp[o + 2] = bl * inv;
      tmp[o + 3] = al * inv;
    }
  }
  // passo vertical: nw×h → nw×nh
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const a = Math.floor(y * sy);
    const b = Math.max(a + 1, Math.min(h, Math.floor((y + 1) * sy)));
    const inv = 1 / (b - a);
    for (let x = 0; x < nw; x++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let al = 0;
      for (let k = a; k < b; k++) {
        const j = (k * nw + x) * 4;
        r += tmp[j];
        g += tmp[j + 1];
        bl += tmp[j + 2];
        al += tmp[j + 3];
      }
      const o = (y * nw + x) * 4;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = bl * inv;
      out[o + 3] = al * inv;
    }
  }
  return out;
}

/** Feature de tamanho fixo (para comparar capturas já retificadas de tamanhos diferentes). */
export function makeFixedFeature(rgba, w, h, fw = 320, fh = 200) {
  const small = resizeArea(rgba, w, h, fw, fh);
  return makeFeature(small, fw, fh, Math.max(fw, fh));
}
