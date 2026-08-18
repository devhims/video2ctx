import { describe, expect, test, vi } from 'vitest';

import { createSkillTransport } from './transport';

describe('youtube-skills transport', () => {
  test('retries configured response statuses with a bounded delay', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const wait = vi.fn(async () => {});
    const transport = createSkillTransport({
      fetch: fetchMock as unknown as typeof fetch,
      wait,
      random: () => 1,
      policy: { maxAttempts: 2, baseDelayMs: 25, maxDelayMs: 25 },
    });

    await expect(transport.fetch('player', () => ({
      input: 'https://youtube.test/player',
    }))).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(25);
  });

  test('classifies exhausted network failures without leaking request details', async () => {
    const transport = createSkillTransport({
      fetch: vi.fn(async () => { throw new Error('signed-url-secret'); }) as unknown as typeof fetch,
      wait: async () => {},
      policy: { maxAttempts: 2 },
    });

    await expect(transport.fetch('player', () => ({
      input: 'https://youtube.test/player',
    }))).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'YouTube player network request failed after 2 attempts.',
      retryable: true,
    });
  });
});
