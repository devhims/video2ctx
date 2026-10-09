// Opt-in calls to Fireworks using a synthetic image: a red rectangle and unreadable fine print.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAgentModel } from '../src/agents/model';
import { createFrameAnalyst } from '../src/agents/providers/youtube/frame-analyst';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
const env = { AGENT_GLM_PROVIDER: 'fireworks', AI_GATEWAY_ID: '',
  FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1 ?? '' } as unknown as Env;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.jpg`, import.meta.url)).toString('base64');
const videoId = 'video000001';
async function analyze(kind: 'frames' | 'storyboard', focus: string, finePrint = false) {
  const imageBase64 = fixture(finePrint ? 'visual-scope' : 'visual-scope-clean');
  const model = createAgentModel(env, `visual-scope:${crypto.randomUUID()}`, 'low', { model_role: 'visual_analyst' });
  const common = { focus, signal: AbortSignal.timeout(25000), modelCallId: `scope-${kind}` };
  if (kind === 'frames') return createFrameAnalyst(model)({ ...common, researchQuestion: focus,
    frames: { videoId, frames: [{ timestampMs: 10000, mimeType: 'image/jpeg', width: 640, height: 360, imageBase64 }],
      failures: [], meta: { partial: false, warnings: [] } } });
  return createVisualAnalyst(model)({ ...common, storyboard: { videoId, frameCount: 61, intervalMs: 1000,
    selection: { mode: 'indexes', requestedSheetIndexes: [10] },
    sheets: [{ tileWidth: 640, tileHeight: 360, columns: 1, rows: 1, firstFrameIndex: 10, frameCount: 1, intervalMs: 1000, imageBase64 }],
    meta: { partial: false, warnings: [] } } });
}
describe.skipIf(process.env.AGENT_VISUAL_SCOPE_LIVE !== '1')('live visual analyst scope', () => {
  for (const kind of ['frames', 'storyboard'] as const) {
    it.each([
      'Compare the shape colors at 10 seconds and 60 seconds in this video.',
      'Compare the shape colors in video000001 and video000002.',
    ])(`${kind} extracts local evidence for %s`, async focus => {
      const result = await analyze(kind, focus);
      expect(result.warnings).toEqual([]);
      expect(result.findings.length).toBeGreaterThan(0);
      const observations = result.findings.map(f => f.observation).join(' ');
      expect(observations).toMatch(/red/i);
      expect(observations).not.toMatch(/60|video000002|missing|not (?:provided|supplied|included|available)|cannot compar|comparison.*(?:impossible|not possible)/i);
    }, 30000);
    it(`${kind} preserves a supplied-image readability limitation`, async () => {
      const result = await analyze(kind, 'Transcribe the fine print at the bottom of the image exactly.', true);
      expect([...result.warnings, ...result.findings.map(f => f.observation)].join(' ')).toMatch(/unreadable|illegible|blur|resolution|small|read|legib/i);
    }, 30000);
  }
});
