import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RESPONSE_BYTES, parseFrameRequest } from './contract.mjs';

export async function runFrameJob(input, { signal, timeoutMs = 60_000,
  jobPath = fileURLToPath(new URL('./job.mjs', import.meta.url)), onWorkspace } = {}) {
  const request = parseFrameRequest(input);
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'youtube-frames-'));
  try {
    onWorkspace?.(directory);
    await writeFile(join(directory, 'request.json'), JSON.stringify(request));
    await new Promise((resolve, reject) => {
      // A separate process group lets a deadline stop the job AND its FFmpeg children.
      const child = spawn(process.execPath, [jobPath, directory], {
        detached: true, shell: false, stdio: 'ignore',
      });
      let failure;
      const stop = (code) => {
        failure ??= Object.assign(new Error(code === 'FRAME_TIMEOUT'
          ? 'Frame extraction exceeded its deadline.' : 'Frame extraction was cancelled.'), { code, retryable: true });
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
        }
      };
      const abort = () => stop('FRAME_CANCELLED');
      const timer = setTimeout(() => stop('FRAME_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      child.once('error', () => { cleanup(); reject(Object.assign(new Error('Could not start frame extraction.'), { code: 'FRAME_EXTRACTION_FAILED' })); });
      child.once('close', code => {
        cleanup();
        if (failure) reject(failure);
        else if (code !== 0) reject(Object.assign(new Error('Frame extraction process failed.'), { code: 'FRAME_EXTRACTION_FAILED' }));
        else resolve();
      });
    });
    const resultPath = join(directory, 'result.json');
    if ((await stat(resultPath)).size > MAX_RESPONSE_BYTES) throw new Error('Frame response exceeded the size limit.');
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    if (result.error) throw Object.assign(new Error(result.error.message), result.error);
    return result.value;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
