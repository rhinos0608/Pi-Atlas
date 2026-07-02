import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';

test('callNativeTool rejects unsupported tools', async () => {
  await assert.rejects(
    () => callNativeTool('missing_tool', {}),
    /Unsupported native tool/,
  );
});

test('native browse rejects private localhost URLs before fetching', async () => {
  await assert.rejects(
    () => callNativeTool('agentic_browse', { action: 'read', url: 'http://localhost:3000' }),
    /Disallowed private or local host/,
  );
});

test('native browse rejects non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('agentic_browse', { action: 'read', url: 'file:///etc/passwd' }),
    /Disallowed URL scheme/,
  );
});

test('reach_status reports native feed channel without network', async () => {
  const result = await callNativeTool('reach_status', { family: 'feeds' });

  assert.match(JSON.stringify(result.details), /native-rss-atom/);
});

test('social requires supported platform', async () => {
  await assert.rejects(
    () => callNativeTool('social', { platform: 'myspace', action: 'search', query: 'test' }),
    /platform is required/,
  );
});

test('feeds rejects non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('feeds', { url: 'file:///tmp/feed.xml' }),
    /Disallowed URL scheme/,
  );
});

test('social external wrappers reject non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('social', { platform: 'twitter', action: 'read', url: 'file:///tmp/tweet' }),
    /Disallowed URL scheme/,
  );
});

test('video external wrappers reject non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('video', { platform: 'youtube', action: 'details', url: 'file:///tmp/video' }),
    /Disallowed URL scheme/,
  );
});

test('reach_setup install actions are blocked when opted out', async () => {
  const result = await callNativeTool('reach_setup', { action: 'install_core' }, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });

  assert.match(JSON.stringify(result.details), /blocked by PI_SEARCH_ALLOW_INSTALL=0/);
});

test('reach_setup import cookies can be opted out', async () => {
  const result = await callNativeTool('reach_setup', { action: 'import_cookies' }, { env: { PI_SEARCH_IMPORT_BROWSER_COOKIES: '0' } });

  assert.match(JSON.stringify(result.details), /Browser cookie import disabled/);
});
