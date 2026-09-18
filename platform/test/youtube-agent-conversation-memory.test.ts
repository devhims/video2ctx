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
  it('retains prior metadata with its observation time', () => {
    const metadata = metadataForConversation([{ recordedAt: 1000, packet: {
      packetId: 'prior-video', kind: 'youtube_video',
      sources: [{ id: 'video', kind: 'video', provider: 'youtube', videoId: 'abcdefghijk', title: 'Video' }],
      excerpts: [], artifacts: [{ type: 'youtube_video_metadata', data: { id: 'abcdefghijk', viewCount: 404433 } }],
      warnings: [], usage: [],
    } as EvidencePacket }]);
    const history = [{ ...turn('summarize', 'A summary without a view count.'), metadata }];
    expect(JSON.stringify(conversationModelMessages(history, 'How many views?'))).toContain('404433');
    expect(JSON.stringify(conversationModelMessages(history, 'How many views?'))).toContain('1970-01-01T00:00:01.000Z');
    expect(boundConversationHistory(history)).toEqual(history);
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

  it('selects the newest ancestors within the turn limit', () => {
    const newestFirst = [
      turn('newest-user', 'newest-assistant'),
      turn('middle-user', 'middle-assistant'),
      turn('oldest-user', 'oldest-assistant'),
    ];

    expect(boundConversationHistory(newestFirst, { maxTurns: 2 }))
      .toEqual([newestFirst[1], newestFirst[0]]);
  });

  it('keeps eight complete turns even when history exceeds 64,000 characters', () => {
    const newestFirst = Array.from({ length: 10 }, (_, index) =>
      turn(`user-${index}`, `${index}:` + 'x'.repeat(65_000)));
    expect(boundConversationHistory(newestFirst)).toEqual(newestFirst.slice(0, 8).reverse());
    const records = newestFirst.map((entry, index) => ({ ...entry,
      parentMessageId: newestFirst[index + 1]?.agentMessageId ?? null }));
    const byId = new Map(records.map(entry => [entry.agentMessageId, entry]));
    expect(resolveConversationHistory(records[0]!.agentMessageId, id => byId.get(id)))
      .toEqual({ ok: true, history: records.slice(0, 8).reverse() });
  });

  it('keeps sibling conversation branches isolated', () => {
    const firstBranch = [turn('topic A', 'answer A')];
    const secondBranch = [turn('topic B', 'answer B')];

    expect(JSON.stringify(conversationModelMessages(firstBranch, 'continue'))).not.toContain('topic B');
    expect(JSON.stringify(conversationModelMessages(secondBranch, 'continue'))).not.toContain('topic A');
  });

  it('reconstructs only the selected parent chain', () => {
    const root = linkedTurn('root', 'root-answer', null);
    const branchA = linkedTurn('branch-a', 'answer-a', root.agentMessageId);
    const branchB = linkedTurn('branch-b', 'answer-b', root.agentMessageId);
    const records = new Map([root, branchA, branchB].map((record) => [record.agentMessageId, record]));

    const resolution = resolveConversationHistory(
      branchA.agentMessageId,
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
    cycle.agentMessageId = 'cycle-id';
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
    agentMessageId: crypto.randomUUID(),
    user,
    assistant,
    resourceIds: [],
  };
}

function linkedTurn(user: string, assistant: string, parentMessageId: string | null): LinkedConversationTurn {
  return { ...turn(user, assistant), parentMessageId };
}
