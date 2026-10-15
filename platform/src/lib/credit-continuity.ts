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
    SELECT p.event_at FROM account_credit_payments p JOIN chain ON chain.user_id=p.user_id WHERE p.event_exact=1
    UNION ALL SELECT c.credit_updated_at FROM account_credit_carryovers c JOIN chain ON chain.user_id=c.user_id
    UNION ALL SELECT r.event_at FROM account_credit_refunds r JOIN chain ON chain.user_id=r.owner_user_id
  )
)`;

/** A signed replay can reconcile a legacy grant's timestamp after deletion. */
export function paymentReceipt(db: D1Database, orderId: string, userId: string, customerId: string, eventAt: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO account_credit_payments (order_id,user_id,customer_id,event_at,event_exact,observed_at)
    SELECT ?,?,?,?,1,? WHERE EXISTS (
      SELECT 1 FROM credit_ledger l JOIN billing_accounts b ON b.user_id=l.user_id
      WHERE l.user_id=? AND l.operation_id=? AND l.entry_type='grant' AND b.provider_customer_id=?
    ) OR EXISTS (
      SELECT 1 FROM account_credit_payments WHERE order_id=? AND user_id=? AND customer_id=?
    ) ON CONFLICT(order_id) DO UPDATE SET event_at=excluded.event_at,event_exact=1
      WHERE account_credit_payments.user_id=excluded.user_id
        AND account_credit_payments.customer_id=excluded.customer_id AND account_credit_payments.event_exact=0`)
    .bind(orderId,userId,customerId,eventAt,Date.now(),userId,`polar:order:${orderId}`,customerId,orderId,userId,customerId);
}

/** Credit decisions and their evidence commit together under D1's write lock. */
export function refundReconciliationStatements(db: D1Database, input: {
  orderId: string; userId: string; customerId: string; eventAt: number; starterCredits: number;
}): D1PreparedStatement[] {
  const { orderId, userId, customerId, eventAt, starterCredits } = input;
  // Later customer/cancellation metadata is not a credit ordering fence.
  // A legacy grant observed after this refund has ambiguous ordering unless it
  // is the refunded order itself. Leave it recoverable via signed paid replay.
  const decision = `${ownership}, decision AS (
    SELECT CASE
      WHEN ? < (SELECT event_at FROM fence) THEN 'superseded'
      WHEN EXISTS (SELECT 1 FROM account_credit_payments p JOIN chain ON chain.user_id=p.user_id
        WHERE p.event_exact=0 AND p.order_id<>? AND p.observed_at>?) THEN 'pending'
      ELSE 'apply' END AS outcome
    WHERE EXISTS (SELECT 1 FROM deleted_accounts WHERE user_id=? AND polar_customer_id=?)
      OR EXISTS (SELECT 1 FROM user u LEFT JOIN billing_accounts b ON b.user_id=u.id
        WHERE u.id=? AND (b.provider_customer_id=? OR b.provider_customer_id IS NULL))
      OR EXISTS (SELECT 1 FROM account_credit_payments WHERE order_id=? AND user_id=? AND customer_id=?)
  )`;
  const bindDecision = [userId,eventAt,orderId,eventAt,userId,customerId,userId,customerId,orderId,userId,customerId];
  const eligible = `NOT EXISTS (SELECT 1 FROM account_credit_refunds WHERE order_id=?)
    AND (SELECT outcome FROM decision)='apply'`;
  return [
    db.prepare(`${decision}
      INSERT OR IGNORE INTO credit_ledger (id,user_id,operation_id,entry_type,credits,metadata_json,created_at)
      SELECT ?,a.user_id,?,'adjustment',?-a.available_credits,?,?
      FROM credit_accounts a JOIN owner ON owner.user_id=a.user_id WHERE ${eligible}
        AND (a.available_credits<>? OR EXISTS (SELECT 1 FROM account_credit_payments p JOIN chain ON chain.user_id=p.user_id))`)
      .bind(...bindDecision,crypto.randomUUID(),`polar:refund:${orderId}`,starterCredits,
        JSON.stringify({provider:'polar',kind:'refund-reset',orderId,originalUserId:userId,balance:starterCredits}),
        Date.now(),orderId,starterCredits),
    db.prepare(`${decision}
      UPDATE account_credit_carryovers SET available_credits=?,billing_status='refunded',credit_updated_at=?
      WHERE user_id=(SELECT user_id FROM owner) AND transferred_to_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM user WHERE id=account_credit_carryovers.user_id) AND ${eligible}`)
      .bind(...bindDecision,starterCredits,eventAt,orderId),
    // A receipt must prove an adjustment, a carryover reset, a newer credit
    // decision, or that no paid credits were ever granted. A skipped UPDATE
    // alone is never evidence that the refund was applied.
    db.prepare(`${decision}
      INSERT INTO account_credit_refunds (order_id,original_user_id,customer_id,owner_user_id,outcome,event_at)
      SELECT ?,?,?,owner.user_id,
        CASE WHEN (SELECT outcome FROM decision)='superseded' THEN 'superseded'
          WHEN EXISTS (SELECT 1 FROM credit_ledger l WHERE l.user_id=owner.user_id AND l.operation_id=?)
            OR EXISTS (SELECT 1 FROM account_credit_carryovers c WHERE c.user_id=owner.user_id
              AND c.transferred_to_user_id IS NULL AND c.billing_status='refunded' AND c.credit_updated_at=? AND changes()>0)
          THEN 'applied' ELSE 'unfunded' END,?
      FROM owner WHERE (SELECT outcome FROM decision)='superseded'
        OR ((SELECT outcome FROM decision)='apply' AND (
          EXISTS (SELECT 1 FROM credit_ledger l WHERE l.user_id=owner.user_id AND l.operation_id=?)
          OR EXISTS (SELECT 1 FROM account_credit_carryovers c WHERE c.user_id=owner.user_id
            AND c.transferred_to_user_id IS NULL AND c.billing_status='refunded' AND c.credit_updated_at=? AND changes()>0)
          OR (EXISTS (SELECT 1 FROM credit_accounts a WHERE a.user_id=owner.user_id AND a.available_credits=?)
            AND NOT EXISTS (SELECT 1 FROM account_credit_payments p JOIN chain ON chain.user_id=p.user_id))
        )) ON CONFLICT(order_id) DO NOTHING`)
      .bind(...bindDecision,orderId,userId,customerId,`polar:refund:${orderId}`,eventAt,eventAt,
        `polar:refund:${orderId}`,eventAt,starterCredits),
    // Access follows the applied credit decision, including replay repair.
    // Newer customer metadata cannot retain Builder after an applied refund.
    // Re-evaluate the credit fence so an old receipt cannot revoke a later
    // fulfilled payment. Preserve customer details and their metadata watermark.
    db.prepare(`${decision}
      UPDATE billing_accounts SET plan='starter',status='refunded',
        provider_updated_at=MAX(provider_updated_at,?),updated_at=?
      WHERE user_id=(SELECT user_id FROM owner) AND (SELECT outcome FROM decision)='apply'
        AND EXISTS (SELECT 1 FROM account_credit_refunds r WHERE r.order_id=?
          AND r.original_user_id=? AND r.customer_id=? AND r.owner_user_id=billing_accounts.user_id
          AND (r.outcome='applied' OR (r.outcome='unfunded' AND billing_accounts.plan='builder')))`)
      .bind(...bindDecision,eventAt,Date.now(),orderId,userId,customerId),
  ];
}
