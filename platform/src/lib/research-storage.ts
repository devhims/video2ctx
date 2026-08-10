export function userSearchInstanceId(userId: string): string {
  return `user-${userId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 27)}`;
}

export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const objects = await bucket.list({ prefix, cursor, limit: 1000 });
    if (objects.objects.length) {
      await bucket.delete(objects.objects.map((object) => object.key));
    }
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
}

export async function deleteProjectAssets(env: Env, userId: string, projectId: string): Promise<void> {
  const documents = await env.DB.prepare(
    'SELECT search_item_id FROM documents WHERE user_id=? AND project_id=? AND search_item_id IS NOT NULL'
  ).bind(userId, projectId).all<{ search_item_id: string }>();
  await deleteR2Prefix(env.RESEARCH, `private/${userId}/projects/${projectId}/`);

  const instance = env.AI_SEARCH.get(userSearchInstanceId(userId));
  for (const document of documents.results) {
    try {
      await instance.items.delete(document.search_item_id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AiSearchNotFoundError') return true;
  const record = error as Error & { code?: unknown; status?: unknown };
  return record.status === 404 || record.code === 404 || record.code === 'NOT_FOUND';
}
