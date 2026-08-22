import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import robots from '../app/robots.ts';
import sitemap from '../app/sitemap.ts';
import { SITE_URL } from './site.ts';

describe('public discovery metadata', () => {
  test('publishes a canonical sitemap and keeps private application routes out of crawlers', () => {
    assert.deepEqual(robots(), {
      rules: {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/dashboard', '/device'],
      },
      sitemap: `${SITE_URL}/sitemap.xml`,
      host: SITE_URL,
    });
  });

  test('lists only canonical public pages', () => {
    assert.deepEqual(
      sitemap().map(({ url }) => url),
      [`${SITE_URL}/`, `${SITE_URL}/privacy`, `${SITE_URL}/terms`],
    );
  });
});
