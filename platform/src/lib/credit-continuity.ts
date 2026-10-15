/** Refund ownership follows one-time transfers, never the successor's email. */
const ownership = `WITH RECURSIVE chain(user_id) AS (
  SELECT ? UNION
  SELECT c.transferred_to_user_id FROM account_credit_carryovers c
    JOIN chain ON chain.user_id=c.user_id WHERE c.transferred_to_user_id IS NOT NULL
), owner AS (
  SELECT user_id FROM chain WHERE NOT EXISTS (SELECT 1 FROM account_credit_carryovers c
    WHERE c.user_id=chain.user_id AND c.transferred_to_user_id IS NOT NULL)
), fence AS (
  SELECT COALESCE(MAX(event_at),0) AS event_at FROM (
    SELECT p.event_at FROM account_credit_payments p JOIN chain ON chain.user_id=p.user_id
    UNION ALL SELECT c.credit_updated_at FROM account_credit_carryovers c JOIN chain ON chain.user_id=c.user_id
    UNION ALL SELECT r.event_at FROM account_credit_refunds r JOIN chain ON chain.user_id=r.owner_user_id
  )
)`;

/** Record only a fulfilled credit grant, not customer/cancellation metadata. */
export function paymentReceipt(db: D1Database, orderId: string, userId: string, customerId: string, eventAt: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO account_credit_payments (order_id,user_id,customer_id,event_at)
    SELECT ?,?,?,? FROM credit_ledger l JOIN billing_accounts b ON b.user_id=l.user_id
    WHERE l.user_id=? AND l.operation_id=? AND l.entry_type='grant' AND b.provider_customer_id=?
    ON CONFLICT(order_id) DO NOTHING`)
    .bind(orderId,userId,customerId,eventAt,userId,`polar:order:${orderId}`,customerId);
}

export function refundReceipt(db: D1Database, orderId: string, userId: string, customerId: string, eventAt: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO account_credit_refunds (order_id,original_user_id,customer_id,owner_user_id,event_at)
    VALUES (?,?,?,?,?) ON CONFLICT(order_id) DO NOTHING`).bind(orderId,userId,customerId,userId,eventAt);
}

/** Mutations, ownership resolution and receipt commit together under D1's write lock. */
export function transferredRefundStatements(db: D1Database, input: {
  orderId: string; userId: string; customerId: string; eventAt: number; starterCredits: number;
}): D1PreparedStatement[] {
  const { orderId, userId, customerId, eventAt, starterCredits } = input;
  // A refund applied before deletion is already reflected in the snapshot.
  // A receipt survives deletion, so retries after transfer cannot refill credits.
  const eligible = `NOT EXISTS (SELECT 1 FROM account_credit_refunds WHERE order_id=?)
    AND ? >= (SELECT event_at FROM fence)
    AND EXISTS (SELECT 1 FROM account_credit_carryovers c JOIN deleted_accounts d ON d.user_id=c.user_id
      WHERE c.user_id=? AND d.polar_customer_id=? AND c.billing_status<>'refunded')`;
  return [
    db.prepare(`${ownership}
      INSERT INTO credit_ledger (id,user_id,operation_id,entry_type,credits,metadata_json,created_at)
      SELECT ?,a.user_id,?,'adjustment',?-a.available_credits,?,?
      FROM credit_accounts a JOIN owner ON owner.user_id=a.user_id WHERE ${eligible}`)
      .bind(userId,crypto.randomUUID(),`polar:refund:${orderId}`,starterCredits,
        JSON.stringify({provider:'polar',kind:'transferred-refund-reset',orderId,originalUserId:userId,balance:starterCredits}),
        Date.now(),orderId,eventAt,userId,customerId),
    db.prepare(`${ownership}
      UPDATE account_credit_carryovers SET available_credits=?,billing_status='refunded',credit_updated_at=?
      WHERE user_id=(SELECT user_id FROM owner) AND transferred_to_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM user WHERE id=account_credit_carryovers.user_id) AND ${eligible}`)
      .bind(userId,starterCredits,eventAt,orderId,eventAt,userId,customerId),
    db.prepare(`${ownership}
      INSERT INTO account_credit_refunds (order_id,original_user_id,customer_id,owner_user_id,event_at)
      SELECT ?,?,?,owner.user_id,? FROM owner WHERE true ON CONFLICT(order_id) DO NOTHING`)
      .bind(userId,orderId,userId,customerId,eventAt),
  ];
}
