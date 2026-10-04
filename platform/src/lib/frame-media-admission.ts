import type { FrameLeaseKind } from '../durable-objects/media-frame-capacity';
import { FrameMediaError, frameAbortable, frameWait } from './frame-media-io';

/** Fail closed on unknown admission. Leases expire if a caller or an RPC disappears. */
export async function acquireFrameLease(env: Env, kind: FrameLeaseKind, signal: AbortSignal, waitMs = 2000) {
  const stub = env.MEDIA_FRAME_CAPACITY.getByName('account-v1');
  const id = crypto.randomUUID(), end = Date.now() + waitMs;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(waitMs)]);
  try {
    for (;;) {
      // Cold placement can take more than one second. Use the complete admission
      // budget while keeping all retries inside the same deadline.
      const response = await frameAbortable(deadline, () => stub.acquire(id, kind));
      if (response.admitted) return {
        release: () => frameAbortable(AbortSignal.timeout(1000), () => stub.release(id)).catch(() => undefined),
        throttle: () => frameAbortable(AbortSignal.timeout(1000), () => stub.throttle()).catch(() => undefined),
      };
      if (Date.now() + response.retryAfterMs >= end) throw new FrameMediaError('capacity');
      await frameWait(Math.max(50, response.retryAfterMs), deadline);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.aborted) throw new FrameMediaError('capacity');
    throw error;
  }
}
