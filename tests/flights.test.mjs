// The flights relay: falls back when a source is down, normalises both feed formats, serves the
// last good answer briefly when every source fails, and answers 200 with no planes after that.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { getAircraft, normalize, SOURCES, _reset } from '../api/flights.js';

const plane = { hex: 'a3c847', flight: 'UAL1878 ', t: 'B738', lat: 44.5, lon: -73.1, alt_baro: 3000, alt_geom: 3100, gs: 200, track: 90, baro_rate: 0, seen_pos: 2 };
const ok = body => ({ ok: true, json: async () => body });
const fake = map => async url => { const f = map[url]; if (!f) throw new Error('timeout'); return f(); };
const at = t => () => t;
const LOL = SOURCES[0].url, FI = SOURCES[1].url;

beforeEach(() => _reset());

test('uses adsb.lol when it answers', async () => {
  const r = await getAircraft(fake({ [LOL]: () => ok({ ac: [plane] }), [FI]: () => ok({ aircraft: [] }) }), at(0));
  assert.equal(r.source, 'adsb.lol'); assert.equal(r.ac.length, 1); assert.equal(r.ac[0].flight, 'UAL1878');
});

test('falls back to adsb.fi, which names the list "aircraft"', async () => {
  const r = await getAircraft(fake({ [FI]: () => ok({ aircraft: [plane] }) }), at(0));
  assert.equal(r.source, 'adsb.fi'); assert.equal(r.ac[0].altFt, 3100);
});

test('a source that just failed is tried last for a while', async () => {
  const calls = [];
  const f = async url => { calls.push(url); if (url === LOL) throw new Error('timeout'); return ok({ aircraft: [plane] }); };
  await getAircraft(f, at(0));
  calls.length = 0;
  await getAircraft(f, at(60_000));
  assert.deepEqual(calls, [FI], 'went straight to the healthy source');
  calls.length = 0;
  await getAircraft(f, at(6 * 60_000));
  assert.equal(calls[0], LOL, 'retries the first source after five minutes');
});

test('a demoted source is still used when the healthy one fails', async () => {
  await getAircraft(fake({ [FI]: () => ok({ aircraft: [plane] }) }), at(0));          // adsb.lol demoted
  const r = await getAircraft(fake({ [LOL]: () => ok({ ac: [plane] }) }), at(10_000));
  assert.equal(r.source, 'adsb.lol');
});

test('serves the last good answer for a minute, dropping planes too old to place, then gives up', async () => {
  await getAircraft(fake({ [LOL]: () => ok({ ac: [plane, { ...plane, hex: 'old', seen_pos: 45 }] }) }), at(0));
  const down = fake({});
  const r = await getAircraft(down, at(20_000));
  assert.equal(r.source, 'stale');
  assert.deepEqual(r.ac.map(a => a.id), ['a3c847'], 'the 45 s-old plane would be 65 s old now');
  assert.equal(r.ac[0].age, 22, 'age grows by the time since the report');
  await assert.rejects(getAircraft(down, at(90_000)), /adsb.lol: timeout; adsb.fi: timeout/);
});

test('stale ages count the time spent waiting on dead sources', async () => {
  await getAircraft(fake({ [LOL]: () => ok({ ac: [plane] }) }), at(0));
  let t = 10_000;
  const slow = async () => { t += 3000; throw new Error('timeout'); };   // each source eats its 3 s timeout
  const r = await getAircraft(slow, () => t);
  assert.equal(r.ac[0].age, 2 + 16, 'reported 2 s old, last good 16 s ago once both timeouts have run');
});

test('an HTTP error or an unexpected body counts as a failure', async () => {
  let r = await getAircraft(fake({ [LOL]: () => ({ ok: false, status: 429 }), [FI]: () => ok({ aircraft: [plane] }) }), at(0));
  assert.equal(r.source, 'adsb.fi');
  _reset();
  r = await getAircraft(fake({ [LOL]: () => ok({ msg: 'rate limited' }), [FI]: () => ok({ aircraft: [plane] }) }), at(0));
  assert.equal(r.source, 'adsb.fi'); assert.equal(r.ac.length, 1);
});

test('drops planes without a position or with an old one', () => {
  assert.equal(normalize({ ac: [{ hex: 'x' }, { ...plane, seen_pos: 90 }, plane] }).length, 1);
  assert.equal(normalize({ ac: [{ ...plane, alt_baro: 'ground' }] })[0].ground, true);
});

test('the handler answers 200 even when every source is down, cached briefly', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('timeout'); };
  const err = console.error; console.error = () => {};
  try {
    const res = { h: {}, setHeader(k, v) { this.h[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    await handler({}, res);
    assert.equal(res.code, 200); assert.deepEqual(res.body.ac, []); assert.equal(res.body.source, 'none');
    assert.equal(res.h['Cache-Control'], 's-maxage=15');
  } finally { globalThis.fetch = real; console.error = err; }
});
