import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(platformRoot, 'test/auth/wrangler.jsonc');
const wranglerPath = resolve(platformRoot, 'node_modules/.bin/wrangler');
const stateDirectory = await mkdtemp(join(tmpdir(), 'video2ctx-auth-e2e-'));
const emptyEnvironmentFile = resolve(stateDirectory, 'empty.env');
await writeFile(emptyEnvironmentFile, '', { mode: 0o600 });

const commonArgs = [
  '--config', configPath,
  '--env-file', emptyEnvironmentFile,
];

const migration = spawnSync(wranglerPath, [
  'd1', 'migrations', 'apply', 'DB',
  '--local',
  '--persist-to', stateDirectory,
  ...commonArgs,
], {
  cwd: platformRoot,
  encoding: 'utf8',
  env: { ...process.env, CI: '1' },
});

if (migration.status !== 0) {
  process.stderr.write(migration.stderr || migration.stdout || 'Could not initialize the auth E2E database.\n');
  await cleanup();
  process.exit(migration.status ?? 1);
}

const worker = spawn(wranglerPath, [
  'dev',
  '--local',
  '--ip', '127.0.0.1',
  '--port', '8788',
  '--persist-to', stateDirectory,
  '--var', 'ENVIRONMENT:development',
  '--var', 'APP_ORIGIN:http://127.0.0.1:3001',
  '--var', 'AUTH_BASE_URL:http://127.0.0.1:3001',
  '--log-level', 'warn',
  '--show-interactive-dev-session=false',
  ...commonArgs,
], {
  cwd: platformRoot,
  stdio: 'inherit',
  env: process.env,
});

let stopping = false;
async function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (worker.exitCode === null) worker.kill(signal);
  await cleanup();
}

async function cleanup() {
  const expectedPrefix = `${resolve(tmpdir())}${sep}`;
  const resolvedState = resolve(stateDirectory);
  if (!resolvedState.startsWith(expectedPrefix) || !basename(resolvedState).startsWith('video2ctx-auth-e2e-')) {
    throw new Error(`Refusing to remove unexpected auth E2E path: ${resolvedState}`);
  }
  await rm(resolvedState, { recursive: true, force: true });
}

process.on('SIGINT', () => { void stop('SIGINT').finally(() => process.exit(130)); });
process.on('SIGTERM', () => { void stop('SIGTERM').finally(() => process.exit(143)); });
worker.on('exit', (code) => { void stop().finally(() => process.exit(code ?? 1)); });
