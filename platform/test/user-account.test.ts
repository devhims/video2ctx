vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import {
  buildFtsQuery,
  decodeSessionCursor,
  encodeSessionCursor,
  previewFromMessage,
  titleFromMessage,
} from '../src/durable-objects/user-account';
import { userAccountInstanceName } from '../src/routes/agent/agent.index';

describe('user account session catalog helpers', () => {
  test('derives bounded titles and previews without a model call', () => {
    expect(titleFromMessage('  Research\n\nDurable Objects  ')).toBe('Research Durable Objects');
    expect(titleFromMessage('a'.repeat(81))).toBe(`${'a'.repeat(77)}...`);
    expect(previewFromMessage('b'.repeat(241))).toBe(`${'b'.repeat(237)}...`);
  });

  test('builds a tokenized prefix query instead of semantic memory', () => {
    expect(buildFtsQuery('Durable objects: agent-runtime')).toBe(
      '"Durable"* AND "objects"* AND "agent"* AND "runtime"*',
    );
    expect(buildFtsQuery('***')).toBe('');
  });

  test('round trips an opaque pagination cursor and rejects malformed input', () => {
    const cursor = {
      updatedAt: 1234,
      conversationId: '55ad5500-c7a3-4f93-a658-c5acdacb90bd',
    };
    const encoded = encodeSessionCursor(cursor);

    expect(encoded).not.toContain(cursor.conversationId);
    expect(decodeSessionCursor(encoded)).toEqual(cursor);
    expect(() => decodeSessionCursor('not-a-cursor')).toThrow();
  });

  test('routes each authenticated user to a stable isolated object name', async () => {
    await expect(userAccountInstanceName('user-1')).resolves.toBe(
      await userAccountInstanceName('user-1'),
    );
    expect(await userAccountInstanceName('user-1')).not.toBe(
      await userAccountInstanceName('user-2'),
    );
  });
});
