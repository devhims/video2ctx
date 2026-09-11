import { describe, expect, it } from 'vitest';
import { metadataForConversation } from '../src/agents/runtime/conversation-metadata';
import type { EvidencePacket } from '../src/agents/contracts';
import {
  boundConversationHistory,
  conversationModelMessages,
  resolveConversationHistory,
  type LinkedConversationTurn,
  type ConversationTurn,
} from '../src/agents/runtime/conversation-memory';

describe('YouTube agent conversation memory', () => {
  it('exposes bounded prior metadata and includes it in the history character budget', () => {
    const metadata = metadataForConversation([{ recordedAt: 1000, packet: {
      packetId: 'prior-video', kind: 'youtube_video',
      sources: [{ id: 'video', kind: 'video', provider: 'youtube', videoId: 'abcdefghijk', title: 'Video' }],
      excerpts: [], artifacts: [{ type: 'youtube_video_metadata', data: { id: 'abcdefghijk', viewCount: 404433 } }],
      warnings: [], usage: [],
    } as EvidencePacket }]);
    const history = [{ ...turn('summarize', 'A summary without a view count.'), metadata }];
    expect(JSON.stringify(conversationModelMessages(history, 'How many views?'))).toContain('404433');
    expect(JSON.stringify(conversationModelMessages(history, 'How many views?'))).toContain('1970-01-01T00:00:01.000Z');
    expect(boundConversationHistory(history, { maxCharacters: 100 })).toEqual([]);
  });

  it('keeps a single-turn request free of invented history', () => {
    expect(conversationModelMessages([], 'Inspect this video')).toEqual([
      { role: 'user', content: 'Inspect this video' },
    ]);
  });

  it('passes completed turns to the model in chronological role order', () => {
    const history = [
      turn('first-user', 'first-assistant'),
      turn('second-user', 'second-assistant'),
    ];

    expect(conversationModelMessages(history, 'follow-up')).toEqual([
      { role: 'user', content: 'first-user' },
      { role: 'assistant', content: 'first-assistant' },
      { role: 'user', content: 'second-user' },
      { role: 'assistant', content: 'second-assistant' },
      { role: 'user', content: 'follow-up' },
    ]);
  });

  it('selects the newest ancestors within both turn and character budgets', () => {
    const newestFirst = [
      turn('newest-user', 'newest-assistant'),
      turn('middle-user', 'middle-assistant'),
      turn('oldest-user', 'oldest-assistant'),
    ];

    expect(boundConversationHistory(newestFirst, { maxTurns: 2, maxCharacters: 1_000 }))
      .toEqual([newestFirst[1], newestFirst[0]]);
    expect(boundConversationHistory(newestFirst, { maxTurns: 8, maxCharacters: 60 }))
      .toEqual([newestFirst[1], newestFirst[0]]);
  });

  it('keeps sibling conversation branches isolated', () => {
    const firstBranch = [turn('topic A', 'answer A')];
    const secondBranch = [turn('topic B', 'answer B')];

    expect(JSON.stringify(conversationModelMessages(firstBranch, 'continue'))).not.toContain('topic B');
    expect(JSON.stringify(conversationModelMessages(secondBranch, 'continue'))).not.toContain('topic A');
  });

  it('reconstructs only the selected parent chain', () => {
    const root = linkedTurn('root', 'root-answer', null);
    const branchA = linkedTurn('branch-a', 'answer-a', root.assistantMessageId);
    const branchB = linkedTurn('branch-b', 'answer-b', root.assistantMessageId);
    const records = new Map([root, branchA, branchB].map((record) => [record.assistantMessageId, record]));

    const resolution = resolveConversationHistory(
      branchA.assistantMessageId,
      (messageId) => records.get(messageId),
    );

    expect(resolution).toMatchObject({ ok: true });
    if (!resolution.ok) throw new Error('Expected a complete branch.');
    expect(resolution.history.map((entry) => entry.user)).toEqual(['root', 'branch-a']);
    expect(JSON.stringify(resolution.history)).not.toContain('branch-b');
  });

  it('rejects unavailable and cyclic parent chains', () => {
    expect(resolveConversationHistory('missing', () => undefined)).toEqual({
      ok: false,
      issue: 'unavailable',
      messageId: 'missing',
    });

    const cycle = linkedTurn('cycle', 'cycle-answer', 'cycle-id');
    cycle.assistantMessageId = 'cycle-id';
    expect(resolveConversationHistory('cycle-id', () => cycle)).toEqual({
      ok: false,
      issue: 'cycle',
      messageId: 'cycle-id',
    });
  });

  it('attaches recovered evidence only to the current request', () => {
    const messages = conversationModelMessages(
      [turn('prior-user', 'prior-assistant')],
      'current-user',
      [{ packetId: 'packet-1' }],
    );

    expect(messages[1]).toEqual({ role: 'assistant', content: 'prior-assistant' });
    expect(JSON.stringify(messages[2])).toContain('current-user');
    expect(JSON.stringify(messages[2])).toContain('packet-1');
  });
});

function turn(user: string, assistant: string): ConversationTurn {
  return {
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    user,
    assistant,
    resourceIds: [],
  };
}

function linkedTurn(user: string, assistant: string, parentMessageId: string | null): LinkedConversationTurn {
  return { ...turn(user, assistant), parentMessageId };
}
