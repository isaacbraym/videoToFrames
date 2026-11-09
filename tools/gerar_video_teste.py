"""Gera um vídeo sintético que imita o celular filmando a tela do notebook.

Inclui: perspectiva, tremor de mão, desfoque de movimento, ruído, exposição
variando, cursor do mouse, mão passando na frente, reflexo, rolagem de página,
alternativa marcada no meio de uma questão e retorno a uma questão já vista.

Uso:  python tools/gerar_video_teste.py [saida.mp4] [--rapido]
Saída: o vídeo + <saida>.gabarito.json com os trechos esperados.
Requer: numpy, opencv-python, pillow e ffmpeg no PATH.
"""

import json
import math
import random
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = next((a for a in sys.argv[1:] if not a.startswith("--")), "tests/fixtures/sintetico.mp4")
FAST = "--rapido" in sys.argv
FW, FH = (1280, 720) if FAST else (1920, 1080)
FPS = 30
SW, SH = 1366, 768  # resolução da tela do notebook
rng = random.Random(7)
nrng = np.random.default_rng(7)


def font(size, bold=False):
    names = ["arialbd.ttf" if bold else "arial.ttf", "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"]
    for n in names:
        for base in ["C:/Windows/Fonts/", "/usr/share/fonts/truetype/dejavu/", ""]:
            try:
                return ImageFont.truetype(base + n, size)
            except OSError:
                pass
    return ImageFont.load_default()


F_TITLE, F_TEXT, F_ALT, F_NAV = font(30, True), font(21), font(20), font(18, True)
WORDS = (
    "a o de que em para com uma um os as do da no na por mais sobre como entre sistema processo "
    "análise dados função valor resultado questão alternativa correta incorreta afirmativa considere "
    "seguinte texto lei artigo princípio administração pública servidor competência norma regra "
    "exceção prazo recurso decisão órgão poder federal estadual municipal contrato licitação "
    "rede protocolo memória algoritmo variável matriz probabilidade evento amostra média"
).split()


def sentence(n):
    w = [rng.choice(WORDS) for _ in range(n)]
    w[0] = w[0].capitalize()
    return " ".join(w) + "."


def wrap(draw, text, fnt, width):
    lines, cur = [], ""
    for word in text.split():
        test = (cur + " " + word).strip()
        if draw.textlength(test, font=fnt) > width:
            lines.append(cur)
            cur = word
        else:
            cur = test
    if cur:
        lines.append(cur)
    return lines


def render_page(num, statement_sentences=4, selected=None, height=SH):
    img = Image.new("RGB", (SW, height), (250, 250, 250))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, SW, 56], fill=(26, 115, 232))
    d.text((24, 16), "Banco de Questões  •  Simulado", font=F_NAV, fill=(255, 255, 255))
    d.text((24, 80), f"Questão {num} de 10", font=F_TITLE, fill=(20, 20, 20))
    y = 132
    text = " ".join(sentence(rng.randint(9, 16)) for _ in range(statement_sentences))
    for line in wrap(d, text, F_TEXT, SW - 80):
        d.text((40, y), line, font=F_TEXT, fill=(35, 35, 35))
        y += 31
    y += 18
    for k, letter in enumerate("ABCDE"):
        if selected == k:
            d.rectangle([30, y - 6, SW - 30, y + 34], fill=(210, 228, 252))
        cx, cy = 52, y + 13
        d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], outline=(60, 60, 60), width=2)
        if selected == k:
            d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=(26, 115, 232))
        d.text((75, y), f"{letter})  " + sentence(rng.randint(5, 10)), font=F_ALT, fill=(30, 30, 30))
        y += 48
    by = height - 64
    d.rectangle([40, by, 190, by + 40], outline=(26, 115, 232), width=2)
    d.text((70, by + 10), "Anterior", font=F_NAV, fill=(26, 115, 232))
    d.rectangle([SW - 190, by, SW - 40, by + 40], fill=(26, 115, 232))
    d.text((SW - 160, by + 10), "Próxima", font=F_NAV, fill=(255, 255, 255))
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


# ---- conteúdo por questão (fixa o texto antes de gerar a seleção) ----
pages = {}
for q in range(1, 11):
    state = rng.getstate()
    if q == 7:
        pages[q] = render_page(q, statement_sentences=16, height=1500)
    else:
        pages[q] = render_page(q)
    if q == 4:
        rng.setstate(state)
        pages["4sel"] = render_page(q, selected=2)
blank = np.full((SH, SW, 3), 250, np.uint8)

# ---- linha do tempo (segundos) ----
T = []  # (início, fim, chave, rótulo, esperado)


def add(a, b, key, label, expect):
    T.append((a, b, key, label, expect))


add(0.0, 8.0, 1, "Q1", "captura")
add(8.25, 16.0, 2, "Q2 (mão passa em 11.0–11.8)", "captura")
add(16.25, 23.0, 3, "Q3", "captura")
add(23.25, 29.0, 4, "Q4", "captura")
add(29.0, 35.0, "4sel", "Q4 com alternativa C marcada", "captura")
add(35.25, 43.0, 5, "Q5 (reflexo 36–40)", "captura")
add(43.25, 50.0, 6, "Q6", "captura")
add(50.25, 58.0, "7top", "Q7 topo", "captura")
add(59.0, 66.0, "7bot", "Q7 após rolagem", "captura")
add(66.25, 73.0, 8, "Q8 (tranco na câmera 69.0–69.6)", "captura")
add(73.25, 80.0, 9, "Q9", "captura")
add(80.25, 87.0, 10, "Q10", "captura")
add(87.25, 91.0, 3, "Q3 de novo", "repetida")
DUR = 91.0
SCROLL = (58.0, 59.0, 0, 1500 - SH)


def screen_at(t):
    if SCROLL[0] <= t < SCROLL[1]:
        f = (t - SCROLL[0]) / (SCROLL[1] - SCROLL[0])
        f = 0.5 - 0.5 * math.cos(math.pi * f)
        off = int(SCROLL[2] + f * (SCROLL[3] - SCROLL[2]))
        return pages[7][off : off + SH].copy()
    for a, b, key, _, _ in T:
        if a <= t < b:
            if key == "7top":
                return pages[7][:SH].copy()
            if key == "7bot":
                return pages[7][SCROLL[3] : SCROLL[3] + SH].copy()
            return pages[key].copy()
    return blank.copy()


# ---- cenário: parede, janela clara, mesa, moldura do notebook ----
s = FW / 1920
WW, WH = int(FW * 1.1), int(FH * 1.1)
world = np.zeros((WH, WW, 3), np.uint8)
grad = np.linspace(150, 120, WH).astype(np.uint8)[:, None]
world[:] = np.dstack([grad * 0.85, grad * 0.95, grad])  # parede bege
world[int(WH * 0.05) : int(WH * 0.45), int(WW * 0.86) :] = (235, 240, 245)  # janela clara
world[int(WH * 0.82) :] = (40, 55, 75)  # mesa
off = np.array([(WW - FW) / 2, (WH - FH) / 2])
quad = np.array([[300, 140], [1640, 175], [1615, 935], [330, 960]], np.float32) * s + off.astype(np.float32)
c = quad.mean(axis=0)
bezel = (c + (quad - c) * 1.07).astype(np.int32)
cv2.fillPoly(world, [bezel], (28, 28, 30))
H_screen = cv2.getPerspectiveTransform(np.float32([[0, 0], [SW, 0], [SW, SH], [0, SH]]), quad.astype(np.float32))

noise_bank = [nrng.normal(0, 1.6, (FH, FW, 3)).astype(np.float32) for _ in range(6)]

# ---- câmera: tremor (processo de Ornstein-Uhlenbeck) + trancos ----
pos = np.zeros(3)  # dx, dy, ângulo (graus)
vel = np.zeros(3)


def jolts(t):
    k = 0.0
    if t < 1.0:
        k = 6.0 * (1 - t)  # ajeitando o celular no começo
    for a in (69.0,):
        if a <= t < a + 0.6:
            k = 7.0
    for a, *_ in T[1:]:
        if a - 0.35 <= t < a:
            k = max(k, 1.5)
    return k


proc = subprocess.Popen(
    [
        "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{FW}x{FH}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "23", "-pix_fmt", "yuv420p", "-g", "30", "-movflags", "+faststart", OUT,
    ],
    stdin=subprocess.PIPE,
)

nframes = int(DUR * FPS)
cursor = np.array([700.0, 400.0])
cursor_target = np.array([900.0, 500.0])
for i in range(nframes):
    t = i / FPS
    # tremor
    k = jolts(t)
    vel = 0.85 * vel - 0.04 * pos + np.array([0.45, 0.45, 0.02]) * nrng.normal(size=3) * (1 + k)
    pos = pos + vel
    # tela + cursor
    scr = screen_at(t)
    if np.linalg.norm(cursor_target - cursor) < 10:
        cursor_target = np.array([rng.uniform(100, SW - 100), rng.uniform(80, SH - 80)])
    cursor += (cursor_target - cursor) * 0.06
    cx, cy = cursor.astype(int)
    tri = np.array([[cx, cy], [cx, cy + 22], [cx + 6, cy + 17], [cx + 15, cy + 16]], np.int32)
    cv2.fillPoly(scr, [tri], (0, 0, 0))
    cv2.polylines(scr, [tri], True, (255, 255, 255), 1)
    # mundo
    frame_w = world.copy()
    warped = cv2.warpPerspective(scr, H_screen, (WW, WH), flags=cv2.INTER_AREA)
    mask = cv2.warpPerspective(np.full((SH, SW), 255, np.uint8), H_screen, (WW, WH))
    frame_w[mask > 128] = warped[mask > 128]
    # câmera: rotação + translação + leve zoom
    M = cv2.getRotationMatrix2D((WW / 2, WH / 2), pos[2], 1.0 + 0.002 * pos[1])
    M[0, 2] += pos[0] - off[0]
    M[1, 2] += pos[1] - off[1]
    frame = cv2.warpAffine(frame_w, M, (FW, FH), flags=cv2.INTER_LINEAR)
    # reflexo
    if 36.0 <= t < 40.0:
        g = np.zeros((FH, FW), np.float32)
        gx = int(FW * (0.35 + 0.05 * (t - 36)))
        cv2.ellipse(g, (gx, int(FH * 0.45)), (int(160 * s), int(110 * s)), 20, 0, 360, 1.0, -1)
        g = cv2.GaussianBlur(g, (0, 0), 40 * s)
        frame = np.clip(frame.astype(np.float32) + 170 * g[..., None], 0, 255).astype(np.uint8)
    # mão passando
    if 11.0 <= t < 11.8:
        f = (t - 11.0) / 0.8
        hx = int(FW * (1.1 - 1.4 * f))
        hy = int(FH * 0.62)
        cv2.ellipse(frame, (hx, hy), (int(170 * s), int(120 * s)), -15, 0, 360, (120, 150, 200), -1)
        cv2.rectangle(frame, (hx, hy - int(70 * s)), (hx + int(600 * s), hy + int(80 * s)), (115, 145, 195), -1)
    # desfoque de movimento proporcional à velocidade
    speed = float(np.hypot(vel[0], vel[1]))
    if speed > 1.2:
        L = min(31, int(speed * 1.6) | 1)
        ker = np.zeros((L, L), np.float32)
        ang = math.atan2(vel[1], vel[0])
        for j in range(L):
            x = int(L // 2 + (j - L // 2) * math.cos(ang))
            y = int(L // 2 + (j - L // 2) * math.sin(ang))
            ker[y, x] = 1
        ker /= ker.sum()
        frame = cv2.filter2D(frame, -1, ker)
    # óptica + exposição + ruído
    frame = cv2.GaussianBlur(frame, (0, 0), 0.7)
    gain = 1.0 + 0.05 * math.sin(t / 7.0)
    f32 = frame.astype(np.float32) * gain + noise_bank[i % len(noise_bank)]
    proc.stdin.write(np.clip(f32, 0, 255).astype(np.uint8).tobytes())
    if i % 300 == 0:
        print(f"{t:5.1f}s / {DUR}s", flush=True)

proc.stdin.close()
proc.wait()
gab = {
    "video": OUT,
    "duracao": DUR,
    "trechos": [{"inicio": a, "fim": b, "rotulo": lab, "esperado": e} for a, b, _, lab, e in T],
    "capturas_esperadas": sum(1 for x in T if x[4] == "captura"),
}
with open(OUT + ".gabarito.json", "w", encoding="utf-8") as fh:
    json.dump(gab, fh, ensure_ascii=False, indent=2)
print("ok", OUT, gab["capturas_esperadas"], "capturas esperadas")
