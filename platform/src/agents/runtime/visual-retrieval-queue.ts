import { visualSpan } from '../../lib/visual-diagnostics';

type Waiter = { videoId: string; start: () => void };

/** Bound image work while keeping overlapping selections for one video ordered. */
export class VisualRetrievalQueue {
  private readonly active = new Set<string>();
  private readonly waiting: Waiter[] = [];

  async run<T>(videoId: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    await visualSpan('session_queue_wait', () => this.acquire(videoId, signal));
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      this.active.delete(videoId);
      this.drain();
    }
  }

  private acquire(videoId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { videoId, start: () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      } };
      const cancel = () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal?.removeEventListener('abort', cancel);
        reject(signal!.reason);
      };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active.size < 2) {
      // A same-video waiter must not occupy the slot another video can use.
      const index = this.waiting.findIndex(waiter => !this.active.has(waiter.videoId));
      if (index < 0) return;
      const [waiter] = this.waiting.splice(index, 1);
      this.active.add(waiter!.videoId);
      // Resolve admission only. Work resumes in its caller's diagnostic context.
      waiter!.start();
    }
  }
}
