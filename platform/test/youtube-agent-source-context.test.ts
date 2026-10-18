import { MockLanguageModelV4 } from 'ai/test';
import { executeGetVideo } from '../src/agents/providers/youtube/tools/get-video';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import { createFrameAnalyst } from '../src/agents/providers/youtube/frame-analyst';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';
import { transcriptSourceContext } from '../src/agents/runtime/transcript-grounding';
import { evidencePacketForModel, finalizationEvidenceForModel } from '../src/agents/runtime/model-evidence';
import { metadataForConversation } from '../src/agents/runtime/conversation-metadata';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';

const videoId = 'B2QtJKMlYTo';
const title = 'How Gen Z are fighting to change India | BBC News';
const description = `${'Episode context. '.repeat(150)}\nThe BBC’s South Asia correspondent, Azadeh Moshiri, explains.\n0:51 Introduction to Azadeh Moshiri\n${'More publisher context. '.repeat(100)}`;
const sourceContext = { title, description, channel: 'BBC News' };

async function metadata() {
  const context = {
    runId: 'context-test', signal: new AbortController().signal,
    provider: { video: async () => ({ cacheStatus: 'hit', value: { id: videoId, title, description,
      url: `https://www.youtube.com/watch?v=${videoId}`, channel: { id: 'bbc', name: 'BBC News' },
      keywords: [], availability: { status: 'OK', playable: true },
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] } } }) },
    executeEvidenceTool: (execution: { execute: () => Promise<unknown> }) => execution.execute(),
  } as unknown as AgentToolContext;
  return executeGetVideo({ videoId }, context, 'metadata');
}

it('retains a complete description beyond both old truncation limits through metadata, follow-ups and finalization', async () => {
  const packet = await metadata();
  expect(transcriptSourceContext(videoId, [packet])).toMatchObject(sourceContext);
  expect(evidencePacketForModel(packet).excerpts!.map(e => e.text).join('')).toContain(description);
  const remembered = metadataForConversation([{ packet, recordedAt: Date.now() }]);
  expect(transcriptSourceContext(videoId, remembered)).toMatchObject(sourceContext);
  expect(JSON.stringify(finalizationEvidenceForModel(remembered, 40_000))).toContain('0:51 Introduction to Azadeh Moshiri');
  expect(transcriptSourceContext('other123456', [packet])).toEqual({});
});

it.each(['frames', 'storyboard', 'transcript'] as const)('passes full publisher context and the question to the %s model', async kind => {
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ findings: [], warnings: [] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 } },
  }) });
  const input = { signal: new AbortController().signal, focus: 'Read the presenter name.',
    researchQuestion: 'What is the presenter wearing and what is her background?', modelCallId: 'context', sourceContext };
  if (kind === 'frames') await createFrameAnalyst(model)({ ...input,
    frames: { videoId, frames: [{ timestampMs: 50_000, mimeType: 'image/jpeg', width: 100, height: 100,
      imageBase64: '/9j/2Q==' }], failures: [], meta: { partial: false, warnings: [] } },
  });
  if (kind === 'storyboard') await createVisualAnalyst(model)({ ...input,
    storyboard: { videoId, frameCount: 1, intervalMs: 1000, sheets: [{ imageBase64: '/9j/2Q==',
      tileWidth: 100, tileHeight: 100, columns: 1, rows: 1, firstFrameIndex: 0, frameCount: 1, intervalMs: 1000 }],
      meta: { partial: false, warnings: [] } },
  });
  if (kind === 'transcript') await analyzeTranscriptWithModel({ ...input, model, videoId,
    segments: [{ text: "I'm Azad Masher, the BBC's South Asia correspondent.", startMs: 0, endMs: 1000, durationMs: 1000 }],
  });
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  const user = model.doGenerateCalls[0]!.prompt.find(message => message.role === 'user')!;
  const text = user.content.find(part => part.type === 'text')!;
  expect(JSON.parse(text.text).sourceContext.description).toBe(description);
  expect(prompt).toContain(title);
  expect(prompt).toContain('BBC News');
  expect(prompt).toContain(input.researchQuestion);
  expect(prompt).toContain('untrusted');
});
