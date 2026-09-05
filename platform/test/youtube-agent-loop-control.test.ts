import { buildAgentTurnResult } from '../src/agents/finalizer';
import { ApiError } from '../src/lib/http';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import {
  FINALIZE_ANSWER_TOOL_NAME,
  getFinalizationReason,
  hasExecutedToolResult,
  hasTerminalToolCallWithoutResult,
  type StepWithToolActivity,
} from '../src/agents/runtime/loop-control';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { AgentModelCostBudget, AgentModelUsageEntry } from '../src/agents/runtime/model-budget';
import type { EvidencePacket } from '../src/agents/contracts';

describe('YouTube AgentCore loop control', () => {
  it.each([false, true])('permits one search even in a parallel batch and removes it after use (failure=%s)', async (fails) => {
    const context = inspectContext();
    context.provider.search = vi.fn(async () => {
      if (fails) throw new Error('Network unavailable');
      return { cacheStatus: 'miss' as const, value: { query: 'design', results: [], videos: [], channels: [], playlists: [], meta: { source: 'allthingsyoutube' as const, fetchedAt: new Date().toISOString(), partial: false, warnings: [] } } };
    });
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async (call) => {
      if (step++ === 0) return multiToolModelResult(['first', 'second'].map(id => ({
        toolCallId: id, toolName: 'search_youtube', input: JSON.stringify({ query: id }),
      })));
      expect(call.tools?.map(t => t.name)).not.toContain('search_youtube');
      expect(call.tools?.map(t => t.name)).toContain('get_video_transcript');
      return modelResult({ toolCallId: 'finish', toolName: 'finalize_answer', input: JSON.stringify({
        blocks: [{ text: 'Done', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }], intent: 'topic_research', confidence: 'low', artifacts: [], warnings: [],
      }) });
    } });
    await runResearchAgentWithModel({ model, message: 'Research design', decision: { route: 'topic_research' }, context });
    expect(context.provider.search).toHaveBeenCalledTimes(1);
  });

  it('keeps search unavailable when a run resumes after consuming its search', async () => {
    const context = inspectContext();
    context.provider.search = vi.fn();
    const model = new MockLanguageModelV4({ doGenerate: async (call) => {
      expect(call.tools?.map(tool => tool.name)).not.toContain('search_youtube');
      expect(call.tools?.map(tool => tool.name)).toContain('get_video_transcript');
      return modelResult({ toolCallId: 'finish', toolName: 'finalize_answer', input: JSON.stringify({
        blocks: [{ text: 'Done', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }], intent: 'topic_research', confidence: 'low', artifacts: [], warnings: [],
      }) });
    } });
    await runResearchAgentWithModel({
      model, message: 'Research design', decision: { route: 'topic_research' }, context,
      recoveredSearchUsed: true,
    });
    expect(context.provider.search).not.toHaveBeenCalled();
  });

  it('returns cited partial evidence before the deadline when research and synthesis both stall', async () => {
    vi.useFakeTimers();
    try {
      const never = new MockLanguageModelV4({ doGenerate: async () => new Promise(() => {}) });
      const context = inspectContext();
      const run = runResearchAgentWithModel({
        model: never, finalizationModel: never, message: 'Research design skills',
        decision: { route: 'topic_research' }, context,
        recoveredEvidence: [transcriptAnalysisPacket()],
      });
      const check = expect(run).resolves.toMatchObject({ finishReason: 'evidence-fallback' });
      await vi.advanceTimersByTimeAsync(59_000);
      await check;
      expect(context.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        answer: expect.stringContaining('[cite:transcript:abcdefghijk:window:0:0]'),
        confidence: 'low',
        warnings: expect.arrayContaining([expect.objectContaining({ code: 'PARTIAL_EVIDENCE' })]),
      }));
    } finally { vi.useRealTimers(); }
  });

  it('ends the entire loop including a stalled recovery finalizer within 60 seconds', async () => {
    vi.useFakeTimers();
    try {
      const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('timeout'); } });
      const recovery = new MockLanguageModelV4({ doGenerate: async () => new Promise(() => {}) });
      const run = runResearchAgentWithModel({
        model, finalizationModel: recovery, message: 'Research design skills',
        decision: { route: 'topic_research' }, context: inspectContext(),
      });
      const check = expect(run).rejects.toThrow(/Finalization phase timeout/i);
      await vi.advanceTimersByTimeAsync(60_001);
      await check;
    } finally { vi.useRealTimers(); }
  });

  it('preserves collected evidence when the model becomes unavailable', async () => {
    const unavailable = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('3040: Capacity temporarily exceeded'); } });
    const context = inspectContext();
    const result = await runResearchAgentWithModel({
      model: unavailable, finalizationModel: unavailable, message: 'Research design skills',
      decision: { route: 'topic_research' }, context,
      recoveredEvidence: [transcriptAnalysisPacket()],
    });
    expect(result.finishReason).toBe('evidence-fallback');
    expect(context.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ confidence: 'low' }));
  });

  it('forces finalization on the last nominal step', () => {
    expect(getFinalizationReason({
      stepNumber: 7,
      maxSteps: 8,
      elapsedMs: 20_000,
      hardBudgetMs: 90_000,
      steps: [],
    })).toBe('last_step');
  });

  it('forces finalization before the wall-clock budget expires', () => {
    expect(getFinalizationReason({
      stepNumber: 3,
      maxSteps: 8,
      elapsedMs: 79_000,
      hardBudgetMs: 90_000,
      steps: [],
    })).toBe('time_budget');
  });

  it('forces finalization after the evidence tool budget is consumed', () => {
    expect(getFinalizationReason({
      stepNumber: 3,
      maxSteps: 8,
      elapsedMs: 20_000,
      hardBudgetMs: 90_000,
      nonTerminalToolCallLimit: 2,
      steps: [{ toolCalls: [
        { toolCallId: 'video-1', toolName: 'get_video' },
        { toolCallId: 'comments-1', toolName: 'get_video_comments' },
      ] }],
    })).toBe('tool_budget');
  });

  it('forces finalization after the research portion of the model-cost budget is consumed', () => {
    expect(getFinalizationReason({
      stepNumber: 3,
      maxSteps: 8,
      elapsedMs: 20_000,
      hardBudgetMs: 90_000,
      steps: [],
      modelCostMicros: 900_000,
      modelCostLimitMicros: 1_000_000,
      finalizationCostReserveMicros: 100_000,
    })).toBe('cost_budget');
  });

  it('distinguishes a generated finalizer call from an executed finalizer result', () => {
    const steps: StepWithToolActivity[] = [{
      toolCalls: [{ toolCallId: 'finalize-1', toolName: FINALIZE_ANSWER_TOOL_NAME }],
      toolResults: [],
    }];
    expect(hasTerminalToolCallWithoutResult(steps)).toBe(true);
    expect(hasExecutedToolResult(FINALIZE_ANSWER_TOOL_NAME)({ steps })).toBe(false);

    steps[0]!.toolResults!.push({
      toolCallId: 'finalize-1',
      toolName: FINALIZE_ANSWER_TOOL_NAME,
    });
    expect(hasTerminalToolCallWithoutResult(steps)).toBe(false);
    expect(hasExecutedToolResult(FINALIZE_ANSWER_TOOL_NAME)({ steps })).toBe(true);
  });

  it('reserves the eighth step for an executed final answer', async () => {
    let generation = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (call) => {
        generation += 1;
        if (generation < 8) {
          return modelResult({
            toolCallId: `video-${generation}`,
            toolName: 'get_video',
            input: JSON.stringify({ videoId: 'abcdefghijk' }),
          });
        }

        expect(call.toolChoice).toEqual({
          type: 'tool',
          toolName: FINALIZE_ANSWER_TOOL_NAME,
        });
        expect(call.tools?.map((tool) => tool.name)).toEqual([FINALIZE_ANSWER_TOOL_NAME]);
        return modelResult({
          toolCallId: 'finalize-1',
          toolName: FINALIZE_ANSWER_TOOL_NAME,
          input: JSON.stringify({
            blocks: [{ text: 'The available metadata identifies the video.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
            intent: 'inspect_video',
            confidence: 'low',
            citations: [],
            artifacts: [],
            warnings: [],
          }),
        });
      },
    });
    const context = inspectContext();

    const result = await runResearchAgentWithModel({
      model,
      message: 'Inspect https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context,
      toolNames: ['get_video', FINALIZE_ANSWER_TOOL_NAME],
    });

    expect(result.stepCount).toBe(8);
    expect(context.finalize).toHaveBeenCalledOnce();
  });

  it('switches AgentCore directly to finalization when only the cost reserve remains', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (call) => {
        expect(call.toolChoice).toEqual({
          type: 'tool',
          toolName: FINALIZE_ANSWER_TOOL_NAME,
        });
        expect(call.tools?.map((tool) => tool.name)).toEqual([FINALIZE_ANSWER_TOOL_NAME]);
        return modelResult({
          toolCallId: 'cost-finalize',
          toolName: FINALIZE_ANSWER_TOOL_NAME,
          input: JSON.stringify({
            blocks: [{ text: 'The run finalized with the evidence already collected.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
            intent: 'inspect_video',
            confidence: 'low',
            citations: [],
            artifacts: [],
            warnings: [],
          }),
        });
      },
    });
    const context = inspectContext();
    const modelBudget = inMemoryModelBudget(900_000);

    const result = await runResearchAgentWithModel({
      model,
      message: 'Inspect https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context,
      toolNames: ['get_video', FINALIZE_ANSWER_TOOL_NAME],
      modelBudget,
    });

    expect(result.stepCount).toBe(1);
    expect(context.finalize).toHaveBeenCalledOnce();
  });

  it('repairs an unexecuted finalizer call with the low-reasoning finalization model', async () => {
    const researchModel = new MockLanguageModelV4({
      doGenerate: async () => modelResult({
        toolCallId: 'invalid-finalize',
        toolName: FINALIZE_ANSWER_TOOL_NAME,
        input: JSON.stringify({
          blocks: [{ text: 'This first finalization attempt is rejected during execution.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
          intent: 'inspect_video',
          confidence: 'low',
          citations: [],
          artifacts: [],
          warnings: [],
        }),
      }),
    });
    const finalizationModel = new MockLanguageModelV4({
      doGenerate: async (call) => {
        expect(call.toolChoice).toEqual({
          type: 'tool',
          toolName: FINALIZE_ANSWER_TOOL_NAME,
        });
        return modelResult({
          toolCallId: 'repaired-finalize',
          toolName: FINALIZE_ANSWER_TOOL_NAME,
          input: JSON.stringify({
            blocks: [{ text: 'Please clarify which aspect of the video to inspect.', evidenceIds: [] }],
            intent: 'clarification',
            confidence: 'low',
            citations: [],
            artifacts: [],
            warnings: [],
          }),
        });
      },
    });
    const context = inspectContext();
    const successfulFinalize = context.finalize;
    let finalizeAttempt = 0;
    context.finalize = vi.fn(async (toolCallId, input) => {
      finalizeAttempt += 1;
      if (finalizeAttempt === 1) throw new ApiError(422, 'INVALID_AGENT_CITATION', 'Citation validation rejected the first answer.');
      return successfulFinalize(toolCallId, input);
    });

    const result = await runResearchAgentWithModel({
      model: researchModel,
      finalizationModel,
      message: 'Inspect https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context,
      toolNames: ['get_video', FINALIZE_ANSWER_TOOL_NAME],
    });

    expect(result.stepCount).toBe(2);
    expect(researchModel.doGenerateCalls).toHaveLength(1);
    expect(finalizationModel.doGenerateCalls).toHaveLength(1);
    expect(context.finalize).toHaveBeenCalledTimes(2);
  });

  it('repairs malformed tool arguments before executing the tool', async () => {
    let generation = 0;
    const researchModel = new MockLanguageModelV4({
      doGenerate: async () => {
        generation += 1;
        return generation === 1
          ? modelResult({
            toolCallId: 'invalid-video',
            toolName: 'get_video',
            input: JSON.stringify({ videoId: 'too-short' }),
          })
          : modelResult({
            toolCallId: 'finalize-after-repair',
            toolName: FINALIZE_ANSWER_TOOL_NAME,
            input: JSON.stringify({
              blocks: [{ text: 'The repaired call retrieved the selected video.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
              intent: 'inspect_video',
              confidence: 'low',
              citations: [],
              artifacts: [],
              warnings: [],
            }),
          });
      },
    });
    const repairModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ videoId: 'abcdefghijk' }) }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const context = inspectContext();
    const modelBudget = inMemoryModelBudget();

    const result = await runResearchAgentWithModel({
      model: researchModel,
      finalizationModel: repairModel,
      message: 'Inspect https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context,
      toolNames: ['get_video', FINALIZE_ANSWER_TOOL_NAME],
      modelBudget,
      modelCallPrefix: 'repair-test',
    });

    expect(result.stepCount).toBe(2);
    expect(repairModel.doGenerateCalls).toHaveLength(1);
    expect(context.provider.video).toHaveBeenCalledWith('abcdefghijk');
    expect(context.finalize).toHaveBeenCalledOnce();
    expect(modelBudget.entries.map((entry) => entry.category)).toEqual([
      'tool_repair',
      'agent_core',
      'agent_core',
    ]);
  });

  it('finalizes a partial result after timeout and exposes the transcript provider failure', async () => {
    let generation = 0;
    const researchModel = new MockLanguageModelV4({
      doGenerate: async () => {
        generation += 1;
        if (generation === 1) {
          return modelResult({
            toolCallId: 'transcript-429',
            toolName: 'get_video_transcript',
            input: JSON.stringify({ videoId: 'abcdefghijk' }),
          });
        }
        throw new Error('The operation was aborted due to timeout');
      },
    });
    const finalizationModel = new MockLanguageModelV4({
      doGenerate: async () => finalizerModelResult({
        blocks: [{ text: 'The transcript could not be retrieved, so no transcript-based answer is available.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
        intent: 'inspect_video',
        confidence: 'low',
        citations: [],
        artifacts: [],
        warnings: [],
      }),
    });
    const context = transcriptFailureContext();
    const modelBudget = inMemoryModelBudget();

    const result = await runResearchAgentWithModel({
      model: researchModel,
      finalizationModel,
      message: 'Inspect the transcript for https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context,
      toolNames: ['get_video_transcript', FINALIZE_ANSWER_TOOL_NAME],
      modelBudget,
      modelCallPrefix: 'timeout-partial',
    });

    expect(result.finishReason).toBe('timeout-finalized');
    expect(context.finalize).toHaveBeenCalledWith(
      expect.stringMatching(/^timeout-finalizer:/u),
      expect.objectContaining({
        warnings: expect.arrayContaining([
          expect.objectContaining({
            code: 'EVIDENCE_TOOL_FAILED',
            message: expect.stringContaining('429 Too Many Requests'),
          }),
        ]),
      }),
    );
    expect(modelBudget.entries.map((entry) => entry.category)).toContain('timeout_finalizer');
  });

  it('keeps raw research transcripts out of Agent Core and timeout-finalizer prompts', async () => {
    const persistedText = 'RAW TRANSCRIPT WINDOW retained only in durable evidence.';
    const analysisSummary = 'The video recommends TypeScript and component testing.';
    const persistedPackets: Array<{ excerpts: Array<{ text: string }> }> = [];
    let generation = 0;
    const researchModel = new MockLanguageModelV4({
      doGenerate: async (call) => {
        generation += 1;
        if (generation === 1) {
          return modelResult({
            toolCallId: 'transcript-success',
            toolName: 'get_video_transcript',
            input: JSON.stringify({ videoId: 'abcdefghijk', focus: 'frontend skills' }),
          });
        }
        const prompt = JSON.stringify(call.prompt);
        expect(prompt).toContain(analysisSummary);
        expect(prompt).not.toContain(persistedText);
        throw new Error('The operation was aborted due to timeout');
      },
    });
    const finalizationModel = new MockLanguageModelV4({
      doGenerate: async (call) => {
        const prompt = JSON.stringify(call.prompt);
        expect(prompt).toContain(analysisSummary);
        expect(prompt).not.toContain(persistedText);
        return finalizerModelResult({
          blocks: [{ text: 'The available analysis recommends TypeScript.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
          intent: 'topic_research',
          confidence: 'medium',
          citations: [],
          artifacts: [],
          warnings: [],
        });
      },
    });
    const context = researchTranscriptContext(persistedText, analysisSummary, persistedPackets);

    const result = await runResearchAgentWithModel({
      model: researchModel,
      finalizationModel,
      message: 'Suggest frontend development skills.',
      decision: { route: 'topic_research' },
      context,
      toolNames: ['get_video_transcript', FINALIZE_ANSWER_TOOL_NAME],
    });

    expect(result.finishReason).toBe('timeout-finalized');
    expect(persistedPackets[0]?.excerpts[0]?.text).toBe(persistedText);
  });

  it.each([['focused', 2], ['comparative', 4]] as const)('caps a parallel %s transcript batch at %i and then forces finalization', async (researchBreadth, target) => {
    let generation = 0;
    const researchModel = new MockLanguageModelV4({
      doGenerate: async (call) => {
        generation += 1;
        if (generation === 1) {
          return multiToolModelResult([
            { toolCallId: 'transcript-1', videoId: 'video000001' },
            { toolCallId: 'transcript-1-duplicate', videoId: 'video000001' },
            { toolCallId: 'transcript-2', videoId: 'video000002' },
            { toolCallId: 'transcript-3', videoId: 'video000003' },
            { toolCallId: 'transcript-4', videoId: 'video000004' },
            { toolCallId: 'transcript-5', videoId: 'video000005' },
          ].map(({ toolCallId, videoId }) => ({
            toolCallId,
            toolName: 'get_video_transcript',
            input: JSON.stringify({
              videoId,
              focus: 'frontend development skills',
            }),
          })));
        }

        expect(call.toolChoice).toEqual({
          type: 'tool',
          toolName: FINALIZE_ANSWER_TOOL_NAME,
        });
        expect(call.tools?.map((availableTool) => availableTool.name)).toEqual([
          FINALIZE_ANSWER_TOOL_NAME,
        ]);
        return modelResult({
          toolCallId: 'finalize-after-transcript-budget',
          toolName: FINALIZE_ANSWER_TOOL_NAME,
          input: JSON.stringify({
            blocks: [{ text: 'Two transcript analyses provide enough evidence.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
            intent: 'topic_research',
            confidence: 'medium',
            citations: [],
            artifacts: [],
            warnings: [],
          }),
        });
      },
    });
    const context = transcriptResearchContext();

    const result = await runResearchAgentWithModel({
      model: researchModel,
      message: 'Suggest the best frontend development skills.',
      decision: { route: 'topic_research', researchBreadth },
      context,
      toolNames: ['get_video_transcript', FINALIZE_ANSWER_TOOL_NAME],
    });

    expect(result.stepCount).toBe(2);
    expect(context.provider.transcript).toHaveBeenCalledTimes(target);
    expect(context.provider.transcript).toHaveBeenNthCalledWith(1, 'video000001', undefined);
    expect(context.provider.transcript).toHaveBeenNthCalledWith(2, 'video000002', undefined);
    expect(context.transcriptPolicy.mode).toBe('contextual_analysis');
    if (context.transcriptPolicy.mode === 'contextual_analysis') {
      expect(context.transcriptPolicy.analyze).toHaveBeenCalledTimes(target);
    }
    expect(context.finalize).toHaveBeenCalledOnce();
  });

  it('runs two isolated analysts concurrently and queues the remaining comparative videos', async () => {
    const context = transcriptResearchContext();
    if (context.transcriptPolicy.mode !== 'contextual_analysis') throw new Error('Missing analyst');
    const original = context.transcriptPolicy.analyze;
    let active = 0;
    let maximum = 0;
    let started = 0;
    const releases: Array<() => void> = [];
    context.transcriptPolicy.analyze = async input => {
      active++;
      started++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      try { return await original(input); } finally { active--; }
    };
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (step++ === 0) return multiToolModelResult([1, 2, 3, 4].map(n => ({
        toolCallId: `analysis-${n}`, toolName: 'get_video_transcript',
        input: JSON.stringify({ videoId: `video00000${n}`, focus: 'Design skills' }),
      })));
      return modelResult({ toolCallId: 'finish', toolName: 'finalize_answer', input: JSON.stringify({
        blocks: [{ text: 'Compared the sources.', evidenceIds: ['transcript:video000001:window:0:0'] }],
        intent: 'topic_research', confidence: 'medium', artifacts: [], warnings: [],
      }) });
    } });
    const run = runResearchAgentWithModel({ model, message: 'Compare design skills',
      decision: { route: 'topic_research', researchBreadth: 'comparative' }, context });
    await vi.waitFor(() => expect(started).toBe(2));
    expect(active).toBe(2);
    releases.splice(0).forEach(release => release());
    await vi.waitFor(() => expect(started).toBe(4));
    expect(active).toBe(2);
    releases.splice(0).forEach(release => release());
    await run;
    expect(maximum).toBe(2);
    expect(context.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ warnings: [] }));
  });

  it('does not start queued analysts after the research deadline and preserves finalization time', async () => {
    vi.useFakeTimers();
    try {
      const context = transcriptResearchContext();
      if (context.transcriptPolicy.mode !== 'contextual_analysis') throw new Error('Missing analyst');
      const analyze = vi.fn(async ({ signal }: { signal: AbortSignal }): Promise<never> =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
      context.transcriptPolicy.analyze = analyze;
      const model = new MockLanguageModelV4({ doGenerate: async () => multiToolModelResult([1, 2, 3, 4].map(n => ({
        toolCallId: `analysis-${n}`, toolName: 'get_video_transcript',
        input: JSON.stringify({ videoId: `video00000${n}`, focus: 'Design skills' }),
      }))) });
      const finalizationModel = new MockLanguageModelV4({ doGenerate: async () => finalizerModelResult({
        blocks: [{ text: 'A supported finding.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
        intent: 'topic_research', confidence: 'medium', artifacts: [], warnings: [],
      }) });
      const run = runResearchAgentWithModel({ model, finalizationModel, message: 'Compare design skills',
        decision: { route: 'topic_research', researchBreadth: 'comparative' }, context,
        recoveredEvidence: [transcriptAnalysisPacket()],
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(analyze).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(run).resolves.toMatchObject({ finishReason: 'timeout-finalized' });
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(context.finalize).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('discloses distinct usable video coverage in recovery answers', async () => {
    const context = inspectContext();
    const recovery = new MockLanguageModelV4({ doGenerate: async () => finalizerModelResult({
      blocks: [{ text: 'A supported finding.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
      intent: 'topic_research', confidence: 'medium', artifacts: [], warnings: [],
    }) });
    await runResearchAgentWithModel({
      model: new MockLanguageModelV4({ doGenerate: async () => { throw new Error('timeout'); } }),
      finalizationModel: recovery, message: 'Compare design skills',
      decision: { route: 'topic_research', researchBreadth: 'comparative' }, context,
      recoveredEvidence: [transcriptAnalysisPacket()],
    });
    expect(context.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      warnings: expect.arrayContaining([expect.objectContaining({
        code: 'RESEARCH_COVERAGE_SHORTFALL', message: expect.stringContaining('1 of 4'),
      })]),
    }));
  });

  it('repairs rejected references once within the shared finalization budget', async () => {
    const researchModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('The operation was aborted due to timeout');
      },
    });
    let finalizerAttempt = 0;
    const finalizationModel = new MockLanguageModelV4({
      doGenerate: async (call) => {
        finalizerAttempt += 1;
        if (finalizerAttempt === 2) {
          expect(JSON.stringify(call.prompt)).toContain('Citation validation rejected the first answer.');
        }
        return finalizerModelResult({
          blocks: [{ text: finalizerAttempt === 1
            ? 'An invalid first answer.'
            : 'The repaired answer uses persisted evidence.', evidenceIds: ['transcript:abcdefghijk:window:0:0'] }],
          intent: 'topic_research',
          confidence: 'medium',
          citations: finalizerAttempt === 1 ? [] : [{
            packetId: 'packet:recovered:transcript',
            sourceId: 'youtube:abcdefghijk:transcript',
            excerptId: 'transcript:abcdefghijk:window:0:0',
          }],
          artifacts: [],
          warnings: [],
        });
      },
    });
    const context = inspectContext();
    let persistAttempt = 0;
    context.finalize = vi.fn(async () => {
      persistAttempt += 1;
      if (persistAttempt === 1) throw new ApiError(422, 'INVALID_AGENT_CITATION', 'Citation validation rejected the first answer.');
      return {
        runId: context.runId,
        conversationId: crypto.randomUUID(),
        userMessageId: crypto.randomUUID(),
        assistantMessageId: crypto.randomUUID(),
        answer: 'The repaired answer uses persisted evidence.',
        intent: 'topic_research' as const,
        confidence: 'medium' as const,
        citations: [],
        artifacts: [],
        warnings: [],
        billing: { creditsCharged: 0, creditsRemaining: 100 },
      };
    });
    const modelBudget = inMemoryModelBudget();

    const result = await runResearchAgentWithModel({
      model: researchModel,
      finalizationModel,
      message: 'Research frontend workflows.',
      decision: { route: 'topic_research' },
      context,
      recoveredEvidence: [transcriptAnalysisPacket()],
      toolNames: [FINALIZE_ANSWER_TOOL_NAME],
      modelBudget,
      modelCallPrefix: 'timeout-citation-repair',
    });

    expect(result.finishReason).toBe('timeout-finalized');
    expect(finalizationModel.doGenerateCalls).toHaveLength(2);
    expect(context.finalize).toHaveBeenCalledTimes(2);
    expect(modelBudget.entries.map((entry) => entry.category)).not.toContain('citation_repair');
  });

  it.each(['missing', 'unknown', 'exhausted'])('validates recovery against persisted evidence (%s references)', async (failure) => {
    const packet = transcriptAnalysisPacket();
    const context = inspectContext();
    context.finalize = vi.fn(async (_id, input) => buildAgentTurnResult({
      runId: context.runId, conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(),
    }, { userId: 'test', idempotencyKey: 'test', creditsRemaining: 100 }, input, [packet], 1));
    let attempts = 0;
    const recovery = new MockLanguageModelV4({ doGenerate: async (call) => {
      attempts += 1;
      if (attempts === 2) expect(JSON.stringify(call.prompt)).toContain('validationFeedback');
      return finalizerModelResult({
        blocks: [{ text: 'Use the supported workflow.', evidenceIds:
          failure === 'exhausted' || (attempts === 1 && failure === 'unknown') ? ['invented'] :
            attempts === 1 ? [] : ['ref_1'] }],
        intent: 'topic_research', confidence: 'medium', artifacts: [], warnings: [],
      });
    } });
    const modelBudget = inMemoryModelBudget();
    const result = await runResearchAgentWithModel({
      model: new MockLanguageModelV4({ doGenerate: async () => { throw new Error('timeout'); } }),
      finalizationModel: recovery, message: 'Research workflows', decision: { route: 'topic_research' },
      context, recoveredEvidence: [packet], modelBudget,
    });
    expect(attempts).toBe(2);
    expect(modelBudget.entries.filter(e => e.category === 'timeout_finalizer')).toHaveLength(2);
    expect(result.finishReason).toBe(failure === 'exhausted' ? 'evidence-fallback' : 'timeout-finalized');
    const lastInput = vi.mocked(context.finalize).mock.calls.at(-1)![1];
    expect(lastInput.answer).toContain(`[cite:${packet.excerpts[0]!.id}]`);
    expect(lastInput.answer).not.toContain('[cite:invented]');
  });

  it('does not restart the finalization deadline when a citation repair stalls', async () => {
    vi.useFakeTimers();
    try {
      const context = inspectContext();
      const originalFinalize = context.finalize;
      context.finalize = vi.fn(async (id, input) => {
        if (id.startsWith('timeout-finalizer:')) throw new ApiError(422, 'INVALID_AGENT_CITATION', 'Unknown reference');
        return originalFinalize(id, input);
      });
      let attempts = 0;
      const recovery = new MockLanguageModelV4({ doGenerate: async () => {
        if (++attempts > 1) return new Promise(() => {});
        return finalizerModelResult({ blocks: [{ text: 'Finding', evidenceIds: ['invented'] }],
          intent: 'topic_research', confidence: 'medium', artifacts: [], warnings: [] });
      } });
      const run = runResearchAgentWithModel({
        model: new MockLanguageModelV4({ doGenerate: async () => { throw new Error('timeout'); } }),
        finalizationModel: recovery, message: 'Research workflows', decision: { route: 'topic_research' },
        context, recoveredEvidence: [transcriptAnalysisPacket()],
      });
      const check = expect(run).resolves.toMatchObject({ finishReason: 'evidence-fallback' });
      await vi.advanceTimersByTimeAsync(20_001);
      await check;
      expect(attempts).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('surfaces Workers AI capacity exhaustion instead of misreporting a timeout', async () => {
    const researchModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('The operation was aborted due to timeout');
      },
    });
    const finalizationModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('3040: Capacity temporarily exceeded');
      },
    });

    await expect(runResearchAgentWithModel({
      model: researchModel,
      finalizationModel,
      message: 'Inspect https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context: inspectContext(),
      toolNames: [FINALIZE_ANSWER_TOOL_NAME],
    })).rejects.toThrow('Workers AI capacity is temporarily exceeded. Retry the request.');
  });

  it('reports the transcript 429 instead of timeout when timeout finalization also fails', async () => {
    let generation = 0;
    const researchModel = new MockLanguageModelV4({
      doGenerate: async () => {
        generation += 1;
        if (generation === 1) {
          return modelResult({
            toolCallId: 'transcript-429',
            toolName: 'get_video_transcript',
            input: JSON.stringify({ videoId: 'abcdefghijk' }),
          });
        }
        throw new Error('The operation was aborted due to timeout');
      },
    });
    const finalizationModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('Fallback finalizer unavailable.');
      },
    });
    const context = transcriptFailureContext();

    await expect(runResearchAgentWithModel({
      model: researchModel,
      finalizationModel,
      message: 'Inspect the transcript for https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context,
      toolNames: ['get_video_transcript', FINALIZE_ANSWER_TOOL_NAME],
    })).rejects.toThrow(
      'Evidence collection failed. get_video_transcript failed 1 time: TRANSCRIPT_FETCH_FAILED: Caption fetch failed: 429 Too Many Requests',
    );
  });

  it('surfaces the recovery failure instead of masking it with the original timeout', async () => {
    const researchModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('The operation was aborted due to timeout');
      },
    });
    const finalizationModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('Fallback finalizer unavailable.');
      },
    });

    await expect(runResearchAgentWithModel({
      model: researchModel,
      finalizationModel,
      message: 'Inspect https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context: inspectContext(),
      toolNames: ['get_video', FINALIZE_ANSWER_TOOL_NAME],
    })).rejects.toThrow('Fallback finalizer unavailable.');
  });
});

function modelResult(toolCall: {
  toolCallId: string;
  toolName: string;
  input: string;
}) {
  return {
    content: [{ type: 'tool-call' as const, ...toolCall }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: {
      inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  };
}

function finalizerModelResult(output: unknown) {
  return modelResult({ toolCallId: 'recovery-answer', toolName: 'finalize_answer', input: JSON.stringify(output) });
}

function multiToolModelResult(toolCalls: Array<{
  toolCallId: string;
  toolName: string;
  input: string;
}>) {
  return {
    content: toolCalls.map((toolCall) => ({ type: 'tool-call' as const, ...toolCall })),
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: {
      inputTokens: { total: 80, noCache: 80, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 40, text: 40, reasoning: undefined },
    },
    warnings: [],
  };
}

function inspectContext(): AgentToolContext {
  const runId = crypto.randomUUID();
  return {
    runId,
    provider: providerWithVideo(),
    transcriptPolicy: { mode: 'complete_transcript' },
    signal: new AbortController().signal,
    executeEvidenceTool: (execution) => execution.execute(),
    finalize: vi.fn(async () => ({
      runId,
      conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(),
      assistantMessageId: crypto.randomUUID(),
      answer: 'The available metadata identifies the video.',
      intent: 'inspect_video' as const,
      confidence: 'low' as const,
      citations: [],
      artifacts: [],
      warnings: [],
      billing: { creditsCharged: 0, creditsRemaining: 100 },
    })),
  };
}

function transcriptFailureContext(): AgentToolContext {
  const context = inspectContext();
  context.provider.transcript = vi.fn(async () => {
    throw new Error('Caption fetch failed: 429 Too Many Requests');
  });
  return context;
}

function transcriptResearchContext(): AgentToolContext {
  const runId = crypto.randomUUID();
  const context = inspectContext();
  context.provider.transcript = vi.fn(async (videoId: string) => ({
    cacheStatus: 'miss' as const,
    value: {
      videoId,
      track: {
        id: 'en',
        name: 'English',
        languageCode: 'en',
        kind: 'manual' as const,
        isTranslatable: true,
        isDefault: true,
      },
      segments: [{
        startMs: 0,
        durationMs: 10_000,
        endMs: 10_000,
        text: `Transcript evidence for ${videoId}.`,
      }],
      text: `Transcript evidence for ${videoId}.`,
      meta: {
        source: 'allthingsyoutube' as const,
        fetchedAt: new Date().toISOString(),
        partial: false,
        warnings: [],
      },
    },
  }));
  context.transcriptPolicy = {
    mode: 'contextual_analysis',
    researchQuestion: 'Suggest the best frontend development skills.',
    analyze: vi.fn(async ({ videoId }) => ({
      summary: `The video ${videoId} recommends practical frontend skills.`,
      findings: [{
        claim: 'Use TypeScript and automated tests.',
        excerptIds: [`transcript:${videoId}:window:0:0`],
      }],
      excerpts: [{
        id: `transcript:${videoId}:window:0:0`,
        text: `Transcript evidence for ${videoId}.`,
        startMs: 0,
        endMs: 10_000,
      }],
      warnings: [],
      coverage: {
        completeTranscriptRead: true as const,
        segmentCount: 1,
        startMs: 0,
        endMs: 10_000,
      },
    })),
  };
  const executions = new Map<string, Promise<Awaited<ReturnType<AgentToolContext['executeEvidenceTool']>>>>();
  context.executeEvidenceTool = (execution) => {
    const existing = executions.get(execution.semanticKey);
    if (existing) return existing;
    const promise = execution.execute();
    executions.set(execution.semanticKey, promise);
    return promise;
  };
  context.finalize = vi.fn(async () => ({
    runId,
    conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    answer: 'Two transcript analyses provide enough evidence.',
    intent: 'topic_research' as const,
    confidence: 'medium' as const,
    citations: [],
    artifacts: [],
    warnings: [],
    billing: { creditsCharged: 0, creditsRemaining: 100 },
  }));
  return context;
}

function researchTranscriptContext(
  transcriptText: string,
  analysisSummary: string,
  persistedPackets: Array<{ excerpts: Array<{ text: string }> }>,
): AgentToolContext {
  const context = inspectContext();
  context.transcriptPolicy = {
    mode: 'contextual_analysis',
    researchQuestion: 'Suggest frontend development skills.',
    analyze: vi.fn(async () => ({
      summary: analysisSummary,
      findings: [{
        claim: 'TypeScript is a recommended frontend skill.',
        excerptIds: ['transcript:abcdefghijk:window:0:0'],
      }],
      excerpts: [{
        id: 'transcript:abcdefghijk:window:0:0',
        text: transcriptText,
        startMs: 0,
        endMs: 60_000,
      }],
      warnings: [],
      coverage: {
        completeTranscriptRead: true as const,
        segmentCount: 1,
        startMs: 0,
        endMs: 60_000,
      },
    })),
  };
  context.provider.transcript = vi.fn(async () => ({
    cacheStatus: 'miss' as const,
    value: {
      videoId: 'abcdefghijk',
      track: {
        id: 'en',
        name: 'English',
        languageCode: 'en',
        kind: 'manual' as const,
        isTranslatable: true,
        isDefault: true,
      },
      segments: [{
        startMs: 0,
        durationMs: 60_000,
        endMs: 60_000,
        text: transcriptText,
      }],
      text: transcriptText,
      meta: {
        source: 'allthingsyoutube' as const,
        fetchedAt: new Date().toISOString(),
        partial: false,
        warnings: [],
      },
    },
  }));
  context.executeEvidenceTool = async (execution) => {
    const packet = await execution.execute();
    persistedPackets.push(packet);
    return packet;
  };
  return context;
}

function transcriptAnalysisPacket(): EvidencePacket {
  return {
    packetId: 'packet:recovered:transcript',
    kind: 'youtube_transcript' as const,
    sources: [{
      id: 'youtube:abcdefghijk:transcript',
      provider: 'youtube',
      kind: 'transcript',
      videoId: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    }],
    excerpts: [{
      id: 'transcript:abcdefghijk:window:0:0',
      sourceId: 'youtube:abcdefghijk:transcript',
      text: 'Persisted transcript evidence.',
      startMs: 0,
      endMs: 60_000,
    }],
    artifacts: [{
      type: 'youtube_transcript_analysis',
      data: {
        summary: 'The video provides one relevant workflow.',
        findings: [{
          claim: 'Use persisted evidence.',
          excerptIds: ['transcript:abcdefghijk:window:0:0'],
        }],
        coverage: {
          completeTranscriptRead: true as const,
          segmentCount: 1,
          startMs: 0,
          endMs: 60_000,
        },
        selectedExcerptCount: 1,
      },
    }],
    warnings: [],
    usage: [{ operation: 'transcript' as const, credits: 1, cacheStatus: 'hit' as const }],
  };
}

function inMemoryModelBudget(
  currentCostMicros = 0,
): AgentModelCostBudget & { entries: AgentModelUsageEntry[] } {
  const entries: AgentModelUsageEntry[] = [];
  return {
    limitMicros: 1_000_000,
    entries,
    currentCostMicros: () => currentCostMicros,
    recordUsage: (entry) => entries.push(entry),
  };
}

function providerWithVideo(): YouTubeAgentProvider {
  const unexpected = async () => { throw new Error('Unexpected provider call.'); };
  return {
    search: unexpected,
    browse: unexpected,
    trends: unexpected,
    video: vi.fn(async () => ({
      cacheStatus: 'miss' as const,
      value: {
        type: 'video',
        id: 'abcdefghijk',
        title: 'Agent design lesson',
        description: 'A practical lesson about agent design.',
        channel: {
          id: 'channel-1',
          name: 'Agent Design Channel',
          url: 'https://www.youtube.com/channel/channel-1',
        },
        thumbnails: [],
        durationSeconds: 600,
        durationText: '10:00',
        publishedTimeText: '1 day ago',
        viewCount: 1000,
        viewCountText: '1K views',
        isLive: false,
        hasCaptions: true,
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        keywords: ['agents'],
        availability: { status: 'OK', playable: true },
        meta: {
          source: 'allthingsyoutube',
          fetchedAt: new Date().toISOString(),
          partial: false,
          warnings: [],
        },
      },
    })),
    tracks: unexpected,
    transcript: unexpected,
    comments: unexpected,
    endscreen: unexpected,
    channel: unexpected,
    channelVideos: unexpected,
    channelPlaylists: unexpected,
    playlist: unexpected,
  } as YouTubeAgentProvider;
}
