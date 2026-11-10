// Live aircraft around Burlington from adsb.lol (open ADS-B data, ODbL), passed through because the
// browser cannot call it directly (no CORS). The CDN caches each answer for a few seconds, so the
// upstream sees at most one request every 5 s however many people have the map open.
const URL = 'https://api.adsb.lol/v2/point/44.47/-73.17/30';   // 30 nm around BTV and the map

export default async function handler(req, res) {
  try {
    const r = await fetch(URL, { headers: { 'User-Agent': 'isometric-burlington (map viewer)' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const j = await r.json();
    const ac = (j.ac || [])
      .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number' && (a.seen_pos ?? 0) < 60)
      .map(a => ({
        id: a.hex, flight: (a.flight || '').trim(), type: a.t || '', lat: a.lat, lon: a.lon,
        altFt: a.alt_baro === 'ground' ? 0 : (typeof a.alt_geom === 'number' ? a.alt_geom : a.alt_baro ?? null),
        ground: a.alt_baro === 'ground', gs: a.gs ?? 0, track: a.track ?? a.true_heading ?? null,
        vr: a.baro_rate ?? a.geom_rate ?? 0, age: a.seen_pos ?? 0,
      }));
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
    res.status(200).json({ now: j.now || Date.now(), ac });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=5');
    res.status(502).json({ error: String(e.message || e), ac: [] });
  }
}
