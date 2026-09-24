import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { sweepSessionAssets, type MigrationClient } from './sweep';

const { values } = parseArgs({ options: {
  production: { type: 'boolean' }, mode: { type: 'string' }, report: { type: 'string' },
} });
if (!values.production || !['migrate', 'verify'].includes(values.mode ?? '') || !values.report)
  throw new Error('Usage: npm run assets:sweep -- --production --mode migrate|verify --report /absolute/audit.jsonl');
const mode = values.mode as 'migrate' | 'verify';
const platform = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workdir = await mkdtemp(resolve(tmpdir(), 'video2ctx-session-assets-'));
const token = randomBytes(32).toString('hex');
const report = await open(resolve(values.report), 'wx', 0o600);
const log = await open(resolve(workdir, 'wrangler.log'), 'wx', 0o600);
const config = resolve(workdir, 'wrangler.json');
// Explicit production bindings in both slots: remote dev otherwise selects preview D1.
await writeFile(config, JSON.stringify({
  name: 'video2ctx-session-assets-operator', main: resolve(platform, 'scripts/session-assets/worker.ts'),
  account_id: '9079b7cc8d9e8cf76bcca7559b82b5c5', compatibility_date: '2026-08-18',
  compatibility_flags: ['nodejs_compat'], vars: { MIGRATION_TOKEN: token },
  d1_databases: [{ binding: 'DB', database_name: 'all-things-youtube-production',
    database_id: '4f173c2a-8c42-49ef-b36d-07a91533f029', preview_database_id: '4f173c2a-8c42-49ef-b36d-07a91533f029' }],
  durable_objects: { bindings: [
    { name: 'USER_ACCOUNT', class_name: 'UserAccountDO', script_name: 'video2ctx' },
    { name: 'AGENT_RUNTIME', class_name: 'AgentRuntimeDO', script_name: 'video2ctx' },
  ] },
}), { mode: 0o600 });
const child = spawn(process.execPath, [resolve(platform, 'node_modules/wrangler/bin/wrangler.js'),
  'dev', '--remote', '--config', config, '--ip', '127.0.0.1', '--port', '8799', '--inspector-port', '0'],
{ cwd: workdir, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(workdir, 'debug.log') } });
let spawnError = false;
child.on('error', () => { spawnError = true; });
const abort = new AbortController();
const stop = () => { abort.abort(); child.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
async function call<T>(path: string, input: unknown, timeoutMs = 120_000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:8799${path}`, {
    method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (!response.ok) throw new Error(`Operator request failed: ${response.status}`);
  return response.json() as Promise<T>;
}
try {
  console.log(`Starting production ${mode} sweep. Original private assets will be retained.`);
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null || abort.signal.aborted)
      throw new Error('Temporary operator stopped before it was ready.');
    try { await call('/health', {}, 3000); ready = true; break; } catch { /* Preview startup. */ }
    await delay(1000, undefined, { signal: abort.signal });
  }
  if (!ready) throw new Error('Temporary operator did not become ready.');
  const client: MigrationClient = {
    users: after => call('/users', { after }),
    sessions: (userId, after) => call('/sessions', { userId, after }),
    batch: (userId, conversationId, mode, cursor) => call('/batch', { userId, conversationId, mode, cursor }),
  };
  const summary = await sweepSessionAssets(client, mode, async row => {
    await report.write(`${JSON.stringify(row)}\n`);
  });
  console.log(JSON.stringify(summary));
  if (!summary.complete) process.exitCode = 1;
} catch {
  await report.write(`${JSON.stringify({ type: 'sweep_error', complete: false })}\n`);
  console.error('Sweep incomplete. Confirm the deployed PR and Wrangler access, then rerun with a new report path.');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (child.exitCode === null && child.signalCode === null && !spawnError) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  await report.close();
  await log.close();
  await rm(workdir, { recursive: true, force: true });
}
