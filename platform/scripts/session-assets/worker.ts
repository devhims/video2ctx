import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { agentInstanceName, userAccountInstanceName } from '../../src/agents/runtime/identity';

// Operator-only temporary remote preview. This entry point is never deployed
// with the application and has no direct R2 bindings or deletion operations.
type MigrationEnv = Pick<Env, 'DB' | 'USER_ACCOUNT' | 'AGENT_RUNTIME'> & { MIGRATION_TOKEN: string };
export default {
  async fetch(request: Request, env: MigrationEnv) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const hash = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    if (!env.MIGRATION_TOKEN || !timingSafeEqual(new Uint8Array(await hash(token)), new Uint8Array(await hash(env.MIGRATION_TOKEN))))
      return new Response('Unauthorized', { status: 401 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ready: true });
    try {
      const input = await request.json();
      if (path === '/users') {
        const { after } = z.object({ after: z.string().max(200).optional() }).parse(input);
        const { results } = await env.DB.prepare('SELECT id FROM user WHERE id>? ORDER BY id LIMIT 101').bind(after ?? '').all<{ id: string }>();
        return Response.json({ userIds: results.slice(0, 100).map(row => row.id), nextCursor: results.length > 100 ? results[99]!.id : null });
      }
      const { userId } = z.object({ userId: z.string().min(1).max(200) }).parse(input);
      const account = env.USER_ACCOUNT.getByName(await userAccountInstanceName(userId));
      if (path === '/sessions') {
        const { after } = z.object({ after: z.string().uuid().optional() }).parse(input);
        return Response.json(await account.listSessionAssetMigrationTargets(after));
      }
      if (path === '/batch') {
        const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(input);
        if (!await account.getSession(conversationId)) return Response.json(null);
        const runtime = env.AGENT_RUNTIME.getByName(await agentInstanceName(userId, conversationId));
        return Response.json(await runtime.migrateSessionAssets(conversationId, userId, input));
      }
      return new Response('Not found', { status: 404 });
    } catch {
      // Do not return private data or raw provider/storage errors.
      return Response.json({ error: 'Migration RPC failed. Confirm deployment and retry the sweep.' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<MigrationEnv>;
