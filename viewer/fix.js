// "Tell me what's wrong here": a short note about the spot in the middle of the map. It goes to the map's
// analytics as one event (no name or email), with the spot as map pixels, latitude and longitude, and a link.
// The spot is read at the city's typical ground height, the same one search pins and turning use.
import { pxToEnu, enuToLla, GROUND_U } from './geo.js';
import { viewHash } from './share.js';

export const NOTE_MAX = 600;
export function correction({ angle, x, y, zoom }, text) {
  const note = String(text || '').trim().slice(0, NOTE_MAX);
  if (!note) return null;
  const [lat, lon] = enuToLla(...pxToEnu(angle, x, y, GROUND_U));
  const r = v => Math.round(v * 1e5) / 1e5;
  return { note, angle, x: Math.round(x), y: Math.round(y), zoom, lat: r(lat), lon: r(lon),
    link: 'https://isoburlington.com/' + viewHash({ angle, x, y, zoom }),
    $geoip_disable: true };   // the spot is the one place in it; no city guessed from the sender's address
}
