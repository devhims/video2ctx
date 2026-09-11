import { metadataForConversation, evidenceWithConversationMetadata, MAX_MEMORY_METADATA_CHARACTERS } from '../src/agents/runtime/conversation-metadata';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import type { EvidencePacket } from '../src/agents/contracts';

function packet(viewCount = 404433, id = 'abcdefghijk'): EvidencePacket {
  return { packetId: `packet:${id}`, kind: 'youtube_video',
    sources: [{ id: `video:${id}`, kind: 'video', provider: 'youtube', videoId: id, title: 'A video' }],
    excerpts: [], artifacts: [{ type: 'youtube_video_metadata', title: 'A video', data: {
      id, viewCount, durationSeconds: 600, channel: { id: 'channel', name: 'Creator', privateToken: 'must-not-leak' },
      privateToken: 'must-not-leak', freshness: { state: 'fresh', fetchedAt: 1000 },
    } }], warnings: [], usage: [{ operation: 'video', credits: 1, cacheStatus: 'miss' }] };
}

test('projects metadata without private fields or historical evidence charges and preserves the fetch timestamp', () => {
  const memory = metadataForConversation([{ packet: packet(), recordedAt: 2000 }]);
  expect(memory[0]?.excerpts[0]?.text).toContain('fetched at: 1970-01-01T00:00:01.000Z');
  expect(memory[0]?.usage).toEqual([]);
  expect(JSON.stringify(memory)).not.toContain('must-not-leak');
});

test('uses recording time explicitly when older packets did not persist a fetch time', () => {
  const old = packet(); delete old.artifacts[0]!.data.freshness;
  expect(metadataForConversation([{ packet: old, recordedAt: 2000 }])[0]?.excerpts[0]?.text)
    .toContain('recorded at: 1970-01-01T00:00:02.000Z');
});

test('excludes bot challenges and transcript payloads from metadata memory', () => {
  const blocked = packet(); blocked.artifacts[0]!.data.availability = {
    status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot",
  };
  expect(metadataForConversation([{ packet: blocked, recordedAt: 2000 },
    { packet: { ...packet(), kind: 'youtube_transcript' }, recordedAt: 3000 }])).toEqual([]);
});

test('bounds metadata and keeps one snapshot per video', () => {
  const records = Array.from({ length: 30 }, (_, i) => ({ packet: packet(i, String(i).padStart(11, '0')), recordedAt: i }));
  const memory = metadataForConversation(records);
  expect(memory.length).toBeLessThanOrEqual(8);
  expect(JSON.stringify(memory).length).toBeLessThanOrEqual(MAX_MEMORY_METADATA_CHARACTERS);
  expect(metadataForConversation([{ packet: packet(1), recordedAt: 1 }, { packet: packet(2), recordedAt: 2 }]))
    .toMatchObject([{ artifacts: [{ data: { viewCount: 2 } }] }]);
});

test('newer history supersedes older snapshots and current evidence supersedes history', () => {
  const first = { metadata: metadataForConversation([{ packet: packet(1), recordedAt: 1000 }]) };
  const second = { metadata: metadataForConversation([{ packet: packet(2), recordedAt: 2000 }]) };
  expect(evidenceWithConversationMetadata([], [first, second])).toEqual(second.metadata);
  const current = packet(3);
  expect(evidenceWithConversationMetadata([current], [first, second])).toEqual([current]);
});

test('remembered metadata is valid cited answer evidence without repeating the prior charge', () => {
  const memory = metadataForConversation([{ packet: packet(), recordedAt: 2000 }]);
  const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID() },
    { userId: 'user', idempotencyKey: 'key-2', creditsRemaining: 100 },
    { intent: 'inspect_video', confidence: 'medium', answer: `It had 404433 views as of the earlier lookup. [cite:${memory[0]!.excerpts[0]!.id}]`, citations: [], artifacts: [], warnings: [] }, memory, 0);
  expect(result.citations[0]).toMatchObject({ videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  expect(result.billing.creditsCharged).toBe(0);
  expect(result.warnings[0]?.code).toBe('HISTORICAL_VIDEO_METADATA');
});
