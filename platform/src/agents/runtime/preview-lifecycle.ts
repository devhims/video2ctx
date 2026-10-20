import type { EvidencePacket } from '../contracts';
import type { AgentToolContext } from '../providers/youtube/tool-context';
import { packetFramePreviews, type FramePreview } from './frame-previews';
import { packetStoryboardPreviews } from './storyboard-previews';

/** Own previews until the entire tool, including durable packet publication, succeeds. */
export async function withPreviewCleanup(
  context: AgentToolContext,
  execute: (context: AgentToolContext) => Promise<EvidencePacket>,
): Promise<EvidencePacket> {
  const created: FramePreview[] = [];
  const writes: Promise<unknown>[] = [];
  let closed = false;
  const track = <Args extends unknown[], Result extends FramePreview[]>(save: (...args: Args) => Promise<Result>) =>
    (...args: Args): Promise<Result> => {
      if (closed) return Promise.reject(new Error('Preview publication is closed.'));
      const writing = save(...args).then(previews => { created.push(...previews); return previews; });
      writes.push(writing);
      return writing;
    };
  let packet: EvidencePacket | undefined;
  try {
    packet = await execute({ ...context,
      saveFramePreviews: context.saveFramePreviews && track(context.saveFramePreviews),
      saveStoryboardPreviews: context.saveStoryboardPreviews && track(context.saveStoryboardPreviews),
    });
    return packet;
  } finally {
    closed = true;
    // A deadline may reject before a write settles. Drain it before deleting so
    // a late PUT cannot recreate an already cleaned-up preview.
    await Promise.allSettled(writes);
    const key = (preview: FramePreview) => `${preview.collectionId}/${preview.assetId}`;
    const retained = new Set(packet ? [...packetFramePreviews(packet), ...packetStoryboardPreviews(packet).sheets].map(key) : []);
    const abandoned = created.filter(preview => !retained.has(key(preview)));
    if (abandoned.length) await context.discardPreviews?.(abandoned);
  }
}
