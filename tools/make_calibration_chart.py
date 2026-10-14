"""보정(캘리브레이션)용 차트 생성. 실행: python tools/make_calibration_chart.py

아이폰 사진 앱에서 슬라이더 하나만 바꿔 저장한 결과와 PWA 결과를 비교해 adjustments.js 의 UI_SCALE/COEF 를 맞춘다.
게인맵 없는 SDR PNG 여야 아이폰이 SDR 경로(CISmartTone 등)를 탄다.
영역 좌표는 analyze 스크립트가 그대로 쓰므로 바꾸면 같이 고칠 것.
"""
import random
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "test" / "calibration"
W, H = 2048, 1536

# 색 패치 (sRGB 8비트)
PATCHES = [
    ("red", (220, 40, 40)), ("green", (40, 200, 60)), ("blue", (40, 60, 220)), ("cyan", (60, 200, 210)),
    ("magenta", (210, 60, 200)), ("yellow", (230, 210, 50)), ("gray118", (118, 118, 118)), ("skin", (224, 172, 140)),
    ("skin_dark", (141, 85, 36)), ("warm_low", (140, 130, 120)), ("cool_low", (120, 130, 140)), ("sky", (90, 150, 230)),
    ("grass", (60, 120, 50)), ("orange", (230, 140, 40)), ("purple", (130, 70, 170)), ("white245", (245, 245, 245)),
]
HUES = [(255, 60, 60), (60, 200, 60), (60, 110, 255), (240, 160, 40)]  # 채도 램프용


def chart() -> Image.Image:
    im = Image.new("RGB", (W, H), (128, 128, 128))
    d = ImageDraw.Draw(im)
    # A. 회색 램프 0~255 (8px × 256) y 0~300
    for v in range(256):
        d.rectangle([v * 8, 0, v * 8 + 7, 299], fill=(v, v, v))
    # B. 색 패치 16개 (128×400) y 300~700
    for i, (_, c) in enumerate(PATCHES):
        d.rectangle([i * 128, 300, i * 128 + 127, 699], fill=c)
    # C-왼쪽. 선명도용: 1/2/4px 줄무늬, 체커, 사선 경계 y 700~1100, x 0~1024
    for x in range(0, 340):
        g = 100 if (x // 1) % 2 else 160
        d.line([x, 700, x, 899], fill=(g, g, g))
    for x in range(340, 680):
        g = 100 if (x // 2) % 2 else 160
        d.line([x, 700, x, 899], fill=(g, g, g))
    for x in range(680, 1024):
        g = 100 if (x // 4) % 2 else 160
        d.line([x, 700, x, 899], fill=(g, g, g))
    for y in range(900, 1100, 8):
        for x in range(0, 512, 8):
            if (x // 8 + y // 8) % 2:
                d.rectangle([x, y, x + 7, y + 7], fill=(90, 90, 90))
            else:
                d.rectangle([x, y, x + 7, y + 7], fill=(170, 170, 170))
    d.polygon([(512, 1100), (1024, 900), (1024, 1100)], fill=(200, 200, 200))
    d.polygon([(512, 900), (1024, 900), (512, 1100)], fill=(60, 60, 60))
    # C-오른쪽. 노이즈 패치 (128 ± 노이즈) y 700~1100, x 1024~2048
    rnd = random.Random(7)
    px = im.load()
    for y in range(700, 1100):
        for x in range(1024, 2048):
            g = max(0, min(255, round(128 + rnd.gauss(0, 8))))
            px[x, y] = (g, g, g)
    # D. 채도 램프: 색상 4개 × 채도 8단계 (회색 128 → 원색) y 1100~1536
    for hi, hue in enumerate(HUES):
        for si in range(8):
            t = si / 7
            c = tuple(round(128 + (h - 128) * t) for h in hue)
            x0, y0 = si * 256, 1100 + hi * 109
            d.rectangle([x0, y0, x0 + 255, y0 + 108], fill=c)
    return im


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    chart().save(OUT / "chart.png", optimize=True)
    Image.new("RGB", (W, H), (128, 128, 128)).save(OUT / "gray.png", optimize=True)  # 비네트용
    print("ok", OUT)
