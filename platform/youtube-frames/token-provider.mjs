// Retain the minter between consecutive jobs on one configured route. Proof is minted for
// each player session. Rotate the process on route changes, expiry or a child exit.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

let child, currentSlot, expiresAt;
export async function prepareTokenProvider(slot, signal) {
  if (child && (currentSlot !== slot || Date.now() >= expiresAt)) {
    const stopped = once(child, 'close');
    child.kill('SIGKILL');
    await stopped;
  }
  if (!child) {
    currentSlot = slot;
    expiresAt = Date.now() + 5 * 60_000;
    const next = spawn(process.execPath, [process.env.ATTESTATION_PROVIDER_PATH, '--host', '127.0.0.1'], {
      stdio: 'ignore',
    });
    child = next;
    next.on('error', () => {});
    next.once('close', () => { if (child === next) child = undefined; });
  }
  const startup = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  while (child) {
    startup.throwIfAborted();
    try {
      const ping = await fetch('http://127.0.0.1:4416/ping', { signal: startup });
      await ping.body?.cancel();
      if (ping.ok) return;
    } catch { startup.throwIfAborted(); }
    await delay(75, undefined, { signal: startup });
  }
  throw new Error('Token provider unavailable');
}
