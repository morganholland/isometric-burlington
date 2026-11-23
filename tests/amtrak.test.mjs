// The Amtrak Ethan Allen Express on its timetable: joined onto the buses, placed by the clock, drawn as a train.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fc from 'fast-check';
import { busesAt, prepare, mergeTransit, trainCars, TRAIN } from '../viewer/transit.js';

const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const both = () => prepare(mergeTransit(json('viewer/transit.json'), json('viewer/amtrak.json')));
const trains = (data, ymd, wd, s) => busesAt(data, { ymd, wd, s }).filter(b => data.routes[b.route]?.[3] === 'train');
const hm = (h, m) => h * 3600 + m * 60;

test('joining two timetables keeps every trip on its own shape and service', () => {
  const tt = fc.record({
    shapes: fc.array(fc.constant([[44.47, -73.21, 10, 0], [44.48, -73.21, 10, 1000]]), { minLength: 1, maxLength: 4 }),
    services: fc.array(fc.integer({ min: 0, max: 127 }), { minLength: 1, maxLength: 4 }),
  }).chain(t => fc.record({
    routes: fc.constant({ [`r${t.shapes.length}${t.services.length}`]: ['1', '#000', 'x'] }),
    shapes: fc.constant(t.shapes), services: fc.constant(t.services),
    trips: fc.array(fc.tuple(fc.nat(t.services.length - 1), fc.nat(t.shapes.length - 1)).map(([v, s]) => ['r', v, s, [0, 0, 60, 1000]]), { maxLength: 5 }),
    dates: fc.dictionary(fc.constantFrom('20261124', '20261225'), fc.record({ off: fc.array(fc.nat(t.services.length - 1)), on: fc.array(fc.nat(t.services.length - 1)) })),
  }));
  fc.assert(fc.property(tt, tt, (a, b) => {
    const m = mergeTransit(a, b);
    assert.equal(m.trips.length, a.trips.length + b.trips.length);
    b.trips.forEach((t, i) => {
      const u = m.trips[a.trips.length + i];
      assert.deepEqual(m.shapes[u[2]], b.shapes[t[2]]);
      assert.equal(m.services[u[1]], b.services[t[1]]);
    });
    for (const [ymd, ex] of Object.entries(b.dates)) for (const k of ['off', 'on']) for (const v of ex[k]) assert.ok(m.dates[ymd][k].includes(v + a.services.length));
    for (const [ymd, ex] of Object.entries(a.dates)) for (const k of ['off', 'on']) assert.deepEqual(m.dates[ymd][k].slice(0, ex[k].length), ex[k]);
  }));
});

test('the evening train comes up the lake shore and reaches Union Station on time', () => {
  const d = both();
  // 9:20 pm: train 291 is on the map, south of downtown, heading north, still moving a minute before it is due
  const t = trains(d, '20261124', 1, hm(21, 20));
  assert.equal(t.length, 1);
  const [a] = trains(d, '20261124', 1, hm(21, 25)), [b] = trains(d, '20261124', 1, hm(21, 25) + 30);
  assert.equal(a.trip[4], '291'); assert.ok(b.dist - a.dist > 100, 'still moving at 9:25 pm');
  assert.equal(t[0].trip[4], '291');
  assert.ok(t[0].dir[1] > 0.5, 'heading north');
  // 9:26 pm it is in, and stays parked at the station overnight
  for (const [ymd, wd, s] of [['20261124', 1, hm(21, 30)], ['20261125', 2, hm(3, 0)], ['20261125', 2, hm(9, 20)]]) {
    const p = trains(d, ymd, wd, s);
    assert.equal(p.length, 1, `${ymd} ${s}`);
    assert.equal(p[0].trip[5], 'parked');
  }
  // 9:30 am train 290 is leaving southbound; mid-afternoon there is no train here
  const m = trains(d, '20261125', 2, hm(9, 30));
  assert.equal(m.length, 1); assert.equal(m[0].trip[4], '290'); assert.ok(m[0].dir[1] < -0.5, 'heading south');
  assert.equal(trains(d, '20261125', 2, hm(15, 0)).length, 0);
});

test('a train is a locomotive and five coaches in a line along the track, all on the map', () => {
  const d = both();
  for (const s of [hm(21, 20), hm(23, 0), hm(9, 25), hm(9, 30)]) {
    for (const b of trains(d, '20261124', 1, s)) {
      const cars = trainCars(d.shapes[b.si], b.dist);
      assert.equal(cars.length, TRAIN.cars.length, `all cars at ${s}`);
      for (let k = 1; k < cars.length; k++) {
        const gap = Math.hypot(cars[k].e - cars[k - 1].e, cars[k].n - cars[k - 1].n);
        const want = (TRAIN.cars[k] + TRAIN.cars[k - 1]) / 2 + TRAIN.gap;
        assert.ok(Math.abs(gap - want) < 3, `car ${k} ${gap.toFixed(1)} m behind, want ${want}`);
      }
      for (const c of cars) assert.ok(c.u > -20 && c.u < 60, `height ${c.u}`);
      // one train, one level: no car steps up or down against its neighbour
      for (let k = 1; k < cars.length; k++) assert.ok(Math.abs(cars[k].u - cars[k - 1].u) < 2, `car ${k} height step`);
    }
  }
});

test('overnight the train stands at the end of the track facing south, and leaves without a jump', () => {
  const d = both();
  const [p] = trains(d, '20261124', 1, hm(23, 0));
  const sh = d.shapes[p.si], buffer = sh[0];
  const cars = trainCars(sh, p.dist);
  const last = cars[cars.length - 1];
  assert.ok(Math.hypot(last.e - buffer[4], last.n - buffer[5]) < 40, 'last coach at the buffer');
  assert.ok(cars[0].dir[1] < -0.5, 'locomotive facing south, the way it leaves');
  const at = s => { const [b] = trains(d, '20261125', 2, s); return trainCars(d.shapes[b.si], b.dist)[0]; };
  const before = at(hm(9, 25) - 1), after = at(hm(9, 25) + 1);
  assert.ok(Math.hypot(after.e - before.e, after.n - before.n) < 5, 'no jump at 9:25 am');
});

test('the train runs on the real rails: every track point near the map is within a few metres of the rail line', () => {
  const rails = json('data/rail_amtrak.geojson').features.flatMap(f => f.geometry.coordinates.slice(1).map((b, i) => [f.geometry.coordinates[i], b]));
  const m = (lat, lon, [a, b]) => {
    const k = Math.cos(lat * Math.PI / 180), X = x => x * 111320 * k, Y = y => y * 110950;
    const ax = X(a[0]), ay = Y(a[1]), bx = X(b[0]), by = Y(b[1]), qx = X(lon), qy = Y(lat), dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
    return Math.hypot(qx - ax - t * dx, qy - ay - t * dy);
  };
  for (const sh of json('viewer/amtrak.json').shapes) for (const [lat, lon] of sh) {
    if (lat < 44.39 || lat > 44.55) continue;
    const near = Math.min(...rails.map(r => m(lat, lon, r)));
    assert.ok(near < 3, `${lat},${lon} is ${near.toFixed(1)} m off the rails`);
  }
});
