import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { TranscriptDiagnostic } from '../src/agents/runtime/transcript-diagnostics';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } };
const output = (name: string) => ({ findings: [{ claim: 'OpenAI provides an API.', windowIndexes: [0], entities: [{ name, quote: 'OpenAI API tutorial', source: 'title' }], quantities: [], uncertainty: null }], warnings: [] });
const response = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] });
const input = () => ({ videoId: 'abcdefghijk', researchQuestion: 'Explain the API', focus: 'Company name', sourceContext: { title: 'OpenAI API tutorial' }, segments: [{ text: 'Open eye provides an API.', startMs: 0, endMs: 1000, durationMs: 1000 }], signal: new AbortController().signal });

describe('transcript analysis diagnostics', () => {
  it('records the rejected finding, exact repair feedback and source before retrying', async () => {
    const events: TranscriptDiagnostic[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (calls) expect(events.some(e => e.outcome === 'rejected')).toBe(true);
      return response(output(calls++ ? 'OpenAI' : 'Anthropic'));
    } });
    await analyzeTranscriptWithModel({ ...input(), model, onDiagnostic: e => events.push(e) });
    expect(events.map(e => e.outcome)).toEqual(['started', 'rejected', 'started', 'accepted']);
    expect(events[1]).toMatchObject({ attempt: 1, code: 'GROUNDING_REJECTED', finishReason: 'stop', inputTokens: 100, outputTokens: 100,
      issues: [expect.objectContaining({ code: 'ENTITY_NOT_SUPPORTED', findingIndex: 0, fieldIndex: 0 })],
      sourceContext: { title: 'OpenAI API tutorial' }, sourceWindows: [expect.objectContaining({ index: 0, text: 'Open eye provides an API.' })] });
    expect(events[1]!.repairFeedback).toContain('Unsupported entity Anthropic');
    expect(events[1]!.rejectedOutput).toContain('Anthropic');
    expect(events[2]!.attemptId).not.toBe(events[0]!.attemptId);
  });

  it('preserves rejection and records cancellation even if the provider ignores abort', async () => {
    const controller = new AbortController();
    const events: TranscriptDiagnostic[] = [];
    let calls = 0;
    let release!: (value: ReturnType<typeof response>) => void;
    let aborted!: () => void;
    const sawAbort = new Promise<void>(resolve => { aborted = resolve; });
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (!calls++) return response(output('Anthropic'));
      controller.abort(new Error('Research phase timeout.'));
      aborted();
      return new Promise(resolve => { release = resolve; });
    } });
    const pending = analyzeTranscriptWithModel({ ...input(), signal: controller.signal, model, onDiagnostic: e => events.push(e) });
    const rejected = expect(pending).rejects.toThrow();
    await sawAbort;
    expect(events.map(e => e.outcome)).toEqual(['started', 'rejected', 'started', 'canceled']);
    expect(events.at(-1)).toMatchObject({ attempt: 2, cancellationReason: 'research_deadline' });
    release(response(output('OpenAI')));
    await rejected;
    expect(events.filter(e => e.outcome === 'canceled')).toHaveLength(1);
    expect(events.some(e => e.outcome === 'accepted')).toBe(false);
  });
});

it('records an unknown window and both rejected attempts without claiming a schema failure', async () => {
  const events: TranscriptDiagnostic[] = [];
  const bad = output('OpenAI'); bad.findings[0]!.windowIndexes = [999];
  const model = new MockLanguageModelV4({ doGenerate: async () => response(bad) });
  await expect(analyzeTranscriptWithModel({ ...input(), model, onDiagnostic: e => events.push(e) })).rejects.toThrow('unknown window');
  expect(events.map(e => e.outcome)).toEqual(['started', 'rejected', 'started', 'rejected']);
  expect(events[1]).toMatchObject({ code: 'INVALID_REFERENCE', issues: [{ code: 'UNKNOWN_WINDOW', findingIndex: 0, windowIndex: 999 }] });
});

it('captures the exact schema field that was invalid without attempting a grounding repair', async () => {
  const events: TranscriptDiagnostic[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => response({ findings: [{ claim: 7 }] }) });
  await expect(analyzeTranscriptWithModel({ ...input(), model, onDiagnostic: e => events.push(e) })).rejects.toThrow();
  expect(events.map(e => e.outcome)).toEqual(['started', 'failed']);
  expect(events[1]).toMatchObject({ code: 'SCHEMA_INVALID', finishReason: 'stop' });
  expect(events[1]!.issues?.some(issue => issue.message.includes('findings.0.claim'))).toBe(true);
  expect(events[1]!.rejectedOutput).toContain('"claim":7');
});

it('records output-limit repair separately from grounding errors', async () => {
  const events: TranscriptDiagnostic[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => ({ ...response(output('OpenAI')),
    finishReason: { unified: calls++ ? 'stop' : 'length', raw: undefined } }) });
  await analyzeTranscriptWithModel({ ...input(), model, onDiagnostic: e => events.push(e) });
  expect(events[1]).toMatchObject({ outcome: 'rejected', code: 'OUTPUT_LIMIT', finishReason: 'length' });
  expect(events[3]?.outcome).toBe('accepted');
});

it('bounds malformed response captures and marks truncation', async () => {
  const events: TranscriptDiagnostic[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => ({ ...response(null), content: [{ type: 'text', text: 'x'.repeat(25000) }] }) });
  await expect(analyzeTranscriptWithModel({ ...input(), model, onDiagnostic: e => events.push(e) })).rejects.toThrow();
  expect(events[1]).toMatchObject({ code: 'SCHEMA_INVALID', captureTruncated: true, issues: [{ code: 'SCHEMA_INVALID', message: 'Response was not valid JSON.' }] });
  expect(events[1]!.rejectedOutput).toHaveLength(24000);
});

it('records provider failure without copying its error body or headers into diagnostics', async () => {
  const events: TranscriptDiagnostic[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw Object.assign(new Error('sensitive provider body'), { statusCode: 401, responseHeaders: { authorization: 'secret' } }); } });
  await expect(analyzeTranscriptWithModel({ ...input(), model, onDiagnostic: e => events.push(e) })).rejects.toThrow();
  expect(events[1]).toMatchObject({ outcome: 'failed', code: 'PROVIDER_ERROR', statusCode: 401 });
  expect(JSON.stringify(events)).not.toContain('secret');
  expect(JSON.stringify(events)).not.toContain('sensitive provider body');
});

it('identifies an SDK timeout separately from schema and provider errors', async () => {
  const events: TranscriptDiagnostic[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new DOMException('Timeout', 'TimeoutError'); } });
  await expect(analyzeTranscriptWithModel({ ...input(), model, onDiagnostic: e => events.push(e) })).rejects.toThrow();
  expect(events[1]).toMatchObject({ outcome: 'failed', code: 'ANALYSIS_TIMEOUT', cancellationReason: 'sdk_timeout' });
});

it('keeps diagnostics for a dropped finding even when the remaining analysis is accepted', async () => {
  const events: TranscriptDiagnostic[] = [];
  const good = output('OpenAI');
  const bad = output('Anthropic');
  const model = new MockLanguageModelV4({ doGenerate: async () => response({ findings: [...good.findings, ...bad.findings], warnings: [] }) });
  const result = await analyzeTranscriptWithModel({ ...input(), model, onDiagnostic: e => events.push(e) });
  expect(result.findings).toHaveLength(1);
  expect(events.map(e => e.outcome)).toEqual(['started', 'accepted']);
  expect(events[1]).toMatchObject({ issueCount: 1, issues: [{ code: 'ENTITY_NOT_SUPPORTED', findingIndex: 1 }] });
  expect(events[1]!.rejectedOutput).toContain('Anthropic');
});
