import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUrl, rrfMerge } from '../src/fusion.js';

test('normalizeUrl canonicalizes URL variants for dedup', () => {
  assert.equal(
    normalizeUrl('https://www.Example.com/path/?utm_source=x&a=1#section'),
    'https://example.com/path?a=1',
  );
});

test('rrfMerge dedupes within rankings and boosts cross-ranking agreement', () => {
  const fused = rrfMerge([
    [{ url: 'https://a.test', title: 'A1' }, { url: 'https://a.test/', title: 'A duplicate' }, { url: 'https://b.test', title: 'B' }],
    [{ url: 'https://b.test/', title: 'B2' }, { url: 'https://c.test', title: 'C' }, { url: 'https://a.test', title: 'A2' }],
  ], { keyFn: (item) => normalizeUrl(item.url) });

  assert.deepEqual(fused.map((result) => normalizeUrl(result.item.url)), [
    'https://b.test/',
    'https://a.test/',
    'https://c.test/',
  ]);
  assert.ok(fused[0]!.rrfScore > fused[2]!.rrfScore);
});
