// Visitor lists: the whole list lives in the link, so decoding must survive anything someone types or pastes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { encodeList, decodeList, LIMITS } from '../viewer/lists.js';
import { viewHash, readList } from '../viewer/share.js';

const sample = { title: 'Best Maple Creemees ☀️', by: 'Dana', items: [
  { name: 'Church St', note: 'Start here — "always" busy & fun <3', lat: 44.47801, lon: -73.21281 },
  { name: 'Oakledge Park', note: '', lat: 44.4551, lon: -73.2269 },
] };

test('a list survives the trip through a link, accents, emoji, quotes and all', () => {
  const back = decodeList(encodeList(sample));
  assert.deepEqual(back, sample);
  assert.match(encodeList(sample), /^[A-Za-z0-9_-]+$/, 'safe in a URL without escaping');
});

test('a list rides along with the view in the address', () => {
  const l = encodeList(sample);
  const h = viewHash({ angle: 2, x: 10, y: 20, zoom: -1, list: l });
  assert.deepEqual(decodeList(readList(h)), sample);
  assert.equal(readList(viewHash({ angle: 2, x: 10, y: 20, zoom: -1 })), null);
});

test('long lists and long words are cut to size; spots outside the map are dropped', () => {
  const many = { title: 'x'.repeat(500), by: 'y'.repeat(500), items: Array.from({ length: 40 }, (_, i) => ({ name: 'n'.repeat(300), note: 'z'.repeat(2000), lat: 44.47 + i / 1000, lon: -73.21 })) };
  many.items.push({ name: 'Paris', note: '', lat: 48.85, lon: 2.35 });
  const back = decodeList(encodeList(many));
  assert.equal(back.items.length, LIMITS.items);
  assert.equal(back.title.length, LIMITS.title);
  assert.equal(back.by.length, LIMITS.by);
  assert.equal(back.items[0].name.length, LIMITS.name);
  assert.equal(back.items[0].note.length, LIMITS.note);
  assert.ok(back.items.every(i => i.lat < 45));
});

test('a broken or hand-made link never throws: it is a list or nothing', () => {
  fc.assert(fc.property(fc.string(), s => {
    const r = decodeList(s);
    if (r === null) return true;
    return typeof r.title === 'string' && Array.isArray(r.items) && r.items.length > 0
      && r.items.every(i => typeof i.name === 'string' && i.name && Number.isFinite(i.lat) && Number.isFinite(i.lon));
  }), { numRuns: 2000 });
  for (const bad of ['', '%%%', 'e30', encodeURIComponent('{"t":1}'), Buffer.from('{"t":"a","i":[["",1,2]]}').toString('base64url'),
    Buffer.from('{"t":"a","i":[[{"x":1},"",44.47,-73.21]]}').toString('base64url'), Buffer.from('[1,2,3]').toString('base64url')])
    assert.equal(decodeList(bad), null, bad);
});

test('any list made in the builder comes back the same', () => {
  const str = n => fc.string({ maxLength: n });
  const item = fc.record({ name: fc.string({ minLength: 1, maxLength: LIMITS.name }).filter(s => s.trim() === s && s), note: str(LIMITS.note).map(s => s.trim()),
    lat: fc.double({ min: 44.40, max: 44.55, noNaN: true }).map(v => Math.round(v * 1e5) / 1e5),
    lon: fc.double({ min: -73.30, max: -73.10, noNaN: true }).map(v => Math.round(v * 1e5) / 1e5) });
  fc.assert(fc.property(fc.record({ title: str(LIMITS.title).map(s => s.trim()), by: str(LIMITS.by).map(s => s.trim()), items: fc.array(item, { minLength: 1, maxLength: LIMITS.items }) }),
    l => { assert.deepEqual(decodeList(encodeList(l)), l); }), { numRuns: 300 });
});

test('a typical list fits in a link: ten spots with a sentence or two each', async () => {
  const { LINK_MAX } = await import('../viewer/lists.js');
  const note = 'Get the maple creemee, then walk down to the water and sit on the swings until sunset.';
  const items = Array.from({ length: 10 }, (_, i) => ({ name: `Spot number ${i + 1}`, note, lat: 44.47 + i / 1000, lon: -73.21 }));
  const code = encodeList({ title: 'My favourite afternoon in Burlington', by: 'A visitor', items });
  assert.ok(code.length < LINK_MAX, `${code.length} chars`);
});

test('a list link without a view keeps its angle', async () => {
  const { listAngle } = await import('../viewer/share.js');
  assert.equal(listAngle('#a=2&l=abc'), 2);
  assert.equal(listAngle('#l=abc'), 0);
  assert.equal(listAngle('#a=-1&l=abc'), 3);
  assert.equal(listAngle('#a=zz&l=abc'), 0);
});
