/** Operator diagnostics, never included in the frame response. Receivers must redact error text. */
export interface FrameDiagnostic {
  stage: string;
  profile?: string;
  timestampMs?: number;
  candidateIndex?: number;
  candidateCount?: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  formatId?: number;
  status?: number;
  playabilityStatus?: string;
  reason?: string;
  elapsedMs?: number;
  attempt?: number;
  delayMs?: number;
  error?: unknown;
}
export type DiagnosticSink = (event: FrameDiagnostic) => void;

export function diagnose(sink: DiagnosticSink | undefined, event: FrameDiagnostic): void {
  try { sink?.(event); } catch { /* Observability must not change extraction behavior. */ }
}
