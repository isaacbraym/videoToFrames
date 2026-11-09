// Geradores de imagens sintéticas para os testes (sem dependências).

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function blank(w, h, v = 245) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i += 4) {
    a[i] = a[i + 1] = a[i + 2] = v;
    a[i + 3] = 255;
  }
  return a;
}

export function rect(a, w, x0, y0, x1, y1, [r, g, b]) {
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const i = (y * w + x) * 4;
      a[i] = r;
      a[i + 1] = g;
      a[i + 2] = b;
    }
  }
}

/** "Página de texto": linhas de palavras escuras sobre fundo claro. */
export function textPage(w, h, seed) {
  const a = blank(w, h);
  const R = rng(seed);
  for (let y = Math.round(h * 0.08); y < h * 0.92; y += Math.round(h * 0.06)) {
    let x = Math.round(w * 0.05);
    while (x < w * 0.92) {
      const len = Math.round(w * (0.02 + R() * 0.07));
      rect(a, w, x, y, Math.min(Math.round(w * 0.95), x + len), y + Math.max(2, Math.round(h * 0.022)), [30, 30, 30]);
      x += len + Math.round(w * 0.015);
    }
  }
  return a;
}

/** Desloca a imagem (dx, dy) repetindo a borda. */
export function shift(a, w, h, dx, dy) {
  const o = new Uint8ClampedArray(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx));
      const sy = Math.min(h - 1, Math.max(0, y - dy));
      const s = (sy * w + sx) * 4;
      const d = (y * w + x) * 4;
      o[d] = a[s];
      o[d + 1] = a[s + 1];
      o[d + 2] = a[s + 2];
      o[d + 3] = 255;
    }
  }
  return o;
}

export function gain(a, g, off = 0) {
  const o = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    o[i] = a[i] * g + off;
    o[i + 1] = a[i + 1] * g + off;
    o[i + 2] = a[i + 2] * g + off;
    o[i + 3] = 255;
  }
  return o;
}

/** Desenha um quadrilátero preenchido (para simular a tela vista em perspectiva). */
export function fillQuad(a, w, h, q, color) {
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = q[i];
      const [x2, y2] = q[(i + 1) % 4];
      const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
      const s = Math.sign(c);
      if (s === 0) continue;
      if (!sign) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const i = (y * w + x) * 4;
      a[i] = color[0];
      a[i + 1] = color[1];
      a[i + 2] = color[2];
    }
  }
}
