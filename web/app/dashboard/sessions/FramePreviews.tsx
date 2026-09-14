'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowRightIcon, XIcon, MagnifyingGlassPlusIcon } from '@phosphor-icons/react';
import type { AgentProgress } from '../../../lib/agent-sessions';

type Preview = NonNullable<NonNullable<AgentProgress['tools'][number]['output']>['frames']>[number];

function timestamp(value: number) {
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  const fraction = value % 1000 ? `.${String(value % 1000).padStart(3, '0')}` : '';
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${remainder}${fraction}`;
}

export function FramePreviews({ frames }: { frames: Preview[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const frame = selected === null ? undefined : frames[selected];
  const url = (preview: Preview) => `/api/platform/v1/agent/frames/${preview.collectionId}/${preview.assetId}`;
  const fail = (assetId: string) => setFailed(previous => new Set(previous).add(assetId));
  useEffect(() => {
    if (selected !== null && !dialog.current?.open) dialog.current?.showModal();
    else if (selected === null) dialog.current?.close();
  }, [selected]);

  if (!frames.length) return <p className='agent-frame-note'>Image previews were not saved for this tool call.</p>;
  return <section className='agent-frame-previews' aria-label='Extracted video frames'>
    <h4>Frames inspected</h4>
    <div className='agent-frame-grid'>{frames.map((preview, index) => <button type='button'
      className='agent-frame-card' key={preview.assetId} disabled={failed.has(preview.assetId)}
      aria-label={`Open frame at ${timestamp(preview.timestampMs)}`} onClick={() => setSelected(index)}>
      <span className='agent-frame-thumbnail'>
        {failed.has(preview.assetId) ? <span className='agent-frame-missing'>Preview unavailable</span>
          : <Image unoptimized src={url(preview)} width={preview.width} height={preview.height}
            alt={`Video frame at ${timestamp(preview.timestampMs)}`} loading='lazy' onError={() => fail(preview.assetId)} />}
        {!failed.has(preview.assetId) && <MagnifyingGlassPlusIcon className='agent-frame-zoom' size={18} aria-hidden='true' />}
      </span>
      <span className='agent-frame-caption'><span>{timestamp(preview.timestampMs)}</span><span>{preview.width} × {preview.height}</span></span>
    </button>)}</div>
    <p className='agent-frame-note'>Saved images used for analysis. Select a frame to enlarge it.</p>
    <dialog ref={dialog} className='agent-frame-dialog' aria-label={frame ? `Frame at ${timestamp(frame.timestampMs)}` : 'Video frame'}
      onClose={() => setSelected(null)} onClick={event => { if (event.target === event.currentTarget) setSelected(null); }}>
      {frame && <div className='agent-frame-viewer'>
        <header><div><strong>Frame at {timestamp(frame.timestampMs)}</strong><span>{frame.width} × {frame.height}</span></div>
          <button type='button' aria-label='Close frame preview' onClick={() => setSelected(null)}><XIcon size={20} aria-hidden='true' /></button></header>
        {failed.has(frame.assetId) ? <p role='status' className='agent-frame-missing'>This preview is no longer available.</p>
          : <Image unoptimized key={frame.assetId} src={url(frame)} width={frame.width} height={frame.height}
            alt={`Enlarged video frame at ${timestamp(frame.timestampMs)}`} onError={() => fail(frame.assetId)} />}
        <footer><button type='button' aria-label='Previous frame' disabled={selected === 0} onClick={() => setSelected(selected! - 1)}><ArrowLeftIcon size={16} aria-hidden='true' />Previous</button>
          <span>{selected! + 1} of {frames.length}</span>
          <button type='button' aria-label='Next frame' disabled={selected === frames.length - 1} onClick={() => setSelected(selected! + 1)}>Next<ArrowRightIcon size={16} aria-hidden='true' /></button></footer>
      </div>}
    </dialog>
  </section>;
}
