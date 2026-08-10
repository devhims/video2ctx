import { ApiError, now, safeErrorLog, sha256 } from './http';
import { userSearchInstanceId } from './research-storage';

export interface Evidence {
  id: string;
  score: number;
  text: string;
  provider?: string;
  entityId?: string;
  startMs?: number;
  projectId?: string;
  sourceKey: string;
}

async function getOrCreatePrivateInstance(env: Env, userId: string) {
  const id = userSearchInstanceId(userId);
  try {
    await env.AI_SEARCH.get(id).info();
    return env.AI_SEARCH.get(id);
  } catch {
    return env.AI_SEARCH.create({
      id,
      index_method: { keyword: true, vector: true },
      fusion_method: 'rrf',
      chunk: true,
      chunk_size: 450,
      chunk_overlap: 20,
      custom_metadata: [
        { field_name: 'provider', data_type: 'text' },
        { field_name: 'project_id', data_type: 'text' },
        { field_name: 'entity_id', data_type: 'text' },
        { field_name: 'start_ms', data_type: 'number' },
      ],
    });
  }
}

export async function indexPrivateDocument(
  env: Env,
  input: { provider: string; userId: string; projectId: string; entityId: string; title: string; content: string; startMs?: number }
): Promise<string | null> {
  const documentId = await sha256(`${input.userId}:${input.projectId}:${input.provider}:${input.entityId}:${input.startMs ?? 0}`);
  const r2Key = `private/${input.userId}/projects/${input.projectId}/${input.provider}/${documentId}.md`;
  const body = `# ${input.title}\n\n${input.content}`;
  const project = await privateProjectExists(env, input.userId, input.projectId);
  if (!project) return null;

  const instance = await getOrCreatePrivateInstance(env, input.userId);
  let searchItemId: string | undefined;
  try {
    await env.RESEARCH.put(r2Key, body, {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: { provider: input.provider, project_id: input.projectId, entity_id: input.entityId },
    });
    const searchItem = await instance.items.upload(`${input.projectId}-${documentId}.md`, body, {
      metadata: {
        provider: input.provider,
        project_id: input.projectId,
        entity_id: input.entityId,
        start_ms: String(input.startMs ?? 0),
      },
    });
    searchItemId = searchItem.id;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO documents
       (id, owner_scope, user_id, project_id, provider, entity_type, entity_id, title, body_preview, r2_key, search_item_id, indexed_at, created_at)
       VALUES (?, 'private', ?, ?, ?, 'transcript', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      documentId, input.userId, input.projectId, input.provider, input.entityId, input.title,
      input.content.slice(0, 500), r2Key, searchItemId, now(), now()
    ).run();
    return documentId;
  } catch (error) {
    await removePartialUpload(env, instance, r2Key, searchItemId);
    if (!await privateProjectExists(env, input.userId, input.projectId)) return null;
    throw error;
  }
}

export async function indexPublicDocument(
  env: Env,
  input: { provider: string; entityId: string; title: string; content: string; language?: string; startMs?: number }
): Promise<string> {
  const documentId = await sha256(`public:${input.provider}:${input.entityId}:${input.language ?? 'und'}:${input.startMs ?? 0}`);
  const r2Key = `public/${input.provider}/videos/${input.entityId}/${documentId}.md`;
  const body = `# ${input.title}\n\n${input.content}`;
  await env.RESEARCH.put(r2Key, body, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: { provider: input.provider, entity_id: input.entityId, language: input.language ?? 'und' },
  });
  let instance = env.AI_SEARCH.get(env.PUBLIC_SEARCH_INSTANCE);
  try {
    await instance.info();
  } catch {
    instance = await env.AI_SEARCH.create({
      id: env.PUBLIC_SEARCH_INSTANCE,
      index_method: { keyword: true, vector: true },
      fusion_method: 'rrf', chunk: true, chunk_size: 450, chunk_overlap: 20,
      custom_metadata: [
        { field_name: 'provider', data_type: 'text' },
        { field_name: 'entity_id', data_type: 'text' },
        { field_name: 'start_ms', data_type: 'number' },
        { field_name: 'language', data_type: 'text' },
      ],
    });
  }
  const searchItem = await instance.items.upload(`${input.entityId}-${documentId}.md`, body, {
    metadata: { provider: input.provider, entity_id: input.entityId, start_ms: String(input.startMs ?? 0), language: input.language ?? 'und' },
  });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO documents
     (id,owner_scope,provider,entity_type,entity_id,language,title,body_preview,r2_key,search_item_id,indexed_at,created_at)
     VALUES (?,'public',?,'transcript',?,?,?,?,?,?,?,?)`
  ).bind(
    documentId, input.provider, input.entityId, input.language ?? null, input.title,
    input.content.slice(0, 500), r2Key, searchItem.id, now(), now()
  ).run();
  return documentId;
}

async function privateProjectExists(env: Env, userId: string, projectId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare('SELECT 1 FROM projects WHERE id=? AND user_id=?')
    .bind(projectId, userId).first());
}

async function removePartialUpload(
  env: Env,
  instance: AiSearchInstance,
  r2Key: string,
  searchItemId?: string,
): Promise<void> {
  const cleanup: Promise<unknown>[] = [env.RESEARCH.delete(r2Key)];
  if (searchItemId) cleanup.push(instance.items.delete(searchItemId));
  const results = await Promise.allSettled(cleanup);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn({ event: 'document_partial_cleanup_failed', ...safeErrorLog(result.reason) });
    }
  }
}

export async function searchPrivate(
  env: Env,
  userId: string,
  query: string,
  projectId?: string
): Promise<Evidence[]> {
  const instance = await getOrCreatePrivateInstance(env, userId);
  const runSearch = (rerankingEnabled: boolean) => instance.search({
    query,
    ai_search_options: {
      retrieval: {
        retrieval_type: 'hybrid',
        max_num_results: 12,
        match_threshold: 0.25,
        return_on_failure: true,
        ...(projectId ? { filters: { project_id: projectId } } : {}),
      },
      reranking: { enabled: rerankingEnabled, model: '@cf/baai/bge-reranker-base' },
    },
  });
  let result = await runSearch(true);
  if (!result.chunks.length) result = await runSearch(false);
  return result.chunks.map((chunk) => ({
    id: chunk.id,
    score: chunk.score,
    text: chunk.text,
    provider: stringMetadata(chunk.item.metadata, 'provider'),
    entityId: stringMetadata(chunk.item.metadata, 'entity_id'),
    startMs: evidenceStartMs(chunk.text, chunk.item.metadata),
    projectId: stringMetadata(chunk.item.metadata, 'project_id'),
    sourceKey: chunk.item.key,
  }));
}

export async function searchPublic(env: Env, query: string): Promise<Evidence[]> {
  try {
    const result = await env.AI_SEARCH.get(env.PUBLIC_SEARCH_INSTANCE).search({
      query,
      ai_search_options: { retrieval: { retrieval_type: 'hybrid', max_num_results: 12, return_on_failure: true } },
    });
    return result.chunks.map((chunk) => ({
      id: chunk.id,
      score: chunk.score,
      text: chunk.text,
      provider: stringMetadata(chunk.item.metadata, 'provider'),
      entityId: stringMetadata(chunk.item.metadata, 'entity_id'),
      startMs: evidenceStartMs(chunk.text, chunk.item.metadata),
      sourceKey: chunk.item.key,
    }));
  } catch (error) {
    console.warn({ event: 'public_search_unavailable', ...safeErrorLog(error) });
    return [];
  }
}

export function requireEvidence(evidence: Evidence[]): Evidence[] {
  if (!evidence.length) throw new ApiError(422, 'INSUFFICIENT_EVIDENCE', 'Insufficient evidence to answer this question.');
  return evidence;
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberMetadata(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' ? value : undefined;
}

function evidenceStartMs(text: string, metadata: Record<string, unknown> | undefined): number | undefined {
  const timestamp = text.match(/(?:^|\n)\[(\d+)]\s/)?.[1];
  if (timestamp !== undefined) {
    const value = Number(timestamp);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return numberMetadata(metadata, 'start_ms');
}
