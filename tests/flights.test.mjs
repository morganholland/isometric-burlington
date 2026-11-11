// The flights relay: falls back when a source is down, normalises both feed formats, and serves
// the last good answer briefly when every source fails.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAircraft, normalize, SOURCES, _reset } from '../api/flights.js';

const plane = { hex: 'a3c847', flight: 'UAL1878 ', t: 'B738', lat: 44.5, lon: -73.1, alt_baro: 3000, alt_geom: 3100, gs: 200, track: 90, baro_rate: 0, seen_pos: 2 };
const ok = body => ({ ok: true, json: async () => body });
const fake = map => async url => { const f = map[url]; if (!f) throw new Error('timeout'); return f(); };
const LOL = SOURCES[0].url, FI = SOURCES[1].url;

beforeEach(() => _reset());

test('uses adsb.lol when it answers', async () => {
  const r = await getAircraft(fake({ [LOL]: () => ok({ ac: [plane] }), [FI]: () => ok({ aircraft: [] }) }), 0);
  assert.equal(r.source, 'adsb.lol'); assert.equal(r.ac.length, 1); assert.equal(r.ac[0].flight, 'UAL1878');
});

test('falls back to adsb.fi, which names the list "aircraft"', async () => {
  const r = await getAircraft(fake({ [FI]: () => ok({ aircraft: [plane] }) }), 0);
  assert.equal(r.source, 'adsb.fi'); assert.equal(r.ac[0].altFt, 3100);
});

test('a source that just failed is tried last for a while', async () => {
  const calls = [];
  const f = async url => { calls.push(url); if (url === LOL) throw new Error('timeout'); return ok({ aircraft: [plane] }); };
  await getAircraft(f, 0);
  calls.length = 0;
  await getAircraft(f, 60_000);
  assert.deepEqual(calls, [FI], 'went straight to the healthy source');
  calls.length = 0;
  await getAircraft(f, 6 * 60_000);
  assert.equal(calls[0], LOL, 'retries the first source after five minutes');
});

test('serves the last good answer for a minute, then gives up', async () => {
  await getAircraft(fake({ [LOL]: () => ok({ ac: [plane] }) }), 0);
  const down = fake({});
  const r = await getAircraft(down, 20_000);
  assert.equal(r.source, 'stale'); assert.equal(r.ac[0].age, 22, 'age grows by the time since the report');
  await assert.rejects(getAircraft(down, 90_000), /adsb.lol: timeout; adsb.fi: timeout/);
});

test('an HTTP error counts as a failure', async () => {
  const r = await getAircraft(fake({ [LOL]: () => ({ ok: false, status: 429 }), [FI]: () => ok({ aircraft: [plane] }) }), 0);
  assert.equal(r.source, 'adsb.fi');
});

test('drops planes without a position or with an old one', () => {
  assert.equal(normalize({ ac: [{ hex: 'x' }, { ...plane, seen_pos: 90 }, plane] }).length, 1);
  assert.equal(normalize({ ac: [{ ...plane, alt_baro: 'ground' }] })[0].ground, true);
});
