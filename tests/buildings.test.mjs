// Tap a building: which building the line of sight hits, the public-record lookup, and the card's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { groundU, indexBuildings, hitBuilding, insideRing, lookupPoint, describeBuilding } from '../viewer/buildings.js';
import { latLonToPx, llaToEnu, enuToLla, enuToPx, pxToEnu, GROUND_U } from '../viewer/geo.js';
import handler, { parsePoints, pick, lookup, stripUnit, SOURCES } from '../api/building.js';

const tap = fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: -15000, max: 15000 }), fc.integer({ min: -15000, max: 15000 }), fc.double({ min: 0, max: 80, noNaN: true }));

// buildings.json's shape, for a few square buildings: [base, top, e0*2, n0*2, de*2, dn*2, ...]
const square = (e, n, half, base, top) => {
  const pts = [[e - half, n - half], [e + half, n - half], [e + half, n + half], [e - half, n + half]].map(([x, y]) => [Math.round(x * 2), Math.round(y * 2)]);
  const flat = []; let px = 0, py = 0;
  for (const [x, y] of pts) { flat.push(x - px, y - py); px = x; py = y; }
  return [base, top, ...flat];
};
// the ground point on the line of sight under pixel (px, py) at height u
const rayAt = (a, px, py, u) => pxToEnu(a, px, py, u).slice(0, 2);

test('with nothing in the way, a tap lands on the ground right under the pixel', () => {
  fc.assert(fc.property(tap, ([a, px, py, g]) => {
    for (const index of [null, indexBuildings({ b: [] })]) {
      const h = hitBuilding(index, a, px, py, g);
      assert.equal(h.building, null);
      const [x, y] = enuToPx(a, h.e, h.n, g);
      assert.ok(Math.hypot(x - px, y - py) < 0.01);
    }
  }));
});

test('a tap finds the nearest building tall enough to reach the line of sight, never one behind it', () => {
  fc.assert(fc.property(tap, fc.double({ min: 4, max: 40, noNaN: true }), fc.double({ min: 14, max: 40, noNaN: true }), ([a, px, py, g], h, lift) => {
    const [e, n] = rayAt(a, px, py, g + h);                // the roof we mean: the line of sight crosses it mid-roof
    const [eb, nb] = rayAt(a, px, py, g + h - 12);          // a taller building behind it
    const [ef, nf] = rayAt(a, px, py, g + h + 12);          // a low shed in front, well under the line of sight
    const [et, nt] = rayAt(a, px, py, g + h + lift);        // a tower in front that does reach it
    const meant = square(e, n, 4, g, g + h), behind = square(eb, nb, 4, g, g + h + 30), shed = square(ef, nf, 4, g, g + h + 12 - 9);
    const one = indexBuildings({ b: [behind, meant, shed] });
    const hit = hitBuilding(one, a, px, py, g);
    assert.equal(hit.building, one.list[1]);
    assert.ok(insideRing(hit.building.ring, hit.e, hit.n), 'the point asked about is inside the building');
    const two = indexBuildings({ b: [behind, meant, shed, square(et, nt, 4, g, g + h + lift)] });
    assert.equal(hitBuilding(two, a, px, py, g).building, two.list[3]);
  }));
});

test('footprints decode to the outline they were written from', () => {
  fc.assert(fc.property(fc.integer({ min: -9000, max: 9000 }), fc.integer({ min: -9000, max: 9000 }), fc.integer({ min: 2, max: 60 }), (e, n, half) => {
    const [b] = indexBuildings({ b: [square(e, n, half, 30, 42)] }).list;
    assert.deepEqual(b.ring, [[e - half, n - half], [e + half, n - half], [e + half, n + half], [e - half, n + half]]);
    assert.deepEqual([b.base, b.top], [30, 42]);
  }));
});

test('on the real map, a tap on a roof finds that building from all four sides', () => {
  const index = indexBuildings(JSON.parse(readFileSync(new URL('../viewer/buildings.json', import.meta.url))));
  assert.ok(index.list.length > 15000, 'Burlington, South Burlington and Winooski');
  // the Hilton (60 Battery St), Decker Towers (230 St Paul St), a New North End house (62 Venus Ave)
  for (const [name, lat, lon] of [['Hilton', 44.477999, -73.218176], ['Decker Towers', 44.472757, -73.213038], ['Venus Ave', 44.520508, -73.253193]]) {
    const [e, n] = llaToEnu(lat, lon, 0);
    const c = b => b.ring.reduce((s, p) => [s[0] + p[0] / b.ring.length, s[1] + p[1] / b.ring.length], [0, 0]);
    const b = index.list.reduce((m, b) => { const [x, y] = c(b), [mx, my] = c(m); return (x - e) ** 2 + (y - n) ** 2 < (mx - e) ** 2 + (my - n) ** 2 ? b : m; });
    const [ce, cn] = c(b);
    for (let a = 0; a < 4; a++) {
      const [x, y] = enuToPx(a, ce, cn, b.top);
      assert.equal(hitBuilding(index, a, x, y, b.base).building, b, `${name}, angle ${a}`);
    }
  }
});

test('the point asked about is rounded to about a metre, so nearby taps share an answer', () => {
  fc.assert(fc.property(fc.integer({ min: -9000, max: 9000 }), fc.integer({ min: -9000, max: 9000 }), (e, n) => {
    const [lat, lon] = lookupPoint(e, n);
    for (const v of [lat, lon]) assert.match(String(v), /^-?\d+(\.\d{1,5})?$/);
    const [e2, n2] = llaToEnu(lat, lon, 0);
    assert.ok(Math.hypot(e2 - e, n2 - n) < 1);
    assert.deepEqual(parsePoints(`${lat},${lon}`), [[lat, lon]]);
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

test('the lookup takes one point inside the map, to at most 5 decimals', () => {
  assert.deepEqual(parsePoints('44.478,-73.2128'), [[44.478, -73.2128]]);
  for (const bad of [undefined, '', '44.478', '44.478,-73.2,1', 'a,b', '40.7,-74.0', '44.478,-73.2128;44.4781,-73.213', '44.4781234,-73.21', '0x2c,-73.21', '44.47,', 'x'.repeat(500)]) assert.equal(parsePoints(bad), null, String(bad));
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
    return { ok: true, json: async () => ({ features: (hit || []).map(attributes => ({ attributes, geometry: { rings: [[[lon, lat], [lon + 0.0001, lat], [lon, lat + 0.0001], [lon, lat]]] } })) }) };
  };
  f.calls = calls; return f;
}

test('Burlington adds its year built and building type to the state record', async () => {
  const f = fakeArcgis({
    'vt:44.4701,-73.21': [{ E911ADDR: '12 MAPLE ST', TNAME: 'Burlington', CAT: 'R1', OWNER1: 'SOMEONE' }],
    'btv:44.4701,-73.21': [{ ST_NUM: 12, ST_NAME: 'MAPLE', ST_TYPE: 'ST', YearBuilt: '1890', BuildingType: 'VICTORIAN', LandUse: 'Single Family' }],
  });
  const r = await lookup([[44.4701, -73.21]], f);
  assert.equal(r.found, true);
  assert.equal(r.address, '12 Maple St'); assert.equal(r.built, 1890); assert.equal(r.kind, 'Victorian'); assert.equal(r.use, 'Single Family');
  assert.equal(r.outline.length, 4);
  assert.equal(JSON.stringify(r).includes('SOMEONE'), false);
  for (const c of f.calls) assert.doesNotMatch(c[3], /OWNER/);
});

test('a condo is named as the building, never as one unit', async () => {
  assert.equal(stripUnit('37 South Williams St Unit 122'), '37 South Williams St');
  assert.equal(stripUnit('1 Main St Unit A'), '1 Main St');
  assert.equal(stripUnit('1 Steele St Unit 1-4'), '1 Steele St');
  assert.equal(stripUnit('12 Maple St'), '12 Maple St');
  const f = fakeArcgis({ 'vt:44.49,-73.186': [{ E911ADDR: '10 MAIN ST UNIT 3', TNAME: 'WINOOSKI', CAT: 'R1' }, { E911ADDR: '10 MAIN ST UNIT 4', TNAME: 'WINOOSKI', CAT: 'R1' }] });
  assert.equal((await lookup([[44.49, -73.186]], f)).address, '10 Main St');
});

test('outside Burlington the state record stands alone; roads, water and unnumbered lots are nothing', async () => {
  const f = fakeArcgis({ 'vt:44.49,-73.186': [{ E911ADDR: '48 MAIN STREET', TNAME: 'WINOOSKI', CAT: 'C' }] });
  const r = await lookup([[44.49, -73.186]], f);
  assert.equal(r.town, 'Winooski'); assert.equal(r.use, 'Commercial'); assert.equal(r.built, null);
  assert.ok(!f.calls.some(c => c[0] === 'btv'), 'no city lookup outside the city');
  assert.deepEqual(await lookup([[44.5, -73.2]], fakeArcgis({})), { found: false });
  assert.deepEqual(await lookup([[44.5, -73.2]], fakeArcgis({ 'vt:44.5,-73.2': [{ E911ADDR: 'COLLEGE PKWY', TNAME: 'COLCHESTER' }] })), { found: false });
});

const res = () => { const r = { headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; return r; };

test('a source that is down is not "nothing there", and is not remembered for long', async () => {
  for (const down of [async () => ({ ok: false, status: 503 }), async () => ({ ok: true, json: async () => ({ error: { code: 429 } }) }), async () => { throw new Error('timeout'); }]) {
    await assert.rejects(lookup([[44.5, -73.2]], down));
  }
  // the city's record down: the state's answer stands, kept only a minute
  const half = async url => url.startsWith(SOURCES.btv.url) ? { ok: false, status: 500 } : fakeArcgis({ 'vt:44.4701,-73.21': [{ E911ADDR: '12 MAPLE ST', TNAME: 'Burlington', CAT: 'R1' }] })(url);
  const r = await lookup([[44.4701, -73.21]], half);
  assert.equal(r.address, '12 Maple St'); assert.equal(r.partial, true);
});

test('the handler refuses points off the map, caches answers for a week and failures for a minute', async () => {
  const bad = res(); await handler({ query: { pts: '40.7,-74.0' } }, bad);
  assert.equal(bad.code, 400);
  const real = globalThis.fetch;
  try {
    globalThis.fetch = fakeArcgis({ 'vt:44.49,-73.186': [{ E911ADDR: '48 MAIN STREET', TNAME: 'WINOOSKI', CAT: 'C' }] });
    const ok = res(); await handler({ query: { pts: '44.49,-73.186' } }, ok);
    assert.equal(ok.code, 200); assert.match(ok.headers['Cache-Control'], /s-maxage=604800/);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    const down = res(); await handler({ query: { pts: '44.49,-73.186' } }, down);
    assert.equal(down.code, 503); assert.equal(down.headers['Cache-Control'], 's-maxage=60'); assert.equal(down.body.found, false);
  } finally { globalThis.fetch = real; }
});
