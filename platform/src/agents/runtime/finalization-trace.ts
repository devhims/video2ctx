import type { EvidencePacket } from '../contracts';
import type { TraceToolCall } from './tool-call-trace';
import { TranscriptGroundingError } from './transcript-grounding';

const CANDIDATE_LIMIT = 32_000;
const ISSUE_LIMIT = 40;
const REFERENCE_LIMIT = 128;

export interface FinalizationFailureCapture {
  runId: string;
  attemptId: string;
  attempt: number;
  modelCallId: string;
  failoverCallId?: string;
  /** Present only when the provider reports the responding model. */
  modelId?: string;
  requestedModelId?: string;
  schemaVersion: string;
  responseId?: string;
  startedAt: number;
  elapsedMs: number;
  validationStage: string;
  finishReason?: string;
  code: string;
  candidate?: string;
  candidateCharacters: number;
  schemaIssues?: Array<{ path: PropertyKey[]; code: string; message: string }>;
  referenceMap: ReadonlyMap<string, string>;
  evidence: readonly EvidencePacket[];
  /** Only application validation errors may contribute private error text. */
  validationMessage?: string;
  error: unknown;
}

/** Post-generation diagnostic, not another model/tool request. Uses the same private
 * trace capture, publication, access and deletion path as ordinary agent tools. */
export async function traceFinalizationFailure(trace: TraceToolCall | undefined, capture: FinalizationFailureCapture): Promise<void> {
  if (!trace) return;
  const issue = capture.error instanceof TranscriptGroundingError ? capture.error.answerIssue : undefined;
  const references = [...capture.referenceMap].map(([alias, evidenceId]) => ({ alias, evidenceId }));
  const cited = new Set(issue?.evidenceIds ?? []);
  for (const evidenceId of cited) {
    if (!references.some(ref => ref.evidenceId === evidenceId)) references.push({ alias: evidenceId, evidenceId });
  }
  // Put the offending block's references first if the full mapping needs truncation.
  references.sort((a, b) => Number(cited.has(b.evidenceId)) - Number(cited.has(a.evidenceId)));
  const schemaIssues = capture.schemaIssues ?? [];
  const message = capture.validationMessage ?? 'Final answer generation did not complete.';
  const recordedError = Object.assign(new Error(message.slice(0, 4_000)), {
    name: 'FinalAnswerRejection', code: capture.code,
  });
  const input = {
    version: 1, stage: 'finalization', captureKind: 'rejected_answer',
    attemptId: capture.attemptId, attempt: capture.attempt,
    modelCallId: capture.modelCallId, failoverCallId: capture.failoverCallId,
    modelId: capture.modelId, requestedModelId: capture.requestedModelId, responseId: capture.responseId,
    schemaVersion: capture.schemaVersion,
    generationStartedAt: capture.startedAt, generationElapsedMs: capture.elapsedMs,
    validationStage: capture.validationStage, finishReason: capture.finishReason, code: capture.code,
    candidate: capture.candidate?.slice(0, CANDIDATE_LIMIT), candidateCharacters: capture.candidateCharacters,
    captureTruncated: capture.candidateCharacters > CANDIDATE_LIMIT
      || capture.candidateCharacters > (capture.candidate?.length ?? 0)
      || schemaIssues.length > ISSUE_LIMIT || references.length > REFERENCE_LIMIT || message.length > 4_000
      || schemaIssues.some(item => item.message.length > 1_000),
    issues: schemaIssues.slice(0, ISSUE_LIMIT).map(item => ({ code: item.code,
      path: item.path.map(String), message: item.message.slice(0, 1_000) })),
    groundingIssue: issue,
    references: references.slice(0, REFERENCE_LIMIT).map(ref => {
      const packet = capture.evidence.find(packet => packet.excerpts.some(excerpt => excerpt.id === ref.evidenceId));
      const excerpt = packet?.excerpts.find(excerpt => excerpt.id === ref.evidenceId);
      const source = packet?.sources.find(source => source.id === excerpt?.sourceId);
      return { ...ref, packetId: packet?.packetId, sourceId: excerpt?.sourceId,
        videoId: source?.videoId, assetVersions: packet?.assetVersions };
    }),
  };
  try {
    await trace({ toolCallId: `final-answer-rejection:${capture.attemptId}`, name: 'final_answer_rejection',
      operation: 'finalization_validation', source: 'model', input,
      execute: async () => { throw recordedError; } });
  } catch (error) {
    // Recording a diagnostic must never replace the original failure or stop its repair.
    if (error !== recordedError) console.warn(JSON.stringify({ event: 'agent_finalization_trace_failed',
      runId: capture.runId, attemptId: capture.attemptId }));
  }
}
