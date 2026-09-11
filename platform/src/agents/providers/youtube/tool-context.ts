import type { FrameAnalyst } from './frame-analyst';
import type { SaveFramePreviews } from '../../runtime/frame-previews';
import type { VisualAnalyst } from './visual-analyst';
import type { AgentTurnResult, EvidenceOperation, EvidencePacket, FinalizeAnswerInput } from '../../contracts';
import type { YouTubeAgentProvider } from './provider';
import type { YouTubeProviderToolName } from './tool-names';
import type { TranscriptAnalyst } from './transcript-analyst';

export interface TranscriptAnalysisBudget {
  tryReserve(semanticKey: string): boolean;
  release(semanticKey: string): void;
  isExhausted(): boolean;
}

export interface EvidenceToolExecution {
  toolCallId: string;
  toolName: YouTubeProviderToolName;
  semanticKey: string;
  operation: EvidenceOperation;
  execute: () => Promise<EvidencePacket>;
}

export interface AgentToolContext {
  analyzeStoryboard?: VisualAnalyst;
  analyzeFrames?: FrameAnalyst;
  saveFramePreviews?: SaveFramePreviews;
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
