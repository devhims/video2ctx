import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { redact, diagnosticDetails, logDiagnostic } from './diagnostics.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RESPONSE_BYTES, parseFrameRequest } from './contract.mjs';

export async function runFrameJob(input, { signal, timeoutMs = 60_000,
  extractionId = randomUUID(), log = logDiagnostic, jobPath = fileURLToPath(new URL('./job.mjs', import.meta.url)), onWorkspace } = {}) {
  const request = parseFrameRequest(input);
  // Leave time after the cooperative cutoff for FFmpeg shutdown and packaging.
  timeoutMs = Math.min(timeoutMs, (request.extractionTimeoutMs ?? 45_000) + 3_000);
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'youtube-frames-'));
  try {
    onWorkspace?.(directory);
    await writeFile(join(directory, 'request.json'), JSON.stringify(request));
    await new Promise((resolve, reject) => {
      // A separate process group lets a deadline stop the job AND its FFmpeg children.
      const child = spawn(process.execPath, [jobPath, directory], {
        detached: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      let pending = '';
      let droppingLine = false;
      let count = 0;
      const decoder = new StringDecoder('utf8');
      const emitLine = line => {
        stderr = (stderr + redact(line) + '\n').slice(-16000);
        try {
          const event = JSON.parse(line);
          if (event.event !== 'frame_diagnostic') return;
          if (count++ < 100) {
            log({ event: 'youtube_frames_diagnostic', extractionId, videoId: request.videoId, ...diagnosticDetails(event) });
          } else if (count === 101) {
            log({ event: 'youtube_frames_diagnostics_truncated', extractionId, videoId: request.videoId, limit: 100 });
          }
        } catch { /* Unexpected output is retained only after redaction. */ }
      };
      const readStderr = text => {
        for (const [index, part] of text.split('\n').entries()) {
          if (index > 0) {
            emitLine(droppingLine ? '[oversized stderr line omitted]' : pending);
            pending = ''; droppingLine = false;
          }
          if (!droppingLine) {
            pending += part;
            // Drop the whole line: truncating before redaction can expose a URL's secret suffix.
            if (pending.length > 64000) { pending = ''; droppingLine = true; }
          }
        }
      };
      child.stderr.on('data', chunk => readStderr(decoder.write(chunk)));
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
      child.once('error', cause => { cleanup(); reject(Object.assign(new Error('Could not start frame extraction.'), { code: 'FRAME_EXTRACTION_FAILED', cause })); });
      child.once('close', (code, signal) => {
        readStderr(decoder.end());
        if (pending || droppingLine) emitLine(droppingLine ? '[oversized stderr line omitted]' : pending);
        cleanup();
        if (failure) reject(Object.assign(failure, { exitCode: code, signal, stderr: redact(stderr) }));
        else if (code !== 0) reject(Object.assign(new Error('Frame extraction process failed.'), { code: 'FRAME_EXTRACTION_FAILED', exitCode: code, signal, stderr: redact(stderr) }));
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
