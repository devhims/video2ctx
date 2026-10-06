import { ApiError, sha256 } from './http';
import { videoCatalog } from './video-catalog';
import { videoResourceKey } from './video-resources';
import { readSourceResponseStrict } from './source-response-storage';
import { withYouTubeMetadata } from './youtube';
import { sourceSnapshotSchema, sourceCommentPageSchema, mergeSourceCommentPages, type RecentSource, type SourceReference, type SourceSnapshot } from './source-history';
import type { ProjectItemRecord } from './project-items';
import type { StoredSourceReference } from '../durable-objects/user-account';

/**
 * Storage-only restore for saved project items. Nothing here contacts a provider,
 * meters credits, enqueues work or writes any store. Absent bytes yield a missing
 * dataset; corrupt bytes and store failures throw so they stay retryable errors.
 */

export const MISSING_DATA_MESSAGE = 'This saved data is currently unavailable. Retry loading from storage at no cost.';
type Dataset = 'metadata' | 'transcript' | 'comments' | 'channel';
const SUPPORTED = new Set(['video', 'playlist', 'channel']);

export interface RestoredSnapshot { snapshot: SourceSnapshot; missingData: Dataset[]; savedText?: string }

export type RecoveryEvidence = 'saved-reference' | 'project-source' | 'project-document' | 'project-import';

export type ItemRestore =
  | { state: 'restored'; origin: 'pin' | 'project-source' | 'recent' | 'storage'; recovered: boolean; source: RecentSource;
    snapshot: SourceSnapshot; sourceRevision?: string; savedText?: string; missingData: Dataset[]; evidence?: RecoveryEvidence }
  | { state: 'unavailable' };

function invalid(): never {
  throw new ApiError(500, 'SOURCE_ASSET_INVALID', 'Saved source data could not be verified.');
}

function catalogFor(env: Env) {
  const catalog = videoCatalog(env);
  if (!catalog) throw new ApiError(503, 'SOURCE_STORAGE_UNAVAILABLE', 'Saved source storage is unavailable. Try again.');
  return catalog;
}

async function readShared(env: Env, key: string): Promise<unknown | null> {
  if (!env.VIDEO_ASSETS) throw new ApiError(503, 'SOURCE_STORAGE_UNAVAILABLE', 'Saved source storage is unavailable. Try again.');
  const object = await env.VIDEO_ASSETS.get(key);
  if (!object) return null;
  const payload = await object.text();
  if (`youtube/source-history/${await sha256(payload)}.json` !== key) invalid();
  try { return JSON.parse(payload); } catch { return invalid(); }
}

function storedValue(stored: { value: unknown; fetchedAt: number }) {
  return { ...withYouTubeMetadata(stored.value as Record<string, unknown>), freshness: { state: 'stored', fetchedAt: new Date(stored.fetchedAt).toISOString() } };
}

function videoFallback(id: string, title?: string) {
  return { id, url: `https://youtube.com/watch?v=${encodeURIComponent(id)}`, ...(title ? { title } : {}) };
}

/** Restore one owned reference set, keeping every dataset that is still available. */
export async function restoreReference(env: Env, reference: SourceReference, title?: string): Promise<RestoredSnapshot | null> {
  if (reference.kind === 'search') {
    const items = await readShared(env, reference.results);
    return items === null ? null : { snapshot: sourceSnapshotSchema.parse({ kind: 'search', selectedData: reference.selectedData, items }), missingData: [] };
  }
  const { assets, entity, channel, commentPages, thumbnailUrl: _thumbnail, ...source } = reference.inspector;
  const missing: Dataset[] = [];
  const restored: Record<string, unknown> = { ...source, dataErrors: { ...source.dataErrors } };
  const dataErrors = restored.dataErrors as Record<string, string>;
  for (const field of Object.keys(dataErrors)) {
    if (dataErrors[field] === 'This saved data is not available. Fetching it again uses credits.') dataErrors[field] = MISSING_DATA_MESSAGE;
  }
  let available = false;
  if (entity) {
    const data = await readShared(env, entity);
    if (data === null) missing.push('metadata');
    else { restored.data = data; available = true; }
  }
  if (channel) {
    const data = await readShared(env, channel);
    if (data === null) missing.push('channel');
    else { restored.channel = data; available = true; }
  }
  const fields = Object.entries(assets).filter((entry): entry is [Dataset, NonNullable<typeof entry[1]>] => Boolean(entry[1]));
  if (fields.length) {
    const catalog = catalogFor(env);
    await Promise.all(fields.map(async ([field, asset]) => {
      const stored = await catalog.readSourceVersion(asset);
      if (!stored) { missing.push(field); return; }
      restored[field === 'metadata' ? 'data' : field] = storedValue(stored);
      available = true;
    }));
  }
  const pages = restored.comments ? [sourceCommentPageSchema.parse(restored.comments)] : [];
  for (const asset of commentPages ?? []) {
    const saved = await catalogFor(env).readSourceVersion(asset);
    if (!saved) { if (!missing.includes('comments')) missing.push('comments'); continue; }
    pages.push(sourceCommentPageSchema.parse(saved.value));
    available = true;
  }
  if (pages.length) {
    restored.comments = mergeSourceCommentPages(pages);
    restored.commentPagesLoaded = pages.length;
  }
  // Playlists and channels have nothing useful to show without their entity payload.
  if (!available || (source.type !== 'video' && missing.includes('metadata'))) return null;
  restored.data ??= videoFallback(source.id, title);
  for (const field of missing) dataErrors[field] = MISSING_DATA_MESSAGE;
  return { snapshot: sourceSnapshotSchema.parse({ kind: 'inspection', inspector: restored }), missingData: missing.sort() };
}

/** Keep the project's private transcript visible even when a usable pin contains only metadata. */
export async function restoreProjectReference(env: Env, reference: SourceReference, context: {
  userId: string; projectId: string; item: ProjectItemRecord;
}): Promise<RestoredSnapshot | null> {
  const restored = await restoreReference(env, reference, context.item.title);
  if (!restored || restored.snapshot.kind !== 'inspection') return restored;
  const inspector = restored.snapshot.inspector;
  if (inspector.type !== 'video' || inspector.transcript || !inspector.requestedData.includes('transcript')) return restored;
  const evidence = await entitlementEvidence(env, context.userId, context.projectId, context.item);
  const savedText = evidence.document ? await savedProjectText(env, evidence.document.r2_key) : undefined;
  if (!savedText) return restored;
  if (inspector.dataErrors.transcript === MISSING_DATA_MESSAGE) delete inspector.dataErrors.transcript;
  return { ...restored, savedText, missingData: restored.missingData.filter(field => field !== 'transcript') };
}

function itemInput(item: Pick<ProjectItemRecord, 'entity_type' | 'entity_id'>) {
  const id = encodeURIComponent(item.entity_id);
  return item.entity_type === 'video' ? `https://www.youtube.com/watch?v=${id}`
    : item.entity_type === 'playlist' ? `https://www.youtube.com/playlist?list=${id}` : `https://www.youtube.com/channel/${id}`;
}

export function projectItemInput(item: Pick<ProjectItemRecord, 'provider' | 'entity_type' | 'entity_id'>): string | null {
  return item.provider === 'youtube' && SUPPORTED.has(item.entity_type) ? itemInput(item) : null;
}

/** A project document or successful project import establishes that this user saved the source here. */
export async function entitlementEvidence(env: Env, userId: string, projectId: string, item: Pick<ProjectItemRecord, 'provider' | 'entity_type' | 'entity_id' | 'start_ms'>) {
  const ids = [...new Set([item.start_ms ?? 0, 0])];
  const documentIds = await Promise.all(ids.map(start => sha256(`${userId}:${projectId}:${item.provider}:${item.entity_id}:${start}`)));
  const [documents, job] = await Promise.all([
    env.DB.prepare(`SELECT id, r2_key FROM documents WHERE owner_scope='private' AND user_id=? AND project_id=? AND provider=? AND entity_id=?
      AND id IN (${documentIds.map(() => '?').join(',')})`).bind(userId, projectId, item.provider, item.entity_id, ...documentIds).all<{ id: string; r2_key: string }>(),
    env.DB.prepare(`SELECT id FROM jobs WHERE user_id=? AND kind=? AND status IN ('succeeded','partial')
      AND json_extract(input_json,'$.projectId')=? AND json_extract(input_json,'$.entityId')=?
      AND json_extract(input_json,'$.provider')=? LIMIT 1`)
      .bind(userId, item.entity_type, projectId, item.entity_id, item.provider).first<{ id: string }>(),
  ]);
  // Never read a private key outside this user's project namespace, whatever the row says.
  const namespace = `private/${userId}/projects/${projectId}/${item.provider}/`;
  const document = documentIds.map(id => documents.results.find(row => row.id === id))
    .find(row => row && row.r2_key === `${namespace}${row.id}.md`);
  return { document, imported: Boolean(job) };
}

async function savedProjectText(env: Env, key: string): Promise<string | undefined> {
  const object = await env.RESEARCH.get(key);
  if (!object) return undefined;
  const body = await object.text();
  // The private copy is "# Title\n\n" followed by the saved lines.
  const text = body.replace(/^# [^\n]*\n\n/, '').trim();
  return text || undefined;
}

const importedTranscriptSchema = sourceSnapshotSchema.options[1].shape.inspector.shape.transcript.unwrap();

/** The import workflow's own transcript copy, used only with owned import evidence. */
async function importedTranscript(env: Env, provider: string, videoId: string) {
  const prefix = `public/${provider}/videos/${videoId}/transcript-`;
  const listed = await env.RESEARCH.list({ prefix, limit: 20 });
  const newest = listed.objects.filter(object => object.key.endsWith('.json')).sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())[0];
  if (!newest) return null;
  const object = await env.RESEARCH.get(newest.key);
  if (!object) return null;
  let value: unknown;
  try { value = JSON.parse(await object.text()); } catch { invalid(); }
  const parsed = importedTranscriptSchema.safeParse(value);
  if (!parsed.success || parsed.data.videoId !== videoId) invalid();
  return { value: parsed.data, fetchedAt: object.uploaded.getTime() };
}

async function sharedResponse(env: Env, resourceType: string, id: string): Promise<Record<string, unknown> | null> {
  const cacheKey = `youtube:v1:${await sha256(JSON.stringify([resourceType, id]))}`;
  const [saved, cachedText] = await Promise.all([
    // Evidence is already established, so retention age alone must not force a paid reopen.
    readSourceResponseStrict<Record<string, unknown>>(env, cacheKey, resourceType, false),
    env.YOUTUBE_CACHE.get(cacheKey),
  ]);
  let cached: { value: Record<string, unknown>; fetchedAt: number } | null = null;
  if (cachedText !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(cachedText); } catch { invalid(); }
    const entry = parsed as { value?: unknown; fetchedAt?: unknown };
    if (entry?.value && typeof entry.value === 'object' && !Array.isArray(entry.value) && typeof entry.fetchedAt === 'number') {
      cached = { value: entry.value as Record<string, unknown>, fetchedAt: entry.fetchedAt };
    }
  }
  const response = saved && (!cached || saved.fetchedAt >= cached.fetchedAt) ? saved : cached;
  return response ? storedValue(response) : null;
}

/**
 * Recover an item without usable retained references, only within the user's
 * saved evidence: another owned reference, a project document, a successful
 * project import, or (for project source rows) the owned row itself.
 */
export async function recoverProjectItem(env: Env, input: {
  userId: string; projectId: string; item: ProjectItemRecord; references: StoredSourceReference[]; ownedRow?: boolean; sourceInput?: string;
}): Promise<ItemRestore> {
  const { userId, projectId, item, references, ownedRow = false } = input;
  for (const reference of references) {
    const restored = await restoreProjectReference(env, reference.snapshot, { userId, projectId, item });
    if (restored) return { state: 'restored', origin: reference.origin, recovered: true, source: reference.source,
      sourceRevision: reference.sourceRevision, ...restored };
  }
  const sourceInput = input.sourceInput ?? projectItemInput(item);
  if (!sourceInput || !SUPPORTED.has(item.entity_type)) return { state: 'unavailable' };
  const evidence = await entitlementEvidence(env, userId, projectId, item);
  // An owned reference whose old bytes are gone still proves this account saved the source.
  const basis: RecoveryEvidence | null = ownedRow ? 'project-source' : references.length ? 'saved-reference'
    : evidence.document ? 'project-document' : evidence.imported ? 'project-import' : null;
  if (!basis) return { state: 'unavailable' };
  const source: RecentSource = { id: item.id, input: sourceInput, title: item.title || item.entity_id, kind: 'inspection', updatedAt: item.created_at };
  if (item.entity_type === 'video') {
    const catalog = catalogFor(env);
    const [metadata, catalogTranscript, savedText] = await Promise.all([
      catalog.readSourceSaved(videoResourceKey({ kind: 'video', id: item.entity_id })!),
      catalog.readSourceSaved(videoResourceKey({ kind: 'transcript', id: item.entity_id, granularity: 'word' })!),
      evidence.document ? savedProjectText(env, evidence.document.r2_key) : Promise.resolve(undefined),
    ]);
    const transcript = catalogTranscript ?? await importedTranscript(env, item.provider, item.entity_id);
    if (!metadata && !transcript && !savedText) return { state: 'unavailable' };
    const missingData: Dataset[] = [...(metadata ? [] : ['metadata' as const]), ...(transcript || savedText ? [] : ['transcript' as const])];
    const snapshot = sourceSnapshotSchema.parse({ kind: 'inspection', inspector: {
      provider: 'youtube', type: 'video', id: item.entity_id, requestedData: ['transcript'],
      data: metadata ? storedValue(metadata) : videoFallback(item.entity_id, item.title),
      ...(transcript ? { transcript: storedValue(transcript) } : {}),
      dataErrors: Object.fromEntries(missingData.map(field => [field, MISSING_DATA_MESSAGE])),
    } });
    // origin 'storage' marks the newest stored data, never the original pinned version.
    return { state: 'restored', origin: 'storage', recovered: true, evidence: basis, source, snapshot, missingData,
      ...(!transcript && savedText ? { savedText } : {}) };
  }
  const data = await sharedResponse(env, item.entity_type === 'playlist' ? 'playlist-v2' : 'channel-v5', item.entity_id);
  if (!data) return { state: 'unavailable' };
  return { state: 'restored', origin: 'storage', recovered: true, evidence: basis, source, missingData: [], snapshot: sourceSnapshotSchema.parse({
    kind: 'inspection', inspector: { provider: 'youtube', type: item.entity_type, id: item.entity_id, data, requestedData: [], dataErrors: {} },
  }) };
}
