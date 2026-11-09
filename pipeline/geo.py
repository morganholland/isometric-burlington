"""Geography + camera grid for Isometric Burlington.

One local east/north/up tangent frame at ORIGIN. Every angle is an orthographic
camera looking down at ELEV_DEG, its heading turned by 90 degrees per angle.
Map pixel coordinates (px, py) for angle a:
    r = right component, f = forward component, u = up (metres, ENU)
    px = r / PIXEL_M
    py = -(f * sin(elev) + u * cos(elev)) / PIXEL_M
The renderer, the tile cutter and every overlay use these same formulas
(see geo.js), so all layers stay pixel-registered.
"""
import json, math, sys
import numpy as np
from pathlib import Path
from shapely.geometry import shape, mapping, Polygon, box
from shapely.ops import unary_union, transform
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

ORIGIN = (44.4759, -73.2121, 0.0)   # Church St Marketplace, lat/lon/height(ellipsoid)
PIXEL_M = 0.23                       # metres per map pixel across the screen
ELEV_DEG = 30.0                      # camera looks down 30 degrees
# heading = compass direction the camera LOOKS. Angle 0 looks east, so the lake
# sits along the bottom of the map and the city climbs up the hill to UVM.
HEADINGS = [90.0, 180.0, 270.0, 0.0]
FRAME = 1024                         # render / training frame, px
BLOCK = 4096                         # generation block, px (4x4 frames)
LAKE_BUFFER_M = 900                  # how far into the lake the map extends

_to_ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)


def enu_basis(lat, lon):
    la, lo = math.radians(lat), math.radians(lon)
    e = (-math.sin(lo), math.cos(lo), 0.0)
    n = (-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la))
    u = (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))
    return e, n, u


O_ECEF = _to_ecef.transform(ORIGIN[1], ORIGIN[0], ORIGIN[2])
E, N, U = enu_basis(ORIGIN[0], ORIGIN[1])


def lla_to_enu(lat, lon, h=0.0):
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    h = np.broadcast_to(np.asarray(h, float), lat.shape)
    x, y, z = _to_ecef.transform(lon, lat, h)
    d = (x - O_ECEF[0], y - O_ECEF[1], z - O_ECEF[2])
    dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    return dot(d, E), dot(d, N), dot(d, U)


def axes(angle):
    h = math.radians(HEADINGS[angle])
    fwd = (math.sin(h), math.cos(h))           # (east, north) of looking direction
    right = (math.cos(h), -math.sin(h))
    return fwd, right


def enu_to_px(angle, e, n, u):
    fwd, right = axes(angle)
    r = e * right[0] + n * right[1]
    f = e * fwd[0] + n * fwd[1]
    el = math.radians(ELEV_DEG)
    return r / PIXEL_M, -(f * math.sin(el) + u * math.cos(el)) / PIXEL_M


def load_poly(name):
    g = json.load(open(DATA / f"nom_{name}.json"))[0]["geojson"]
    return shape(g)


def region_lonlat():
    towns = unary_union([load_poly(n) for n in ("Burlington", "South_Burlington", "Winooski")])
    lake = load_poly("lake")
    land = towns.difference(lake)
    # keep the town land plus a band of lake along its shore
    enu = lambda poly: transform(lambda lon, lat, z=None: lla_to_enu(lat, lon)[:2], poly)
    land_m = enu(land)
    towns_m = enu(towns)
    band = land_m.buffer(LAKE_BUFFER_M).intersection(towns_m.buffer(LAKE_BUFFER_M))
    return land_m, band, enu(lake)


def build():
    land_m, region_m, lake_m = region_lonlat()
    cfg = dict(origin=ORIGIN, pixel_m=PIXEL_M, elev_deg=ELEV_DEG, headings=HEADINGS,
               frame=FRAME, block=BLOCK, angles=[])
    total_frames = total_blocks = 0
    for a in range(4):
        # ground-level footprint of the region in map pixels (terrain lifts it a little;
        # pad 600 px at the top for hills/buildings)
        ring = [enu_to_px(a, x, y, 0.0) for x, y in region_m.exterior.coords] if region_m.geom_type == "Polygon" else \
               [enu_to_px(a, x, y, 0.0) for g in region_m.geoms for x, y in g.exterior.coords]
        poly_px = Polygon([(x, y) for x, y in ring]).buffer(0) if region_m.geom_type == "Polygon" else \
            unary_union([Polygon([enu_to_px(a, x, y, 0.0) for x, y in g.exterior.coords]) for g in region_m.geoms])
        minx, miny, maxx, maxy = poly_px.bounds
        miny -= 600
        x0 = math.floor(minx / BLOCK) * BLOCK
        y0 = math.floor(miny / BLOCK) * BLOCK
        x1 = math.ceil(maxx / BLOCK) * BLOCK
        y1 = math.ceil(maxy / BLOCK) * BLOCK
        reg = poly_px.buffer(300)
        blocks = []
        for by in range(y0, y1, BLOCK):
            for bx in range(x0, x1, BLOCK):
                cell = box(bx, by - 600, bx + BLOCK, by + BLOCK)  # the cell, plus what hills could lift into it
                if cell.intersects(reg):
                    blocks.append([bx, by])
        cfg["angles"].append(dict(heading=HEADINGS[a], x0=x0, y0=y0, x1=x1, y1=y1,
                                  width=x1 - x0, height=y1 - y0, blocks=blocks,
                                  region_px=mapping(poly_px)))
        total_blocks += len(blocks)
        total_frames += len(blocks) * (BLOCK // FRAME) ** 2
        print(f"angle {a} heading {HEADINGS[a]:>5}: canvas {(x1-x0)/1e3:.0f}k x {(y1-y0)/1e3:.0f}k px, "
              f"{len(blocks)} blocks, {len(blocks)*(BLOCK/1e3)**2*1e-3:.2f} Gpx drawn")
    print(f"land area {land_m.area/1e6:.1f} km2, mapped region {region_m.area/1e6:.1f} km2")
    print(f"total: {total_blocks} blocks, {total_frames} render frames over 4 angles")
    json.dump(cfg, open(DATA / "grid.json", "w"))
    json.dump(dict(type="Feature", properties={}, geometry=mapping(region_m)), open(DATA / "region_enu.geojson", "w"))
    return cfg


if __name__ == "__main__":
    build()
