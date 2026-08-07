vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));

vi.mock('../src/lib/youtube', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/youtube')>();
  return {
    ...original,
    getCaptionTracks: vi.fn(async () => ({
      tracks: [],
      sourceTracks: [],
      translationLanguages: [],
      autoTranslationTargets: [],
      meta: { source: 'allthingsyoutube', fetchedAt: '2026-08-06T00:00:00.000Z', partial: false, warnings: [] },
    })),
  };
});

import { app } from '../src/index';
import { getCaptionTracks } from '../src/lib/youtube';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('tracks route', () => {
  test('returns transcript track metadata from the canonical route', async () => {
    const response = await app.request(
      '/v1/videos/abcdefghijk/tracks',
      {},
      {} as Env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(getCaptionTracks).toHaveBeenCalledWith('abcdefghijk');
    await expect(response.json()).resolves.toMatchObject({ sourceTracks: [], autoTranslationTargets: [] });
  });

  test('does not expose the former captions route', async () => {
    const response = await app.request(
      '/v1/videos/abcdefghijk/captions',
      {},
      {} as Env,
      executionContext,
    );

    expect(response.status).toBe(404);
  });
});
