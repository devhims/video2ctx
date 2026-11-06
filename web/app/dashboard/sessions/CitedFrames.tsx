'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRightIcon, MagnifyingGlassPlusIcon, XIcon } from '@phosphor-icons/react';
import { citedFrameImageUrl, citedFrameLabel, safeSourceUrl, type CitedFrame } from '../../../lib/agent-sessions';

type Source = { id: string; title: string };

/** Exact frames the answer cites, shown large enough to read without opening them. Selecting an
 * image enlarges it; the caption opens the video at that moment. A deleted preview disappears. */
export function CitedFrames({ frames, sources = [] }: { frames: CitedFrame[]; sources?: Source[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const visible = frames.flatMap(frame => {
    const image = citedFrameImageUrl(frame), href = safeSourceUrl(frame.videoUrl);
    if (!image || !href || failed.has(frame.imagePath)) return [];
    const label = citedFrameLabel(frame);
    return [{ frame, image, href, label, time: label.slice(1, -1).split(' · ')[1]!,
      title: sources.find(source => source.id === frame.sourceId)?.title }];
  });
  const open = visible.find(item => item.frame.imagePath === selected);
  const fail = (path: string) => setFailed(previous => new Set(previous).add(path));
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  if (!visible.length) return null;
  return <section className='agent-cited-frames' aria-label='Frames cited in this answer'>
    <h3>{visible.length === 1 ? 'Frame cited' : 'Frames cited'}</h3>
    <div className={`agent-cited-frame-grid${visible.length === 1 ? ' single' : ''}`}>{visible.map(({ frame, image, href, label, time, title }) =>
      <figure key={frame.imagePath} className='agent-cited-frame'>
        <button type='button' className='agent-cited-frame-image' aria-label={`Enlarge frame ${label}`} onClick={() => setSelected(frame.imagePath)}>
          <Image unoptimized src={image} width={frame.width} height={frame.height} loading='lazy'
            alt={`Video frame at ${time}${title ? ` from ${title}` : ''}`} onError={() => fail(frame.imagePath)} />
          <MagnifyingGlassPlusIcon className='agent-frame-zoom' size={18} aria-hidden='true' />
        </button>
        <figcaption>
          <span className='agent-cited-frame-ref'>{label}</span>
          {title && <span className='agent-cited-frame-title' title={title}>{title}</span>}
          <a href={href} target='_blank' rel='noreferrer' aria-label={`Open source ${frame.sourceId} at ${time} on YouTube`}>
            Watch at {time}<ArrowUpRightIcon size={12} aria-hidden='true' />
          </a>
        </figcaption>
      </figure>)}</div>
    <dialog ref={dialog} className='agent-frame-dialog' aria-label={open ? `Frame ${open.label}` : 'Cited frame'}
      onClose={() => setSelected(null)} onClick={event => { if (event.target === event.currentTarget) setSelected(null); }}>
      {open && <div className='agent-frame-viewer'>
        <header><div><strong>Frame at {open.time}</strong><span>{open.title ?? `Source ${open.frame.sourceId}`}</span></div>
          <button type='button' aria-label='Close frame preview' onClick={() => setSelected(null)}><XIcon size={20} aria-hidden='true' /></button></header>
        <Image unoptimized src={open.image} width={open.frame.width} height={open.frame.height} alt={`Enlarged video frame at ${open.time}`} />
        <footer><span>{open.frame.width} × {open.frame.height}</span>
          <a href={open.href} target='_blank' rel='noreferrer'>Watch at {open.time}<ArrowUpRightIcon size={12} aria-hidden='true' /></a></footer>
      </div>}
    </dialog>
  </section>;
}
