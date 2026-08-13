import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InspectionRequestError,
  isLandingDemoLimitError,
  transcriptExcerptText,
} from '../app/_lib/inspect.ts';

test('formats a copied transcript excerpt with playable timestamps', () => {
  assert.equal(
    transcriptExcerptText([
      { startMs: 800, durationMs: 1200, endMs: 2000, text: 'First source moment' },
      { startMs: 65_000, durationMs: 1600, endMs: 66_600, text: 'Second source moment' },
    ]),
    '[0:00] First source moment\n[1:05] Second source moment',
  );
});

test('returns an empty string when no transcript segments are available', () => {
  assert.equal(transcriptExcerptText([]), '');
});

test('recognizes only the public landing-page inspection limit', () => {
  assert.equal(
    isLandingDemoLimitError(
      new InspectionRequestError(
        429,
        'LANDING_DEMO_LIMIT_REACHED',
        'Limit reached.',
      ),
    ),
    true,
  );
  assert.equal(
    isLandingDemoLimitError(
      new InspectionRequestError(429, 'RATE_LIMITED', 'Try again later.'),
    ),
    false,
  );
});
