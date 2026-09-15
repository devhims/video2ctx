import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorDetails, redact } from '../diagnostics.mjs';

test('redacts URLs, auth headers, tokens and local paths while preserving error text', () => {
  const source = 'HTTP 403 Forbidden https://user:pass@host/video?sig=SIGNED\nAuthorization: Bearer AUTH\nCookie: session=COOKIE\npassword=PASS token=TOKEN\n/app/private/file.js:12';
  const result = redact(source);
  for (const secret of ['SIGNED', 'AUTH', 'COOKIE', 'PASS', 'TOKEN', '/app/private']) assert.ok(!result.includes(secret), result);
  assert.match(result, /HTTP 403 Forbidden/);
});

test('bounds cyclic causes and strips configured proxy credentials', () => {
  const old = process.env.OUTBOUND_PROXY_URL;
  process.env.OUTBOUND_PROXY_URL = 'http://proxyuser:proxypass@proxy.test';
  try {
    const error = Object.assign(new Error('connect ECONNRESET proxypass'), { code: 'ECONNRESET' });
    error.cause = error;
    const serialized = JSON.stringify(errorDetails(error));
    assert.ok(!serialized.includes('proxypass'));
    assert.match(serialized, /ECONNRESET/);
    assert.ok(serialized.length < 20000);
  } finally {
    if (old === undefined) delete process.env.OUTBOUND_PROXY_URL;
    else process.env.OUTBOUND_PROXY_URL = old;
  }
});

test('retains bounded media retry context without accepting arbitrary fields', async () => {
  const { diagnosticDetails } = await import('../diagnostics.mjs');
  assert.deepEqual(diagnosticDetails({ stage: 'media_retry', attempt: 1, delayMs: 250, status: 429,
    url: 'https://media.test/?sig=SECRET' }), { stage: 'media_retry', attempt: 1, delayMs: 250, status: 429 });
});
