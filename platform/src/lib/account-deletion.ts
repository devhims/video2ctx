import { sha256 } from './http';

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
