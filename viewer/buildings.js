// Tap a building: which building is under the tap, and the card's words.
// The map is drawn looking down at 30 degrees, so a tap on a roof is not above the ground point under it: the
// building stands some way in front of that point. hitBuilding follows the line of sight down from the tap and
// stops at the first footprint tall enough to reach it (viewer/buildings.json, from pipeline/buildings.py).
// With no building in the way, the tap is on the ground: a yard, a street or the lake.
import { pxToEnu, enuToLla, llaToEnu, GROUND_U } from './geo.js';

const NEAR_STREET_M = 150;
const CELL = 50;                                  // metres, the footprint index's grid
const STEP_U = 0.25;                              // metres of height per step down the line of sight
const ABOVE = 100;                                // start this far above the tap's ground (taller than anything here)

// streets: [[lat, lon, h], ...] (labels.json street points). The ground height (ENU up) under a map pixel.
const enuCache = new WeakMap();
export function groundU(angle, px, py, streets) {
  let u = GROUND_U;
  if (!streets || !streets.length) return u;
  if (!enuCache.has(streets)) enuCache.set(streets, streets.map(p => llaToEnu(p[0], p[1], p[2])));
  const enu = enuCache.get(streets);
  for (let k = 0; k < 3; k++) {
    const [e, n] = pxToEnu(angle, px, py, u);
    let best = null, bd = NEAR_STREET_M ** 2;
    for (const [pe, pn, pu] of enu) {
      const d = (pe - e) ** 2 + (pn - n) ** 2;
      if (d < bd) { bd = d; best = pu; }
    }
    if (best == null) break;
    u = best;
  }
  return u;
}

// buildings.json -> { list: [{base, top, ring: [[e, n], ...], bb}], grid: Map(cell -> [building]) }
export function indexBuildings(d) {
  const list = [], grid = new Map();
  for (const r of d.b) {
    const ring = [];
    let e = 0, n = 0;
    for (let k = 2; k + 1 < r.length; k += 2) { e += r[k]; n += r[k + 1]; ring.push([e / 2, n / 2]); }
    if (ring.length < 3) continue;
    const es = ring.map(p => p[0]), ns = ring.map(p => p[1]);
    const b = { base: r[0], top: r[1], ring, bb: [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)] };
    list.push(b);
    for (let i = Math.floor(b.bb[0] / CELL); i <= Math.floor(b.bb[2] / CELL); i++)
      for (let j = Math.floor(b.bb[1] / CELL); j <= Math.floor(b.bb[3] / CELL); j++) {
        const key = i * 100003 + j;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(b);
      }
  }
  return { list, grid };
}

export function insideRing(ring, x, y) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j], [x2, y2] = ring[i];
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) c = !c;
  }
  return c;
}

// The building a tap at map pixel (px, py) hits, nearest the viewer first: { building, e, n, u } where (e, n)
// is a ground point inside its footprint, or { building: null, e, n, u: ground } for a tap on open ground.
export function hitBuilding(index, angle, px, py, ground) {
  if (index) {
    for (let u = ground + ABOVE; u > ground; u -= STEP_U) {
      const [e, n] = pxToEnu(angle, px, py, u);
      const cell = index.grid.get(Math.floor(e / CELL) * 100003 + Math.floor(n / CELL));
      if (!cell) continue;
      for (const b of cell) {
        if (u > b.top || e < b.bb[0] || e > b.bb[2] || n < b.bb[1] || n > b.bb[3]) continue;
        if (insideRing(b.ring, e, n)) return { building: b, e, n, u };
      }
    }
  }
  const [e, n] = pxToEnu(angle, px, py, ground);
  return { building: null, e, n, u: ground };
}

// where to ask about: [lat, lon] at 1 m (5 decimals), so nearby taps share a cached answer
export function lookupPoint(e, n) {
  const [lat, lon] = enuToLla(e, n, 0);
  return [+lat.toFixed(5), +lon.toFixed(5)];
}

// the lookup's answer -> the card's lines, or null when there is nothing to say
export function describeBuilding(r) {
  if (!r || !r.found || !r.address) return null;
  const facts = [r.kind, r.built ? `built ${r.built}` : null].filter(Boolean);
  const line = facts.length ? facts.join(', ').replace(/^./, c => c.toUpperCase()) : null;
  const use = r.use && r.use !== r.kind ? r.use : null;
  return { title: r.address, town: r.town || '', line, use, source: r.source || '' };
}
