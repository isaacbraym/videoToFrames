// video-source.js — lê quadros do vídeo no navegador (decodificação nativa,
// com aceleração de hardware) usando <video> + canvas. O arquivo não é
// carregado inteiro na memória: o navegador lê do disco sob demanda.

function waitEvent(el, ok, fail, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Tempo esgotado aguardando o vídeo (${label || ok})`));
    }, ms);
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onFail = () => {
      cleanup();
      reject(videoError(el));
    };
    function cleanup() {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      if (fail) el.removeEventListener(fail, onFail);
    }
    el.addEventListener(ok, onOk, { once: true });
    if (fail) el.addEventListener(fail, onFail, { once: true });
  });
}

function videoError(video) {
  const code = video.error ? video.error.code : 0;
  if (code === 4 || code === 3) {
    return new Error(
      'Este navegador não consegue decodificar o vídeo. Se foi gravado no iPhone em HEVC, use o Safari ' +
        'ou mude em Ajustes › Câmera › Formatos para "Mais Compatível" (H.264).',
    );
  }
  return new Error('Não foi possível abrir o vídeo' + (code ? ` (código ${code})` : '') + '.');
}

export class BrowserVideoSource {
  constructor(video, url, ownsUrl) {
    this.video = video;
    this.url = url;
    this.ownsUrl = ownsUrl;
    this.duration = video.duration;
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.canvases = new Map();
    this.useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    this.rvfcMisses = 0;
    this.checkedFirstFrame = false;
  }

  size(longSide) {
    if (!longSide || longSide >= Math.max(this.width, this.height)) return { w: this.width, h: this.height };
    const s = longSide / Math.max(this.width, this.height);
    return { w: Math.round(this.width * s), h: Math.round(this.height * s) };
  }

  canvasFor(w, h) {
    const key = `${w}x${h}`;
    let c = this.canvases.get(key);
    if (!c) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      c = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
      // Redução com filtro de qualidade: o bilinear simples serrilha o texto e
      // cria "mudanças" falsas entre quadros.
      c.ctx.imageSmoothingEnabled = true;
      c.ctx.imageSmoothingQuality = 'high';
      this.canvases.set(key, c);
    }
    return c;
  }

  async seek(t) {
    const v = this.video;
    const target = Math.max(0, Math.min(this.duration - 0.001, t));
    if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) return;
    const seeked = waitEvent(v, 'seeked', 'error', 15000, 'posicionar');
    let frame = null;
    if (this.useRVFC) {
      frame = new Promise((resolve) => {
        const id = v.requestVideoFrameCallback(() => resolve(true));
        setTimeout(() => {
          try {
            v.cancelVideoFrameCallback(id);
          } catch {
            /* ignore */
          }
          resolve(false);
        }, 300);
      });
    }
    v.currentTime = target;
    await seeked;
    if (Math.abs(v.currentTime - target) > 0.75) {
      throw new Error(
        'O navegador não conseguiu posicionar o vídeo (busca sem suporte). Escolha o arquivo pelo botão "Escolher vídeo".',
      );
    }
    if (frame) {
      // Garante que o quadro novo já foi apresentado (Safari às vezes atrasa).
      // Se o navegador não dispara o callback com o vídeo pausado, desliga.
      if (await frame) this.rvfcMisses = 0;
      else if (++this.rvfcMisses >= 3) this.useRVFC = false;
    }
  }

  async grab(t, longSide = 0) {
    await this.seek(t);
    const { w, h } = this.size(longSide);
    const { ctx } = this.canvasFor(w, h);
    ctx.drawImage(this.video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    this.checkFrame(data);
    return { rgba: data, w, h };
  }

  checkFrame(data) {
    if (this.checkedFirstFrame) return;
    this.checkedFirstFrame = true;
    let max = 0;
    for (let i = 0; i < data.length; i += 4 * 97) max = Math.max(max, data[i], data[i + 1]);
    if (max === 0) {
      throw new Error('O navegador abriu o vídeo, mas devolveu quadros pretos. Tente outro navegador ou o formato H.264.');
    }
  }

  /**
   * Amostras em sequência. Preferência: reprodução acelerada (2×, sem som),
   * pegando os quadros conforme passam — bem mais rápido que posicionar o vídeo
   * a cada amostra (cada seek redecodifica desde o quadro-chave anterior).
   * Se o navegador parar de entregar quadros (aba em segundo plano, por
   * exemplo), continua de onde parou usando seek.
   */
  async *samples(times, longSide) {
    let idx = 0;
    if (this.playbackOk !== false) {
      const v = this.video;
      const { w, h } = this.size(longSide);
      const { ctx } = this.canvasFor(w, h);
      const queue = [];
      let done = false;
      let failed = false;
      let wake = null;
      let lastTime = -1;
      let lastProgressAt = performance.now();
      const notify = () => {
        if (wake) {
          const f = wake;
          wake = null;
          f();
        }
      };
      // Chamado a cada quadro apresentado (requestVideoFrameCallback, tempo exato)
      // e por um temporizador (navegadores/painéis que não disparam o callback).
      const tick = (mediaTime) => {
        if (done) return;
        const mt = mediaTime ?? v.currentTime;
        if (mt > lastTime + 1e-4) {
          lastTime = mt;
          lastProgressAt = performance.now();
        }
        if (idx < times.length && mt + 0.02 >= times[idx] && queue.length < 3) {
          ctx.drawImage(v, 0, 0, w, h);
          queue.push({ t: Math.round(mt * 1000) / 1000, rgba: ctx.getImageData(0, 0, w, h).data, w, h });
          while (idx < times.length && times[idx] <= mt + 0.02) idx++;
          if (queue.length >= 2 && !v.paused) v.pause(); // o processamento não acompanhou: espera
          notify();
        }
        if (idx >= times.length) {
          done = true;
          v.pause();
          notify();
        }
      };
      const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
      const onFrame = (_now, meta) => {
        tick(meta.mediaTime);
        if (!done) v.requestVideoFrameCallback(onFrame);
      };
      const onEnded = () => {
        done = true;
        notify();
      };
      await this.seek(times[0]);
      v.addEventListener('ended', onEnded);
      v.playbackRate = 2;
      if (hasRVFC) v.requestVideoFrameCallback(onFrame);
      const timer = setInterval(() => tick(), 15);
      try {
        await v.play();
      } catch {
        failed = true;
      }
      try {
        while (!failed) {
          if (queue.length) {
            const item = queue.shift();
            this.checkFrame(item.rgba);
            if (!done && v.paused && queue.length < 2) {
              lastProgressAt = performance.now();
              v.play().catch(() => {});
            }
            yield item;
            continue;
          }
          if (done) break;
          await new Promise((r) => {
            wake = r;
            setTimeout(r, 1000);
          });
          // reprodução travada (aba em segundo plano, decodificador ocupado…)
          if (!done && !queue.length && performance.now() - lastProgressAt > 2500) failed = true;
        }
      } finally {
        done = true;
        clearInterval(timer);
        v.pause();
        v.removeEventListener('ended', onEnded);
        v.playbackRate = 1;
      }
      if (!failed) return;
      this.playbackOk = false; // segue por seek a partir da próxima amostra
    }
    for (const t of times.slice(idx)) {
      const fr = await this.grab(t, longSide);
      yield { t, ...fr };
    }
  }

  dispose() {
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    if (this.ownsUrl) URL.revokeObjectURL(this.url);
    this.canvases.clear();
  }
}

/** Abre um File (ou URL, no modo de demonstração) e devolve a fonte de quadros. */
export async function openVideo(fileOrUrl) {
  if (typeof fileOrUrl === 'string') {
    // Modo demonstração: baixa como Blob para que a busca funcione mesmo em
    // servidores sem suporte a "Range" (e para se comportar como um arquivo local).
    const res = await fetch(fileOrUrl);
    if (!res.ok) throw new Error(`Não foi possível baixar o vídeo de demonstração (HTTP ${res.status}).`);
    fileOrUrl = await res.blob();
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  // Fica no DOM (o Safari do iOS só decodifica quadros de vídeos anexados).
  video.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(video);
  const ownsUrl = typeof fileOrUrl !== 'string';
  const url = ownsUrl ? URL.createObjectURL(fileOrUrl) : fileOrUrl;
  video.src = url;
  try {
    await waitEvent(video, 'loadedmetadata', 'error', 30000, 'metadados');
    if (!Number.isFinite(video.duration)) {
      // Alguns arquivos (ex.: WebM gravado no navegador) não informam a duração.
      video.currentTime = 1e9;
      await waitEvent(video, 'durationchange', 'error', 15000, 'duração');
      video.currentTime = 0;
    }
    if (video.readyState < 2) await waitEvent(video, 'loadeddata', 'error', 30000, 'primeiro quadro');
    if (!video.videoWidth || !video.videoHeight) throw new Error('O arquivo não tem uma faixa de vídeo legível.');
    // iOS: "destrava" a decodificação com play/pause silencioso.
    try {
      await video.play();
      video.pause();
    } catch {
      /* sem problema: autoplay bloqueado */
    }
  } catch (e) {
    video.remove();
    if (ownsUrl) URL.revokeObjectURL(url);
    throw e;
  }
  return new BrowserVideoSource(video, url, ownsUrl);
}

// ---- codificação/decodificação de imagens ----

let encCanvas = null;

export function encodeImage(rgba, w, h, type = 'image/jpeg', quality = 0.92) {
  if (!encCanvas) encCanvas = document.createElement('canvas');
  encCanvas.width = w;
  encCanvas.height = h;
  const ctx = encCanvas.getContext('2d');
  ctx.putImageData(new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba), w, h), 0, 0);
  return new Promise((resolve, reject) =>
    encCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar a imagem'))), type, quality),
  );
}

export async function decodeImage(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { rgba: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}
