'use client';

import Image from 'next/image';
import { useState } from 'react';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { citedFrameImageUrl, citedFrameLabel, safeSourceUrl, type CitedFrame } from '../../../lib/agent-sessions';

/** Exact frames the answer cites. Each opens its video at that moment; a deleted preview disappears. */
export function CitedFrames({ frames }: { frames: CitedFrame[] }) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const visible = frames.flatMap(frame => {
    const image = citedFrameImageUrl(frame), href = safeSourceUrl(frame.videoUrl);
    return image && href && !failed.has(frame.imagePath) ? [{ frame, image, href, label: citedFrameLabel(frame) }] : [];
  });
  if (!visible.length) return null;
  return <section className='agent-cited-frames' aria-label='Frames cited in this answer'>
    <h3>Frames cited</h3>
    <div className='agent-frame-grid'>{visible.map(({ frame, image, href, label }) =>
      <a key={frame.imagePath} className='agent-frame-card agent-cited-frame' href={href} target='_blank' rel='noreferrer'
        aria-label={`Open source ${frame.sourceId} at ${label.slice(1, -1).split(' · ')[1]} on YouTube`}>
        <span className='agent-frame-thumbnail'>
          <Image unoptimized src={image} width={frame.width} height={frame.height} loading='lazy'
            alt={`Cited video frame ${label}`} onError={() => setFailed(previous => new Set(previous).add(frame.imagePath))} />
        </span>
        <span className='agent-frame-caption'><span>{label}</span><span>Open at this moment<ArrowUpRightIcon size={11} aria-hidden='true' /></span></span>
      </a>)}</div>
  </section>;
}
