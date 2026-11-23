// Visitor lists: a title, a "by" line and up to 20 spots with notes, kept entirely in the link (no accounts,
// no database). Encoded as compact JSON in base64url; anything that does not decode cleanly is no list at all.
// longest list code the maker will put in a link (chat apps and texts cut longer links short)
export const LINK_MAX = 8000;
export const LIMITS = { title: 80, by: 40, name: 60, note: 240, items: 20 };
const BOX = { lat: [44.35, 44.60], lon: [-73.35, -73.05] };   // the drawn area, with room to spare

const r5 = v => Math.round(v * 1e5) / 1e5;
const cut = (s, n) => (typeof s === 'string' ? [...s.trim()].slice(0, n).join('').trim() : '');

function b64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export function encodeList({ title = '', by = '', items = [] }) {
  const i = items.slice(0, LIMITS.items).map(it => [cut(it.name, LIMITS.name), cut(it.note, LIMITS.note), r5(it.lat), r5(it.lon)]);
  return b64url(new TextEncoder().encode(JSON.stringify({ t: cut(title, LIMITS.title), b: cut(by, LIMITS.by), i })));
}

export function decodeList(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]+$/.test(str)) return null;
  let d;
  try { d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unb64url(str))); } catch { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.i)) return null;
  const items = [];
  for (const it of d.i) {
    if (!Array.isArray(it) || typeof it[0] !== 'string' || (it[1] != null && typeof it[1] !== 'string')) continue;
    const [lat, lon] = [it[2], it[3]];
    if (typeof lat !== 'number' || typeof lon !== 'number' || !(lat >= BOX.lat[0] && lat <= BOX.lat[1] && lon >= BOX.lon[0] && lon <= BOX.lon[1])) continue;
    const name = cut(it[0], LIMITS.name);
    if (!name) continue;
    items.push({ name, note: cut(it[1] || '', LIMITS.note), lat: r5(lat), lon: r5(lon) });
    if (items.length === LIMITS.items) break;
  }
  if (!items.length) return null;
  return { title: cut(d.t, LIMITS.title), by: cut(d.b, LIMITS.by), items };
}
