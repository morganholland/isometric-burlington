// The map position lives in the URL hash; analytics must never send it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHash, initTracking } from '../viewer/track.js';

test('analytics drops the map position from every URL it sends', () => {
  const e = stripHash({ event: '$pageleave', properties: {
    $current_url: 'https://isoburlington.com/#a=1&x=17344&y=11840&z=-6',
    $referrer: 'https://isoburlington.com/#a=0&x=1&y=2&z=3',
    $referring_domain: 'news.ycombinator.com',
    $session_entry_url: 'https://isoburlington.com/?utm_source=qa#a=0&x=17000&y=11000&z=-5',
    $pathname: '/', $set_once: { $initial_current_url: 'https://isoburlington.com/?utm_source=x#a=2&x=9&y=9&z=1' },
  } });
  assert.equal(e.properties.$current_url, 'https://isoburlington.com/');
  assert.equal(e.properties.$referrer, 'https://isoburlington.com/');
  assert.equal(e.properties.$set_once.$initial_current_url, 'https://isoburlington.com/?utm_source=x');
  assert.equal(e.properties.$session_entry_url, 'https://isoburlington.com/?utm_source=qa');
  assert.equal(e.properties.$pathname, '/');
  assert.doesNotMatch(JSON.stringify(e), /#a=/);
  assert.equal(stripHash(null), null, 'a dropped event stays dropped');
});

test('analytics only switches on for the live domain', () => {
  assert.equal(initTracking('localhost'), false);
  assert.equal(initTracking('isometric-burlington-git-x.vercel.app'), false);
});
