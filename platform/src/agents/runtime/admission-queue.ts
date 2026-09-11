import { z } from 'zod';
import { agentAdmissionSchema, agentRequestSchema, agentRunReceiptSchema, type AgentAdmission, type AgentRequest } from '../contracts';
import { agentInstanceName } from './identity';

export const queuedRunIdentitySchema = agentRunReceiptSchema.pick({ runId: true, userMessageId: true, assistantMessageId: true })
  .extend({ admittedAt: z.number().int().nonnegative() });
export type QueuedRunIdentity = z.infer<typeof queuedRunIdentitySchema>;
const storedSchema = z.object({ request: agentRequestSchema.required({ conversationId: true }), admission: agentAdmissionSchema,
  receipt: agentRunReceiptSchema, admittedAt: z.number().int().nonnegative() });
interface Row extends Record<string, SqlStorageValue> {
  run_id: string; conversation_id: string; idempotency_key: string; payload: string;
  status: string; attempts: number; next_attempt_at: number; error: string | null;
}

/** Durable outbox for first-turn admission. Existing conversations keep runtime validation. */
export class AgentAdmissionQueue {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Pick<Env, 'AGENT_RUNTIME'>,
    private readonly hooks: { assertActive(): void; register(conversationId: string): void;
      record(input: { conversationId: string; runId: string; message: string; updatedAt: number }): unknown }) {}

  initialize(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS agent_admissions (
      run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, error TEXT)`);
  }

  async enqueue(request: AgentRequest, admission: AgentAdmission) {
    const parsed = agentRequestSchema.required({ conversationId: true }).parse(request);
    const owner = agentAdmissionSchema.parse(admission);
    if (parsed.parentMessageId) return { legacy: true as const };
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.hooks.assertActive();
        const existing = this.row(parsed.conversationId);
        if (existing) {
          if (existing.idempotency_key !== owner.idempotencyKey) return { legacy: true as const };
          const stored = storedSchema.parse(JSON.parse(existing.payload));
          return { receipt: { ...stored.receipt, request: { message: stored.request.message } } };
        }
        // Preserve pre-outbox idempotency, including interrupted legacy admissions.
        if (this.ctx.storage.sql.exec('SELECT conversation_id FROM agent_conversations WHERE conversation_id = ?', parsed.conversationId).toArray().length) {
          return { legacy: true as const };
        }
        // Arm recovery BEFORE writing admission. The concurrency gate prevents this alarm
        // from observing half-written state; a crash after insertion still leaves a wakeup.
        const alarm = await this.ctx.storage.getAlarm();
        const wakeAt = Date.now() + 100;
        if (alarm === null || alarm > wakeAt) await this.ctx.storage.setAlarm(wakeAt);
        this.hooks.assertActive();
        const admittedAt = Date.now();
        const receipt = agentRunReceiptSchema.parse({ runId: crypto.randomUUID(), conversationId: parsed.conversationId,
          userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(), conversationTurn: 1,
          modelStepCount: 0, toolCallCount: 0, status: 'pending', request: { message: parsed.message } });
        this.ctx.storage.transactionSync(() => {
          this.hooks.register(parsed.conversationId);
          this.hooks.record({ conversationId: parsed.conversationId, runId: receipt.runId, message: parsed.message, updatedAt: admittedAt });
          this.ctx.storage.sql.exec(`INSERT INTO agent_admissions
            (run_id, conversation_id, idempotency_key, payload, status, next_attempt_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
            receipt.runId, parsed.conversationId, owner.idempotencyKey,
            JSON.stringify({ request: parsed, admission: owner, receipt, admittedAt }), admittedAt);
        });
        return { receipt };
      } catch (error) { return { error }; }
    });
    // Expected admission failures must not break the object's input gate.
    if ('error' in result) throw result.error;
    return result;
  }

  pending(conversationId: string, runId?: string) {
    const row = this.row(conversationId);
    if (!row || row.status === 'delivered' || (runId !== undefined && row.run_id !== runId)) return null;
    const stored = storedSchema.parse(JSON.parse(row.payload));
    const run = { ...stored.receipt, request: { message: stored.request.message }, status: row.status === 'failed' ? 'failed' as const : 'pending' as const,
      ...(row.error ? { error: row.error } : {}) };
    return { run, message: stored.request.message, admittedAt: stored.admittedAt };
  }

  async alarm(): Promise<void> {
    try { this.hooks.assertActive(); } catch { return; }
    const rows = this.ctx.storage.sql.exec<Row>("SELECT * FROM agent_admissions WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 4", Date.now()).toArray();
    // A durable watchdog survives interruption while an RPC is in flight.
    if (rows.length) await this.ctx.storage.setAlarm(Date.now() + 1000);
    await Promise.all(rows.map(row => this.deliver(row)));
    try { this.hooks.assertActive(); } catch { return; }
    // Recheck after I/O: new admissions may have arrived while delivery was running.
    await this.ctx.blockConcurrencyWhile(async () => {
      const next = this.ctx.storage.sql.exec<{ wake: number | null }>("SELECT MIN(next_attempt_at) AS wake FROM agent_admissions WHERE status = 'pending'").toArray()[0]?.wake;
      if (next != null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next));
    });
  }

  clear(): void { this.ctx.storage.sql.exec('DELETE FROM agent_admissions'); }

  private async deliver(row: Row): Promise<void> {
    try {
      this.hooks.assertActive();
      const stored = storedSchema.parse(JSON.parse(row.payload));
      const name = await agentInstanceName(stored.admission.userId, stored.request.conversationId);
      this.hooks.assertActive();
      const delivery = this.env.AGENT_RUNTIME.getByName(name).startRun(stored.request, stored.admission,
        { runId: stored.receipt.runId, userMessageId: stored.receipt.userMessageId,
          assistantMessageId: stored.receipt.assistantMessageId, admittedAt: stored.admittedAt });
      const receipt = await boundedDelivery((async () => await delivery)());
      this.hooks.assertActive();
      if ('rejected' in receipt) {
        this.ctx.storage.sql.exec("UPDATE agent_admissions SET status = 'failed', error = ? WHERE run_id = ?", receipt.message, row.run_id);
      } else {
        if (receipt.runId !== stored.receipt.runId || receipt.userMessageId !== stored.receipt.userMessageId || receipt.assistantMessageId !== stored.receipt.assistantMessageId) {
          throw new Error('Admission identities do not match the runtime.');
        }
        this.ctx.storage.sql.exec("UPDATE agent_admissions SET status = 'delivered', error = NULL WHERE run_id = ?", row.run_id);
      }
    } catch {
      try { this.hooks.assertActive(); } catch { return; }
      // An RPC failure is ambiguous: the runtime may have accepted the run. Retry
      // the same identity until acknowledged, never create a replacement run.
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(row.attempts, 5));
      this.ctx.storage.sql.exec(`UPDATE agent_admissions SET attempts = attempts + 1,
        next_attempt_at = ?, error = 'Runtime startup is delayed; delivery will retry.' WHERE run_id = ? AND status = 'pending'`, Date.now() + delay, row.run_id);
    }
  }

  private row(conversationId: string): Row | undefined {
    return this.ctx.storage.sql.exec<Row>('SELECT * FROM agent_admissions WHERE conversation_id = ?', conversationId).toArray()[0];
  }
}

// A hung RPC must not hold the account's only alarm indefinitely. The original
// RPC can still finish, so every retry carries the same runtime idempotency key.
async function boundedDelivery<T>(delivery: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(delivery), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Runtime admission timed out.')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
