import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolvePlatformBaseUrl } from './platform-proxy.ts';

describe('platform proxy target', () => {
  test('keeps localhost demo authentication on the local platform', () => {
    assert.equal(resolvePlatformBaseUrl({
      configuredBaseUrl: 'https://api.video2ctx.dev',
      nodeEnv: 'development',
      requestHostname: 'localhost',
      demoUser: 'local-beta',
    }), 'http://localhost:8787');
  });

  test('never redirects a production request to the local platform', () => {
    assert.equal(resolvePlatformBaseUrl({
      configuredBaseUrl: 'https://api.video2ctx.dev',
      nodeEnv: 'production',
      requestHostname: 'localhost',
      demoUser: 'local-beta',
    }), 'https://api.video2ctx.dev');
  });

  test('respects the configured target for non-loopback development hosts', () => {
    assert.equal(resolvePlatformBaseUrl({
      configuredBaseUrl: 'https://preview.example',
      nodeEnv: 'development',
      requestHostname: 'dashboard.test',
      demoUser: 'local-beta',
    }), 'https://preview.example');
  });
});
