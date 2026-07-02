import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapInstallArgs, callSetupTool, installAllowed } from '../src/bootstrap.js';

test('bootstrapInstallArgs supports documented install_all mode', () => {
  assert.deepEqual(bootstrapInstallArgs('install_all'), ['install', '--env=auto', '--channels=all']);
});

test('bootstrapInstallArgs supports install_core mode', () => {
  assert.deepEqual(bootstrapInstallArgs('install_core'), ['install', '--env=auto']);
});

test('bootstrapInstallArgs treats safe mode as gated install command', () => {
  assert.deepEqual(bootstrapInstallArgs('safe'), ['install', '--env=auto', '--safe']);
});

test('installAllowed is opt-out', () => {
  assert.equal(installAllowed({}), true);
  assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: '0' }), false);
  assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: 'false' }), false);
});

test('reach_setup install blocks when explicitly opted out', async () => {
  const result = await callSetupTool({ action: 'install_all' }, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });

  assert.match(JSON.stringify(result.details), /blocked by PI_SEARCH_ALLOW_INSTALL=0/);
});
