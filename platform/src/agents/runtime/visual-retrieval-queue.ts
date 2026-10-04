import { visualSpan } from '../../lib/visual-diagnostics';

type VisualKind = 'storyboard' | 'frames';
type Waiter = { videoId: string; kind: VisualKind; start: () => void };

/** Bound image work while keeping overlapping selections for one video ordered. */
export class VisualRetrievalQueue {
  private readonly active = new Set<string>();
  private readonly waiting: Waiter[] = [];
  private framesActive = false;

  async run<T>(videoId: string, signal: AbortSignal | undefined, work: () => Promise<T>, kind: VisualKind = 'storyboard'): Promise<T> {
    await visualSpan('session_queue_wait', () => this.acquire(videoId, kind, signal));
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      this.active.delete(videoId);
      if (kind === 'frames') this.framesActive = false;
      this.drain();
    }
  }

  private acquire(videoId: string, kind: VisualKind, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { videoId, kind, start: () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      } };
      const cancel = () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal?.removeEventListener('abort', cancel);
        reject(signal!.reason);
        this.drain();
      };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active.size < 2) {
      // Waiting for a frame processor must not block another video's storyboard.
      // Preserve same-video order even when its earlier request is capacity-blocked.
      const index = this.waiting.findIndex((waiter, index) => !this.active.has(waiter.videoId)
        && (waiter.kind !== 'frames' || !this.framesActive)
        && !this.waiting.slice(0, index).some(earlier => earlier.videoId === waiter.videoId));
      if (index < 0) return;
      const [waiter] = this.waiting.splice(index, 1);
      this.active.add(waiter!.videoId);
      if (waiter!.kind === 'frames') this.framesActive = true;
      // Resolve admission only. Work resumes in its caller's diagnostic context.
      waiter!.start();
    }
  }
}
