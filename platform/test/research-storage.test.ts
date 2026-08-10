import { deleteProjectAssets, userSearchInstanceId } from '../src/lib/research-storage';

describe('research storage cleanup', () => {
  test('deletes only the selected project from R2 and the user search instance', async () => {
    const r2Delete = vi.fn(async () => undefined);
    const itemDelete = vi.fn(async () => undefined);
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: [{ search_item_id: 'match-1' }] })) })),
        })),
      },
      RESEARCH: {
        list: vi.fn(async () => ({
          objects: [{ key: 'private/user-1/projects/project-1/document-a.md' }],
          truncated: false,
        })),
        delete: r2Delete,
      },
      AI_SEARCH: {
        get: vi.fn(() => ({ items: { delete: itemDelete } })),
      },
    } as unknown as Env;

    await deleteProjectAssets(env, 'user-1', 'project-1');

    expect(env.RESEARCH.list).toHaveBeenCalledWith({
      prefix: 'private/user-1/projects/project-1/', cursor: undefined, limit: 1000,
    });
    expect(r2Delete).toHaveBeenCalledWith(['private/user-1/projects/project-1/document-a.md']);
    expect(env.DB.prepare).toHaveBeenCalledWith(
      'SELECT search_item_id FROM documents WHERE user_id=? AND project_id=? AND search_item_id IS NOT NULL',
    );
    expect(itemDelete).toHaveBeenCalledTimes(1);
    expect(itemDelete).toHaveBeenCalledWith('match-1');
  });

  test('uses the same normalized per-user AI Search instance identifier as indexing', () => {
    expect(userSearchInstanceId('User!_123')).toBe('user-user_123');
  });
});
