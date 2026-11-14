"""Street names and area names for the map -> viewer/labels.json.

The viewer draws these as crisp text on top of the drawing, so names stay sharp however far in you zoom.

usage: python3 pipeline/labels.py [out.json]

Streets and areas come from OpenStreetMap (Overpass). Every point gets a ground height so it lands on the
drawn road: bare-earth terrain (AWS Terrain Tiles, USGS 3DEP here) converted to ellipsoid height, then
shifted so it agrees with the road heights the bus routes were measured at (viewer/transit.json).

Buildings (OpenStreetMap footprints, with a guessed height where none is tagged) mark the stretches of
each street that a building stands in front of in each of the four views, so names are not drawn on roofs.

Output (compact):
  {"streets": [[name, rank, [[lat, lon, h], ...], hidden], ...],   # rank 0 = main road ... 3 = side street;
                                                    # hidden[angle] = flat [p0, p1, ...] ranges of the line
                                                    # (p = point index + fraction) that buildings cover
   "areas":   [[name, kind, lat, lon, h], ...],              # kind: water | park | hood
   "places":  [[name, note, lat, lon, h], ...]}              # hand-picked, from data/places.json
"""
import io, json, math, statistics, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BBOX = (44.40, -73.31, 44.54, -73.13)           # south, west, north, east
GEOID_M = -29.3                                 # orthometric -> ellipsoid height here (same as transit.py)
DEM_Z = 14
CACHE = ROOT / "runs" / "labels-cache"
OVERPASS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter"]
RANK = {"motorway": 0, "trunk": 0, "primary": 0, "secondary": 1, "tertiary": 2,
        "residential": 3, "unclassified": 3, "living_street": 3, "pedestrian": 2}


def get(url, data=None, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "isometric-map-labels/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print("  retry", url[:60], e, file=sys.stderr)
            time.sleep(5 + 10 * i)


def overpass(name, query, out="out geom;", bbox=BBOX):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{name}.json"
    if f.exists():
        return json.loads(f.read_text())
    s, w, n, e = bbox
    q = f"[out:json][timeout:170];({query.replace('BBOX', f'{s},{w},{n},{e}')});{out}"
    for url in OVERPASS:
        try:
            raw = get(url, urllib.parse.urlencode({"data": q}).encode(), tries=4)
            d = json.loads(raw)
            f.write_text(json.dumps(d))
            return d
        except Exception as ex:  # noqa: BLE001
            print("  overpass failed at", url, ex, file=sys.stderr)
    raise SystemExit("no Overpass server answered")


# ---------- terrain ----------
_tiles = {}


def tile(x, y):
    if (x, y) not in _tiles:
        f = CACHE / f"dem-{DEM_Z}-{x}-{y}.png"
        if not f.exists():
            f.write_bytes(get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{DEM_Z}/{x}/{y}.png"))
        _tiles[(x, y)] = Image.open(io.BytesIO(f.read_bytes())).convert("RGB").load()
    return _tiles[(x, y)]


def elev(lat, lon):
    """Bare-earth height above sea level (m), bilinear."""
    n = 2 ** DEM_Z
    fx = (lon + 180) / 360 * n * 256
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n * 256
    def px(X, Y):
        r, g, b = tile(X // 256, Y // 256)[X % 256, Y % 256]
        return r * 256 + g + b / 256 - 32768
    x0, y0 = int(fx - .5), int(fy - .5)
    tx, ty = fx - .5 - x0, fy - .5 - y0
    return ((px(x0, y0) * (1 - tx) + px(x0 + 1, y0) * tx) * (1 - ty) +
            (px(x0, y0 + 1) * (1 - tx) + px(x0 + 1, y0 + 1) * tx) * ty)


# ---------- geometry ----------
def xy(p):
    return p[1] * 111320 * math.cos(math.radians(44.47)), p[0] * 110950


def rdp(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (ax, ay), (bx, by) = xy(pts[i]), xy(pts[j])
        L = math.hypot(bx - ax, by - ay) or 1e-9
        best, bk = 0, None
        for k in range(i + 1, j):
            px, py = xy(pts[k])
            d = abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L
            if d > best:
                best, bk = d, k
        if bk is not None and best > tol:
            keep[bk] = True
            stack += [(i, bk), (bk, j)]
    return [p for p, k in zip(pts, keep) if k]


def chain(ways):
    """Join ways of one street that share end nodes into longer lines."""
    lines = [list(w) for w in ways]
    merged = True
    while merged:
        merged = False
        for i in range(len(lines)):
            for j in range(i + 1, len(lines)):
                a, b = lines[i], lines[j]
                if a[-1] == b[0]: lines[i] = a + b[1:]
                elif a[-1] == b[-1]: lines[i] = a + b[::-1][1:]
                elif a[0] == b[-1]: lines[i] = b + a[1:]
                elif a[0] == b[0]: lines[i] = b[::-1] + a[1:]
                else: continue
                del lines[j]; merged = True; break
            if merged:
                break
    return lines


def length(line):
    return sum(math.dist(xy(a), xy(b)) for a, b in zip(line, line[1:]))


# ---------- buildings in front of streets ----------
SIN30, COS30, PIX = 0.5, math.cos(math.radians(30)), 0.23
HEADINGS = [90, 180, 270, 0]


def enu(lat, lon, h):
    """Local flat approximation of geo.js's ENU around the map origin (good to well under a pixel's worth
    of occlusion accuracy here)."""
    return ((lon + 73.2121) * 111320 * math.cos(math.radians(44.4759)), (lat - 44.4759) * 111132, h)


def to_px(a, e, n, u):
    h = math.radians(HEADINGS[a])
    r = e * math.cos(h) - n * math.sin(h)
    f = e * math.sin(h) + n * math.cos(h)
    return r / PIX, -(f * SIN30 + u * COS30) / PIX


def hull(pts):
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def inside(poly, x, y):
    c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i - 1], poly[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def building_height(t, area):
    if "height" in t:
        try: return float(t["height"].split()[0])
        except ValueError: pass
    if "building:levels" in t:
        try: return float(t["building:levels"]) * 3.2 + 1.5
        except ValueError: pass
    kind = t.get("building", "yes")
    if kind in ("garage", "garages", "shed", "carport", "roof", "hut"): return 3.0
    if kind in ("house", "detached", "semidetached_house", "residential", "bungalow"): return 8.0
    return 16.0 if area > 2500 else 12.0 if area > 600 else 8.5


class Occluders:
    CELL = 256

    def __init__(self, ways, H):
        self.grid = [defaultdict(list) for _ in range(4)]
        n = 0
        for w in ways:
            g = w.get("geometry")
            if not g or len(g) < 4:
                continue
            ring = [enu(p["lat"], p["lon"], 0)[:2] for p in g]
            area = abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))) / 2
            if area < 25:
                continue
            cla = sum(p["lat"] for p in g) / len(g); clo = sum(p["lon"] for p in g) / len(g)
            base = H(cla, clo); top = base + building_height(w.get("tags", {}), area)
            for a in range(4):
                pts = [to_px(a, e, nn, base) for e, nn in ring] + [to_px(a, e, nn, top) for e, nn in ring]
                poly = hull([(round(x, 1), round(y, 1)) for x, y in pts])
                xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
                bb = (min(xs), min(ys), max(xs), max(ys))
                for cx in range(int(bb[0] // self.CELL), int(bb[2] // self.CELL) + 1):
                    for cy in range(int(bb[1] // self.CELL), int(bb[3] // self.CELL) + 1):
                        self.grid[a][(cx, cy)].append((bb, poly))
            n += 1
        print(f"{n} buildings as occluders")

    def hidden(self, a, x, y):
        for bb, poly in self.grid[a].get((int(x // self.CELL), int(y // self.CELL)), ()):
            if bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3] and inside(poly, x, y):
                return True
        return False

    def ranges(self, line):
        """For each view, the stretches of a [[lat, lon, h], ...] line hidden behind buildings."""
        out = [[] for _ in range(4)]
        for a in range(4):
            run = None
            for i in range(len(line) - 1):
                (la0, lo0, h0), (la1, lo1, h1) = line[i], line[i + 1]
                seg = math.dist(xy((la0, lo0)), xy((la1, lo1)))
                k = max(1, int(seg / 3))                   # a sample every ~3 m
                for j in range(k + (i == len(line) - 2)):
                    t = j / k
                    x, y = to_px(a, *enu(la0 + (la1 - la0) * t, lo0 + (lo1 - lo0) * t, h0 + (h1 - h0) * t))
                    p, half = i + t, 0.5 / k              # each sample stands for ~3 m of street
                    if self.hidden(a, x, y):
                        if run is None: run = [max(0, p - half), p]
                        run[1] = min(len(line) - 1, p + half)
                    elif run is not None:
                        out[a] += [round(run[0], 3), round(run[1], 3)]; run = None
            if run is not None:
                out[a] += [round(run[0], 3), round(run[1], 3)]
        return out


def main(out):
    roads = overpass("roads", 'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)$"]["name"](BBOX);')
    areas = overpass("areas", 'nwr["place"~"^(suburb|neighbourhood|quarter)$"]["name"](BBOX);'
                              'way["leisure"="park"]["name"](BBOX);relation["leisure"="park"]["name"](BBOX);'
                              'relation["natural"="water"]["name"](BBOX);way["natural"="water"]["name"](BBOX);',
                      out="out tags center bb;")
    river_ways = overpass("rivers", 'way["waterway"="river"]["name"](BBOX);')

    by = defaultdict(list); rank = {}
    for w in roads["elements"]:
        if w["type"] != "way" or "geometry" not in w:
            continue
        nm = w["tags"]["name"]
        by[nm].append([(round(g["lat"], 6), round(g["lon"], 6)) for g in w["geometry"]])
        rank[nm] = min(rank.get(nm, 9), RANK[w["tags"]["highway"]])

    # height offset: terrain vs the road heights the bus routes were measured at
    transit = json.loads((ROOT / "viewer" / "transit.json").read_text())
    diffs = [p[2] - (elev(p[0], p[1]) + GEOID_M) for s in transit["shapes"] for p in s[::4]
             if BBOX[0] < p[0] < BBOX[2] and BBOX[1] < p[1] < BBOX[3]]
    off = statistics.median(diffs)
    print(f"terrain vs bus-route heights: median {off:+.2f} m over {len(diffs)} points "
          f"(IQR {statistics.quantiles(diffs, n=4)[0]:+.1f}..{statistics.quantiles(diffs, n=4)[2]:+.1f})")
    H = lambda lat, lon: round(elev(lat, lon) + GEOID_M + off, 1)

    bld = []                                      # in four parts: the whole area at once is too big an ask
    mid_lat, mid_lon = (BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2
    quads = [(BBOX[0], BBOX[1], mid_lat, mid_lon), (BBOX[0], mid_lon, mid_lat, BBOX[3]),
             (mid_lat, BBOX[1], BBOX[2], mid_lon), (mid_lat, mid_lon, BBOX[2], BBOX[3])]
    for i, q in enumerate(quads):
        bld += overpass(f"bld{i + 1}", 'way["building"](BBOX);', out="out tags geom;", bbox=q)["elements"]
    occ = Occluders({w["id"]: w for w in bld if w["type"] == "way"}.values(), H)

    streets = []
    for nm, ways in sorted(by.items()):
        for line in chain(ways):
            if length(line) < 60:
                continue
            pts = [[round(la, 5), round(lo, 5), H(la, lo)] for la, lo in rdp(line, 4.0)]
            streets.append([nm, rank[nm], pts, occ.ranges(pts)])

    def centre(el):
        if el["type"] == "node":
            return el["lat"], el["lon"]
        if "center" in el:
            return el["center"]["lat"], el["center"]["lon"]
        b = el.get("bounds")
        return ((b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2) if b else None

    area_out, seen = [], set()
    for el in areas["elements"]:
        t = el.get("tags", {}); nm = t.get("name")
        kind = "hood" if "place" in t else "park" if t.get("leisure") == "park" else "water"
        if not nm or (nm, kind) in seen:
            continue
        c = centre(el)
        if not c or not (BBOX[0] < c[0] < BBOX[2] and BBOX[1] < c[1] < BBOX[3]):
            continue
        b = el.get("bounds")
        if kind == "park" and b and (b["maxlat"] - b["minlat"]) * (b["maxlon"] - b["minlon"]) < 1.2e-6:
            continue                                  # pocket parks: too small to name
        seen.add((nm, kind))
        area_out.append([nm, kind, round(c[0], 5), round(c[1], 5), H(*c)])
    # rivers are long lines: name them as streets drawn in the water style (rank 9)
    rivers = defaultdict(list)
    for el in river_ways["elements"]:
        if "geometry" in el:
            rivers[el["tags"]["name"]].append([(round(g["lat"], 6), round(g["lon"], 6)) for g in el["geometry"]])
    for nm, ways in rivers.items():
        for line in chain(ways):
            if length(line) > 300:
                streets.append([nm, 9, [[round(la, 5), round(lo, 5), H(la, lo)] for la, lo in rdp(line, 8.0)], [[], [], [], []]])

    places = [[p["name"], p["note"], p["lat"], p["lon"], H(p["lat"], p["lon"])]
              for p in json.loads((ROOT / "data" / "places.json").read_text())]
    Path(out).write_text(json.dumps({"streets": streets, "areas": area_out, "places": places}, separators=(",", ":")))
    print(f"{len(streets)} street lines, {len(area_out)} areas, {len(places)} places -> {out} ({Path(out).stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT / "viewer" / "labels.json")
