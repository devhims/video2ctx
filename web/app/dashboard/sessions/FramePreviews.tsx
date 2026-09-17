'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowRightIcon, XIcon, MagnifyingGlassPlusIcon } from '@phosphor-icons/react';
import type { AgentProgress } from '../../../lib/agent-sessions';

type ToolOutput = NonNullable<AgentProgress['tools'][number]['output']>;
type Preview = NonNullable<ToolOutput['frames']>[number] | NonNullable<ToolOutput['storyboard']>['sheets'][number];

function timestamp(value: number) {
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  const fraction = value % 1000 ? `.${String(value % 1000).padStart(3, '0')}` : '';
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${remainder}${fraction}`;
}

export function FramePreviews({ frames, kind = 'frames' }: { frames: Preview[]; kind?: 'frames' | 'storyboard' }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const frame = selected === null ? undefined : frames[selected];
  const noun = kind === 'storyboard' ? 'sheet' : 'frame';
  const range = (preview: Preview) => 'endTimestampMs' in preview
    ? `${timestamp(preview.timestampMs)} to ${timestamp(preview.endTimestampMs)}` : timestamp(preview.timestampMs);
  const title = (preview: Preview) => `${kind === 'storyboard' ? 'Storyboard sheet' : 'Frame'} at ${range(preview)}`;
  const description = (preview: Preview) => 'frameCount' in preview
    ? `${preview.frameCount} sampled frames · ${preview.columns} × ${preview.rows} grid · ${preview.intervalMs / 1000}s intervals`
    : `${preview.width} × ${preview.height}`;
  const url = (preview: Preview) => `/api/platform/v1/agent/frames/${preview.collectionId}/${preview.assetId}`;
  const fail = (assetId: string) => setFailed(previous => new Set(previous).add(assetId));
  useEffect(() => {
    if (selected !== null && !dialog.current?.open) dialog.current?.showModal();
    else if (selected === null) dialog.current?.close();
  }, [selected]);

  if (!frames.length) return <p className='agent-frame-note'>Image previews were not saved for this tool call.</p>;
  return <section className='agent-frame-previews' aria-label={kind === 'storyboard' ? 'Inspected storyboard sheets' : 'Extracted video frames'}>
    <h4>{kind === 'storyboard' ? 'Storyboard sheets inspected' : 'Frames inspected'}</h4>
    <div className='agent-frame-grid'>{frames.map((preview, index) => <button type='button'
      className='agent-frame-card' key={preview.assetId} disabled={failed.has(preview.assetId)}
      aria-label={`Open ${noun} at ${range(preview)}`} onClick={() => setSelected(index)}>
      <span className='agent-frame-thumbnail'>
        {failed.has(preview.assetId) ? <span className='agent-frame-missing'>Preview unavailable</span>
          : <Image unoptimized src={url(preview)} width={preview.width} height={preview.height}
            alt={kind === 'storyboard' ? title(preview) : `Video frame at ${timestamp(preview.timestampMs)}`} loading='lazy' onError={() => fail(preview.assetId)} />}
        {!failed.has(preview.assetId) && <MagnifyingGlassPlusIcon className='agent-frame-zoom' size={18} aria-hidden='true' />}
      </span>
      <span className='agent-frame-caption'><span>{range(preview)}</span><span>{description(preview)}</span></span>
    </button>)}</div>
    <p className='agent-frame-note'>{kind === 'storyboard'
      ? 'Saved sheets used for analysis. Tiles run left to right, then top to bottom. Select a sheet to enlarge it.'
      : 'Saved images used for analysis. Select a frame to enlarge it.'}</p>
    <dialog ref={dialog} className='agent-frame-dialog' aria-label={frame ? title(frame) : kind === 'storyboard' ? 'Storyboard sheet' : 'Video frame'}
      onClose={() => setSelected(null)} onClick={event => { if (event.target === event.currentTarget) setSelected(null); }}>
      {frame && <div className='agent-frame-viewer'>
        <header><div><strong>{title(frame)}</strong><span>{description(frame)}</span></div>
          <button type='button' aria-label={`Close ${noun} preview`} onClick={() => setSelected(null)}><XIcon size={20} aria-hidden='true' /></button></header>
        {failed.has(frame.assetId) ? <p role='status' className='agent-frame-missing'>This preview is no longer available.</p>
          : <Image unoptimized key={frame.assetId} src={url(frame)} width={frame.width} height={frame.height}
            alt={`Enlarged ${kind === 'storyboard' ? 'storyboard sheet' : 'video frame'} at ${range(frame)}`} onError={() => fail(frame.assetId)} />}
        <footer><button type='button' aria-label={`Previous ${noun}`} disabled={selected === 0} onClick={() => setSelected(selected! - 1)}><ArrowLeftIcon size={16} aria-hidden='true' />Previous</button>
          <span>{selected! + 1} of {frames.length}</span>
          <button type='button' aria-label={`Next ${noun}`} disabled={selected === frames.length - 1} onClick={() => setSelected(selected! + 1)}>Next<ArrowRightIcon size={16} aria-hidden='true' /></button></footer>
      </div>}
    </dialog>
  </section>;
}
