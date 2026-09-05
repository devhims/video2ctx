import { ensureCreditGrant, type CreditEnv } from '../../lib/entitlements';
import { ApiError } from '../../lib/http';
import { DATA_OPERATION_PRICING } from '../../lib/metering';

export const AGENT_MAX_TOOL_CALLS = 12;
export const AGENT_CREDIT_RESERVE = (AGENT_MAX_TOOL_CALLS - 1)
  * Math.max(...Object.values(DATA_OPERATION_PRICING).flatMap(price => [price.cached, price.fresh]));

export async function reserveAgentCredits(env: CreditEnv, userId: string, runId: string): Promise<boolean> {
  await ensureCreditGrant(env, userId);
  const operationId = `agent:${runId}`;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO credit_ledger
      (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
    SELECT ?, ?, ?, 'reserve', ?, ?, ?
    WHERE (SELECT COALESCE(SUM(credits), 0) FROM credit_ledger WHERE user_id = ?) >= ?
      AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE user_id = ? AND operation_id = ? AND entry_type = 'settle')
  `).bind(crypto.randomUUID(), userId, operationId, -AGENT_CREDIT_RESERVE,
    JSON.stringify({ operation: 'agent', runId }), Date.now(), userId, AGENT_CREDIT_RESERVE,
    userId, operationId).run();
  const entries = await env.DB.prepare('SELECT entry_type FROM credit_ledger WHERE user_id = ? AND operation_id = ?')
    .bind(userId, operationId).all<{ entry_type: string }>();
  if (entries.results.some(entry => entry.entry_type === 'settle')) return false;
  if (!entries.results.some(entry => entry.entry_type === 'reserve')) {
    throw new ApiError(402, 'INSUFFICIENT_CREDITS', `An agent run requires ${AGENT_CREDIT_RESERVE} available credits.`);
  }
  return true;
}

// Use one terminal ledger entry for every outcome, including a zero-cost failure.
// A zero-value terminal entry also prevents a late reservation after cancellation. The unique
// ledger key makes retries after an interrupted cross-database write safe.
export async function settleAgentCredits(
  env: CreditEnv, userId: string, runId: string, actual: number, providerCostMicros: number,
): Promise<number> {
  if (!Number.isInteger(actual) || actual < 0 || actual > AGENT_CREDIT_RESERVE) {
    throw new Error('Agent credit usage exceeds its reserved budget.');
  }
  if (actual > 0) {
    const reservation = await env.DB.prepare("SELECT -credits AS reserved FROM credit_ledger WHERE user_id = ? AND operation_id = ? AND entry_type = 'reserve'")
      .bind(userId, `agent:${runId}`).first<{ reserved: number }>();
    if (!reservation || reservation.reserved < actual) throw new Error('Agent usage has no matching credit reservation.');
  }
  await env.DB.prepare(`
    INSERT OR IGNORE INTO credit_ledger
      (id, user_id, operation_id, entry_type, credits, provider_cost_micros, metadata_json, created_at)
    SELECT ?, ?, ?, 'settle', COALESCE((SELECT -credits FROM credit_ledger
      WHERE user_id = ? AND operation_id = ? AND entry_type = 'reserve'), 0) - ?, ?, ?, ?
  `).bind(crypto.randomUUID(), userId, `agent:${runId}`, userId, `agent:${runId}`, actual, providerCostMicros,
    JSON.stringify({ operation: 'agent', actual, reserved: AGENT_CREDIT_RESERVE }),
    Date.now()).run();
  const row = await env.DB.prepare('SELECT COALESCE(SUM(credits), 0) AS balance FROM credit_ledger WHERE user_id = ?')
    .bind(userId).first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}
