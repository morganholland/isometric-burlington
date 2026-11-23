#!/usr/bin/env python3
"""Cut full-resolution (level-0, 1 map px = 1 image px) pictures for viewer/how.html.

Fetches 512 px level-0 tiles from the public R2 bucket and (for the drag-to-compare pair)
the matching 4096 px raw Google render block, crops cleanly with zero scaling on the 2x
image, and writes both 2x and 1x WebP files into viewer/press/.
"""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
import math
import sys
import urllib.request
from PIL import Image

TILE_BASE = "https://pub-9c551c98dab048f484c2c7e896e92cc0.r2.dev"
T = 512
OUT = Path(__file__).resolve().parent.parent / "viewer" / "press"
CACHE = Path("/tmp/iso-burlington-tiles")
CACHE.mkdir(parents=True, exist_ok=True)


def fetch(rel: str) -> bytes:
    p = CACHE / rel
    if p.exists():
        return p.read_bytes()
    p.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(f"{TILE_BASE}/{rel}", headers={"User-Agent": "isometric-burlington/about"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    p.write_bytes(data)
    return data


def stitch_level0(angle: int, x0: int, y0: int, w: int, h: int) -> Image.Image:
    """Stitch level-0 tiles covering [x0, x0+w) x [y0, y0+h) at native 1:1 resolution."""
    tx0, tx1 = math.floor(x0 / T), math.floor((x0 + w - 1) / T)
    ty0, ty1 = math.floor(y0 / T), math.floor((y0 + h - 1) / T)
    coords = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]

    def get_tile(c):
        tx, ty = c
        data = fetch(f"map-v1/a{angle}/0/{tx}/{ty}.webp")
        return tx, ty, Image.open(BytesIO(data)).convert("RGB")

    canvas = Image.new("RGB", ((tx1 - tx0 + 1) * T, (ty1 - ty0 + 1) * T))
    with ThreadPoolExecutor(max_workers=8) as ex:
        for tx, ty, im in ex.map(get_tile, coords):
            canvas.paste(im, ((tx - tx0) * T, (ty - ty0) * T))
    ox, oy = x0 - tx0 * T, y0 - ty0 * T
    return canvas.crop((ox, oy, ox + w, oy + h))


def save_pair(im_2x: Image.Image, stem: str, quality: int = 84):
    """Save 2x (native) and 1x (half size) WebP files, keeping each well under 500 KB."""
    w2, h2 = im_2x.size
    w1, h1 = w2 // 2, h2 // 2
    p2 = OUT / f"{stem}.webp"
    p1 = OUT / f"{stem}-1x.webp"
    q = quality
    while q >= 68:
        im_2x.save(p2, "WEBP", quality=q, method=6)
        if p2.stat().st_size <= 460_000:
            break
        q -= 4
    im_1x = im_2x.resize((w1, h1), Image.LANCZOS)
    im_1x.save(p1, "WEBP", quality=min(q + 2, 86), method=6)
    print(f"{stem:26s} 2x={w2}x{h2} ({p2.stat().st_size/1024:5.1f} KB, q={q})  1x={w1}x{h1} ({p1.stat().st_size/1024:5.1f} KB)")


def cut_centered(angle: int, cx: int, cy: int, w: int, h: int, stem: str, quality: int = 84):
    im = stitch_level0(angle, cx - w // 2, cy - h // 2, w, h)
    save_pair(im, stem, quality=quality)


def cut_compare(angle: int, bx: int, by: int, ox: int, oy: int, w: int, h: int):
    """Cut pixel-identical raw Google render + level-0 drawn crop from block (bx, by)."""
    assert 0 <= ox and ox + w <= 4096 and 0 <= oy and oy + h <= 4096
    raw = Image.open(BytesIO(fetch(f"renders/a{angle}/{bx}_{by}.png"))).convert("RGB")
    raw_crop = raw.crop((ox, oy, ox + w, oy + h))
    drawn_crop = stitch_level0(angle, bx + ox, by + oy, w, h)
    save_pair(raw_crop, "compare-google", quality=84)
    save_pair(drawn_crop, "compare-drawn", quality=84)


def main():
    # Feature close-ups (1440x900 2x = 1:1 map pixels, 720x450 1x)
    # 1. Church Street Marketplace (hero, Angle 3 looking north straight up the brick mall toward the Unitarian Church)
    cut_centered(3, -208, -1220, 1440, 900, "about-church-street")
    # 2. The waterfront (before & after compare: Waterfront Park, marina, Boathouse & ECHO)
    #    Block (-4096, 0) covers x in [-4096, 0), y in [0, 4096).
    cut_compare(0, -4096, 0, 2400, 1050, 1440, 900)
    # 3. City Hall Park & downtown blocks
    cut_centered(0, -240, 140, 1440, 900, "about-city-hall-park")
    # 4. UVM's green (Ira Allen Chapel, Billings Library, Old Mill & University Green)
    cut_centered(0, -1450, -2600, 1440, 900, "about-uvm-green")
    # 5. Winooski's rotary (roundabout, downtown, Champlain Mill & Winooski Falls)
    cut_centered(0, -7200, -4680, 1440, 900, "about-winooski-rotary")

    # Change-log clickable thumbnails (480x300 2x = 1:1 map pixels, 240x150 1x)
    # Nov 23: Amtrak train at Union Station
    cut_centered(0, 60, 1260, 480, 300, "log-amtrak")
    # Nov 23: Waterfront moments (fireworks / Champ / snow)
    cut_centered(0, -1350, 1650, 480, 300, "log-moments")
    # Nov 13: Downtown streets (cars & night lights) at #a=0&x=-773&y=216
    cut_centered(0, -773, 216, 480, 300, "log-night")
    # Nov 11: Church Street up close (Angle 3 brick pedestrian mall)
    cut_centered(3, -208, -650, 480, 300, "log-church-st")
    # Nov 10: Launch view (Waterfront Boathouse & marina)
    cut_centered(0, -560, 1760, 480, 300, "log-launch")
    # Nov 9: First test pictures (UVM Billings Library & Ira Allen Chapel)
    cut_centered(0, -1650, -2580, 480, 300, "log-first-tests")


if __name__ == "__main__":
    main()
