import { userAccountInstanceName } from '../agents/runtime/identity';

export interface ProjectItemRecord {
  id: string; provider: string; entity_type: string; entity_id: string; title: string;
  start_ms: number | null; end_ms: number | null; note: string; tags_json: string; created_at: number;
  source_id?: string;
}

// Both dashboard detail and exports include legacy items and saved source references.
export async function listProjectItems(env: Env, userId: string, projectId: string): Promise<ProjectItemRecord[]> {
  const legacy = await env.DB.prepare('SELECT * FROM project_items WHERE project_id=? AND user_id=? ORDER BY created_at DESC')
    .bind(projectId, userId).all<ProjectItemRecord>();
  const account = env.USER_ACCOUNT.getByName(await userAccountInstanceName(userId));
  const sources = (await account.listProjectSources(projectId)).map(item => ({
    ...item, start_ms: null, end_ms: null, note: '', tags_json: '[]',
  }));
  return [...legacy.results, ...sources].sort((a, b) => b.created_at - a.created_at);
}
