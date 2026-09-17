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

test('delivers final source details to capture even after operator logs reach their limit', async () => {
  await fixture(`import {writeFile} from 'node:fs/promises';
    for(let i=0;i<105;i++) console.error(JSON.stringify({event:'frame_diagnostic',stage:'media_http',status:403}));
    console.error(JSON.stringify({event:'frame_diagnostic',stage:'ffmpeg_success',profile:'ios',formatId:18,width:640,height:360}));
    await writeFile(process.argv[2]+'/result.json', JSON.stringify({value:{frames:[]}}));`, async jobPath => {
    const events = [], logs = [];
    await runFrameJob({ videoId: 'abcdefghijk', timestampsMs: [0] }, {
      jobPath, onDiagnostic: event => events.push(event), log: event => logs.push(event),
    });
    assert.equal(events.length, 106);
    assert.equal(events.at(-1).stage, 'ffmpeg_success');
    assert.equal(events.at(-1).formatId, 18);
    assert.equal(logs.length, 101);
    assert.equal(logs.at(-1).droppedEvents, 6);
  });
});

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

test('retains subprocess exit and redacted stderr after deleting the workspace', async () => {
  await fixture(`process.stderr.write('decoder exploded https://media.test/file?sig=HIDDEN\\n'); process.exitCode=7;`, async jobPath => {
    await assert.rejects(runFrameJob({ videoId: 'abcdefghijk', timestampsMs: [0] }, { jobPath }), error => {
      assert.equal(error.exitCode, 7);
      assert.equal(error.signal, null);
      assert.match(error.stderr, /decoder exploded/);
      assert.ok(!error.stderr.includes('HIDDEN'));
      return true;
    });
  });
});

test('forwards structured diagnostics even when fallback succeeds', async () => {
  await fixture(`import {writeFile} from 'node:fs/promises';
    console.error(JSON.stringify({event:'frame_diagnostic',stage:'ffmpeg',profile:'ios',
      error:{code:'MEDIA_UNAVAILABLE',message:'range rejected',stderr:'HTTP 403 https://media.test/?sig=HIDDEN'}}));
    await writeFile(process.argv[2]+'/result.json',JSON.stringify({value:{frames:[]}}));`, async jobPath => {
    const logs = [];
    await runFrameJob({ videoId: 'abcdefghijk', timestampsMs: [0] }, { jobPath, extractionId: 'test-id', log: event => logs.push(event) });
    assert.equal(logs[0].extractionId, 'test-id');
    assert.equal(logs[0].stage, 'ffmpeg');
    assert.equal(logs[0].error.code, 'MEDIA_UNAVAILABLE');
    assert.match(logs[0].error.stderr, /HTTP 403/);
    assert.ok(!JSON.stringify(logs).includes('HIDDEN'));
  });
});

test('does not expose secret suffixes of oversized subprocess lines', async () => {
  await fixture(`process.stderr.write('https://media.test/?sig='+ 'x'.repeat(70000)+'HIDDEN'); process.exitCode=1;`, async jobPath => {
    await assert.rejects(runFrameJob({ videoId: 'abcdefghijk', timestampsMs: [0] }, { jobPath }), error => {
      assert.match(error.stderr, /oversized stderr line omitted/);
      assert.ok(!error.stderr.includes('HIDDEN'));
      return true;
    });
  });
});
