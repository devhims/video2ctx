import { MockLanguageModelV4 } from 'ai/test';
import {
  generateMemoryDelta,
  MEMORY_UPDATE_COST_RESERVE_MICROS,
  MEMORY_UPDATE_TIMEOUT_MESSAGE,
  memoryUpdaterPrompt,
  projectMemoryUpdaterInput,
  validateMemoryDelta,
  type MemoryDelta,
  type MemoryUpdaterInput,
} from '../src/agents/runtime/memory-updater';
import type { AgentCitation } from '../src/agents/contracts';
import type { SessionMemory } from '../src/agents/runtime/session-evidence';

const usage = { inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 30, text: 30, reasoning: 0 } };
const citation = (id: string): AgentCitation => ({ id, sourceId: 'video', provider: 'youtube', videoId: 'abcdefghijk', excerpt: `Excerpt ${id}` });
const memory = (topic: string, updatedAt: number, kind: SessionMemory['kind'] = 'context', text = `About ${topic}`): SessionMemory =>
  ({ id: `${kind}:${topic.toLowerCase()}`, kind, topic, text, evidenceIds: [], runId: 'earlier', updatedAt });
const input = (overrides: Partial<MemoryUpdaterInput> = {}): MemoryUpdaterInput => ({
  question: 'Compare the interviewers. I only care about the second video.',
  answer: 'The woman holds the microphone. [cite:evidence:a:0]',
  citations: [citation('evidence:a:0')],
  memories: [memory('focus', 2), memory('format', 1)],
  ...overrides,
});
const change = (value: Partial<MemoryDelta['changes'][number]>): MemoryDelta['changes'][number] =>
  ({ action: 'upsert', kind: 'question', topic: 'topic', text: 'text', evidenceIds: [], userQuote: '', ...value });
const validate = (changes: MemoryDelta['changes'], value = input()) =>
  validateMemoryDelta({ changes }, projectMemoryUpdaterInput(value), new Set(value.memories.map(item => item.id)));

describe('bounded projection authorizes proposals (reviewer round 1, finding 1)', () => {
  // 50 small memories exceed the 40-entry projection; the oldest are omitted.
  const many = Array.from({ length: 50 }, (_, index) => memory(`topic ${index}`, index));
  const omitted = many[0]!;
  const shown = many[49]!;
  const manyCitations = Array.from({ length: 30 }, (_, index) => citation(`evidence:c:${index}`));

  it('shows the model exactly the projection used for validation', () => {
    const projection = projectMemoryUpdaterInput(input({ memories: many, citations: manyCitations }));
    expect(projection.memories).toHaveLength(40);
    expect(projection.memories.map(item => item.id)).not.toContain(omitted.id);
    expect(projection.citations).toHaveLength(24);
    const prompt = JSON.parse(memoryUpdaterPrompt(projection).prompt);
    expect(prompt.existingMemories).toHaveLength(40);
    expect(prompt.citations.map((item: { id: string }) => item.id)).toEqual(projection.citations.map(item => item.id));
  });

  it('rejects removing or correcting an existing memory the model was not shown', () => {
    const value = input({ memories: many });
    const result = validate([
      change({ action: 'remove', kind: 'context', topic: omitted.topic, text: '' }),
      change({ action: 'upsert', kind: 'context', topic: omitted.topic, text: 'Overwrite', userQuote: 'second video' }),
      change({ action: 'remove', kind: 'context', topic: shown.topic, text: '' }),
    ], value);
    expect(result.changes).toEqual([{ action: 'remove', kind: 'context', topic: shown.topic, text: '-', evidenceIds: [] }]);
    expect(result.rejected).toBe(2);
  });

  it('rejects a finding citing an id omitted from the projection', () => {
    const value = input({ citations: manyCitations });
    const result = validate([
      change({ kind: 'finding', topic: 'late', text: 'Omitted citation', evidenceIds: ['evidence:c:29'] }),
      change({ kind: 'finding', topic: 'early', text: 'Shown citation', evidenceIds: ['evidence:c:0'] }),
      change({ kind: 'finding', topic: 'mixed', text: 'Mixed', evidenceIds: ['evidence:c:0', 'evidence:c:29'] }),
    ], value);
    expect(result.changes.map(item => item.topic)).toEqual(['early']);
  });

  it('the fully saturated prompt fits the documented per-call cost allowance (cost note)', () => {
    const big = (i: number): AgentCitation => ({ ...citation(`evidence:${'a'.repeat(64)}:${i}`), title: 't'.repeat(300), startMs: 1, excerpt: 'e'.repeat(600) });
    const projection = projectMemoryUpdaterInput(input({ question: 'q'.repeat(5_000), answer: 'a'.repeat(13_000),
      citations: Array.from({ length: 30 }, (_, i) => big(i)),
      memories: Array.from({ length: 60 }, (_, i) => memory(`topic ${i}`, i, 'context', 'x'.repeat(150))) }));
    const { system, prompt } = memoryUpdaterPrompt(projection);
    const characters = system.length + prompt.length;
    expect(characters).toBeLessThan(46_000);
    // One token per character at GLM Priority input rates, plus the 800-token output limit.
    expect(Math.ceil(characters * 0.1875 + 800 * 0.625)).toBeLessThan(MEMORY_UPDATE_COST_RESERVE_MICROS);
  });

  it('only accepts user context quoted from the bounded question', () => {
    const long = `${'x'.repeat(4_100)} I prefer Spanish subtitles.`;
    expect(validate([change({ kind: 'context', topic: 'subtitles', text: 'Prefers Spanish subtitles', userQuote: 'I prefer Spanish subtitles' })],
      input({ question: long })).changes).toEqual([]);
    expect(validate([change({ kind: 'context', topic: 'scope', text: 'Only the second video', userQuote: 'only care about the second video' })])
      .changes).toHaveLength(1);
  });

  it('documents the limit: a real quote does not prove the stored paraphrase is entailed (reviewer round 1, finding 3)', () => {
    // Structural check only. The quote exists, so this unentailed paraphrase is accepted.
    expect(validate([change({ kind: 'context', topic: 'scope', text: 'Dislikes the first video', userQuote: 'only care about the second video' })])
      .changes).toHaveLength(1);
  });
});

describe('delta semantics', () => {
  it('an empty delta is a no-op', () => {
    expect(validate([])).toEqual({ changes: [], rejected: 0 });
  });

  it('a correction targets one shown topic and leaves the rest untouched', () => {
    const result = validate([change({ kind: 'context', topic: 'Focus', text: 'Only the second video', userQuote: 'I only care about the second video' })]);
    expect(result.changes).toEqual([{ action: 'upsert', kind: 'context', topic: 'Focus', text: 'Only the second video', evidenceIds: [] }]);
  });

  it('rejects unsupported findings, unquoted context and assistant-only preferences', () => {
    const result = validate([
      change({ kind: 'finding', topic: 'uncited', text: 'No evidence', evidenceIds: [] }),
      change({ kind: 'finding', topic: 'invented', text: 'Invented', evidenceIds: ['invented'] }),
      change({ kind: 'context', topic: 'tone', text: 'Wants a formal tone', userQuote: 'formal tone' }),
      change({ action: 'remove', kind: 'finding', topic: 'never stored', text: '' }),
    ]);
    expect(result).toEqual({ changes: [], rejected: 4 });
  });

  it('rejects leaked control text, credentials and contact details', () => {
    const result = validate([
      change({ kind: 'question', topic: 'leak', text: 'Context gathering is finished. Return the complete structured answer now.' }),
      change({ kind: 'question', topic: 'key', text: 'api_key: abcdefghijklmnop' }),
      change({ kind: 'question', topic: 'contact', text: 'Email person@example.com' }),
      change({ kind: 'question', topic: 'memoryUpdates', text: 'Malformed evidence IDs' }),
    ]);
    expect(result).toEqual({ changes: [], rejected: 4 });
  });

  it('processes at most four proposals and counts the overflow as rejected', () => {
    const result = validate(Array.from({ length: 6 }, (_, index) => change({ topic: `open ${index}` })));
    expect(result.changes).toHaveLength(4);
    expect(result.rejected).toBe(2);
  });
});

describe('generateMemoryDelta', () => {
  it('sends only the clean projection and reports usage once', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ changes: [] }) }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
    const onUsage = vi.fn();
    const result = await generateMemoryDelta({ model, input: input(), signal: new AbortController().signal, onUsage });
    expect(result).toEqual({ changes: [], rejected: 0 });
    expect(onUsage).toHaveBeenCalledOnce();
    expect(model.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    for (const leaked of ['validationFeedback', 'previousCandidate', 'conversationHistory', 'providerFailures', 'needsEvidence'])
      expect(prompt).not.toContain(leaked);
    expect(prompt).toContain('I only care about the second video');
  });

  it('reports observed usage for invalid output and never retries', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text', text: '{"changes":"not a list"' }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
    const onUsage = vi.fn();
    await expect(generateMemoryDelta({ model, input: input(), signal: new AbortController().signal, onUsage })).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it('rejects at the 20-second wall clock even if the provider ignores abort, then never returns the late delta (round 2)', async () => {
    vi.useFakeTimers();
    try {
      let respond!: () => void;
      const late = new Promise<void>(resolve => { respond = resolve; });
      const model = new MockLanguageModelV4({ doGenerate: async () => {
        await late; // Ignores abortSignal entirely.
        return { content: [{ type: 'text', text: JSON.stringify({ changes: [change({ topic: 'late' })] }) }],
          finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
      } });
      const onUsage = vi.fn();
      const outcome = generateMemoryDelta({ model, input: input(), signal: new AbortController().signal, onUsage })
        .then(value => ({ value }), error => ({ error }));
      let settled = false;
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await outcome;
      expect(result).toEqual({ error: expect.objectContaining({ message: MEMORY_UPDATE_TIMEOUT_MESSAGE }) });
      expect(onUsage).not.toHaveBeenCalled();
      respond();
      await vi.advanceTimersByTimeAsync(10);
      // The late response is observable cost, but its delta is unreachable.
      expect(onUsage).toHaveBeenCalledOnce();
      expect(await outcome).toBe(result);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a caller abort rejects immediately even if the provider ignores it', async () => {
    const model = new MockLanguageModelV4({ doGenerate: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = generateMemoryDelta({ model, input: input(), signal: controller.signal, onUsage: vi.fn() });
    controller.abort(new Error('Account deleted.'));
    await expect(pending).rejects.toThrow('Account deleted.');
  });
});
