import type { ExtractionAttempt } from './extraction-diagnostics';
import type { FrameLeaseKind } from '../durable-objects/media-frame-capacity';
import { FrameMediaError, frameAbortable, frameWait } from './frame-media-io';

export type AdmissionDetails = Pick<ExtractionAttempt['events'][number], 'leaseKind' | 'leaseId' | 'admissionState' |
  'lastDenial' | 'rpcMs' | 'rpcAttempts' | 'retryAfterMs'>;

// Two production first grants arrived at 2.067 s and 2.618 s. Only the initial
// batch RPC gets reply grace. Refusals and retries still share the original budget.
const FIRST_JOB_REPLY_GRACE_MS = 2000;

/** Fail closed on unknown admission. Leases expire if a caller or an RPC disappears. */
export async function acquireFrameLease(env: Env, kind: FrameLeaseKind, signal: AbortSignal, waitMs = 2000,
  observe?: (details: AdmissionDetails) => void) {
  const stub = env.MEDIA_FRAME_CAPACITY.getByName('account-v1');
  const id = crypto.randomUUID(), end = Date.now() + waitMs;
  const retryDeadline = AbortSignal.any([signal, AbortSignal.timeout(waitMs)]);
  let deadline = kind === 'media-job'
    ? AbortSignal.any([signal, AbortSignal.timeout(waitMs + FIRST_JOB_REPLY_GRACE_MS)])
    : retryDeadline;
  const details: AdmissionDetails = { leaseId: id, leaseKind: kind };
  let rpcAttempts = 0, rpcMs = 0;
  let phase: 'rpc' | 'retry' = 'rpc';
  try {
    for (;;) {
      phase = 'rpc';
      const sent = Date.now();
      rpcAttempts++;
      const response = await frameAbortable(deadline, () => stub.acquire(id, kind)).finally(() => {
        rpcMs += Date.now() - sent;
      });
      if (response.admitted) {
        details.admissionState = 'admitted';
        return {
          release: () => frameAbortable(AbortSignal.timeout(1000), () => stub.release(id)).catch(() => undefined),
          throttle: () => frameAbortable(AbortSignal.timeout(1000), () => stub.throttle()).catch(() => undefined),
        };
      }
      details.lastDenial = response.denial;
      details.retryAfterMs = response.retryAfterMs;
      if (Date.now() + response.retryAfterMs >= end) {
        details.admissionState = 'refused';
        throw new FrameMediaError('capacity');
      }
      deadline = retryDeadline;
      phase = 'retry';
      await frameWait(Math.max(50, response.retryAfterMs), deadline);
    }
  } catch (error) {
    details.admissionState ??= signal.aborted ? 'canceled' : !deadline.aborted ? 'rpc_error'
      : phase === 'rpc' ? 'rpc_timeout' : 'retry_timeout';
    signal.throwIfAborted();
    if (deadline.aborted) throw new FrameMediaError('capacity');
    throw error;
  } finally {
    observe?.({ ...details, rpcAttempts, rpcMs });
  }
}
