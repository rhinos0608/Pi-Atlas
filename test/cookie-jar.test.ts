import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cookieAuthEnvironment, filterCookiesForDomains, importCookiesFromDefaultBrowser, writeCookieState, type BrowserCookie } from '../src/cookie-jar.js';

const cookies: BrowserCookie[] = [
  { name: 'auth', value: 'secret-facebook', domain: '.facebook.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
  { name: 'other', value: 'secret-other', domain: '.example.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
];

test('filterCookiesForDomains keeps only provider domain suffixes', () => {
  const filtered = filterCookiesForDomains(cookies, ['facebook.com']);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.domain, '.facebook.com');
});

test('writeCookieState writes private storageState and omits values from summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-state-'));
  try {
    const summary = await writeCookieState('facebook', [cookies[0]!], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    assert.equal(summary.count, 1);
    assert.equal(summary.storagePath, join(dir, 'cookies', 'facebook.storageState.json'));
    assert.doesNotMatch(JSON.stringify(summary), /secret-facebook|auth/);

    const storage = JSON.parse(await readFile(summary.storagePath, 'utf8')) as { cookies: Array<{ value: string }> };
    assert.equal(storage.cookies[0]?.value, 'secret-facebook');

    if (process.platform !== 'win32') {
      assert.equal((await stat(join(dir, 'cookies'))).mode & 0o777, 0o700);
      assert.equal((await stat(summary.storagePath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cookieAuthEnvironment maps saved Twitter cookies to backend env vars', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-env-'));
  try {
    await writeCookieState('twitter', [
      { name: 'auth_token', value: 'tw-auth-secret', domain: '.x.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'ct0', value: 'tw-ct0-secret', domain: '.x.com', path: '/', expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    assert.deepEqual(cookieAuthEnvironment('twitter', { PI_SEARCH_STATE_DIR: dir }), {
      TWITTER_AUTH_TOKEN: 'tw-auth-secret',
      TWITTER_CT0: 'tw-ct0-secret',
      TWITTER_COOKIE: 'auth_token=tw-auth-secret; ct0=tw-ct0-secret',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('default browser import handles large Chrome expires_utc integers', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('default browser import currently supports macOS only');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-sqlite-'));
  const binDir = join(dir, 'bin');
  const profileDir = join(dir, 'profile');
  const networkDir = join(profileDir, 'Network');
  const stateDir = join(dir, 'state');
  const previousPath = process.env.PATH;
  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(networkDir, { recursive: true });
    const securityPath = join(binDir, 'security');
    await writeFile(securityPath, '#!/bin/sh\necho fake-safe-storage-key\n');
    await chmod(securityPath, 0o700);
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;

    const db = new DatabaseSync(join(networkDir, 'Cookies'));
    db.exec('create table cookies (host_key text, name text, value text, encrypted_value blob, path text, expires_utc integer, is_secure integer, is_httponly integer, samesite integer)');
    db.prepare('insert into cookies values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('.x.com', 'auth_token', 'large-expiry-token', null, '/', 13439400717159052n, 1, 1, 1);
    db.close();

    const result = await importCookiesFromDefaultBrowser({ BROWSER_PROFILE_DIR: profileDir, PI_SEARCH_STATE_DIR: stateDir }, { providers: ['twitter'], force: true });

    assert.equal(result.ok, true);
    assert.equal(result.results[0]?.status, 'imported');
    assert.equal(result.results[0]?.count, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('default browser import honors browser automation opt-out', async () => {
  const result = await importCookiesFromDefaultBrowser({ PI_SEARCH_BROWSER_AUTOMATION: '0' });

  assert.equal(result.ok, false);
  assert.match(result.message, /disabled/);
});

test('default browser import degrades on unsupported platforms', async (t) => {
  if (process.platform === 'darwin') {
    t.skip('macOS path may prompt for Keychain; covered by opt-out and writer tests');
    return;
  }

  const result = await importCookiesFromDefaultBrowser({});
  assert.equal(result.ok, false);
  assert.match(result.message, /macOS/);
});
