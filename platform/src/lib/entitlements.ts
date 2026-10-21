import type { Plan } from '../types';
import { ApiError, now } from './http';

export interface Entitlements {
  plan: Plan;
  includedCredits: number;
  creditGrant: 'onboarding' | 'billing-cycle';
  projectLimit: number;
  monitorLimit: number;
  dailyImportLimit: number;
}

export interface CreditEnv {
  DB: D1Database;
  STARTER_ONBOARDING_CREDITS: string;
  BUILDER_MONTHLY_CREDITS: string;
  STARTER_PROJECT_LIMIT: string;
  STARTER_MONITOR_LIMIT: string;
  STARTER_DAILY_IMPORTS: string;
  BUILDER_PROJECT_LIMIT: string;
  BUILDER_MONITOR_LIMIT: string;
  BUILDER_DAILY_IMPORTS: string;
}

export async function entitlements(env: CreditEnv, userId: string): Promise<Entitlements> {
  const row = await env.DB.prepare('SELECT plan FROM billing_accounts WHERE user_id = ?')
    .bind(userId).first<{ plan: Plan }>();
  const plan = row?.plan === 'builder' ? 'builder' : 'starter';
  return {
    plan,
    includedCredits: Number(plan === 'builder' ? env.BUILDER_MONTHLY_CREDITS : env.STARTER_ONBOARDING_CREDITS),
    creditGrant: plan === 'builder' ? 'billing-cycle' : 'onboarding',
    projectLimit: Number(plan === 'builder' ? env.BUILDER_PROJECT_LIMIT : env.STARTER_PROJECT_LIMIT),
    monitorLimit: Number(plan === 'builder' ? env.BUILDER_MONITOR_LIMIT : env.STARTER_MONITOR_LIMIT),
    dailyImportLimit: Number(plan === 'builder' ? env.BUILDER_DAILY_IMPORTS : env.STARTER_DAILY_IMPORTS),
  };
}

export async function enforceImportLimit(env: Env, userId: string, limits: Entitlements, deep = false): Promise<void> {
  if (deep && limits.plan !== 'builder') {
    throw new ApiError(403, 'BUILDER_REQUIRED', 'Deep comment fetch is available on Builder.');
  }
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND created_at>=?'
  ).bind(userId, now() - 24 * 60 * 60_000).first<{ count: number }>();
  if ((row?.count ?? 0) >= limits.dailyImportLimit) {
    throw new ApiError(403, 'IMPORT_LIMIT_REACHED', `Your plan allows ${limits.dailyImportLimit} imports per 24 hours.`);
  }
}

export async function enforceCount(
  env: Env,
  userId: string,
  resource: 'projects' | 'monitors',
  limit: number
): Promise<void> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${resource} WHERE user_id = ?`)
    .bind(userId)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= limit) {
    throw new ApiError(403, 'PLAN_LIMIT_REACHED', `Your plan allows up to ${limit} ${resource}.`);
  }
}

/** Reading a balance never grants credits. Signup and payment events own grants. */
export async function creditBalance(env: CreditEnv, userId: string): Promise<number> {
  const row = await balanceStatement(env, userId).first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

function balanceStatement(env: CreditEnv, userId: string): D1PreparedStatement {
  return env.DB.prepare('SELECT available_credits AS balance FROM credit_accounts WHERE user_id = ?').bind(userId);
}

export async function reserveCredits(
  env: CreditEnv,
  userId: string,
  operationId: string,
  amount: number,
  metadata: Record<string, unknown>
): Promise<void> {
  // The conditional insert and balance trigger execute as one atomic statement.
  // Check duplicates after a no-op so simultaneous retries also succeed once.
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger
     (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
     SELECT ?, ?, ?, 'reserve', ?, ?, ?
     WHERE (SELECT available_credits FROM credit_accounts WHERE user_id=?) >= ?`
  ).bind(
    crypto.randomUUID(), userId, operationId, -amount, JSON.stringify(metadata), now(), userId, amount
  ).run();
  if (!result.meta.changes) {
    const existing = await env.DB.prepare(
      `SELECT 1 FROM credit_ledger WHERE user_id=? AND operation_id=? AND entry_type='reserve'`
    ).bind(userId, operationId).first();
    if (existing) return;
    throw new ApiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits for this operation.');
  }
}

export async function settleCredits(
  env: CreditEnv,
  userId: string,
  operationId: string,
  reserved: number,
  actual: number,
  providerCostMicros: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await settlementStatement(env, userId, operationId, reserved, actual, providerCostMicros, metadata).run();
}

/** Read the balance after settlement in the same database round trip. */
export async function settleCreditsAndReadBalance(
  env: CreditEnv,
  userId: string,
  operationId: string,
  reserved: number,
  actual: number,
  providerCostMicros: number,
  metadata: Record<string, unknown> = {},
): Promise<number> {
  const results = await env.DB.batch<{ balance: number }>([
    settlementStatement(env, userId, operationId, reserved, actual, providerCostMicros, metadata),
    balanceStatement(env, userId),
  ]);
  return Number(results[1]!.results[0]?.balance ?? 0);
}

function settlementStatement(
  env: CreditEnv,
  userId: string,
  operationId: string,
  reserved: number,
  actual: number,
  providerCostMicros: number,
  metadata: Record<string, unknown>,
): D1PreparedStatement {
  const refund = Math.max(0, reserved - actual);
  return env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger
     (id, user_id, operation_id, entry_type, credits, provider_cost_micros, metadata_json, created_at)
     VALUES (?, ?, ?, 'settle', ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), userId, operationId, refund, providerCostMicros,
    JSON.stringify({ ...metadata, reserved, actual }), now()
  );
}

export async function releaseCredits(
  env: CreditEnv,
  userId: string,
  operationId: string,
  reserved: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger
     (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
     VALUES (?, ?, ?, 'release', ?, ?, ?)`
  ).bind(crypto.randomUUID(), userId, operationId, reserved, JSON.stringify(metadata), now()).run();
}
