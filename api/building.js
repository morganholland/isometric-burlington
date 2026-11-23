// What a tapped building is, from public records: its address, what it is used for and, in Burlington, the
// year it was built. Never owners' names or values: only the fields named below are asked for, and only the
// fields in `pick` are passed on.
//
// GET /api/building?pts=lat,lon;lat,lon;...  (points along the line of sight under the tap, best guess first)
//
// Sources (both public ArcGIS services, no key):
// - City of Burlington parcels with land use and assessor information (year built, building type)
// - VCGI statewide standardized parcels (address and property category), for South Burlington and Winooski
export const SOURCES = {
  btv: {
    name: 'City of Burlington assessor',
    url: 'https://services.arcgis.com/pwNwIGBE7M7VOXjQ/arcgis/rest/services/AGOL_BIP_ParcelsByLandUse/FeatureServer/0/query',
    fields: 'ST_NUM,ST_NAME,ST_TYPE,LandUse,BuildingType,YearBuilt',
  },
  vt: {
    name: 'Vermont parcel data (VCGI)',
    url: 'https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0/query',
    fields: 'E911ADDR,TNAME,CAT',
  },
};
const TIMEOUT_MS = 4000;
const MAX_PTS = 6;
const BOX = { lat: [44.35, 44.6], lon: [-73.35, -73.05] };   // the drawn area and a margin

// "lat,lon;lat,lon" -> [[lat, lon]], or null if anything is off
export function parsePoints(s) {
  if (typeof s !== 'string' || s.length > 400) return null;
  const pts = s.split(';').filter(Boolean).map(p => p.split(',').map(Number));
  if (!pts.length || pts.length > MAX_PTS) return null;
  for (const p of pts) {
    if (p.length !== 2 || !p.every(Number.isFinite)) return null;
    if (p[0] < BOX.lat[0] || p[0] > BOX.lat[1] || p[1] < BOX.lon[0] || p[1] > BOX.lon[1]) return null;
  }
  return pts;
}

const title = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
// Vermont grand list property categories
const CATS = { R1: 'Home', R2: 'Home on a large lot', MHU: 'Mobile home', MHL: 'Mobile home', S1: 'Seasonal home', S2: 'Seasonal home',
  C: 'Commercial', CA: 'Apartments', I: 'Industrial', UE: 'Utility', UO: 'Utility', F: 'Farm', W: 'Woodland' };
// Burlington's building types, in words (the assessor's codes are terse)
const KINDS = {
  'OLD STYLE': 'Old-style house', 'RANCH': 'Ranch house', 'COLONIAL': 'Colonial', 'CAPE COD': 'Cape Cod', 'APARTMENTS': 'Apartments',
  'MULTI-FAMLY': 'Multi-family house', 'RAISED RANCH': 'Raised ranch', 'VICTORIAN': 'Victorian', 'CONTEMPORARY': 'Contemporary house',
  'DUPLEX': 'Duplex', 'OFFICE GENR': 'Offices', 'FOUR SQUARE': 'Foursquare house', 'SPLTLVL RNCH': 'Split-level ranch',
  'RETL W APTS': 'Shops with apartments above', 'BUNGELOW': 'Bungalow', 'OFFICE W/APT': 'Offices with apartments',
  'WAREHSE GEN': 'Warehouse', 'ASSOC HALL': 'Hall', 'DECKER': 'Triple-decker', 'DORM +RESID': 'Dormitory', 'ROOMNG HSE': 'Rooming house',
  'TUDOR': 'Tudor house', 'RETAIL GEN': 'Shops', 'CHURCH SYNG': 'Church or synagogue', 'SCHOOLS ELEM': 'School',
  'LT MFG': 'Light industry', 'SERV GARG': 'Service garage', 'COTTAGE': 'Cottage', 'ROW APT': 'Row apartments',
  'OFFICE ELVTR': 'Office building', 'RETL W OFF': 'Shops with offices', 'CLTRL EDUCTN': 'Cultural or education building',
  'REP+BODY': 'Auto repair', 'FRATS + SOR': 'Fraternity or sorority house', 'REST BAR': 'Restaurant or bar', 'COLLEGE': 'College building',
  'SERV REST': 'Restaurant', 'HOSPITALS': 'Hospital', 'MUNIC GARAGE': 'City garage', 'FEDERAL': 'Federal building',
  'RETL OFF APT': 'Shops, offices and apartments', 'PRK GRG MLT': 'Parking garage', 'ELDERLY HOME': 'Senior housing',
  'APT ELEVATOR': 'Apartment building', 'NURSING HOM': 'Nursing home', 'GOVT BLDGS': 'Government building', 'BANKS': 'Bank',
  'MED DENTAL': 'Medical or dental office', 'FUNERAL HOME': 'Funeral home', 'TRIPLEX': 'Triplex', 'GAS STAT FUL': 'Gas station',
  'TOWNHS END': 'Townhouse', 'BED&BREAKFST': 'Bed and breakfast', 'MOTELS': 'Motel', 'ICE RINK': 'Ice rink', 'FIRE STATION': 'Fire station',
  'CONV STORE': 'Convenience store', 'SUPERMARKET': 'Supermarket', 'SMALL SHOP': 'Small shop', 'MUSEUMS': 'Museum', 'SALTBOX': 'Saltbox house',
  'MED OFFICE': 'Medical office', 'MED CLINIC': 'Clinic', 'HOTELS': 'Hotel',
};
const SKIP = new Set(['', 'NULL']);
// Burlington's land use classes, where the words need help
const USES = { 'Exempt': 'Public or nonprofit', 'Partial Exempt': 'Partly public or nonprofit', 'Exempt Land': 'Public or nonprofit land',
  'Exempt Utility': 'Utility', 'Res. Vacant Land': 'Empty lot' };

// one parcel's record -> the fields the map shows; everything else is dropped
export function pick(src, a) {
  if (src === 'btv') {
    const num = a.ST_NUM ? String(a.ST_NUM).trim() : '';
    const street = [a.ST_NAME, a.ST_TYPE].map(title).filter(Boolean).join(' ');
    const built = /^\d{4}$/.test(String(a.YearBuilt || '').trim()) && +a.YearBuilt > 1700 ? +a.YearBuilt : null;
    const kind = String(a.BuildingType || '').trim().replace(/\s+/g, ' ').toUpperCase();
    const use = String(a.LandUse || '').trim();
    return { address: [num !== '0' ? num : '', street].filter(Boolean).join(' ') || null, town: 'Burlington', built,
      kind: SKIP.has(kind) ? null : KINDS[kind] || title(kind), use: use ? USES[use] || use : null, source: SOURCES.btv.name };
  }
  return { address: a.E911ADDR ? title(a.E911ADDR) : null, town: a.TNAME ? title(a.TNAME) : null, built: null, kind: null,
    use: CATS[String(a.CAT || '').trim().toUpperCase()] || null, source: SOURCES.vt.name };
}

async function query(src, [lat, lon], fetchImpl) {
  const s = SOURCES[src];
  const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: s.fields, returnGeometry: String(src === 'vt'), outSR: '4326', maxAllowableOffset: '0.00001', geometryPrecision: '6', f: 'json' });
  const r = await fetchImpl(`${s.url}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${src} ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${src} ${j.error.code}`);
  const f = j.features && j.features[0];
  if (!f) return null;
  const ring = src === 'vt' && f.geometry && f.geometry.rings && f.geometry.rings[0];
  const outline = Array.isArray(ring) && ring.length <= 400 ? ring.map(([x, y]) => [+y.toFixed(6), +x.toFixed(6)]) : null;
  return { ...pick(src, f.attributes || {}), outline };
}

// The first point (in the caller's order) that lands on a parcel wins. The state's parcel map gives the lot,
// its address and outline; in Burlington the city's assessor record at the same point adds the year built and
// building type (its own polygons are cut into pieces, so they are not used as outlines).
export async function lookup(pts, fetchImpl = fetch) {
  const found = await Promise.all(pts.map(p => query('vt', p, fetchImpl).catch(() => null)));
  const i = found.findIndex(f => f && f.address);   // roads, water and unnumbered lots are not buildings
  if (i < 0) return { found: false };
  const lot = found[i];
  if (lot.town === 'Burlington') {
    const city = await query('btv', pts[i], fetchImpl).catch(() => null);
    if (city) return { found: true, at: i, ...lot, built: city.built, kind: city.kind, use: city.use || lot.use, source: `${SOURCES.btv.name}; ${SOURCES.vt.name}` };
  }
  return { found: true, at: i, ...lot };
}

export default async function handler(req, res) {
  const pts = parsePoints(req.query && req.query.pts);
  if (!pts) { res.status(400).json({ found: false, error: 'pts must be 1-6 lat,lon pairs inside the map' }); return; }
  try {
    const out = await lookup(pts);
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=86400');   // records change yearly
    res.status(200).json(out);
  } catch (e) {
    console.error('building:', e.message || e);
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(200).json({ found: false, error: 'lookup failed' });
  }
}
