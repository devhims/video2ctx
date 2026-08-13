import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));
const children = new Set();
let stopping = false;

function stopChildren(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;

  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}

function fail(message) {
  console.error(`\nLocal development could not start: ${message}\n`);
  process.exitCode = 1;
}

function requireDocker() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (result.status !== 0) {
    fail('Docker must be installed and running to load videos and playlists.');
    return false;
  }
  return true;
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...options,
  });
  children.add(child);
  return child;
}

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    const child = run(command, args);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

function waitForExit(child, label) {
  if (child.exitCode !== null) return Promise.resolve({ label, code: child.exitCode });
  return new Promise((resolve) => child.once('exit', (code, signal) => {
    resolve({ label, code: code ?? 1, signal });
  }));
}

async function waitForPlatform(child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('the local platform stopped before becoming ready');
    }

    try {
      const response = await fetch('http://localhost:8787/health');
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the local platform did not become ready within 45 seconds');
}

process.once('SIGINT', () => {
  stopChildren('SIGINT');
  process.exit(130);
});
process.once('SIGTERM', () => {
  stopChildren('SIGTERM');
  process.exit(143);
});
process.once('exit', () => stopChildren());

if (requireDocker()) {
  try {
    console.log('\nApplying local D1 migrations…');
    await runToCompletion('npm', ['--prefix', 'platform', 'run', 'db:migrate:local']);

    console.log('\nStarting the local platform…');
    const platform = run('npm', ['--prefix', 'platform', 'run', 'dev:local', '--', '--port', '8787']);
    await waitForPlatform(platform);

    console.log('\nStarting the dashboard at http://localhost:3000…');
    const web = run('npm', ['--prefix', 'web', 'run', 'dev', '--', '--port', '3000'], {
      env: {
        ...process.env,
        PLATFORM_API_BASE_URL: 'http://localhost:8787',
      },
    });

    const exited = await Promise.race([
      waitForExit(platform, 'platform'),
      waitForExit(web, 'dashboard'),
    ]);
    stopChildren();
    if (exited.label === 'platform') {
      throw new Error(`the local platform stopped unexpectedly (${exited.signal ?? `code ${exited.code}`})`);
    }
    process.exitCode = exited.code;
  } catch (error) {
    stopChildren();
    fail(error instanceof Error ? error.message : String(error));
  }
}
