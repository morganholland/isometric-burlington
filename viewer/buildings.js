// Tap a building: which ground points could be under the tap, and the card's words.
// The map is drawn looking down at 30 degrees, so a tap on a roof lands on the ground some way behind the
// building. The points sent to the lookup lie on the line of sight, from a typical roof height down to the
// ground, with the ground height read from the nearest street.
import { pxToEnu, enuToLla, llaToEnu, GROUND_U } from './geo.js';

export const ROOFS = [6, 0, 12, 3, 20];          // metres above the ground, most likely first
const NEAR_STREET_M = 150;

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

// [[lat, lon, h], ...] on the line of sight under map pixel (px, py), in the order of ROOFS
export function rayPoints(angle, px, py, ground) {
  return ROOFS.map(r => {
    const [e, n, u] = pxToEnu(angle, px, py, ground + r);
    const [lat, lon, h] = enuToLla(e, n, u);
    return [+lat.toFixed(6), +lon.toFixed(6), h];
  });
}

// the lookup's answer -> the card's lines, or null when there is nothing to say
export function describeBuilding(r) {
  if (!r || !r.found || !r.address) return null;
  const facts = [r.kind, r.built ? `built ${r.built}` : null].filter(Boolean);
  const line = facts.length ? facts.join(', ').replace(/^./, c => c.toUpperCase()) : null;
  const use = r.use && r.use !== r.kind ? r.use : null;
  return { title: r.address, town: r.town || '', line, use, source: r.source || '' };
}
