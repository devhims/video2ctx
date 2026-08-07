import { indexPrivateDocument, indexPublicDocument } from '../src/lib/search';

function indexingEnv() {
  const upload = vi.fn(async () => ({ id: 'item-1', key: 'document.md', status: 'queued' }));
  const instance = {
    info: vi.fn(async () => ({ id: 'search-instance' })),
    items: { upload },
  };
  const env = {
    PUBLIC_SEARCH_INSTANCE: 'public-search',
    AI_SEARCH: { get: vi.fn(() => instance) },
    RESEARCH: { put: vi.fn(async () => undefined) },
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ run: vi.fn(async () => ({ success: true })) })),
      })),
    },
  } as unknown as Env;
  return { env, upload };
}

describe('AI Search document indexing', () => {
  test('serializes private custom metadata values as strings for the Items API', async () => {
    const { env, upload } = indexingEnv();

    await indexPrivateDocument(env, {
      userId: 'user-1',
      projectId: 'project-1',
      entityId: 'video-1',
      title: 'A transcript',
      content: 'A useful transcript passage.',
      startMs: 125_000,
    });

    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^project-1-.*\.md$/),
      '# A transcript\n\nA useful transcript passage.',
      { metadata: { project_id: 'project-1', entity_id: 'video-1', start_ms: '125000' } },
    );
  });

  test('serializes public custom metadata values as strings for the Items API', async () => {
    const { env, upload } = indexingEnv();

    await indexPublicDocument(env, {
      entityId: 'video-1',
      title: 'A transcript',
      content: 'A useful transcript passage.',
      language: 'en',
      startMs: 125_000,
    });

    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^video-1-.*\.md$/),
      '# A transcript\n\nA useful transcript passage.',
      { metadata: { entity_id: 'video-1', start_ms: '125000', language: 'en' } },
    );
  });
});
