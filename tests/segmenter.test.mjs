import test from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter, paramsFor, compareContent, isSameContent, isChanged } from '../js/segmenter.js';
import { planSampleTimes, describeFrame } from '../js/pipeline.js';
import { textPage, shift, rect } from './helpers.mjs';

const W = 640;
const H = 360;

function sample(t, rgba) {
  return { t, ...describeFrame(rgba, W, H) };
}

test('conteúdo: mesma página com tremor = igual; outra página = mudou', () => {
  const P = paramsFor('normal');
  const A = describeFrame(textPage(W, H, 5), W, H);
  const A2 = describeFrame(shift(textPage(W, H, 5), W, H, 6, -4), W, H);
  const B = describeFrame(textPage(W, H, 6), W, H);
  assert.ok(isSameContent(compareContent(A, A2), P));
  assert.ok(isChanged(compareContent(A, B), P));
});

function run(frames, dt = 0.25) {
  const seg = new Segmenter(paramsFor('normal'), dt);
  frames.forEach((f, i) => seg.push(sample(i * dt, f)));
  return seg.finish();
}

test('duas páginas → dois trechos, mesmo com tremor', () => {
  const A = textPage(W, H, 11);
  const B = textPage(W, H, 12);
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push(shift(A, W, H, (i % 3) - 1, (i % 2) * 2));
  frames.push(shift(B, W, H, 15, 9)); // transição com tranco
  for (let i = 0; i < 12; i++) frames.push(shift(B, W, H, -(i % 2), i % 3));
  const segs = run(frames);
  assert.equal(segs.length, 2);
  assert.ok(segs[0].best.t < 3 && segs[1].best.t > 3);
});

test('alternativa marcada no meio → trecho adicional', () => {
  const A = textPage(W, H, 21);
  const A2 = A.slice();
  rect(A2, W, 60, 250, 300, 272, [180, 205, 245]);
  rect(A2, W, 40, 255, 52, 267, [20, 90, 220]);
  const frames = [...Array(10).fill(A), ...Array(10).fill(A2)];
  assert.equal(run(frames).length, 2);
});

test('obstrução passageira (A-B-A curto) não gera captura extra', () => {
  const A = textPage(W, H, 31);
  const hand = A.slice();
  rect(hand, W, 200, 100, 640, 360, [190, 150, 120]);
  const frames = [...Array(12).fill(A), ...Array(4).fill(hand), ...Array(12).fill(A)];
  assert.equal(run(frames).length, 1);
});

test('conteúdo sempre em movimento → nenhum trecho', () => {
  const frames = [];
  for (let i = 0; i < 20; i++) frames.push(textPage(W, H, 100 + i));
  assert.equal(run(frames).length, 0);
});

test('amostragem: 4/s até 5 min, limitada depois', () => {
  assert.equal(planSampleTimes(60).times.length, 240);
  const long = planSampleTimes(1800);
  assert.ok(long.times.length <= 2701 && long.times.length >= 2600);
});
