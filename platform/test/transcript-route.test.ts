vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));

vi.mock('../src/lib/youtube', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/youtube')>();
  return {
    ...original,
    getTranscript: vi.fn(async () => ({
      videoId: 'abcdefghijk',
      track: {
        id: 'a.en', name: 'English', languageCode: 'en', kind: 'asr', provenance: 'asr',
        isTranslatable: true, isDefault: true,
      },
      translatedTo: { languageCode: 'hi', name: 'Hindi' },
      segments: [],
      granularity: 'word',
      text: '',
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
    })),
  };
});

import { app } from '../src/index';
import { getTranscript } from '../src/lib/youtube';

describe('transcript route', () => {
  test('treats lang as the desired output language and leaves source selection to the backend', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await app.request(
      '/v1/videos/abcdefghijk/transcript?lang=hi',
      {},
      {} as Env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(getTranscript).toHaveBeenCalledWith(expect.anything(), 'abcdefghijk', 'hi');
    warning.mockRestore();
  });
});
