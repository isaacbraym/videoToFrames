import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFeature, compareFeatures, sharpness, luminance, resizeArea, blur121 } from '../js/vision.js';
import { textPage, shift, gain, rect, blank } from './helpers.mjs';

const W = 640;
const H = 360;
const feat = (a) => makeFeature(a, W, H);

test('mesma imagem → nenhuma mudança', () => {
  const a = textPage(W, H, 1);
  const r = compareFeatures(feat(a), feat(a));
  assert.equal(r.global, 0);
  assert.equal(r.local, 0);
});

test('tremor da mão (translação) é compensado', () => {
  const a = textPage(W, H, 1);
  const b = shift(a, W, H, 7, -5);
  const r = compareFeatures(feat(a), feat(b));
  assert.ok(r.global < 0.01, `global=${r.global}`);
  assert.ok(r.local < 0.05, `local=${r.local}`);
});

test('exposição automática (ganho/offset) é compensada', () => {
  const a = textPage(W, H, 1);
  const b = gain(a, 0.85, 12);
  const r = compareFeatures(feat(a), feat(b));
  assert.ok(r.global < 0.01, `global=${r.global}`);
});

test('outra página de texto → mudança global grande', () => {
  const r = compareFeatures(feat(textPage(W, H, 1)), feat(textPage(W, H, 2)));
  assert.ok(r.global > 0.08, `global=${r.global}`);
});

test('mudança pequena e localizada (alternativa marcada) → local alto, global baixo', () => {
  const a = textPage(W, H, 1);
  const b = a.slice();
  rect(b, W, 60, 250, 260, 272, [180, 205, 245]); // faixa azul-clara de destaque
  rect(b, W, 40, 255, 52, 267, [20, 90, 220]); // "rádio" preenchido
  const r = compareFeatures(feat(a), feat(b));
  assert.ok(r.local > 0.15, `local=${r.local}`);
  assert.ok(r.global < 0.03, `global=${r.global}`);
});

test('nitidez cai com desfoque', () => {
  const Y = luminance(textPage(W, H, 3), W, H);
  const Yb = Y.slice();
  for (let k = 0; k < 4; k++) blur121(Yb, W, H);
  assert.ok(sharpness(Y, W, H) > 2 * sharpness(Yb, W, H));
});

test('resizeArea preserva a média', () => {
  const a = blank(100, 50, 200);
  rect(a, 100, 0, 0, 50, 50, [0, 0, 0]);
  const r = resizeArea(a, 100, 50, 10, 5);
  let s = 0;
  for (let i = 0; i < r.length; i += 4) s += r[i];
  assert.ok(Math.abs(s / 50 - 100) < 1);
});
