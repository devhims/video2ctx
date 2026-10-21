// Account reads use the allowance recorded at signup, so changing the offer
// never makes an older account appear to have received the new grant.
// The containing query must alias the user table as `u`.
export const signupAllowanceSql = `(SELECT CASE
  WHEN operation_id='onboarding:v1' THEN COALESCE(json_extract(metadata_json,'$.allowance'),credits)
  ELSE 0 END FROM credit_ledger WHERE id='onboarding:' || u.id AND user_id=u.id)`;

/** Returning accounts carry their balance forward and receive no welcome grant. */
export async function signupGrant(db: D1Database, userId: string): Promise<number | null> {
  return db.prepare(`SELECT credits FROM credit_ledger
    WHERE user_id=? AND operation_id='onboarding:v1' AND entry_type='grant'`)
    .bind(userId).first<number>('credits');
}
