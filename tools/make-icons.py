#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10"]
# ///
"""
PWA 圖示產生器 — 由 icon.svg 的幾何定義重繪為 PNG

    uv run --script tools/make-icons.py

**刻意不用 SVG→PNG 轉檔器**：cairosvg 在 Windows 需要系統 cairo DLL
（實測 `OSError: no library called "cairo-2"`），為了四張圖示要求開發機
裝 GTK 執行環境不划算。icon.svg 只有圓角矩形、圓、直線與六個小方塊，
用 Pillow 直接重畫即可，且不引入 repo 的執行期依賴。

**改 icon.svg 時要一併改這裡**——兩份幾何定義是分開的，會漂移。
漂移的後果只是圖示與網頁 favicon 長得不一樣，不影響功能，
但沒有測試會抓到，因此靠這行註解提醒。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"

# 與 index.html 的 CSS 變數同一組值
BG = "#F5F0E8"
ACCENT = "#3D7A8A"
BORDER = "#E0D9CE"
WHITE = "#FFFFFF"

BASE = 512          # icon.svg 的 viewBox
SS = 4              # 超取樣倍率，Pillow 沒有抗鋸齒，只能畫大再縮


def draw(size: int, *, maskable: bool = False) -> Image.Image:
    """依 icon.svg 的幾何重繪。maskable 版把內容縮到中央 80%（安全區）。"""
    px = size * SS
    img = Image.new("RGBA", (px, px), BG)
    d = ImageDraw.Draw(img)
    k = px / BASE                      # viewBox → 實際像素

    # maskable：內容縮小並置中，四角被裁掉也不會切到圖形
    scale, off = (0.8, px * 0.1) if maskable else (1.0, 0.0)

    def X(v: float) -> float:
        return off + v * k * scale

    def W(v: float) -> float:
        return v * k * scale

    if not maskable:
        # rx=96 的圓角矩形背景。maskable 由系統自行裁形，不畫圓角
        corner = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        ImageDraw.Draw(corner).rounded_rectangle(
            [0, 0, px - 1, px - 1], radius=W(96), fill=BG)
        img = corner
        d = ImageDraw.Draw(img)

    # 藥錠：白底、青色描邊的圓（cx256 cy212 r96 stroke-width18）
    d.ellipse([X(256 - 96), X(212 - 96), X(256 + 96), X(212 + 96)],
              fill=WHITE, outline=ACCENT, width=int(W(18)))
    # 中央刻痕（M256 116v192）
    d.line([X(256), X(116), X(256), X(308)], fill=ACCENT, width=int(W(18)))
    # 底線（M150 372h212）
    d.line([X(150), X(372), X(362), X(372)], fill=BORDER, width=int(W(14)))
    # 六個刻度，高度交錯 26／18
    for i, h in enumerate([26, 18, 26, 18, 26, 18]):
        x = 150 + i * 40
        d.rounded_rectangle([X(x), X(392), X(x + 6), X(392 + h)],
                            radius=W(3), fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    jobs = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
    ]
    for name, size, maskable in jobs:
        path = OUT / name
        img = draw(size, maskable=maskable)
        # apple-touch-icon 不支援透明，且 iOS 會自行加圓角
        img.convert("RGB").save(path, "PNG", optimize=True)
        print(f"{path.relative_to(ROOT)}  {size}x{size}  {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
