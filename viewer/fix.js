// "Tell me what's wrong here": a short note about the spot in the middle of the map. It goes to the map's
// analytics as one event (no name or email), with the spot as map pixels, latitude and longitude, and a link.
import { pxToEnu, enuToLla } from './geo.js';
import { viewHash } from './share.js';

export const NOTE_MAX = 600;
export function correction({ angle, x, y, zoom }, text) {
  const note = String(text || '').trim().slice(0, NOTE_MAX);
  if (!note) return null;
  const [lat, lon] = enuToLla(...pxToEnu(angle, x, y, 0));
  const r = v => Math.round(v * 1e5) / 1e5;
  return { note, angle, x: Math.round(x), y: Math.round(y), zoom, lat: r(lat), lon: r(lon),
    link: 'https://isoburlington.com/' + viewHash({ angle, x, y, zoom }) };
}
