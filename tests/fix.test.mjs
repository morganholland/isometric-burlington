// Corrections: what a "Tell me what's wrong here" note sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correction, NOTE_MAX } from '../viewer/fix.js';
import { latLonToPx, GROUND_U } from '../viewer/geo.js';

test('a correction carries the note and the spot, in map pixels and as latitude and longitude', () => {
  for (const a of [0, 1, 2, 3]) {
    const [x, y] = latLonToPx(a, 44.4780, -73.2128, GROUND_U);   // Church Street, on the ground
    const c = correction({ angle: a, x, y, zoom: 0.5 }, '  The Flynn is drawn as a parking lot.  ');
    assert.equal(c.note, 'The Flynn is drawn as a parking lot.');
    assert.deepEqual([c.angle, c.x, c.y, c.zoom], [a, Math.round(x), Math.round(y), 0.5]);
    assert.ok(Math.abs(c.lon - -73.2128) < 2e-5, `lon back in view ${a}: ${c.lon}`);
    assert.ok(Math.abs(c.lat - 44.4780) < 2e-5, `lat back in view ${a}: ${c.lat}`);
    assert.match(c.link, new RegExp(`^https://isoburlington\\.com/#a=${a}&x=`));
  }
});

test('a correction is trimmed to a short note, and an empty one is refused', () => {
  assert.equal(correction({ angle: 0, x: 0, y: 0, zoom: 0 }, '   '), null);
  assert.equal(correction({ angle: 0, x: 0, y: 0, zoom: 0 }, 'x'.repeat(5000)).note.length, NOTE_MAX);
});
