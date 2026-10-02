import type { StoredExtractionDiagnostic } from '../../../lib/extraction-diagnostics';
import type { FrameAnalyst } from './frame-analyst';
import type { SaveFramePreviews } from '../../runtime/frame-previews';
import type { SaveStoryboardPreviews } from '../../runtime/storyboard-previews';
import type { VisualAnalyst } from './visual-analyst';
import type { AgentTurnResult, EvidenceOperation, EvidencePacket, FinalizeAnswerInput } from '../../contracts';
import type { YouTubeAgentProvider } from './provider';
import type { YouTubeEvidenceToolName } from './tool-names';
import type { TranscriptAnalyst } from './transcript-analyst';

export interface TranscriptAnalysisBudget {
  tryReserve(semanticKey: string): boolean;
  release(semanticKey: string): void;
  isExhausted(): boolean;
}

export interface EvidenceToolExecution {
  toolCallId: string;
  toolName: YouTubeEvidenceToolName;
  semanticKey: string;
  operation: EvidenceOperation;
  input: unknown;
  execute: () => Promise<EvidencePacket>;
}

export interface AgentToolContext {
  traceToolCall?: import('../../runtime/tool-call-trace').TraceToolCall;
  pinnedVideoId?: string;
  transcriptSelection?: {
    allowReplacement: boolean;
    attempted: Set<string>;
    unavailable: Set<string>;
    regionRestricted?: Set<string>;
    /** Videos rejected for exceeding the agent's video length limit. */
    tooLong?: Set<string>;
  };
  /** Longest video, in seconds, the agent will search for, retrieve or analyze. */
  maxVideoSeconds?: number;
  refreshEvidence?: boolean;
  session?: import('../../runtime/session-evidence').SessionAccess;
  onExtractionDiagnostic?: (event: StoredExtractionDiagnostic) => void;
  researchDeadlineAt?: number;
  researchQuestion?: string;
  /** Trusted line naming the run's date, appended to research and finalizer instructions. */
  currentDate?: string;
  getEvidence?(): readonly EvidencePacket[];
  analyzeStoryboard?: VisualAnalyst;
  analyzeFrames?: FrameAnalyst;
  saveFramePreviews?: SaveFramePreviews;
  saveStoryboardPreviews?: SaveStoryboardPreviews;
  validateAnswerBlocks?(blocks: readonly { text: string; evidenceIds: string[] }[]): void;
  runId: string;
  provider: YouTubeAgentProvider;
  transcriptPolicy:
    | {
      mode: 'contextual_analysis';
      researchQuestion: string;
      analyze: TranscriptAnalyst;
      budget?: TranscriptAnalysisBudget;
    }
    | { mode: 'complete_transcript' };
  signal: AbortSignal;
  executeEvidenceTool(execution: EvidenceToolExecution): Promise<EvidencePacket>;
  finalize(toolCallId: string, input: FinalizeAnswerInput): Promise<AgentTurnResult>;
}

export class ConcurrencyLimiter {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency limit must be a positive integer.');
    this.#limit = limit;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await work();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}
