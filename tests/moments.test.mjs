// Local moments: the calendar, Champ's schedule and how white the snow makes the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snowCover, groundSnow, momentsAt, champAt, CHAMP_SPOTS } from '../viewer/moments.js';

// a time in Burlington (Eastern; these dates are all standard or daylight time as given)
const at = iso => new Date(iso);

test('fireworks: July 3 after dark and around midnight on New Year, by Burlington time', () => {
  assert.equal(momentsAt(at('2026-07-03T21:40:00-04:00')).fireworks, true);
  assert.equal(momentsAt(at('2026-07-03T20:30:00-04:00')).fireworks, false, 'not before dark');
  assert.equal(momentsAt(at('2026-07-04T21:40:00-04:00')).fireworks, false, 'Burlington does them on the 3rd');
  assert.equal(momentsAt(at('2026-12-31T23:59:00-05:00')).fireworks, true);
  assert.equal(momentsAt(at('2027-01-01T00:10:00-05:00')).fireworks, true);
  assert.equal(momentsAt(at('2027-01-01T01:00:00-05:00')).fireworks, false);
  // 9:40 pm in Burlington is 01:40 UTC the next day: the clock is Burlington's, not the visitor's
  assert.equal(momentsAt(at('2026-07-04T01:40:00Z')).fireworks, true);
  assert.equal(momentsAt(at('2026-11-23T21:40:00-05:00')).fireworks, false);
});

test('holiday lights: from late November to Twelfth Night', () => {
  assert.equal(momentsAt(at('2026-11-23T19:00:00-05:00')).holiday, true);
  assert.equal(momentsAt(at('2026-12-25T19:00:00-05:00')).holiday, true);
  assert.equal(momentsAt(at('2027-01-06T19:00:00-05:00')).holiday, true);
  assert.equal(momentsAt(at('2027-01-07T19:00:00-05:00')).holiday, false);
  assert.equal(momentsAt(at('2026-07-03T21:40:00-04:00')).holiday, false);
  assert.equal(momentsAt(at('2026-11-19T19:00:00-05:00')).holiday, false);
});

test('Champ surfaces now and then: up some of the hours, never for long, always in the lake list', () => {
  let up = 0, runs = 0, run = 0, longest = 0;
  const t0 = Date.parse('2026-11-23T00:00:00Z') / 1000;
  for (let s = 0; s < 86400 * 3; s += 5) {
    const c = champAt(t0 + s);
    if (c) {
      up++; run++; if (run === 1) runs++;
      assert.ok(c.t >= 0 && c.t < 1); assert.ok(c.spot >= 0 && c.spot < CHAMP_SPOTS.length);
    } else { longest = Math.max(longest, run); run = 0; }
  }
  const share = up / (86400 * 3 / 5);
  assert.ok(share > 0.03 && share < 0.1, `up ${(share * 100).toFixed(1)}% of the time`);
  assert.ok(longest * 5 <= 40, `never up longer than 40 s (${longest * 5})`);
  assert.ok(runs > 100, `surfaces many times a day (${runs} in three days)`);
});

test('snow on the ground: none under a centimetre, all white from ten', () => {
  assert.equal(snowCover(0), 0);
  assert.equal(snowCover(0.005), 0);
  assert.equal(snowCover(0.1), 1);
  assert.equal(snowCover(0.5), 1);
  assert.equal(snowCover(null), 0);
  assert.equal(snowCover(NaN), 0);
  let prev = 0;
  for (let d = 0; d <= 0.2; d += 0.002) { const v = snowCover(d); assert.ok(v >= prev && v >= 0 && v <= 1); prev = v; }
  // chosen weather wins; live follows the measurement, or a little while it snows with none
  assert.equal(groundSnow('snow', 0, false), 1);
  assert.equal(groundSnow('clear', 0.3, true), 0);
  assert.equal(groundSnow('rain', 0.3, false), 0);
  assert.equal(groundSnow('live', 0.3, false), 1);
  assert.equal(groundSnow('live', 0, true), 0, 'a measured bare ground stays bare while flakes fall');
  assert.equal(groundSnow('live', null, true), 0.4);
  assert.equal(groundSnow('live', null, false), 0);
});
