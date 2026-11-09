// Roda o mesmo pipeline do navegador em Node, usando ffmpeg para decodificar,
// e compara o resultado com o gabarito do vídeo sintético.
//
// Uso: node tools/calibrar.mjs tests/fixtures/sintetico.mp4 [--sens=normal] [--png=saida/]
// Requer ffmpeg/ffprobe no PATH.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runPipeline, formatTime } from '../js/pipeline.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
  }),
);
if (!file) {
  console.error('uso: node tools/calibrar.mjs <video> [--sens=normal] [--png=pasta/]');
  process.exit(1);
}

function probe(f) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(r.stdout);
  return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration) };
}

const info = probe(file);
const size = (long) => {
  if (!long) return { w: info.width, h: info.height };
  const s = long / Math.max(info.width, info.height);
  return { w: Math.round(info.width * s), h: Math.round(info.height * s) };
};

const source = {
  ...info,
  async *samples(times, long) {
    const { w, h } = size(long);
    const dt = times.length > 1 ? times[1] - times[0] : 1;
    const p = spawn('ffmpeg', [
      '-loglevel', 'error', '-ss', String(times[0]), '-i', file,
      '-vf', `fps=${1 / dt},scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ]);
    const frameBytes = w * h * 4;
    let buf = Buffer.alloc(0);
    let k = 0;
    for await (const chunk of p.stdout) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameBytes && k < times.length) {
        const rgba = new Uint8ClampedArray(buf.subarray(0, frameBytes));
        buf = buf.subarray(frameBytes);
        yield { t: times[k++], rgba, w, h };
      }
    }
  },
  async grab(t, long) {
    const { w, h } = size(long);
    const r = spawnSync(
      'ffmpeg',
      ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area`,
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      { maxBuffer: w * h * 4 + 1024 },
    );
    return { rgba: new Uint8ClampedArray(r.stdout), w, h };
  },
};

const pngDir = typeof opt.png === 'string' ? opt.png : null;
if (pngDir && !existsSync(pngDir)) mkdirSync(pngDir, { recursive: true });
let encCount = 0;
const hooks = {
  progress: (() => {
    let last = '';
    return (phase, frac) => {
      const s = `${phase} ${Math.floor(frac * 10) * 10}%`;
      if (s !== last) process.stderr.write(s + '  \r');
      last = s;
    };
  })(),
  async encode(rgba, w, h, kind) {
    if (!pngDir || kind !== 'final') return null;
    const name = `${pngDir}/cap_${String(++encCount).padStart(2, '0')}.png`;
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-', name], {
      input: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    });
    return name;
  },
};

const res = await runPipeline(source, { sensitivity: opt.sens || 'normal', enhance: opt.realce || 'leve' }, hooks);
process.stderr.write('\n');
console.log(`amostras: ${res.stats.samples}  tempo: ${res.stats.seconds.toFixed(1)} s  trechos: ${res.segments.length}`);
for (const c of res.captures) {
  console.log(
    `${c.deleted ? '  [removida]' : '  captura  '} ${formatTime(c.t)} (t=${c.t.toFixed(2)}) trecho ${c.segStart.toFixed(1)}–${c.segEnd.toFixed(1)}` +
      ` ${c.w}x${c.h} quad=${c.quad ? 'sim' : 'não'} q=${c.quality.toFixed(2)} ${c.image ?? ''} ${c.reason ?? ''}`,
  );
}

const gabFile = file + '.gabarito.json';
if (existsSync(gabFile)) {
  const gab = JSON.parse(readFileSync(gabFile, 'utf8'));
  const kept = res.captures.filter((c) => !c.deleted);
  let ok = 0;
  const used = new Set();
  console.log('\nGabarito:');
  for (const tr of gab.trechos) {
    const inside = res.captures.filter((c) => c.t >= tr.inicio && c.t < tr.fim);
    const keptInside = inside.filter((c) => !c.deleted);
    keptInside.forEach((c) => used.add(c));
    let status;
    if (tr.esperado === 'captura') {
      status = keptInside.length === 1 ? 'OK' : keptInside.length === 0 ? 'FALTOU' : `EXCESSO(${keptInside.length})`;
    } else {
      status = keptInside.length === 0 ? 'OK' : 'NÃO REMOVIDA';
    }
    if (status === 'OK') ok++;
    console.log(`  ${status.padEnd(12)} ${tr.inicio.toFixed(2)}–${tr.fim.toFixed(2)}  ${tr.rotulo}`);
  }
  const extras = kept.filter((c) => !used.has(c));
  console.log(`\nAcertos: ${ok}/${gab.trechos.length}   capturas mantidas: ${kept.length} (esperado ${gab.capturas_esperadas})   fora de trecho: ${extras.length}`);
}
if (opt.timeline) writeFileSync(opt.timeline, JSON.stringify(res.timeline));
