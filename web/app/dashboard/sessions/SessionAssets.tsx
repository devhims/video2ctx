'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArchiveIcon, ArrowClockwiseIcon, BrainIcon, CaretRightIcon, ChatCircleTextIcon, CircleNotchIcon, EyeIcon, ImagesIcon, TextAlignLeftIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
import { z } from 'zod';
import { platformRequest } from '@/lib/platform-request';
import { fetchAgentData } from '@/lib/agent-sessions';
import styles from './SessionAssets.module.css';

const inventorySchema = z.object({
  assets: z.array(z.object({
    version: z.string(), kind: z.string(), videoId: z.string(), collectedAt: z.number(),
    current: z.boolean().optional(), details: z.record(z.string(), z.unknown()),
  })),
  memories: z.array(z.object({
    id: z.string(), topic: z.string(), kind: z.string(), text: z.string(),
    evidenceIds: z.array(z.string()), updatedAt: z.number(), deletedEvidenceIds: z.array(z.string()).optional(),
  })),
});
type Inventory = z.infer<typeof inventorySchema>;
type Asset = Inventory['assets'][number];
type Selection = { asset: Asset; loading: boolean; data?: unknown; error?: string };
type Confirmation = { kind: 'source' | 'memory' | 'all'; path: string; label: string };
const payloadSchema = z.object({ data: z.unknown() });
const visualSchema = z.object({
  frames: z.array(z.object({ imageBase64: z.string(), timestampMs: z.number() })).optional(),
  sheets: z.array(z.object({ imageBase64: z.string(), firstFrameIndex: z.number(), intervalMs: z.number() })).optional(),
});
const transcriptSchema = z.object({ segments: z.array(z.object({ text: z.string(), startMs: z.number() })) });
type SavedComment = {
  id: string; author: { name: string }; text: string; publishedTimeText?: string;
  likeCount?: number; replies?: SavedComment[];
};
const commentSchema: z.ZodType<SavedComment> = z.object({
  id: z.string(), author: z.object({ name: z.string() }), text: z.string(), publishedTimeText: z.string().optional(),
  likeCount: z.number().optional(), replies: z.lazy(() => z.array(commentSchema)).optional(),
});
const commentsSchema = z.object({ comments: z.array(commentSchema) });

function assetName(kind: string) {
  const names: Record<string, string> = { transcript: 'Transcript', frames: 'Video frames', storyboard: 'Video previews', comments: 'Video comments' };
  return names[kind] ?? kind.replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
}
function AssetIcon({ kind }: { kind: string }) {
  const Icon = kind === 'transcript' ? TextAlignLeftIcon : kind === 'comments' ? ChatCircleTextIcon : ImagesIcon;
  return <Icon size={18} aria-hidden='true' />;
}
function timestamp(value: number) {
  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SessionAssets({ sessionId, revision, onDeleted, readOnly = false }: {
  sessionId: string; revision: string; onDeleted: () => void; readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<Inventory>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Selection>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [deleteError, setDeleteError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const viewRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { viewRequest.current?.abort(); }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(''); setLoading(true);
    void fetchAgentData(`/sessions/${sessionId}/assets`, inventorySchema, controller.signal)
      .then(value => { if (!controller.signal.aborted) setInventory(value); })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load saved evidence.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, sessionId, revision, refresh]);

  function closeAsset() { viewRequest.current?.abort(); setSelected(undefined); }
  async function view(asset: Asset) {
    viewRequest.current?.abort();
    const controller = new AbortController();
    viewRequest.current = controller;
    setSelected({ asset, loading: true });
    try {
      const result = await fetchAgentData(`/sessions/${sessionId}/assets/${asset.version}`, payloadSchema, controller.signal);
      if (!controller.signal.aborted) setSelected({ asset, data: result.data, loading: false });
    } catch (cause) {
      if (!controller.signal.aborted) setSelected({ asset, loading: false,
        error: cause instanceof Error ? cause.message : 'Could not load this evidence.' });
    }
  }
  function confirm(value: Confirmation) { setDeleteError(''); setConfirmation(value); }
  async function remove() {
    if (!confirmation || readOnly) return;
    setBusy(true); setDeleteError('');
    try {
      await platformRequest(`/v1/agent/sessions/${sessionId}/${confirmation.path}`, {
        method: 'DELETE', credentials: 'include',
      });
      closeAsset(); setConfirmation(undefined); setRefresh(value => value + 1); onDeleted();
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'Deletion failed. Please try again.');
    } finally { setBusy(false); }
  }

  return <>
    <details className={`agent-session-assets ${styles.panel}`} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>
        <CaretRightIcon className={styles.caret} size={14} aria-hidden='true' />
        <ArchiveIcon size={17} aria-hidden='true' /><span>Session Assets</span>
      </summary>
      {open && <div className={styles.body}>
        <div className={styles.toolbar}>
          <p>Session assets are automatically used in the conversation when needed.</p>
          <div className={styles.actions}>
            <button className={styles.button} disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>
              <ArrowClockwiseIcon className={loading ? 'agent-spin' : undefined} size={15} aria-hidden='true' />Refresh
            </button>
            {!readOnly && <button className={`${styles.button} ${styles.danger}`} disabled={busy || !inventory || (!inventory.assets.length && !inventory.memories.length)}
              onClick={() => confirm({ kind: 'all', path: 'assets', label: 'all stored evidence and memory in this session' })}>
              <TrashIcon size={15} aria-hidden='true' />Clear saved data
            </button>}
          </div>
        </div>
        {error && <p className='alert error' role='alert'>{error}</p>}
        {!inventory && !error && <div role='status' aria-label='Loading assets' className={styles.loading}>
          <CircleNotchIcon className='agent-spin' size={17} aria-hidden='true' />Loading saved evidence…
        </div>}
        {inventory && <>
          <section aria-label='Session evidence' className={styles.section}>
            <h3>Evidence <span className={styles.count}>({inventory.assets.length})</span></h3>
            {!inventory.assets.length ? <p className={styles.empty}>No reusable evidence yet. Evidence collected by the agent will appear here.</p>
              : <ul className={styles.list}>{inventory.assets.map(asset => <li className={styles.record} key={asset.version}>
                <div className={styles.row}>
                  <span className={styles.recordIcon}><AssetIcon kind={asset.kind} /></span>
                  <div className={styles.copy}>
                    <div className={styles.title}><strong>{assetName(asset.kind)}</strong>{asset.current === false && <span className={styles.badge}>Previous version</span>}</div>
                    <span className={styles.videoId}>{asset.videoId}</span>
                    <p className={styles.metadata}>
                      <time dateTime={new Date(asset.collectedAt).toISOString()}>{new Date(asset.collectedAt).toLocaleString()}</time>
                      {typeof asset.details.language === 'string' && <span>{asset.details.language}</span>}
                      {typeof asset.details.segments === 'number' && <span>{asset.details.segments} {asset.details.segments === 1 ? 'segment' : 'segments'}</span>}
                    </p>
                  </div>
                  <div className={styles.actions}>
                    <button className={`${styles.button} ${styles.viewButton}`} aria-label='View' title={`View ${assetName(asset.kind).toLowerCase()}`} disabled={busy} onClick={() => void view(asset)}><EyeIcon size={15} aria-hidden='true' /><span>View</span></button>
                    {!readOnly && <button className={`${styles.button} ${styles.iconButton} ${styles.danger}`} disabled={busy}
                      aria-label={`Delete ${assetName(asset.kind).toLowerCase()} for ${asset.videoId}`} title='Delete evidence'
                      onClick={() => confirm({ kind: 'source', path: `assets/${asset.version}`, label: `this ${assetName(asset.kind).toLowerCase()}` })}>
                      <TrashIcon size={16} aria-hidden='true' />
                    </button>}
                  </div>
                </div>
              </li>)}</ul>}
          </section>
          <section aria-label='Session memory' className={styles.section}>
            <h3>Memory <span className={styles.count}>({inventory.memories.length})</span></h3>
            {!inventory.memories.length ? <p className={styles.empty}>No saved memory yet.</p>
              : <ul className={styles.list}>{inventory.memories.map(memory => <li className={styles.record} key={memory.id}>
                <div className={styles.row}>
                  <span className={styles.recordIcon}><BrainIcon size={18} aria-hidden='true' /></span>
                  <div className={styles.copy}><strong>{memory.topic}</strong><p className={styles.memoryText}>{memory.text}</p>
                    <p className={styles.metadata}>{memory.evidenceIds.length} {memory.evidenceIds.length === 1 ? 'source reference' : 'source references'}{memory.deletedEvidenceIds?.length ? ` · ${memory.deletedEvidenceIds.length} deleted, now unverified` : ''}</p>
                  </div>
                  {!readOnly && <button className={`${styles.button} ${styles.danger}`} disabled={busy} onClick={() => confirm({ kind: 'memory', path: `memory/${encodeURIComponent(memory.id)}`, label: 'this memory' })}>
                    <TrashIcon size={15} aria-hidden='true' />Forget
                  </button>}
                </div>
              </li>)}</ul>}
            {!readOnly && <p className={styles.help}>To correct remembered context, describe the correction in a follow-up.</p>}
          </section>
        </>}
      </div>}
    </details>
    <AssetViewer selection={selected} onClose={closeAsset} onRetry={asset => void view(asset)} />
    {!readOnly && <DeleteConfirmation confirmation={confirmation} busy={busy} error={deleteError} onClose={() => setConfirmation(undefined)} onConfirm={() => void remove()} />}
  </>;
}

function AssetViewer({ selection, onClose, onRetry }: { selection?: Selection; onClose: () => void; onRetry: (asset: Asset) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const version = selection?.asset.version;
  useEffect(() => {
    if (version && !dialog.current?.open) dialog.current?.showModal();
    else if (!version) dialog.current?.close();
  }, [version]);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={headingId} onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {selection && <>
      <header className={styles.viewerHeader}>
        <span className={styles.recordIcon}><AssetIcon kind={selection.asset.kind} /></span>
        <div className={styles.copy}><h2 id={headingId}>{assetName(selection.asset.kind)}</h2><span className={styles.videoId}>{selection.asset.videoId}</span>
          {selection.asset.current === false && <span className={styles.badge}>Previous version</span>}
        </div>
        <button className={`${styles.button} ${styles.iconButton}`} onClick={onClose} aria-label='Close evidence preview'><XIcon size={20} aria-hidden='true' /></button>
      </header>
      <div className={styles.viewerBody} tabIndex={0} aria-label='Evidence content'>
        {selection.loading ? <p className={styles.loading} role='status'><CircleNotchIcon className='agent-spin' size={18} aria-hidden='true' />Loading evidence…</p>
          : selection.error ? <div><p className='alert error' role='alert'>{selection.error}</p><button className={styles.button} onClick={() => onRetry(selection.asset)}><ArrowClockwiseIcon size={15} aria-hidden='true' />Try again</button></div>
          : <AssetContents value={selection.data} />}
      </div>
    </>}
  </dialog>;
}

function DeleteConfirmation({ confirmation, busy, error, onClose, onConfirm }: {
  confirmation?: Confirmation; busy: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (confirmation && !dialog.current?.open) dialog.current?.showModal();
    else if (!confirmation) dialog.current?.close();
  }, [confirmation]);
  return <dialog ref={dialog} className={`${styles.dialog} ${styles.confirmation}`} aria-labelledby={headingId} onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    {confirmation && <div className={styles.confirmationBody}>
      <h2 id={headingId}>Delete saved data?</h2>
      <p>Delete {confirmation.label}?</p>
      {confirmation.kind === 'source' && <p>The source and its saved excerpts will be removed. Saved memories remain, with references to this source marked deleted and unverified.</p>}
      {confirmation.kind === 'memory' && <p>This saved memory will be removed. Saved sources and other memories remain.</p>}
      {confirmation.kind === 'all' && <p>All saved sources, excerpts, and memories in this session will be removed.</p>}
      <p>Conversation messages remain, and the agent can still refer to them as earlier conversation.</p>
      {error && <p className='alert error' role='alert'>{error}</p>}
      <div className={styles.actions}>
        <button className={styles.button} disabled={busy} onClick={onClose}>Cancel</button>
        <button className={`${styles.button} ${styles.danger}`} disabled={busy} onClick={onConfirm}>
          {busy ? <CircleNotchIcon className='agent-spin' size={15} aria-hidden='true' /> : <TrashIcon size={15} aria-hidden='true' />}
          {busy ? 'Deleting…' : 'Confirm deletion'}
        </button>
      </div>
    </div>}
  </dialog>;
}

function AssetContents({ value }: { value: unknown }) {
  const transcript = transcriptSchema.safeParse(value);
  if (transcript.success) return transcript.data.segments.length ? <ol className={styles.transcript}>
    {transcript.data.segments.map((segment, index) => <li key={index}><span className={styles.timestamp}>{timestamp(segment.startMs)}</span><p>{segment.text}</p></li>)}
  </ol> : <p className={styles.empty}>This transcript has no saved segments.</p>;
  const comments = commentsSchema.safeParse(value);
  if (comments.success) return comments.data.comments.length ? <CommentList comments={comments.data.comments} />
    : <p className={styles.empty}>No comments were saved.</p>;
  const visual = visualSchema.safeParse(value);
  if (visual.success && (visual.data.frames?.length || visual.data.sheets?.length)) return <div className={styles.images}>
    {[...(visual.data.frames ?? []).map(frame => ({ image: frame.imageBase64, time: frame.timestampMs })),
      ...(visual.data.sheets ?? []).map(sheet => ({ image: sheet.imageBase64, time: sheet.firstFrameIndex * sheet.intervalMs }))]
      .map((item, index) => <figure key={index}><img src={`data:image/jpeg;base64,${item.image}`} alt={`Saved video evidence at ${item.time / 1000} seconds`} />
        <figcaption>{timestamp(item.time)}</figcaption></figure>)}
  </div>;
  return <pre className={styles.raw}>{JSON.stringify(value, null, 2)}</pre>;
}

function CommentList({ comments }: { comments: SavedComment[] }) {
  return <ul className={styles.comments}>{comments.map(comment => <li key={comment.id}>
    <strong>{comment.author.name}</strong>{comment.publishedTimeText && <small>{comment.publishedTimeText}</small>}
    <p>{comment.text}</p>
    {comment.likeCount !== undefined && <small>{comment.likeCount} {comment.likeCount === 1 ? 'like' : 'likes'}</small>}
    {!!comment.replies?.length && <CommentList comments={comment.replies} />}
  </li>)}</ul>;
}
