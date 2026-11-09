import test from 'node:test';
import assert from 'node:assert/strict';
import {
  homography,
  applyH,
  detectScreenQuad,
  warpQuad,
  outputSizeForQuad,
  rotate,
  enhance,
  orderQuad,
} from '../js/imageops.js';
import { blank, fillQuad, rect } from './helpers.mjs';

test('homografia leva os cantos aos cantos', () => {
  const src = [
    [10, 20],
    [300, 40],
    [280, 200],
    [30, 190],
  ];
  const dst = [
    [0, 0],
    [400, 0],
    [400, 225],
    [0, 225],
  ];
  const H = homography(src, dst);
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyH(H, ...src[i]);
    assert.ok(Math.abs(x - dst[i][0]) < 1e-6 && Math.abs(y - dst[i][1]) < 1e-6);
  }
});

test('orderQuad ordena TL, TR, BR, BL', () => {
  const q = orderQuad([
    [300, 40],
    [30, 190],
    [10, 20],
    [280, 200],
  ]);
  assert.deepEqual(q, [
    [10, 20],
    [300, 40],
    [280, 200],
    [30, 190],
  ]);
});

function scene(w, h, quad) {
  const a = blank(w, h, 140); // parede
  rect(a, w, Math.round(w * 0.88), 0, w, Math.round(h * 0.4), [235, 238, 240]); // janela clara
  const c = quad.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
  const bezel = quad.map(([x, y]) => [c[0] + (x - c[0]) * 1.07, c[1] + (y - c[1]) * 1.07]);
  fillQuad(a, w, h, bezel, [25, 25, 28]);
  fillQuad(a, w, h, quad, [248, 248, 248]);
  // "texto" dentro da tela
  for (let y = 0.25; y < 0.8; y += 0.07) {
    const p = (u, v) => [
      quad[0][0] + (quad[1][0] - quad[0][0]) * u + (quad[3][0] - quad[0][0]) * v,
      quad[0][1] + (quad[1][1] - quad[0][1]) * u + (quad[3][1] - quad[0][1]) * v,
    ];
    fillQuad(a, w, h, [p(0.1, y), p(0.85, y), p(0.85, y + 0.02), p(0.1, y + 0.02)], [30, 30, 30]);
  }
  return a;
}

test('detecta a tela em perspectiva com moldura escura', () => {
  const w = 960;
  const h = 540;
  const quad = [
    [150, 70],
    [820, 88],
    [808, 468],
    [165, 480],
  ];
  const det = detectScreenQuad(scene(w, h, quad), w, h);
  assert.ok(det, 'deveria detectar');
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(det.quad[i][0] - quad[i][0], det.quad[i][1] - quad[i][1]);
    assert.ok(d < 12, `canto ${i} desviou ${d.toFixed(1)} px`);
  }
  assert.equal(det.touches, false);
});

test('sem tela visível → null', () => {
  const w = 640;
  const h = 360;
  const a = blank(w, h, 128);
  assert.equal(detectScreenQuad(a, w, h), null);
});

test('retificação produz retângulo claro com proporção de tela', () => {
  const w = 960;
  const h = 540;
  const quad = [
    [150, 70],
    [820, 88],
    [808, 468],
    [165, 480],
  ];
  const img = scene(w, h, quad);
  const size = outputSizeForQuad(quad, 2560);
  // o quadrilátero tem ≈1,63 de proporção → deve encaixar em 16:10
  assert.ok(Math.abs(size.w / size.h - 16 / 10) < 0.01, `proporção ${size.w}/${size.h}`);
  const out = warpQuad(img, w, h, quad, size.w, size.h);
  // cantos da saída devem ser "tela" (claros), não moldura
  const px = (x, y) => out[(y * size.w + x) * 4];
  for (const [x, y] of [
    [4, 4],
    [size.w - 5, 4],
    [4, size.h - 5],
    [size.w - 5, size.h - 5],
  ]) {
    assert.ok(px(x, y) > 200, `canto (${x},${y}) = ${px(x, y)}`);
  }
});

test('rotação de 90° troca largura e altura e preserva pixels', () => {
  const a = blank(4, 2, 0);
  a[0] = 255; // pixel (0,0) vermelho
  const r = rotate(a, 4, 2, 1);
  assert.equal(r.w, 2);
  assert.equal(r.h, 4);
  assert.equal(r.rgba[(0 * 2 + 1) * 4], 255); // vai para (1,0)
});

test('realce "nenhum" não altera nada', () => {
  const a = blank(10, 10, 100);
  const b = a.slice();
  enhance(b, 10, 10, 'nenhum');
  assert.deepEqual(b, a);
});

test('realce "leve" estica contraste sem inverter tons', () => {
  const a = blank(64, 64, 180);
  rect(a, 64, 10, 10, 50, 20, [90, 90, 90]);
  enhance(a, 64, 64, 'leve');
  const bg = a[(40 * 64 + 5) * 4];
  const fg = a[(15 * 64 + 30) * 4];
  assert.ok(bg > fg + 100, `fundo ${bg} texto ${fg}`);
});
