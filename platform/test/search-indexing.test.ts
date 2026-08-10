import { indexPrivateDocument, indexPublicDocument } from '../src/lib/search';

function indexingEnv() {
  const upload = vi.fn(async () => ({ id: 'item-1', key: 'document.md', status: 'queued' }));
  const itemDelete = vi.fn(async () => undefined);
  const instance = {
    info: vi.fn(async () => ({ id: 'search-instance' })),
    items: { upload, delete: itemDelete },
  };
  const bind = vi.fn(() => ({
    first: vi.fn(async () => ({ exists: 1 })),
    run: vi.fn(async () => ({ success: true })),
  }));
  const env = {
    PUBLIC_SEARCH_INSTANCE: 'public-search',
    AI_SEARCH: { get: vi.fn(() => instance) },
    RESEARCH: { put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    DB: {
      prepare: vi.fn(() => ({ bind })),
    },
  } as unknown as Env;
  return { env, upload, itemDelete, bind };
}

describe('AI Search document indexing', () => {
  test('serializes private custom metadata values as strings for the Items API', async () => {
    const { env, upload } = indexingEnv();

    await indexPrivateDocument(env, {
      provider: 'youtube',
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
      { metadata: { provider: 'youtube', project_id: 'project-1', entity_id: 'video-1', start_ms: '125000' } },
    );
  });

  test('skips private indexing after its project has been deleted', async () => {
    const { env, upload } = indexingEnv();
    vi.mocked(env.DB.prepare).mockReturnValueOnce({
      bind: vi.fn(() => ({ first: vi.fn(async () => null) })),
    } as unknown as D1PreparedStatement);

    const result = await indexPrivateDocument(env, {
      provider: 'youtube', userId: 'user-1', projectId: 'deleted-project', entityId: 'video-1',
      title: 'Deleted', content: 'No longer needed.',
    });

    expect(result).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(env.RESEARCH.put).not.toHaveBeenCalled();
  });

  test('serializes public custom metadata values as strings for the Items API', async () => {
    const { env, upload, bind } = indexingEnv();

    await indexPublicDocument(env, {
      provider: 'youtube',
      entityId: 'video-1',
      title: 'A transcript',
      content: 'A useful transcript passage.',
      language: 'en',
      startMs: 125_000,
    });

    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^video-1-.*\.md$/),
      '# A transcript\n\nA useful transcript passage.',
      { metadata: { provider: 'youtube', entity_id: 'video-1', start_ms: '125000', language: 'en' } },
    );
    expect(bind).toHaveBeenCalledWith(
      expect.any(String), 'youtube', 'video-1', 'en', 'A transcript', 'A useful transcript passage.',
      expect.stringMatching(/^public\/youtube\/videos\/video-1\/.*\.md$/), 'item-1', expect.any(Number), expect.any(Number),
    );
  });

  test('removes partial private uploads when a concurrent project deletion rejects the document row', async () => {
    const { env, itemDelete } = indexingEnv();
    vi.mocked(env.DB.prepare)
      .mockReturnValueOnce({ bind: vi.fn(() => ({ first: vi.fn(async () => ({ exists: 1 })) })) } as unknown as D1PreparedStatement)
      .mockReturnValueOnce({ bind: vi.fn(() => ({ run: vi.fn(async () => { throw new Error('FOREIGN KEY constraint failed'); }) })) } as unknown as D1PreparedStatement)
      .mockReturnValueOnce({ bind: vi.fn(() => ({ first: vi.fn(async () => null) })) } as unknown as D1PreparedStatement);

    const result = await indexPrivateDocument(env, {
      provider: 'youtube', userId: 'user-1', projectId: 'project-1', entityId: 'video-1',
      title: 'A transcript', content: 'A useful transcript passage.',
    });

    expect(result).toBeNull();
    expect(env.RESEARCH.delete).toHaveBeenCalledWith(expect.stringMatching(/^private\/user-1\/projects\/project-1\//));
    expect(itemDelete).toHaveBeenCalledWith('item-1');
  });
});
