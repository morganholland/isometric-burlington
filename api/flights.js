// Live aircraft around Burlington from open ADS-B feeds, passed through because the browser cannot
// call them directly (no CORS). adsb.lol (ODbL) first, adsb.fi open data as the fallback; both speak
// the readsb JSON format. The CDN caches each answer for a few seconds, so the upstreams see at most
// one request every 5 s however many people have the map open.
export const SOURCES = [
  { name: 'adsb.lol', url: 'https://api.adsb.lol/v2/point/44.47/-73.17/30' },               // 30 nm around BTV
  { name: 'adsb.fi', url: 'https://opendata.adsb.fi/api/v2/lat/44.47/lon/-73.17/dist/30' },
];
const TIMEOUT_MS = 3000;          // per source, so a dead first source still leaves time for the second
const SKIP_MS = 5 * 60 * 1000;    // after a failure, try that source last for five minutes
const STALE_MS = 60 * 1000;       // serve the last good answer for up to a minute if every source fails

const failedAt = new Map();       // per warm instance
let lastGood = null;              // { at, ac }

export function normalize(j) {
  return (j.ac || j.aircraft || [])
    .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number' && (a.seen_pos ?? 0) < 60)
    .map(a => ({
      id: a.hex, flight: (a.flight || '').trim(), type: a.t || '', lat: a.lat, lon: a.lon,
      altFt: a.alt_baro === 'ground' ? 0 : (typeof a.alt_geom === 'number' ? a.alt_geom : a.alt_baro ?? null),
      ground: a.alt_baro === 'ground', gs: a.gs ?? 0, track: a.track ?? a.true_heading ?? null,
      vr: a.baro_rate ?? a.geom_rate ?? 0, age: a.seen_pos ?? 0,
    }));
}

function order(now) {
  const healthy = s => !(now - (failedAt.get(s.name) ?? -Infinity) < SKIP_MS);
  return [...SOURCES.filter(healthy), ...SOURCES.filter(s => !healthy(s))];
}

export async function getAircraft(fetchImpl = fetch, now = Date.now()) {
  const errors = [];
  for (const s of order(now)) {
    try {
      const r = await fetchImpl(s.url, { headers: { 'User-Agent': 'isometric-burlington (map viewer)' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const ac = normalize(await r.json());
      failedAt.delete(s.name);
      lastGood = { at: now, ac };
      return { source: s.name, ac };
    } catch (e) {
      failedAt.set(s.name, now);
      errors.push(`${s.name}: ${e.message || e}`);
    }
  }
  if (lastGood && now - lastGood.at < STALE_MS) {
    const extra = (now - lastGood.at) / 1000;      // positions are that much older now
    return { source: 'stale', ac: lastGood.ac.map(a => ({ ...a, age: a.age + extra })) };
  }
  const err = new Error(errors.join('; '));
  err.all = true;
  throw err;
}

export function _reset() { failedAt.clear(); lastGood = null; }

export default async function handler(req, res) {
  try {
    const { source, ac } = await getAircraft();
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
    res.status(200).json({ now: Date.now(), source, ac });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=15');
    res.status(503).json({ error: String(e.message || e), ac: [] });
  }
}
