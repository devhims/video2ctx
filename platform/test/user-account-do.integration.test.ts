import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';

const CONVERSATION_A = 'a08cff6c-326e-47f7-b771-59ff58c48846';
const CONVERSATION_B = 'e665d2a1-f9f9-4b7f-8b7c-0bf0a1393c3b';
const CONVERSATION_C = 'cfb5309a-954f-4e4a-9b0e-2d673c708f20';

describe('UserAccountDO', () => {
  test('records sessions idempotently and preserves the first-message title', async () => {
    const account = env.USER_ACCOUNT.getByName('user:catalog-idempotency');
    await account.recordSession({
      conversationId: CONVERSATION_A,
      runId: '6c5496c8-0efe-450b-b2d7-b5d0d2c105aa',
      message: 'Research Durable Object coordination',
      updatedAt: 100,
    });
    await account.recordSession({
      conversationId: CONVERSATION_A,
      runId: '6c5496c8-0efe-450b-b2d7-b5d0d2c105aa',
      message: 'Research Durable Object coordination',
      updatedAt: 100,
    });
    await account.recordSession({
      conversationId: CONVERSATION_A,
      runId: '540208c8-4d9d-43e0-842e-0bdd331ff4d9',
      message: 'Now compare it with D1',
      updatedAt: 200,
    });

    const page = await account.listSessions({});
    expect(page.sessions).toEqual([expect.objectContaining({
      conversationId: CONVERSATION_A,
      title: 'Research Durable Object coordination',
      latestMessagePreview: 'Now compare it with D1',
      runCount: 2,
      updatedAt: 200,
    })]);
    await expect(account.getSession(CONVERSATION_A)).resolves.toMatchObject({
      conversationId: CONVERSATION_A,
      runCount: 2,
      title: 'Research Durable Object coordination',
    });
  });

  test('searches user prompts with FTS5 and paginates by recent activity', async () => {
    const account = env.USER_ACCOUNT.getByName('user:catalog-search');
    await account.recordSession({
      conversationId: CONVERSATION_A,
      runId: 'b0c16b5d-6d0b-433d-a000-50464eea39ab',
      message: 'Research Cloudflare Durable Objects',
      updatedAt: 100,
    });
    await account.recordSession({
      conversationId: CONVERSATION_B,
      runId: '1f500067-ea34-45d1-a394-fc80d82e67ab',
      message: 'Inspect a YouTube architecture video',
      updatedAt: 200,
    });
    await account.recordSession({
      conversationId: CONVERSATION_C,
      runId: '8051cf66-34fa-4780-935d-7f2f6173f5ea',
      message: 'Compare Durable Object storage options',
      updatedAt: 300,
    });

    const search = await account.listSessions({ query: 'dur obj', limit: 10 });
    expect(search.sessions.map((session) => session.conversationId)).toEqual([
      CONVERSATION_C,
      CONVERSATION_A,
    ]);

    const firstPage = await account.listSessions({ limit: 2 });
    expect(firstPage.sessions.map((session) => session.conversationId)).toEqual([
      CONVERSATION_C,
      CONVERSATION_B,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await account.listSessions({ limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.sessions.map((session) => session.conversationId)).toEqual([CONVERSATION_A]);
    expect(secondPage.nextCursor).toBeNull();
  });

  test('keeps separate users in separate Durable Objects', async () => {
    const first = env.USER_ACCOUNT.getByName('user:first');
    const second = env.USER_ACCOUNT.getByName('user:second');
    await first.recordSession({
      conversationId: CONVERSATION_A,
      runId: 'f4e21122-5141-4872-b298-a0ae76ad19e1',
      message: 'Private first-user session',
      updatedAt: 100,
    });

    await expect(first.listSessions({})).resolves.toMatchObject({ sessions: [{ conversationId: CONVERSATION_A }] });
    await expect(first.getSession(CONVERSATION_A)).resolves.toMatchObject({ conversationId: CONVERSATION_A });
    await expect(second.listSessions({})).resolves.toEqual({ sessions: [], nextCursor: null });
    await expect(second.getSession(CONVERSATION_A)).resolves.toBeNull();
  });
});
