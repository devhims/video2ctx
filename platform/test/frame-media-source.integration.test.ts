import { expect, test } from 'vitest';
import { frameMediaRangeRequest } from '../src/lib/frame-media-source';

test('constructs bounded range requests in workerd without following redirects', () => {
  const request = frameMediaRangeRequest('https://r1.googlevideo.com/videoplayback', 1024, 16, new AbortController().signal);
  expect(request.redirect).toBe('manual');
  expect(request.headers.get('range')).toBe('bytes=1024-1039');
});
