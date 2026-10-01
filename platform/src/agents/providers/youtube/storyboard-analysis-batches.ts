import { canAnalyzeStoryboard } from '../../runtime/storyboard-budget';
import type { Storyboard } from './storyboard';
import type { VisualAnalyst, VisualAnalystInput, VisualAnalysis } from './visual-analyst';

export const STORYBOARD_ANALYSIS_BATCH_SHEETS = 6;
const ANALYSIS_CONCURRENCY = 2;

/** Keep source frame IDs intact and retain completed batches if another fails. */
export async function analyzeStoryboardBatches(
  analyze: VisualAnalyst, input: VisualAnalystInput, deadlineAt?: number,
) {
  const batches: Storyboard[] = [];
  for (let offset = 0; offset < input.storyboard.sheets.length; offset += STORYBOARD_ANALYSIS_BATCH_SHEETS) {
    const sheets = input.storyboard.sheets.slice(offset, offset + STORYBOARD_ANALYSIS_BATCH_SHEETS);
    batches.push({ ...input.storyboard, sheets, selection: { mode: 'indexes', requestedSheetIndexes:
      sheets.map(sheet => Math.floor(sheet.firstFrameIndex / (input.storyboard.manifest?.framesPerSheet ?? sheet.columns * sheet.rows))) } });
  }
  const findings: VisualAnalysis['findings'] = [];
  const warnings: string[] = [];
  const analyzedSheets: Storyboard['sheets'] = [];
  let firstFailure: unknown;
  for (let offset = 0; offset < batches.length; offset += ANALYSIS_CONCURRENCY) {
    input.signal.throwIfAborted();
    if (!canAnalyzeStoryboard(deadlineAt)) {
      warnings.push('Remaining storyboard batches were not analyzed because the research deadline is too close.');
      break;
    }
    const wave = batches.slice(offset, offset + ANALYSIS_CONCURRENCY);
    const results = await Promise.allSettled(wave.map(async (storyboard, index) => {
      const result = await analyze({ ...input, storyboard,
        modelCallId: batches.length === 1 ? input.modelCallId : `${input.modelCallId}:batch:${offset + index}` });
      for (const finding of result.findings) for (const frame of finding.frameIndexes) {
        if (!storyboard.sheets.some(sheet => frame >= sheet.firstFrameIndex && frame < sheet.firstFrameIndex + sheet.frameCount))
          throw new Error(`Visual analyst referenced unavailable frame ${frame}.`);
      }
      return result;
    }));
    input.signal.throwIfAborted();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        findings.push(...result.value.findings);
        warnings.push(...result.value.warnings);
        analyzedSheets.push(...wave[index]!.sheets);
      } else {
        firstFailure ??= result.reason;
        warnings.push(`Storyboard analysis batch ${offset + index + 1} failed; its ${wave[index]!.sheets.length} sheets have no visual findings.`);
      }
    });
  }
  if (!analyzedSheets.length) throw firstFailure ?? new Error('Not enough research time to analyze storyboards.');
  return { findings, warnings, analyzedSheets, batchCount: batches.length };
}
