import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeResponseText, validatePublicHttpUrl } from '../src/http.js';

test('validatePublicHttpUrl blocks private IPs without blocking public hostnames that start with fc/fd', () => {
  assert.equal(validatePublicHttpUrl('https://fdns.google/path'), 'https://fdns.google/path');
  assert.equal(validatePublicHttpUrl('https://fccdn.example/path'), 'https://fccdn.example/path');
  assert.throws(() => validatePublicHttpUrl('http://[fd00::1]/'), /Disallowed private or local host/);
  assert.throws(() => validatePublicHttpUrl('http://[fc00::1]/'), /Disallowed private or local host/);
  assert.throws(() => validatePublicHttpUrl('http://metadata.google.internal/'), /Disallowed private or local host/);
});

test('safeResponseText rejects content-length over cap', async () => {
  const response = new Response('', { headers: { 'content-length': '10' } });
  await assert.rejects(() => safeResponseText(response, 'https://example.com', 5), /too large/);
});
