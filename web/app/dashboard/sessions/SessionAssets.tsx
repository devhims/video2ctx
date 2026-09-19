'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { fetchAgentData } from '@/lib/agent-sessions';

const inventorySchema = z.object({
  assets: z.array(
    z.object({
      version: z.string(),
      kind: z.string(),
      videoId: z.string(),
      collectedAt: z.number(),
      current: z.boolean().optional(),
      details: z.record(z.string(), z.unknown()),
    }),
  ),
  memories: z.array(
    z.object({
      id: z.string(),
      topic: z.string(),
      kind: z.string(),
      text: z.string(),
      evidenceIds: z.array(z.string()),
      updatedAt: z.number(),
    }),
  ),
});
type Inventory = z.infer<typeof inventorySchema>;
const payloadSchema = z.object({ data: z.unknown() });
const visualSchema = z.object({
  frames: z.array(z.object({ imageBase64: z.string(), timestampMs: z.number() })).optional(),
  sheets: z
    .array(z.object({ imageBase64: z.string(), firstFrameIndex: z.number(), intervalMs: z.number() }))
    .optional(),
});
const transcriptSchema = z.object({ segments: z.array(z.object({ text: z.string(), startMs: z.number() })) });

export function SessionAssets({
  sessionId,
  revision,
  onDeleted,
}: {
  sessionId: string;
  revision: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<Inventory>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ version: string; data: unknown }>();
  const [confirmation, setConfirmation] = useState<{ path: string; label: string }>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError('');
    void fetchAgentData(`/sessions/${sessionId}/assets`, inventorySchema, controller.signal)
      .then(setInventory)
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not load session assets.');
      });
    return () => controller.abort();
  }, [open, sessionId, revision, refresh]);
  async function view(version: string) {
    setBusy(true);
    setError('');
    try {
      const result = await fetchAgentData(`/sessions/${sessionId}/assets/${version}`, payloadSchema);
      setSelected({ version, data: result.data });
    } catch {
      setError('Could not load this asset. It may have been deleted.');
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirmation) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/platform/v1/agent/sessions/${sessionId}/${confirmation.path}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error();
      setSelected(undefined);
      setConfirmation(undefined);
      setRefresh((value) => value + 1);
      onDeleted();
    } catch {
      setError('Deletion failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className='agent-session-assets' onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Session evidence and memory</summary>
      {open && (
        <div className='agent-assets-body'>
          <p>
            Saved transcripts, images and comments can be reused in later messages. To retrieve fresh data, ask the
            agent to fetch it again.
          </p>
          {error && (
            <p className='alert error' role='alert'>
              {error}
            </p>
          )}
          {!inventory && !error && <p role='status'>Loading assets…</p>}
          {inventory && (
            <>
              <div className='agent-asset-actions'>
                <button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
                  Refresh list
                </button>
                <button
                  disabled={busy || (!inventory.assets.length && !inventory.memories.length)}
                  onClick={() =>
                    setConfirmation({ path: 'assets', label: 'all stored evidence and memory in this session' })
                  }
                >
                  Delete all assets and memory
                </button>
              </div>
              <h3>Evidence ({inventory.assets.length})</h3>
              {!inventory.assets.length && <p>No reusable evidence collected yet.</p>}
              <ul>
                {inventory.assets.map((asset) => (
                  <li key={asset.version}>
                    <strong>
                      {asset.kind.replaceAll('_', ' ')} · {asset.videoId}
                    </strong>
                    {asset.current === false && <small> · Previous version</small>}
                    <p>
                      <time dateTime={new Date(asset.collectedAt).toISOString()}>
                        {new Date(asset.collectedAt).toLocaleString()}
                      </time>
                      {typeof asset.details.language === 'string' ? ` · ${asset.details.language}` : ''}
                      {typeof asset.details.segments === 'number' ? ` · ${asset.details.segments} ${asset.details.segments===1 ? 'segment' : 'segments'}` : ''}
                    </p>
                    <div className='agent-asset-actions'>
                      <button disabled={busy} onClick={() => void view(asset.version)}>
                        View
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            path: `assets/${asset.version}`,
                            label: `this ${asset.kind.replaceAll('_', ' ')}`,
                          })
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <h3>Memory ({inventory.memories.length})</h3>
              {!inventory.memories.length && <p>No saved memory yet.</p>}
              <ul>
                {inventory.memories.map((memory) => (
                  <li key={memory.id}>
                    <strong>{memory.topic}</strong>
                    <p>{memory.text}</p>
                    <small>
                      {memory.kind} · {memory.evidenceIds.length} source references
                    </small>{' '}
                    <button
                      disabled={busy}
                      onClick={() =>
                        setConfirmation({ path: `memory/${encodeURIComponent(memory.id)}`, label: 'this memory' })
                      }
                    >
                      Forget
                    </button>
                  </li>
                ))}
              </ul>
              <p>To correct remembered context, send a follow-up describing the correction.</p>
            </>
          )}
          {confirmation && (
            <div role='alert'>
              <p>
                Delete {confirmation.label}? Related saved findings and source excerpts will also be removed.
                Conversation messages remain.
              </p>
              <button disabled={busy} onClick={() => void remove()}>
                Confirm deletion
              </button>{' '}
              <button disabled={busy} onClick={() => setConfirmation(undefined)}>
                Cancel
              </button>
            </div>
          )}
          {selected && (
            <section aria-label='Stored asset'>
              <button onClick={() => setSelected(undefined)}>Close asset</button>
              <AssetContents value={selected.data} />
            </section>
          )}
        </div>
      )}
    </details>
  );
}
function AssetContents({ value }: { value: unknown }) {
  const transcript = transcriptSchema.safeParse(value);
  if (transcript.success)
    return (
      <div className='agent-asset-text'>
        {transcript.data.segments.map((segment, i) => (
          <p key={i}>
            <small>{(segment.startMs / 1000).toFixed(1)}s</small> {segment.text}
          </p>
        ))}
      </div>
    );
  const visual = visualSchema.safeParse(value);
  if (visual.success && (visual.data.frames?.length || visual.data.sheets?.length))
    return (
      <div>
        {[
          ...(visual.data.frames ?? []).map((frame) => ({ image: frame.imageBase64, time: frame.timestampMs })),
          ...(visual.data.sheets ?? []).map((sheet) => ({
            image: sheet.imageBase64,
            time: sheet.firstFrameIndex * sheet.intervalMs,
          })),
        ].map((item, i) => (
          <figure key={i}>
            <img
              src={`data:image/jpeg;base64,${item.image}`}
              alt={`Saved video evidence at ${item.time / 1000} seconds`}
              style={{ maxWidth: '100%', height: 'auto' }}
            />
            <figcaption>{item.time / 1000}s</figcaption>
          </figure>
        ))}
      </div>
    );
  return <pre className='agent-asset-text'>{JSON.stringify(value, null, 2)}</pre>;
}
