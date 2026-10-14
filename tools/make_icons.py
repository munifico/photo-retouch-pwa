"""앱 아이콘 생성 (Pillow). 실행: python tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
BG = (20, 20, 22)
ACCENT = (255, 214, 10)


def draw(size: int) -> Image.Image:
    s = size * 4  # 4배로 그려서 축소 (안티에일리어싱)
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)
    c = s / 2
    # 보정 다이얼: 바깥 링 + 눈금 + 가운데 반쪽 원
    r = s * 0.30
    d.ellipse([c - r, c - r, c + r, c + r], outline=ACCENT, width=int(s * 0.035))
    r2 = s * 0.19
    d.pieslice([c - r2, c - r2, c + r2, c + r2], 90, 270, fill=ACCENT)
    tick_y0, tick_y1 = s * 0.80, s * 0.86
    for i in range(-4, 5):
        x = c + i * s * 0.05
        w = int(s * (0.014 if i else 0.022))
        y0 = tick_y0 - (s * 0.02 if i == 0 else 0)
        d.rectangle([x - w / 2, y0, x + w / 2, tick_y1], fill=ACCENT if i == 0 else (150, 150, 150))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    draw(192).save(OUT / "icon-192.png")
    draw(512).save(OUT / "icon-512.png")
    draw(180).save(OUT / "apple-touch-icon.png")
    print("ok", OUT)
