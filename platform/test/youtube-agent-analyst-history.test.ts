import { MockLanguageModelV4 } from 'ai/test';
import { createFrameAnalyst } from '../src/agents/providers/youtube/frame-analyst';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';

it.each(['frames', 'storyboard', 'transcript'] as const)('includes prior statements in the %s model request', async kind => {
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ findings: [], warnings: [] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 } },
  }) });
  const input = { signal: new AbortController().signal, focus: 'Check the previous claim.', modelCallId: 'history',
    conversationHistory: [{ userMessageId: 'u', agentMessageId: 'a', resourceIds: ['abcdefghijk'],
      user: 'Who holds the microphone?', assistant: 'The man in red holds it.' }] };
  if (kind === 'frames') await createFrameAnalyst(model)({ ...input,
    frames: { videoId: 'abcdefghijk', frames: [{ timestampMs: 1000, mimeType: 'image/jpeg',
      width: 100, height: 100, imageBase64: '/9j/2Q==' }], failures: [], meta: { partial: false, warnings: [] } },
  });
  if (kind === 'storyboard') await createVisualAnalyst(model)({ ...input,
    storyboard: { videoId: 'abcdefghijk', frameCount: 1, intervalMs: 1000,
      sheets: [{ imageBase64: '/9j/2Q==', tileWidth: 100, tileHeight: 100, columns: 1, rows: 1,
        firstFrameIndex: 0, frameCount: 1, intervalMs: 1000 }], meta: { partial: false, warnings: [] } },
  });
  if (kind === 'transcript') await analyzeTranscriptWithModel({ ...input, model, videoId: 'abcdefghijk',
    researchQuestion: 'Check the previous claim.',
    segments: [{ text: 'Thank you for the interview.', startMs: 0, endMs: 1000, durationMs: 1000 }],
  });
  expect(model.doGenerateCalls).toHaveLength(1);
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  expect(prompt).toContain('Who holds the microphone?');
  expect(prompt).toContain('The man in red holds it.');
  expect(prompt).toContain('Earlier assistant answers may be wrong.');
});
