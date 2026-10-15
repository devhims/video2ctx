import { ApiError, safeErrorLog, sha256 } from './http';
import { assertAccountDeletable } from './admin-identity';
import { billingAccount } from './billing-coordination';
import { closeBillingAccount, requireNoRenewingSubscription } from './billing';
import { deleteAgentAccountData } from '../agents/runtime/account-deletion';
import { framePreviewPrefix } from '../agents/runtime/frame-previews';
import { disconnectYoutube } from './oauth';
import { deleteR2Prefix, userSearchInstanceId } from './research-storage';

/** Both admin and self-service deletion use the same billing gate and cleanup. */
export async function deleteAccount(env: Env, user: { id: string; email: string }): Promise<void> {
  await assertAccountDeletable(env, user.id);
  const account = await billingAccount(env, user.id);
  const claim = crypto.randomUUID();
  if (!await account.beginBillingDeletion(claim)) {
    throw new ApiError(409, 'BILLING_OPERATION_PENDING', 'A billing operation is in progress. Please retry account deletion shortly.');
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
      await deleteAccountRecords(env.DB, user);
    } catch (cause) {
      console.error({ event: 'account_cleanup_failed', ...safeErrorLog(cause) });
      throw new ApiError(503, 'ACCOUNT_DELETION_INCOMPLETE', 'Account deletion could not finish. Please retry.');
    }
  } finally {
    await account.endBillingDeletion(claim);
  }
}

/** Remove account metadata that is not covered by the user foreign-key cascades. */
export async function deleteAccountRecords(db: D1Database, user: { id: string; email: string }): Promise<void> {
  const email = user.email.trim().toLowerCase();
  const emailHash = await sha256(email);
  await db.batch([
    db.prepare('DELETE FROM email_deliveries WHERE user_id=? OR recipient_hash=?').bind(user.id, emailHash),
    db.prepare(`DELETE FROM verification WHERE lower(identifier)=? OR identifier=?
      OR CASE WHEN json_valid(value) THEN lower(json_extract(value, '$.email')) END=?`).bind(email, emailHash, email),
    db.prepare('DELETE FROM user WHERE id=?').bind(user.id),
  ]);
}
