// Map-pixel <-> geography for Isometric Burlington. Same formulas as pipeline/geo.py.
export const GRID = {
  origin: [44.4759, -73.2121, 0.0],
  pixelM: 0.23,
  elevDeg: 30,
  headings: [90, 180, 270, 0],
};

const A = 6378137.0, F = 1 / 298.257223563, E2 = F * (2 - F);
const rad = d => d * Math.PI / 180;

function ecef(lat, lon, h) {
  const la = rad(lat), lo = rad(lon);
  const n = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [(n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - E2) + h) * Math.sin(la)];
}

const [OLAT, OLON, OH] = GRID.origin;
const O = ecef(OLAT, OLON, OH);
const la0 = rad(OLAT), lo0 = rad(OLON);
const BE = [-Math.sin(lo0), Math.cos(lo0), 0];
const BN = [-Math.sin(la0) * Math.cos(lo0), -Math.sin(la0) * Math.sin(lo0), Math.cos(la0)];
const BU = [Math.cos(la0) * Math.cos(lo0), Math.cos(la0) * Math.sin(lo0), Math.sin(la0)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function llaToEnu(lat, lon, h = 0) {
  const p = ecef(lat, lon, h);
  const d = [p[0] - O[0], p[1] - O[1], p[2] - O[2]];
  return [dot(d, BE), dot(d, BN), dot(d, BU)];
}

export function enuToPx(angle, e, n, u) {
  const h = rad(GRID.headings[angle]), el = rad(GRID.elevDeg);
  const fwd = [Math.sin(h), Math.cos(h)], right = [Math.cos(h), -Math.sin(h)];
  const r = e * right[0] + n * right[1];
  const f = e * fwd[0] + n * fwd[1];
  return [r / GRID.pixelM, -(f * Math.sin(el) + u * Math.cos(el)) / GRID.pixelM];
}

// Ground point under a map pixel, given its height u (metres, ENU up).
export function pxToEnu(angle, px, py, u = 0) {
  const h = rad(GRID.headings[angle]), el = rad(GRID.elevDeg);
  const r = px * GRID.pixelM;
  const f = (-py * GRID.pixelM - u * Math.cos(el)) / Math.sin(el);
  const fwd = [Math.sin(h), Math.cos(h)], right = [Math.cos(h), -Math.sin(h)];
  return [r * right[0] + f * fwd[0], r * right[1] + f * fwd[1], u];
}

// Inverse of llaToEnu (good to millimetres over the map area).
export function enuToLla(e, n, u = 0) {
  let lat = OLAT, lon = OLON, h = OH;
  for (let i = 0; i < 4; i++) {
    const [e1, n1, u1] = llaToEnu(lat, lon, h);
    lat += (n - n1) / 111132.0;
    lon += (e - e1) / (111320.0 * Math.cos(rad(lat)));
    h += u - u1;
  }
  return [lat, lon, h];
}

export const latLonToPx = (angle, lat, lon, h = 0) => { const [e, n, u] = llaToEnu(lat, lon, h); return enuToPx(angle, e, n, u); };
