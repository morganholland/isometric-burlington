"""GMT bus schedule -> viewer/transit.json: every scheduled trip that serves the map area, so the viewer
can move buses along their routes by the timetable (GMT's live positions need an API key).

usage: python3 pipeline/transit.py <unzipped GTFS dir> [out.json]

Output (compact; times are seconds after the service day's midnight, may exceed 24 h):
  {"routes": {rid: [short_name, "#color", long_name]},
   "shapes": [[[lat, lon, h_ellipsoid_m, metres_along], ...]],   # simplified to ~3 m, h from a DEM
   "services": [day_mask, ...],                                # bit 0 = Monday ... bit 6 = Sunday
   "trips": [[rid, service_index, shape_index, [t, metres along shape, t, metres, ...]]],
   "dates": {"YYYYMMDD": {"off": [service_index, ...], "on": [service_index, ...]}} }   # exceptions Calendar start/end dates are ignored on purpose, so the
fall timetable keeps playing after the feed expires (until this is re-run on a newer feed)."""
import csv, json, math, sys, time, urllib.request
from collections import defaultdict
from pathlib import Path

BBOX = (44.39, -73.33, 44.55, -73.10)          # lat0, lon0, lat1, lon1 (the viewer's search box)
GEOID_M = -29.3                               # orthometric -> ellipsoid height here (Lake Champlain at ENU -0.3)
SIMPLIFY_M = 3.0


def rows(d, name):
    with open(Path(d) / name, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def secs(t):
    h, m, s = (int(x) for x in t.split(":"))
    return h * 3600 + m * 60 + s


def inside(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def xy(lat, lon):
    return lon * 111320 * math.cos(math.radians(44.47)), lat * 110950


def simplify(pts, tol):
    """Douglas-Peucker on [(lat, lon, dist)] -> kept points (first and last always)."""
    if len(pts) < 3:
        return pts
    P = [xy(p[0], p[1]) for p in pts]
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (ax, ay), (bx, by) = P[i], P[j]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1e-9
        best, bk = -1.0, -1
        for k in range(i + 1, j):
            px, py = P[k]
            t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
            dd = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if dd > best:
                best, bk = dd, k
        if best > tol:
            keep[bk] = True
            stack += [(i, bk), (bk, j)]
    return [p for p, k in zip(pts, keep) if k]


def elevations(points):
    """Copernicus DEM (via Open-Meteo), 100 points per request."""
    out = []
    for i in range(0, len(points), 100):
        chunk = points[i:i + 100]
        q = "latitude=" + ",".join(f"{p[0]:.5f}" for p in chunk) + "&longitude=" + ",".join(f"{p[1]:.5f}" for p in chunk)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(f"https://api.open-meteo.com/v1/elevation?{q}", timeout=30) as r:
                    out += json.load(r)["elevation"]
                break
            except Exception:  # noqa: BLE001
                if attempt == 4:
                    raise
                time.sleep(2 + 3 * attempt)
        time.sleep(0.3)
    return out


def build(d):
    routes = {r["route_id"]: [r["route_short_name"], "#" + (r.get("route_color") or "c8472f").lower(), r["route_long_name"]]
              for r in rows(d, "routes.txt")}
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    mask = {c["service_id"]: sum(1 << i for i, k in enumerate(days) if c[k] == "1") for c in rows(d, "calendar.txt")}
    exc = list(rows(d, "calendar_dates.txt")) if (Path(d) / "calendar_dates.txt").exists() else []
    for c in exc:                                   # services defined only by their dates
        mask.setdefault(c["service_id"], 0)
    sidx = {sid: i for i, sid in enumerate(mask)}
    trips = {t["trip_id"]: t for t in rows(d, "trips.txt")}
    stops = {s["stop_id"]: (float(s["stop_lat"]), float(s["stop_lon"])) for s in rows(d, "stops.txt") if s["stop_lat"]}
    st = defaultdict(list)
    for r in rows(d, "stop_times.txt"):
        if r["arrival_time"] and r["shape_dist_traveled"] != "":
            st[r["trip_id"]].append((int(r["stop_sequence"]), secs(r["arrival_time"]), secs(r["departure_time"] or r["arrival_time"]),
                                     float(r["shape_dist_traveled"]), r["stop_id"]))
    shp = defaultdict(list)
    for r in rows(d, "shapes.txt"):
        shp[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"]), float(r["shape_dist_traveled"] or 0)))

    used, out_trips = {}, []
    for tid, s in st.items():
        t = trips.get(tid)
        if not t or t["service_id"] not in mask or t["route_id"] not in routes or not t["shape_id"] in shp:
            continue
        s.sort()
        if not any(inside(*stops[x[4]]) for x in s if x[4] in stops):
            continue
        si = used.setdefault(t["shape_id"], len(used))
        tl = []
        for _, arr, dep, dist, _ in s:
            tl += [arr, round(dist, 1)]
            if dep != arr:
                tl += [dep, round(dist, 1)]
        out_trips.append([t["route_id"], sidx[t["service_id"]], si, tl])

    shapes = [None] * len(used)
    allpts = []
    for sid, i in used.items():
        pts = [(la, lo, di) for _, la, lo, di in sorted(shp[sid])]
        pts = simplify(pts, SIMPLIFY_M)
        # far outside the map a bus is never drawn: keep only the points next to the map area
        near = [inside(p[0], p[1]) for p in pts]
        pts = [p for k, p in enumerate(pts) if near[k] or (k > 0 and near[k - 1]) or (k + 1 < len(pts) and near[k + 1])]
        shapes[i] = pts
        allpts += pts
    # one DEM lookup per distinct point
    uniq = sorted({(round(p[0], 5), round(p[1], 5)) for p in allpts})
    el = dict(zip(uniq, elevations(uniq)))
    out_shapes = [[[round(p[0], 5), round(p[1], 5), round(el[(round(p[0], 5), round(p[1], 5))] + GEOID_M, 1), round(p[2], 1)]
                   for p in pts] for pts in shapes]
    dates = defaultdict(lambda: {"off": [], "on": []})
    for c in exc:
        dates[c["date"]]["off" if c["exception_type"] == "2" else "on"].append(sidx[c["service_id"]])
    used_routes = {t[0] for t in out_trips}
    return {"routes": {k: v for k, v in routes.items() if k in used_routes}, "shapes": out_shapes,
            "services": list(mask.values()), "trips": out_trips, "dates": dict(dates)}


if __name__ == "__main__":
    data = build(sys.argv[1])
    out = Path(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).parent.parent / "viewer/transit.json")
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"{len(data['trips'])} trips, {len(data['shapes'])} shapes, {sum(len(s) for s in data['shapes'])} points, "
          f"{len(data['routes'])} routes, {out.stat().st_size // 1024} KB")
