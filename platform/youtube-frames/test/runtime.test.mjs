import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFrameJob } from '../runtime.mjs';

async function fixture(source, work) {
  const directory = await mkdtemp(join(tmpdir(), 'frame-job-test-'));
  const jobPath = join(directory, 'job.mjs');
  await writeFile(jobPath, source);
  try { await work(jobPath); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('reads completed results and removes the temporary workspace', async () => {
  await fixture(`import {writeFile} from 'node:fs/promises';
    await writeFile(process.argv[2]+'/result.json', JSON.stringify({value:{frames:[]}}));`, async jobPath => {
    let workspace;
    const result = await runFrameJob({ videoId: 'abcdefghijk', timestampsMs: [0] }, {
      jobPath, onWorkspace: value => { workspace = value; },
    });
    assert.deepEqual(result, { frames: [] });
    await assert.rejects(stat(workspace), { code: 'ENOENT' });
  });
});

test('a deadline kills descendant processes and cleans up', async () => {
  await fixture(`import {spawn} from 'node:child_process'; import {writeFile} from 'node:fs/promises';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    await writeFile(process.argv[2]+'/pid',String(child.pid)); setInterval(()=>{},1000);`, async jobPath => {
    let workspace;
    let descendant;
    const result = runFrameJob({ videoId: 'abcdefghijk', timestampsMs: [0] }, {
      jobPath, timeoutMs: 1000, onWorkspace: value => { workspace = value; },
    });
    const rejected = assert.rejects(result, { code: 'FRAME_TIMEOUT' });
    for (let i = 0; i < 50; i++) {
      if (workspace) descendant = await readFile(join(workspace, 'pid'), 'utf8').catch(() => undefined);
      if (descendant) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(descendant);
    await rejected;
    await assert.rejects(stat(workspace), { code: 'ENOENT' });
    // Allow the operating system to reap the terminated descendant.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.throws(() => process.kill(Number(descendant), 0), { code: 'ESRCH' });
  });
});

test('cancellation stops a running job and releases its directory', async () => {
  await fixture('setInterval(()=>{},1000);', async jobPath => {
    const controller = new AbortController();
    let workspace;
    const result = runFrameJob({ videoId: 'abcdefghijk', timestampsMs: [0] }, {
      jobPath, signal: controller.signal, onWorkspace: value => { workspace = value; },
    });
    const rejected = assert.rejects(result, { code: 'FRAME_CANCELLED' });
    setTimeout(() => controller.abort(), 100);
    await rejected;
    await assert.rejects(stat(workspace), { code: 'ENOENT' });
  });
});
