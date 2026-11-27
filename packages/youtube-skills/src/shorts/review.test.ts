import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';

import { runShortsCli } from './cli';
import {
  applyReviewAction,
  parseReview,
  resolveComments,
  updateReview,
  projectState,
  resolveProjectFile,
  scopeOf,
  startReviewServer,
  type ReviewServer,
} from './review';

const directories: string[] = [];
const servers: ReviewServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const edl = {
  videoId: 'abcdefghijk',
  shorts: [
    { id: 'S1', title: 'Minions', hook: 'AI agents are Minions.', cuts: [{ from: 'the minions', to: 'love Guru', startMs: 1_000, endMs: 2_400, text: 'The minions love Gru.' }] },
    { id: 'S1-b', hook: 'Your AI is a Minion.', cuts: [{ from: 'the minions', to: 'love Guru' }] },
    { id: 'S2', title: 'Cake', cuts: [{ from: 'they bake', to: 'cake', startMs: 5_000, endMs: 5_900 }] },
  ],
};

/** A project with an edl, a transcript, renders, and a secret file beside it to try to escape to. */
async function fixture(): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'shorts-review-'));
  directories.push(root);
  const project = join(root, 'project');
  await mkdir(join(project, 'render'), { recursive: true });
  await mkdir(join(project, 'shots'), { recursive: true });
  await mkdir(join(project, 'overlay', 'S1', 'snapshots'), { recursive: true });
  await writeFile(join(project, 'edl.json'), JSON.stringify(edl));
  await writeFile(join(project, 'video.json'), JSON.stringify({ videoId: 'abcdefghijk', title: 'A talk' }));
  await writeFile(join(project, 'transcript.md'), '# A talk\n\n## Transcript\n\n[00:01] the minions love Guru.\n\n[00:05] >> They bake cake.\n');
  for (const name of ['S1.mp4', 'S1-overlay.mp4', 'S1-captioned.mp4', 'S1-b.mp4', 'S1-b-overlay.mp4', 'S1-preview.jpg']) {
    await writeFile(join(project, 'render', name), `${name} bytes`);
  }
  await writeFile(join(project, 'render', 'S1.mp4'), '0123456789');
  await writeFile(join(project, 'shots', 'S1.jpg'), 'sheet');
  await writeFile(join(project, 'overlay', 'S1', 'snapshots', 'frame-01.png'), 'png');
  await writeFile(join(project, 'overlay', 'S1', 'index.html'), '<script>alert(1)</script>');
  await writeFile(join(root, 'secret.mp4'), 'secret');
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'clip.mp4'), 'outside');
  return { root, project };
}

async function serve(project: string, idleMs?: number): Promise<ReviewServer> {
  const server = await startReviewServer({ project, idleMs });
  servers.push(server);
  return server;
}

/** Sends a raw request so the path reaches the server unnormalized. */
function raw(url: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function post(server: ReviewServer, action: unknown): Promise<Response> {
  return fetch(new URL('/api/review', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
}

describe('resolveProjectFile', () => {
  test('serves regular files of known types inside the project', async () => {
    const { project } = await fixture();
    expect(await resolveProjectFile(project, 'render/S1.mp4')).toMatch(/project\/render\/S1\.mp4$/);
    expect(await resolveProjectFile(project, 'render/S1%2Doverlay.mp4')).toMatch(/S1-overlay\.mp4$/);
    expect(await resolveProjectFile(project, 'overlay/S1/snapshots/frame-01.png')).toBeDefined();
  });

  test.each([
    ['parent segments', '../secret.mp4'],
    ['encoded parent segments', '%2e%2e/secret.mp4'],
    ['encoded slashes', '..%2fsecret.mp4'],
    ['nested parent segments', 'render/../../secret.mp4'],
    ['absolute paths', '/etc/hosts'],
    ['backslashes', 'render\\..\\..\\secret.mp4'],
    ['null bytes', 'render/S1.mp4%00.png'],
    ['malformed escapes', 'render/%E0%A4%A.mp4'],
    ['dotfiles', '.git/config'],
    ['unserved types', 'overlay/S1/index.html'],
    ['directories', 'render'],
    ['missing files', 'render/nope.mp4'],
  ])('rejects %s', async (_name, path) => {
    const { project } = await fixture();
    expect(await resolveProjectFile(project, path)).toBeUndefined();
  });

  test('rejects symlinks that lead out of the project, and follows ones that stay in', async () => {
    const { root, project } = await fixture();
    await symlink(join(root, 'secret.mp4'), join(project, 'render', 'leak.mp4'));
    await symlink(join(root, 'outside'), join(project, 'render', 'linked'));
    await symlink(join(project, 'render', 'S1.mp4'), join(project, 'render', 'alias.mp4'));
    await symlink(join(project, 'overlay', 'S1', 'index.html'), join(project, 'render', 'page.mp4'));
    expect(await resolveProjectFile(project, 'render/leak.mp4')).toBeUndefined();
    expect(await resolveProjectFile(project, 'render/linked/clip.mp4')).toBeUndefined();
    expect(await resolveProjectFile(project, 'render/page.mp4')).toBeUndefined();
    expect(await resolveProjectFile(project, 'render/alias.mp4')).toMatch(/render\/S1\.mp4$/);
  });
});

describe('review server', () => {
  test('binds to loopback and serves the page, files with ranges, and nothing outside the project', async () => {
    const { project } = await fixture();
    const server = await serve(project);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('Shorts review');

    const whole = await fetch(new URL('/files/render/S1.mp4', server.url));
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(await whole.text()).toBe('0123456789');

    const part = await fetch(new URL('/files/render/S1.mp4', server.url), { headers: { Range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await part.text()).toBe('2345');
    const tail = await fetch(new URL('/files/render/S1.mp4', server.url), { headers: { Range: 'bytes=-3' } });
    expect(await tail.text()).toBe('789');
    const beyond = await fetch(new URL('/files/render/S1.mp4', server.url), { headers: { Range: 'bytes=20-' } });
    expect(beyond.status).toBe(416);

    for (const path of ['/files/../secret.mp4', '/files/%2e%2e/secret.mp4', '/files/render/..%2f..%2fsecret.mp4', '/files/overlay/S1/index.html', '/edl.json']) {
      const response = await raw(server.url, path);
      expect(response.status, path).toBe(404);
      expect(response.body).not.toContain('secret');
    }
  });

  test('refuses requests for other hosts and cross-site writes', async () => {
    const { project } = await fixture();
    const server = await serve(project);
    expect((await raw(server.url, '/', { headers: { Host: 'evil.example:80' } })).status).toBe(403);
    const body = JSON.stringify({ type: 'select', short: 'S1', selected: true });
    expect((await raw(server.url, '/api/review', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })).status).toBe(403);
    expect((await raw(server.url, '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body })).status).toBe(403);
    await expect(readFile(join(project, 'review.json'), 'utf8')).rejects.toThrow();
  });

  test('writes every decision to review.json and keeps what the agent added', async () => {
    const { project } = await fixture();
    await writeFile(join(project, 'review.json'), JSON.stringify({
      version: 1,
      shorts: { S2: { status: 'changes', comments: [{ id: 'old', atSec: 1, text: 'Tighter start', createdAt: '2026-11-01T00:00:00.000Z', resolved: true }], agentNote: 'kept' } },
    }));
    const server = await serve(project);

    const responses = await Promise.all([
      post(server, { type: 'select', short: 'S1', selected: true }),
      post(server, { type: 'select', short: 'S2', selected: false }),
      post(server, { type: 'variant', short: 'S1', choice: 'S1-b' }),
      post(server, { type: 'status', short: 'S1-b', status: 'approved' }),
      post(server, { type: 'comment', short: 'S1', atSec: 3.26, text: '  Hook covers the face  ', file: 'render/S1-overlay.mp4', revision: 1 }),
      post(server, { type: 'comment', short: 'S1', atSec: 0.5, text: 'Start on the laugh' }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);

    const review = JSON.parse(await readFile(join(project, 'review.json'), 'utf8'));
    expect(review.version).toBe(1);
    expect(review.updatedAt).toEqual(expect.any(String));
    expect(review.shorts.S1).toMatchObject({ selected: true, variant: 'S1-b' });
    expect(review.shorts.S1.comments.map((comment: { atSec: number; text: string; file?: string }) => [comment.atSec, comment.text, comment.file]))
      .toEqual([[0.5, 'Start on the laugh', undefined], [3.3, 'Hook covers the face', 'render/S1-overlay.mp4']]);
    expect(review.shorts['S1-b'].status).toBe('approved');
    expect(review.shorts.S2).toMatchObject({ selected: false, status: 'changes', agentNote: 'kept' });
    expect(review.shorts.S2.comments[0]).toMatchObject({ id: 'old', resolved: true });

    const removed = await post(server, { type: 'uncomment', short: 'S1', id: review.shorts.S1.comments[0].id });
    const state = await removed.json();
    expect(state.review.shorts.S1.comments).toHaveLength(1);
  });

  test('rejects invalid actions without touching review.json', async () => {
    const { project } = await fixture();
    const server = await serve(project);
    await post(server, { type: 'select', short: 'S1', selected: true });
    const before = await readFile(join(project, 'review.json'), 'utf8');
    for (const action of [
      { type: 'select', short: 'S9', selected: true },
      { type: 'status', short: 'S1', status: 'great' },
      { type: 'variant', short: 'S2', choice: 'S2' },
      { type: 'variant', short: 'S1', choice: 'S2' },
      { type: 'comment', short: 'S1', atSec: -1, text: 'x' },
      { type: 'comment', short: 'S1', atSec: 1, text: '   ' },
      { type: 'comment', short: 'S1', atSec: 1, text: 'x', file: '../secret.mp4', revision: 1 },
      { type: 'comment', short: 'S1', atSec: 1, text: 'x', file: 'render/S1.mp4' },
      { type: 'comment', short: 'S1', atSec: 1, text: 'x', revision: 1 },
      { type: 'status', short: 'S1', status: 'approved', file: 'render/S1.mp4', revision: -1 },
      { type: 'resolve', short: 'S1', id: 'nope' },
      { type: 'uncomment', short: 'S1', id: 'nope' },
      { type: 'delete-everything', short: 'S1' },
    ]) {
      const response = await post(server, action);
      expect(response.status, JSON.stringify(action)).toBe(400);
    }
    const malformed = await fetch(new URL('/api/review', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(await readFile(join(project, 'review.json'), 'utf8')).toBe(before);
  });

  test('refuses to overwrite a review.json it cannot parse', async () => {
    const { project } = await fixture();
    await writeFile(join(project, 'review.json'), '{"shorts": {');
    const server = await serve(project);
    const response = await post(server, { type: 'select', short: 'S1', selected: true });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('not valid JSON');
    expect(await readFile(join(project, 'review.json'), 'utf8')).toBe('{"shorts": {');
  });

  test('stops after the idle timeout', async () => {
    const { project } = await fixture();
    const server = await serve(project, 50);
    await expect(server.closed).resolves.toBe('idle');
    await expect(fetch(server.url)).rejects.toThrow();
  });

  test('reports an unchanged project as 204 so the page can poll cheaply', async () => {
    const { project } = await fixture();
    const server = await serve(project);
    const first = await (await fetch(new URL('/api/state', server.url))).json();
    expect((await fetch(new URL(`/api/state?since=${first.version}`, server.url))).status).toBe(204);
    await writeFile(join(project, 'render', 'S2.mp4'), 'new');
    expect((await fetch(new URL(`/api/state?since=${first.version}`, server.url))).status).toBe(200);
  });
});

describe('projectState', () => {
  test('groups hook variants, assigns renders to the right short, and finds excerpts', async () => {
    const { project } = await fixture();
    const state = await projectState(project);
    expect(state.title).toBe('A talk');
    const [s1, s1b, s2] = state.shorts;
    expect(s1).toMatchObject({ id: 'S1', rank: 1, variants: ['S1-b'] });
    expect(s1!.videos.map((video) => video.label)).toEqual(['overlay', 'captioned', 'cut']);
    expect(s1!.sheet).toMatch(/^\/files\/shots\/S1\.jpg\?v=\d+$/);
    expect(s1!.preview).toMatch(/^\/files\/render\/S1-preview\.jpg/);
    expect(s1!.snapshots).toHaveLength(1);
    expect(s1!.cuts[0]).toEqual({ atMs: 1_000, durationMs: 1_400, excerpt: 'The minions love Gru.' });
    expect(s1b).toMatchObject({ id: 'S1-b', rank: 1, variantOf: 'S1', variants: [] });
    expect(s1b!.videos.map((video) => video.path)).toEqual(['render/S1-b-overlay.mp4', 'render/S1-b.mp4']);
    expect(s1b!.cuts[0]!.excerpt).toBe('“the minions” … “love Guru”');
    expect(s2).toMatchObject({ id: 'S2', rank: 2, videos: [] });
    expect(s2!.cuts[0]!.excerpt).toBe('>> They bake cake.');
    expect(scopeOf(state).variants.get('S1')).toEqual(['S1-b']);
  });

  test('reports a missing or broken edl instead of failing', async () => {
    const { project } = await fixture();
    await rm(join(project, 'edl.json'));
    expect((await projectState(project)).edlError).toBe('No edl.json yet.');
    await writeFile(join(project, 'edl.json'), '{');
    expect((await projectState(project)).edlError).toBe('edl.json is not valid JSON.');
  });
});

describe('render revisions', () => {
  test('a status and notes given on a render stop applying when a new render replaces it at the same path', async () => {
    const { project } = await fixture();
    const server = await serve(project);
    const stateNow = async () => (await fetch(new URL('/api/state', server.url))).json();
    const overlay = (await stateNow()).shorts[0].videos.find((video: { label: string }) => video.label === 'overlay');
    const reviewed = { file: overlay.path, revision: overlay.revision };

    await post(server, { type: 'status', short: 'S1', status: 'approved', ...reviewed });
    await post(server, { type: 'comment', short: 'S1', atSec: 1, text: 'Nice framing', ...reviewed });
    let s1 = (await stateNow()).review.shorts.S1;
    expect(s1).toMatchObject({ status: 'approved', current: 'approved', statusStale: false, reviewed });
    expect(s1.comments[0]).toMatchObject({ stale: false, ...reviewed });

    await writeFile(join(project, 'render', 'S1-overlay.mp4'), 'a different render');
    const later = new Date(Date.now() + 5_000);
    await utimes(join(project, 'render', 'S1-overlay.mp4'), later, later);
    // A note started on the old render and sent after the swap keeps the revision it was started on.
    await post(server, { type: 'comment', short: 'S1', atSec: 2, text: 'Started before the swap', ...reviewed });

    s1 = (await stateNow()).review.shorts.S1;
    expect(s1).toMatchObject({ status: 'approved', current: 'pending', statusStale: true });
    expect(s1.comments.map((comment: { text: string; stale: boolean }) => [comment.text, comment.stale]))
      .toEqual([['Nice framing', true], ['Started before the swap', true]]);

    const output: string[] = [];
    expect(await runShortsCli(['decisions', '--project', project], { stdout: (value) => output.push(value), stderr: () => undefined })).toBe(0);
    expect(JSON.parse(output[0]!).shorts.S1).toMatchObject({ current: 'pending', statusStale: true, comments: [{ stale: true }, { stale: true }] });

    const fresh = (await stateNow()).shorts[0].videos.find((video: { label: string }) => video.label === 'overlay');
    await post(server, { type: 'status', short: 'S1', status: 'approved', file: fresh.path, revision: fresh.revision });
    expect((await stateNow()).review.shorts.S1).toMatchObject({ current: 'approved', statusStale: false });
  });

  test('a removed render makes what was said about it stale too', async () => {
    const { project } = await fixture();
    await updateReview(project, [{ type: 'status', short: 'S2', status: 'rejected', file: 'render/S2.mp4', revision: 5 }]);
    expect((await projectState(project)).review.shorts.S2).toMatchObject({ current: 'pending', statusStale: true });
  });
});

describe('one writer for review.json', () => {
  test('page saves and the agent resolving comments never overwrite each other', async () => {
    const { project } = await fixture();
    const server = await serve(project);
    await post(server, { type: 'comment', short: 'S2', atSec: 1, text: 'Tighter start' });
    const id = (await projectState(project)).review.shorts.S2!.comments[0]!.id;

    // Separate writers that share no in-process queue, as the server and the agent's CLI run in different processes.
    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) => post(server, { type: 'comment', short: 'S1', atSec: index, text: `note ${index}` })),
      ...Array.from({ length: 4 }, (_, index) => updateReview(project, [{ type: 'comment', short: 'S1-b', atSec: index, text: `direct ${index}` }])),
      resolveComments(project, [id]),
      runShortsCli(['decisions', '--project', project, '--resolve', id], { stdout: () => undefined, stderr: () => undefined }),
    ]);

    const review = JSON.parse(await readFile(join(project, 'review.json'), 'utf8'));
    expect(review.shorts.S1.comments).toHaveLength(8);
    expect(review.shorts['S1-b'].comments).toHaveLength(4);
    expect(review.shorts.S2.comments[0]).toMatchObject({ id, resolved: true });
    await expect(readFile(join(project, 'review.json.lock'))).rejects.toThrow();
  });

  test('waits for a held lock and takes over one left by a writer that died', async () => {
    const { project } = await fixture();
    const lock = join(project, 'review.json.lock');
    await writeFile(lock, '1');
    const waiting = updateReview(project, [{ type: 'select', short: 'S1', selected: true }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(readFile(join(project, 'review.json'))).rejects.toThrow();
    await rm(lock);
    await waiting;
    expect((await projectState(project)).review.shorts.S1!.selected).toBe(true);

    await writeFile(lock, '1');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await updateReview(project, [{ type: 'select', short: 'S2', selected: true }]);
    expect((await projectState(project)).review.shorts.S2!.selected).toBe(true);
  });

  test('decisions --resolve marks comments and reports unknown ids', async () => {
    const { project } = await fixture();
    await updateReview(project, [{ type: 'comment', short: 'S1', atSec: 1, text: 'Lower the title' }]);
    const id = (await projectState(project)).review.shorts.S1!.comments[0]!.id;
    const output: string[] = [];
    const errors: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: (value: string) => errors.push(value) };
    expect(await runShortsCli(['decisions', '--project', project, '--resolve', id], io)).toBe(0);
    const printed = JSON.parse(output[0]!);
    expect(printed).toMatchObject({ review: join(project, 'review.json'), resolved: [id] });
    expect(printed.shorts.S1.comments[0]).toMatchObject({ id, resolved: true, stale: false });
    expect(await runShortsCli(['decisions', '--project', project, '--resolve', 'nope'], io)).toBe(2);
    expect(errors.join('')).toContain('No comment nope');
  });
});

describe('applyReviewAction', () => {
  test('returns a new review and leaves the input alone', () => {
    const review = parseReview({ shorts: { S1: { comments: [] } } });
    const scope = { shorts: new Set(['S1']), variants: new Map<string, string[]>() };
    const next = applyReviewAction(review, { type: 'status', short: 'S1', status: 'rejected' }, scope, new Date('2026-11-27T00:00:00Z'));
    expect(next.shorts.S1!.status).toBe('rejected');
    expect(next.updatedAt).toBe('2026-11-27T00:00:00.000Z');
    expect(review.shorts.S1!.status).toBeUndefined();
  });

  test('parses an unreadable review as empty', () => {
    expect(parseReview('nope')).toEqual({ version: 1, updatedAt: undefined, shorts: {} });
    expect(parseReview({ shorts: { S1: { comments: [{ text: 'no id' }] } } }).shorts.S1!.comments).toEqual([]);
  });
});

describe('review command', () => {
  test('prints the URL as JSON and runs until stopped', async () => {
    const { project } = await fixture();
    const output: string[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    const done = runShortsCli(['review', '--project', project], { stdout: (value) => output.push(value), stderr: (value) => errors.push(value) }, {}, { reviewSignal: controller.signal });
    for (let attempt = 0; attempt < 100 && !output.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const printed = JSON.parse(output[0]!);
    expect(printed).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/), review: join(project, 'review.json'), idleMinutes: 30 });
    expect((await fetch(printed.url)).status).toBe(200);
    controller.abort();
    await expect(done).resolves.toBe(0);
    expect(errors).toEqual([]);
  });

  test.each([
    [['review'], '--project is required'],
    [['review', '--project', '/definitely/not/here'], 'Project directory not found'],
    [['review', '--project', '.', '--port', 'x'], '--port must be'],
    [['review', '--project', '.', '--idle-minutes', '0'], '--idle-minutes must be'],
  ])('rejects %j', async (argv, message) => {
    const errors: string[] = [];
    expect(await runShortsCli(argv, { stdout: () => undefined, stderr: (value) => errors.push(value) })).toBe(2);
    expect(errors.join('')).toContain(message);
  });
});
