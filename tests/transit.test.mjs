// Timetable buses: position along the route by the clock, service days, holidays, trips past midnight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busesAt, prepare, burlingtonClock } from '../viewer/transit.js';
import { llaToEnu } from '../viewer/geo.js';
import fs from 'node:fs';

const lat = 44.4759, lon0 = -73.22, lon1 = lon0 + 1000 / (111320 * Math.cos(lat * Math.PI / 180));
const mk = () => prepare({
  routes: { r7: ['7', '#ff0000', 'North Avenue'] },
  shapes: [[[lat, lon0, 10, 0], [lat, lon1, 10, 1000]]],
  services: [0b0000001, 0b0000001, 0],   // Mondays; Mondays (another service); only on listed dates
  trips: [
    ['r7', 0, 0, [8 * 3600, 0, 8 * 3600 + 600, 1000]],          // Mondays 8:00-8:10
    ['r7', 1, 0, [24 * 3600 + 600, 0, 24 * 3600 + 1200, 1000]],  // Monday's 00:10-00:20 (Tuesday early)
    ['r7', 2, 0, [12 * 3600, 0, 12 * 3600 + 600, 1000]],         // noon, special dates only
  ],
  dates: { 20261130: { off: [0], on: [] }, 20261201: { off: [], on: [2] } },
});

test('a bus halfway through its trip is halfway along the route', () => {
  const b = busesAt(mk(), { ymd: '20261109', wd: 0, s: 8 * 3600 + 300 });
  assert.equal(b.length, 1);
  const [e0] = llaToEnu(lat, lon0, 10), [e1] = llaToEnu(lat, lon1, 10);
  assert.ok(Math.abs(b[0].e - (e0 + e1) / 2) < 1, `${b[0].e} vs ${(e0 + e1) / 2}`);
  assert.ok(b[0].dir[0] > 0.99, 'heading east');
});

test('no bus before or after the trip, or on another day', () => {
  const d = mk();
  assert.equal(busesAt(d, { ymd: '20261109', wd: 0, s: 7 * 3600 }).length, 0);
  assert.equal(busesAt(d, { ymd: '20261109', wd: 0, s: 9 * 3600 }).length, 0);
  assert.equal(busesAt(d, { ymd: '20261110', wd: 1, s: 8 * 3600 + 300 }).length, 0);
});

test('a holiday takes only its own service off, and a special date adds one', () => {
  assert.equal(busesAt(mk(), { ymd: '20261130', wd: 0, s: 8 * 3600 + 300 }).length, 0);
  assert.equal(busesAt(mk(), { ymd: '20261201', wd: 1, s: 900 }).length, 1, 'Monday-night trip of the other service still runs');
  assert.equal(busesAt(mk(), { ymd: '20261201', wd: 1, s: 12 * 3600 + 300 }).length, 1);
  assert.equal(busesAt(mk(), { ymd: '20261202', wd: 2, s: 12 * 3600 + 300 }).length, 0);
});

test("a trip after midnight belongs to the day before", () => {
  const b = busesAt(mk(), { ymd: '20261110', wd: 1, s: 900 });
  assert.equal(b.length, 1);
});

test('the Burlington clock is in New York time', () => {
  const c = burlingtonClock(new Date('2026-11-10T13:30:00Z'));   // 8:30 am EST, a Tuesday
  assert.equal(c.ymd, '20261110'); assert.equal(c.wd, 1); assert.equal(Math.round(c.s), 8 * 3600 + 1800);
});

test('the real timetable puts buses on the map on a weekday morning', () => {
  const data = prepare(JSON.parse(fs.readFileSync('viewer/transit.json', 'utf8')));
  const b = busesAt(data, { ymd: '20261110', wd: 1, s: 8 * 3600 });
  assert.ok(b.length >= 8 && b.length < 120, `${b.length} buses`);
  for (const x of b) assert.ok(Math.hypot(x.e, x.n) < 40000 && x.u > -20 && x.u < 200, JSON.stringify(x));
});
