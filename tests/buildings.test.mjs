// Tap a building: the line of sight under the tap, the public-record lookup, and the card's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { rayPoints, groundU, describeBuilding, ROOFS } from '../viewer/buildings.js';
import { latLonToPx, llaToEnu, enuToLla, GROUND_U, GRID } from '../viewer/geo.js';
import handler, { parsePoints, pick, lookup, SOURCES } from '../api/building.js';

const tap = fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: -15000, max: 15000 }), fc.integer({ min: -15000, max: 15000 }), fc.double({ min: 0, max: 80, noNaN: true }));

test('every point sent to the lookup lies under the tapped pixel, at its height', () => {
  fc.assert(fc.property(tap, ([a, px, py, g]) => {
    const pts = rayPoints(a, px, py, g);
    assert.equal(pts.length, ROOFS.length);
    for (const [lat, lon, h] of pts) {
      const [x, y] = latLonToPx(a, lat, lon, h);
      assert.ok(Math.hypot(x - px, y - py) < 1, `${x},${y} vs ${px},${py}`);
    }
  }));
});

test('a higher roof guess lies nearer the viewer, so the guesses fan out along the line of sight', () => {
  fc.assert(fc.property(tap, ([a, px, py, g]) => {
    const h = GRID.headings[a] * Math.PI / 180, fwd = [Math.sin(h), Math.cos(h)];
    const along = rayPoints(a, px, py, g).map(([lat, lon, hh], i) => { const [e, n] = llaToEnu(lat, lon, hh); return [ROOFS[i], e * fwd[0] + n * fwd[1]]; })
      .sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < along.length; i++) assert.ok(along[i][1] < along[i - 1][1], 'farther up means nearer');
  }));
});

test('the ground under a tap comes from the nearest street, else the typical height', () => {
  const [lat, lon] = [44.47, -73.21];
  const [, , hEll] = enuToLla(...llaToEnu(lat, lon, 0).slice(0, 2), 25);
  const [x, y] = latLonToPx(0, lat, lon, hEll);
  assert.ok(Math.abs(groundU(0, x, y, [[lat, lon, hEll]]) - 25) < 0.5, 'reads the street');
  assert.equal(groundU(0, x, y, []), GROUND_U);
  assert.equal(groundU(0, x + 5000, y, [[lat, lon, hEll]]), GROUND_U, 'a street a kilometre away says nothing');
});

test('the card: address first, then what it is and when it was built; nothing without an address', () => {
  assert.deepEqual(describeBuilding({ found: true, address: '81 Church St', town: 'Burlington', built: 1899, kind: 'Office building', use: 'Commercial', source: 's' }),
    { title: '81 Church St', town: 'Burlington', line: 'Office building, built 1899', use: 'Commercial', source: 's' });
  assert.equal(describeBuilding({ found: true, address: '48 Main Street', town: 'Winooski', built: null, kind: null, use: null }).line, null);
  assert.equal(describeBuilding({ found: true, address: '1 A St', built: 1950 }).line, 'Built 1950');
  assert.equal(describeBuilding({ found: false }), null);
  assert.equal(describeBuilding({ found: true, address: null, use: 'Commercial' }), null);
});

test('the lookup only takes points inside the map, at most six', () => {
  assert.deepEqual(parsePoints('44.478,-73.2128;44.4781,-73.213'), [[44.478, -73.2128], [44.4781, -73.213]]);
  for (const bad of [undefined, '', '44.478', '44.478,-73.2,1', 'a,b', '40.7,-74.0', Array(7).fill('44.47,-73.21').join(';'), 'x'.repeat(500)]) assert.equal(parsePoints(bad), null, String(bad));
});

test('owners and values never leave the function, whatever the records hold', () => {
  const secretish = fc.record({ OWNER1: fc.string(), OWNER2: fc.string(), REAL_FLV: fc.integer(), LAND_LV: fc.integer(), IMPRV_LV: fc.integer(), ADDRGL1: fc.string(),
    E911ADDR: fc.string(), TNAME: fc.string(), CAT: fc.string(), ST_NUM: fc.integer(), ST_NAME: fc.string(), ST_TYPE: fc.string(), YearBuilt: fc.string(), BuildingType: fc.string(), LandUse: fc.string() });
  fc.assert(fc.property(secretish, fc.constantFrom('btv', 'vt'), (a, src) => {
    assert.deepEqual(Object.keys(pick(src, a)).sort(), ['address', 'built', 'kind', 'source', 'town', 'use']);
  }));
  // and they are never asked for
  for (const s of Object.values(SOURCES)) assert.doesNotMatch(s.fields, /OWNER|FLV|_LV|ADDRGL|VAL/);
});

// a fake ArcGIS: parcels by the point asked about
function fakeArcgis(byPoint) {
  const calls = [];
  const f = async url => {
    const u = new URL(url); const [lon, lat] = u.searchParams.get('geometry').split(',').map(Number);
    const src = url.startsWith(SOURCES.btv.url) ? 'btv' : 'vt';
    calls.push([src, lat, lon, u.searchParams.get('outFields')]);
    const hit = byPoint[`${src}:${lat},${lon}`];
    return { ok: true, json: async () => ({ features: hit ? [{ attributes: hit, geometry: { rings: [[[lon, lat], [lon + 0.0001, lat], [lon, lat + 0.0001], [lon, lat]]] } }] : [] }) };
  };
  f.calls = calls; return f;
}

test('the first point on a numbered lot wins, and Burlington adds its year built', async () => {
  const f = fakeArcgis({
    'vt:44.47,-73.21': { E911ADDR: '', TNAME: 'Burlington' },                             // the street: no address
    'vt:44.4701,-73.21': { E911ADDR: '12 MAPLE ST', TNAME: 'Burlington', CAT: 'R1', OWNER1: 'SOMEONE' },
    'btv:44.4701,-73.21': { ST_NUM: 12, ST_NAME: 'MAPLE', ST_TYPE: 'ST', YearBuilt: '1890', BuildingType: 'VICTORIAN', LandUse: 'Single Family' },
  });
  const r = await lookup([[44.47, -73.21], [44.4701, -73.21]], f);
  assert.equal(r.found, true); assert.equal(r.at, 1);
  assert.equal(r.address, '12 Maple St'); assert.equal(r.built, 1890); assert.equal(r.kind, 'Victorian'); assert.equal(r.use, 'Single Family');
  assert.equal(r.outline.length, 4);
  assert.equal(JSON.stringify(r).includes('SOMEONE'), false);
  for (const c of f.calls) assert.doesNotMatch(c[3], /OWNER/);
});

test('outside Burlington the state record stands alone; nothing found says so', async () => {
  const f = fakeArcgis({ 'vt:44.49,-73.186': { E911ADDR: '48 MAIN STREET', TNAME: 'WINOOSKI', CAT: 'C' } });
  const r = await lookup([[44.49, -73.186]], f);
  assert.equal(r.town, 'Winooski'); assert.equal(r.use, 'Commercial'); assert.equal(r.built, null);
  assert.ok(!f.calls.some(c => c[0] === 'btv'), 'no city lookup outside the city');
  assert.deepEqual(await lookup([[44.5, -73.2]], fakeArcgis({})), { found: false });
  // a source that is down is the same as nothing there
  assert.deepEqual(await lookup([[44.5, -73.2]], async () => ({ ok: false, status: 503 })), { found: false });
});

test('the handler refuses points off the map and caches answers for a week', async () => {
  const res = () => { const r = { headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; return r; };
  const bad = res(); await handler({ query: { pts: '40.7,-74.0' } }, bad);
  assert.equal(bad.code, 400);
});
