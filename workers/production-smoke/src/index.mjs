import { client, transcriptCheck, submitAgent, pollAgent, validReceipt, safeFailure, CheckError } from './checks.mjs';

// This module intentionally exports NO fetch handler, HTTP routes, or public RPC entrypoint.
export default {
  async scheduled(controller, env) {
    if (env.CHECKS_ENABLED !== 'true') {
      console.log(JSON.stringify({ event: 'production_smoke', status: 'disabled' }));
      return;
    }
    if (!env.VIDEO2CTX_API_KEY?.trim()) throw new Error('VIDEO2CTX_API_KEY is not configured');
    const guard = env.SMOKE_GUARD.get(env.SMOKE_GUARD.idFromName('production-smoke-v1'));
    const response = await guard.fetch('https://smoke.internal/scheduled', {
      method: 'POST', body: JSON.stringify({ scheduledTime: controller.scheduledTime }),
    });
    if (!response.ok) throw new Error('Production smoke check failed; inspect production_smoke logs');
  },
};

// Only the private Durable Object binding reaches this handler. Persistent state prevents
// duplicate cron delivery and overlapping paid runs, including across isolate restarts.
export class SmokeGuard {
  constructor(state, env) { this.storage = state.storage; this.env = env; }
  async fetch(request) {
    if (this.env.CHECKS_ENABLED !== 'true') return new Response(null, { status: 204 });
    if (!this.env.VIDEO2CTX_API_KEY?.trim()) return new Response(null, { status: 503 });
    const { scheduledTime } = await request.json();
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) return new Response(null, { status: 400 });
    const claimed = await this.storage.transaction(async txn => {
      const guard = await txn.get('guard') ?? {};
      if ((guard.lastScheduled ?? -1) >= scheduledTime || (guard.busyUntil ?? 0) > Date.now()) return false;
      await txn.put('guard', { lastScheduled: scheduledTime, busyUntil: Date.now() + 600000 });
      return true;
    });
    if (!claimed) {
      console.log(JSON.stringify({ event: 'production_smoke', status: 'skipped_duplicate_or_busy', scheduledTime }));
      return new Response(null, { status: 204 });
    }
    const started = Date.now();
    let report = { event: 'production_smoke', scheduledTime };
    try {
      const api = client(this.env.VIDEO2CTX_API_KEY);
      const pending = await this.storage.get('pending');
      if (pending && !validReceipt(pending)) {
        // A lost POST receipt cannot safely be retried. Fail closed until an operator
        // reconciles the account's Sessions and intentionally replaces the guard namespace.
        report.agent = { status: 'failed', code: 'ADMISSION_UNCERTAIN_OPERATOR_REQUIRED' };
      } else if (validReceipt(pending)) {
        report.mode = 'resume';
        report.agent = await pollAgent(api, pending);
        report.run = pending;
        if (report.agent.terminal) await this.storage.delete('pending');
      } else {
        report.mode = 'new';
        try { report.transcript = await transcriptCheck(api); }
        catch (error) { report.transcript = safeFailure(error); }
        // Fail fast on key/account rejection rather than submit potentially chargeable work.
        if ([401, 402, 403, 429].includes(report.transcript.httpStatus)) {
          report.agent = { status: 'skipped', code: 'TRANSCRIPT_ACCOUNT_OR_RATE_LIMIT' };
        } else {
          // Record before any admission attempt. Even a crash between the POST and
          // receipt persistence must not cause a duplicate paid run on the next cron.
          try {
            const access = await api('/v1/agent/access');
            if (access?.enabled !== true) throw new CheckError('AGENT_ACCESS_DISABLED');
            await this.storage.put('pending', { uncertain: true });
            const receipt = await submitAgent(api);
            if (!validReceipt(receipt)) throw new Error('Invalid receipt');
            const run = { sessionId: receipt.sessionId, runId: receipt.runId };
            await this.storage.put('pending', run);
            report.run = run;
            report.agent = await pollAgent(api, run);
            if (report.agent.terminal) await this.storage.delete('pending');
          } catch (error) {
            report.agent = safeFailure(error);
            if ((await this.storage.get('pending'))?.uncertain) report.agent.code = 'ADMISSION_UNCERTAIN_OPERATOR_REQUIRED';
          }
        }
      }
      report.status = report.agent.status === 'passed' && (!report.transcript || report.transcript.status === 'passed') ? 'passed' : 'failed';
    } catch (error) { report = { ...report, ...safeFailure(error) }; }
    finally {
      // Leave the lease in place on storage failure, rather than risking overlap.
      await this.storage.transaction(async txn => {
        const guard = await txn.get('guard');
        if (guard?.lastScheduled === scheduledTime) await txn.put('guard', { ...guard, busyUntil: 0 });
      });
    }
    console.log(JSON.stringify({ ...report, elapsedMs: Date.now() - started }));
    return new Response(null, { status: report.status === 'passed' ? 204 : 503 });
  }
}
