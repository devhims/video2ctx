import type { SessionEvidenceStore } from '../../src/agents/runtime/session-evidence';

type Batch = Awaited<ReturnType<SessionEvidenceStore['migrateAssetBatch']>>;
export interface MigrationClient {
  users(after?: string): Promise<{ userIds: string[]; nextCursor: string | null }>;
  sessions(userId: string, after?: string): Promise<{ conversationIds: string[]; nextCursor: string | null }>;
  batch(userId: string, conversationId: string, mode: 'migrate' | 'verify', cursor?: NonNullable<Batch['nextCursor']>): Promise<Batch | null>;
}

/** Snapshot discovery first. ID pagination does not skip recently active sessions. */
async function inventory(client: MigrationClient) {
  const targets: { userId: string; conversationId: string }[] = [];
  let afterUser: string | undefined;
  do {
    const users = await client.users(afterUser);
    for (const userId of users.userIds) {
      let afterSession: string | undefined;
      do {
        const sessions = await client.sessions(userId, afterSession);
        for (const conversationId of sessions.conversationIds) targets.push({ userId, conversationId });
        afterSession = sessions.nextCursor ?? undefined;
      } while (afterSession);
    }
    afterUser = users.nextCursor ?? undefined;
  } while (afterUser);
  return targets;
}

export async function sweepSessionAssets(client: MigrationClient, mode: 'migrate' | 'verify',
  record: (value: unknown) => Promise<void>) {
  const targets = await inventory(client);
  await record({ type: 'inventory', mode, targets, at: new Date().toISOString() });
  let failedSessions = 0, verifiedAssets = 0;
  for (const target of targets) {
    let cursor: NonNullable<Batch['nextCursor']> | undefined;
    let seen = 0, failed = false;
    try {
      do {
        const batch = await client.batch(target.userId, target.conversationId, mode, cursor);
        await record({ type: 'batch', ...target, batch });
        if (!batch) { failed = true; break; }
        seen += batch.results.length;
        verifiedAssets += batch.results.filter(row => row.status === 'shared_verified').length;
        if (batch.results.some(row => row.status !== 'shared_verified')) failed = true;
        if (!batch.stable) { failed = true; break; }
        cursor = batch.nextCursor ?? undefined;
        if (!cursor && seen !== batch.total) failed = true;
      } while (cursor);
    } catch {
      failed = true;
      await record({ type: 'session_error', ...target });
    }
    if (failed) failedSessions++;
  }
  // Account/session creation or deletion during the sweep invalidates the scope.
  const inventoryStable = JSON.stringify(targets) === JSON.stringify(await inventory(client));
  const summary = { type: 'summary', mode, sessions: targets.length, verifiedAssets, failedSessions,
    inventoryStable, complete: inventoryStable && failedSessions === 0, at: new Date().toISOString() };
  await record(summary);
  return summary;
}
