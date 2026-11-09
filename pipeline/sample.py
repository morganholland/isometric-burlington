"""Pick training frames for one angle: spread over the whole map, a share along the shore,
never overlapping, deterministic for a seed."""
import json, random
from pathlib import Path
from shapely.geometry import shape, Point, box

ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024


def frames(angle, n, seed=1, shore_share=0.15, avoid=()):
    g = json.loads((ROOT / "data/grid.json").read_text())["angles"][angle]
    region = shape(g["region_px"])
    shore = region.boundary.buffer(1500).intersection(region)
    inner = region.buffer(-SIZE / 2)
    rng = random.Random(seed * 1000 + angle)
    taken = [box(x, y, x + SIZE, y + SIZE) for x, y in avoid]
    out = []

    def pick(area, k):
        minx, miny, maxx, maxy = area.bounds
        tries = 0
        while k > 0 and tries < 20000:
            tries += 1
            p = Point(rng.uniform(minx, maxx), rng.uniform(miny, maxy))
            if not area.contains(p) or not inner.buffer(SIZE).contains(p):
                continue
            x = int(round((p.x - SIZE / 2) / 64)) * 64
            y = int(round((p.y - SIZE / 2) / 64)) * 64
            b = box(x, y, x + SIZE, y + SIZE)
            if any(b.intersects(t) for t in taken):
                continue
            taken.append(b); out.append([x, y]); k -= 1

    pick(shore, round(n * shore_share))
    pick(region, n - len(out))
    return out


if __name__ == "__main__":
    for a in range(4):
        f = frames(a, 105)
        print(a, len(f), f[:3])
