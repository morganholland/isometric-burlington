// The cars: how busy the hour is, and the rules every car keeps while it drives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trafficLevel, buildGraph, laneAt, isRed, isHidden, Traffic } from '../viewer/traffic.js';
import { litShare } from '../viewer/lights.js';
import { viewHash, readViewHash } from '../viewer/share.js';

// a small seeded random source, so a failure can be replayed
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// a street grid in streets.json's own format: n x n junctions, ~100 m apart, some one-way, some with lights
function grid(n, r) {
  const origin = [44.4759, -73.2121], nodes = [], edges = [], signals = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { nodes.push(i * 125, j * 90, 400); if (r() < 0.3) signals.push(j * n + i); }
  const edge = (a, b) => {
    const mid = r() < 0.4 ? [Math.round((nodes[a * 3] + nodes[b * 3]) / 2) + 3, Math.round((nodes[a * 3 + 1] + nodes[b * 3 + 1]) / 2) + 2, 400] : [];
    edges.push([a, b, Math.floor(r() * 6), r() < 0.2 ? 1 : 0, mid, [[20, 40], [], [], []]]);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (i + 1 < n) edge(j * n + i, j * n + i + 1);
    if (j + 1 < n) edge(j * n + i, (j + 1) * n + i);
  }
  return { origin, nodes, signals, edges };
}

test('traffic follows the day: rush hour is busy, 3 am is nearly empty', () => {
  const at = (wd, h) => trafficLevel({ wd, s: h * 3600 });
  assert.ok(at(1, 17) > 0.9);
  assert.ok(at(1, 3) < 0.05);
  assert.ok(at(1, 8) > at(6, 8), 'a weekday morning is busier than a Sunday morning');
  for (let wd = 0; wd < 7; wd++) for (let h = 0; h < 24; h += 0.25) { const v = at(wd, h); assert.ok(v > 0 && v <= 1, `${wd} ${h} ${v}`); }
  assert.ok(Math.abs(at(2, 23.99) - at(2, 0)) < 0.1, 'no jump at midnight');
});

test('streets become one lane per direction of travel', () => {
  const d = grid(3, rng(1));
  const g = buildGraph(d);
  const oneway = d.edges.filter(e => e[3]).length;
  assert.equal(g.lanes.length, d.edges.length * 2 - oneway);
  for (const l of g.lanes) {
    assert.ok(l.len > 50 && l.len < 200, `lane length ${l.len}`);
    const a = laneAt(l, 0), b = laneAt(l, l.len);
    assert.ok(Math.hypot(a.e - g.node[l.from][0], a.n - g.node[l.from][1]) < 0.01);
    assert.ok(Math.hypot(b.e - g.node[l.to][0], b.n - g.node[l.to][1]) < 0.01);
    assert.ok(Math.abs(Math.hypot(...a.dir) - 1) < 1e-9);
  }
});

test('a stretch behind a building hides the car in that view only, from either direction', () => {
  const g = buildGraph({ origin: [44.47, -73.22], nodes: [0, 0, 400, 125, 0, 400], signals: [], edges: [[0, 1, 4, 0, [], [[20, 40], [], [], []]]] });
  const [fwd, back] = g.lanes;
  assert.equal(isHidden(fwd, 0, 30), true);
  assert.equal(isHidden(fwd, 0, 50), false);
  assert.equal(isHidden(fwd, 1, 30), false);
  assert.equal(isHidden(back, 0, back.len - 30), true);
  assert.equal(isHidden(back, 0, 30), false);
});

test('at a light the two cross streets are never green together', () => {
  const d = { origin: [44.47, -73.22], nodes: [0, 0, 400, 125, 0, 400, 0, 90, 400], signals: [0], edges: [[1, 0, 2, 1, [], [[], [], [], []]], [2, 0, 2, 1, [], [[], [], [], []]]] };
  const g = buildGraph(d);
  const [ew, ns] = g.lanes;
  let greenEW = 0, greenNS = 0;
  for (let t = 0; t < 600; t += 0.5) {
    const a = !isRed(g, ew, t), b = !isRed(g, ns, t);
    assert.ok(!(a && b), `both green at ${t}`);
    greenEW += a; greenNS += b;
  }
  assert.ok(greenEW > 400 && greenNS > 400, 'each street gets its turn');
});

test('every car keeps to its lane, behind the car ahead, under the limit, and stops at red (random towns)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed);
    const g = buildGraph(grid(3 + Math.floor(r() * 3), r));
    const sim = new Traffic(g, r);
    const level = 0.3 + r() * 0.7;
    sim.setArea([-100, -100, 700, 700], [0, 0, 450, 450], level);
    let t = 1000 * r(), peak = 0;
    for (let k = 0; k < 900; k++) {
      const dt = 0.01 + r() * 0.09;
      const before = new Map(sim.cars.map(c => [c, { lane: c.lane, s: c.s }]));
      sim.step(dt, t, level); t += dt;
      peak = Math.max(peak, sim.cars.length);
      for (const l of g.lanes) {
        for (let i = 0; i < l.cars.length; i++) {
          const c = l.cars[i];
          assert.equal(c.lane, l, `seed ${seed}: car listed on the wrong lane`);
          assert.ok(c.s >= -1e-6 && c.s <= l.len + 1e-6, `seed ${seed}: car off its lane (${c.s} of ${l.len})`);
          assert.ok(c.v >= 0 && c.v <= 26 * 1.13, `seed ${seed}: speed ${c.v}`);
          if (i > 0) assert.ok(l.cars[i - 1].s - c.s >= l.cars[i - 1].len - 1e-6, `seed ${seed}: cars overlap on a lane`);
        }
      }
      for (const c of sim.cars) {
        const was = before.get(c);
        if (!was) continue;
        if (was.lane === c.lane) assert.ok(c.s >= was.s - 1e-9, `seed ${seed}: a car reversed`);
        else assert.ok(!isRed(g, was.lane, t - dt) || was.lane.len - was.s <= 0.5, `seed ${seed}: a car ran a red light`);
      }
    }
    assert.ok(peak > 0, `seed ${seed}: the town never had a car`);
    assert.ok(sim.cars.length <= 1500);
    sim.setArea(null);
    assert.equal(sim.cars.length, 0, 'switching off clears the streets');
    assert.ok(g.lanes.every(l => l.cars.length === 0));
  }
});

test('a busy hour puts more cars out than a quiet one, and they keep coming', () => {
  const run = level => {
    const r = rng(7), g = buildGraph(grid(6, r)), sim = new Traffic(g, r);
    sim.setArea([-100, -100, 800, 800], [100, 100, 500, 400], level);
    let sum = 0;
    for (let k = 0; k < 2400; k++) { sim.step(0.05, k * 0.05, level); if (k >= 1200) sum += sim.cars.length; }
    return sum / 1200;
  };
  const busy = run(1), quiet = run(0.05);
  assert.ok(busy > quiet * 3, `busy ${busy} vs quiet ${quiet}`);
  assert.ok(busy >= 5, `a busy town keeps its cars after two minutes (${busy})`);
});

test('windows: all lit in the evening, few in the small hours', () => {
  assert.equal(litShare(19), 1);
  assert.ok(litShare(3) < 0.2);
  for (let h = 0; h <= 24; h += 0.25) { const v = litShare(h); assert.ok(v > 0 && v <= 1, `${h} ${v}`); }
});

test('a shared link opens the same view', () => {
  const r = rng(3);
  for (let k = 0; k < 500; k++) {
    const v = { angle: Math.floor(r() * 4), x: Math.round((r() - 0.5) * 80000), y: Math.round((r() - 0.5) * 80000), zoom: Math.round((r() * 9.5 - 6.5) * 4) / 4 || 0, time: ['live', 'day', 'night'][Math.floor(r() * 3)] };
    const back = readViewHash(viewHash(v));
    assert.deepEqual(back, { a: v.angle, x: v.x, y: v.y, z: v.zoom, t: v.time });
  }
  assert.equal(viewHash({ angle: 1, x: 10.4, y: -3.6, zoom: -2.5, time: 'live' }), '#a=1&x=10&y=-4&z=-2.5');
  assert.equal(readViewHash(''), null);
  assert.equal(readViewHash('#about'), null);
  // a mangled link still opens somewhere sensible
  assert.deepEqual(readViewHash('#a=9&x=abc&y=5&z=99&t=dusk'), { a: 1, x: 0, y: 5, z: 3, t: 'live' });
  assert.deepEqual(readViewHash('#a=-1&x=1&y=2&z=-40'), { a: 3, x: 1, y: 2, z: -6.5, t: 'live' });
});
