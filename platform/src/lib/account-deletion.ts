import { ApiError, safeErrorLog, sha256 } from './http';
import { assertAccountDeletable } from './admin-identity';
import { billingAccount } from './billing-coordination';
import { closeBillingAccount, requireNoRenewingSubscription } from './billing';
import { deleteAgentAccountData } from '../agents/runtime/account-deletion';
import { framePreviewPrefix } from '../agents/runtime/frame-previews';
import { disconnectYoutube } from './oauth';
import { deleteR2Prefix, userSearchInstanceId } from './research-storage';

export type DeletionActor = { source: 'self' | 'admin'; userId: string };

/** Both admin and self-service deletion use the same billing gate and cleanup. */
export async function deleteAccount(env: Env, user: { id: string; email: string }, actor: DeletionActor = { source: 'self', userId: user.id }): Promise<void> {
  await assertAccountDeletable(env, user.id);
  const account = await billingAccount(env, user.id);
  const claim = crypto.randomUUID();
  const admission = await account.claimBillingDeletion(claim);
  if (admission === 'deletion_in_progress') {
    throw new ApiError(409, 'ACCOUNT_DELETION_IN_PROGRESS', 'Account deletion is already running. Please wait for cleanup to finish.');
  }
  if (admission !== 'acquired') {
    throw new ApiError(409, 'BILLING_OPERATION_PENDING', 'A previous billing operation must finish or be reviewed before this account can be deleted.');
  }
  try {
    await requireNoRenewingSubscription(env, user.id);
    // Keep checkout fenced once customer deletion may have reached Polar.
    await account.commitBillingDeletion(claim);
    await closeBillingAccount(env, user.id);
    try {
      await deleteAgentAccountData(env, user.id);
      await disconnectYoutube(env, user.id);
      await deleteR2Prefix(env.RESEARCH, `private/${user.id}/`);
      await deleteR2Prefix(env.RESEARCH, await framePreviewPrefix(user.id));
      await env.TASKS.send({ type: 'delete-user-search', idempotencyKey: `delete-search:${user.id}`,
        payload: { instanceId: userSearchInstanceId(user.id) } }, { contentType: 'json' });
      await deleteAccountRecords(env.DB, user, actor);
    } catch (cause) {
      console.error({ event: 'account_cleanup_failed', ...safeErrorLog(cause) });
      throw new ApiError(503, 'ACCOUNT_DELETION_INCOMPLETE', 'Account deletion could not finish. Please retry.');
    }
  } finally {
    await account.endBillingDeletion(claim);
  }
}

/** Remove account metadata that is not covered by the user foreign-key cascades. */
export async function deleteAccountRecords(db: D1Database, user: { id: string; email: string }, actor: DeletionActor = { source: 'self', userId: user.id }): Promise<void> {
  const email = user.email.trim().toLowerCase();
  const emailHash = await sha256(email);
  await db.batch([
    // Snapshot and deletion commit together. A retry after deletion cannot
    // create or overwrite history because the original user no longer exists.
    db.prepare(`INSERT INTO deleted_accounts
      (user_id,email,signed_up_at,deleted_at,polar_customer_id,plan,remaining_credits,deletion_source,deleted_by_user_id)
      SELECT u.id,lower(trim(u.email)),u.createdAt,?,b.provider_customer_id,
        COALESCE(b.plan,'starter'),COALESCE(a.available_credits,0),?,?
      FROM user u LEFT JOIN credit_accounts a ON a.user_id=u.id
        LEFT JOIN billing_accounts b ON b.user_id=u.id WHERE u.id=?
      ON CONFLICT(user_id) DO NOTHING`).bind(Date.now(), actor.source, actor.userId, user.id),
    db.prepare('DELETE FROM email_deliveries WHERE user_id=? OR recipient_hash=?').bind(user.id, emailHash),
    db.prepare(`DELETE FROM verification WHERE lower(identifier)=? OR identifier=?
      OR CASE WHEN json_valid(value) THEN lower(json_extract(value, '$.email')) END=?`).bind(email, emailHash, email),
    db.prepare('DELETE FROM user WHERE id=?').bind(user.id),
  ]);
}
