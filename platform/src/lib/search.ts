import { ApiError, now, sha256 } from './http';

export interface Evidence {
  id: string;
  score: number;
  text: string;
  entityId?: string;
  startMs?: number;
  projectId?: string;
  sourceKey: string;
}

function userInstance(userId: string): string {
  return `user-${userId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 27)}`;
}

async function getOrCreatePrivateInstance(env: Env, userId: string) {
  const id = userInstance(userId);
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
        { field_name: 'project_id', data_type: 'text' },
        { field_name: 'entity_id', data_type: 'text' },
        { field_name: 'start_ms', data_type: 'number' },
      ],
    });
  }
}

export async function indexPrivateDocument(
  env: Env,
  input: { userId: string; projectId: string; entityId: string; title: string; content: string; startMs?: number }
): Promise<string> {
  const documentId = await sha256(`${input.userId}:${input.projectId}:${input.entityId}:${input.startMs ?? 0}`);
  const r2Key = `private/${input.userId}/projects/${input.projectId}/${documentId}.md`;
  const body = `# ${input.title}\n\n${input.content}`;
  await env.RESEARCH.put(r2Key, body, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: { project_id: input.projectId, entity_id: input.entityId },
  });
  const instance = await getOrCreatePrivateInstance(env, input.userId);
  await instance.items.upload(`${input.projectId}-${documentId}.md`, body, {
    metadata: {
      project_id: input.projectId,
      entity_id: input.entityId,
      start_ms: input.startMs ?? 0,
    },
  });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO documents
     (id, owner_scope, user_id, project_id, entity_type, entity_id, title, body_preview, r2_key, indexed_at, created_at)
     VALUES (?, 'private', ?, ?, 'transcript', ?, ?, ?, ?, ?, ?)`
  ).bind(
    documentId, input.userId, input.projectId, input.entityId, input.title,
    input.content.slice(0, 500), r2Key, now(), now()
  ).run();
  return documentId;
}

export async function indexPublicDocument(
  env: Env,
  input: { entityId: string; title: string; content: string; language?: string; startMs?: number }
): Promise<string> {
  const documentId = await sha256(`public:${input.entityId}:${input.language ?? 'und'}:${input.startMs ?? 0}`);
  const r2Key = `public/videos/${input.entityId}/${documentId}.md`;
  const body = `# ${input.title}\n\n${input.content}`;
  await env.RESEARCH.put(r2Key, body, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: { entity_id: input.entityId, language: input.language ?? 'und' },
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
        { field_name: 'entity_id', data_type: 'text' },
        { field_name: 'start_ms', data_type: 'number' },
        { field_name: 'language', data_type: 'text' },
      ],
    });
  }
  await instance.items.upload(`${input.entityId}-${documentId}.md`, body, {
    metadata: { entity_id: input.entityId, start_ms: input.startMs ?? 0, language: input.language ?? 'und' },
  });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO documents
     (id,owner_scope,entity_type,entity_id,language,title,body_preview,r2_key,indexed_at,created_at)
     VALUES (?,'public','transcript',?,?,?,?,?,?,?,?)`
  ).bind(
    documentId, input.entityId, input.language ?? null, input.title,
    input.content.slice(0, 500), r2Key, now(), now()
  ).run();
  return documentId;
}

export async function searchPrivate(
  env: Env,
  userId: string,
  query: string,
  projectId?: string
): Promise<Evidence[]> {
  const instance = await getOrCreatePrivateInstance(env, userId);
  const result = await instance.search({
    query,
    ai_search_options: {
      retrieval: {
        retrieval_type: 'hybrid',
        max_num_results: 12,
        match_threshold: 0.25,
        return_on_failure: true,
        ...(projectId ? { filters: { project_id: projectId } } : {}),
      },
      reranking: { enabled: true, model: '@cf/baai/bge-reranker-base' },
    },
  });
  return result.chunks.map((chunk) => ({
    id: chunk.id,
    score: chunk.score,
    text: chunk.text,
    entityId: stringMetadata(chunk.item.metadata, 'entity_id'),
    startMs: numberMetadata(chunk.item.metadata, 'start_ms'),
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
      entityId: stringMetadata(chunk.item.metadata, 'entity_id'),
      startMs: numberMetadata(chunk.item.metadata, 'start_ms'),
      sourceKey: chunk.item.key,
    }));
  } catch (error) {
    console.warn('public_search_unavailable', error);
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
