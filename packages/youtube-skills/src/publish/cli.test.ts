import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { runPublishCli } from './cli';

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });

function io() {
  const output: string[] = [];
  const errors: string[] = [];
  return { output, errors, stdout: (value: string) => output.push(value), stderr: (value: string) => errors.push(value) };
}

async function project(publish: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'publish-cli-'));
  directories.push(directory);
  await writeFile(join(directory, 'video.json'), JSON.stringify({ videoId: 'abcdefghijk' }));
  await writeFile(join(directory, 'edl.json'), JSON.stringify({ shorts: [{ id: 'S1', cuts: [{ startMs: 684_880 }] }] }));
  await writeFile(join(directory, 'publish.json'), JSON.stringify(publish));
  return directory;
}

const short = { id: 'S1', title: 'AI agents are like the Minions', description: 'Full: {episode}', hashtags: ['#Shorts'], tags: ['AI'] };

describe('publish upload', () => {
  test('refuses to upload until publish.json declares madeForKids', async () => {
    const directory = await project({ shorts: [short] });
    const capture = io();
    expect(await runPublishCli(['upload', '--project', directory, '--dry-run'], capture)).toBe(2);
    expect(capture.errors.join('')).toMatch(/madeForKids/);
  });

  test('allows only unlisted or private', async () => {
    const directory = await project({ madeForKids: false, shorts: [short] });
    const capture = io();
    expect(await runPublishCli(['upload', '--project', directory, '--privacy', 'public', '--dry-run'], capture)).toBe(2);
    expect(capture.errors.join('')).toMatch(/unlisted or private/);
  });
});

const describeFfmpeg = process.env.SHORTS_FFMPEG_TEST === '1' ? describe : describe.skip;

describeFfmpeg('publish upload with a real video file', () => {
  test('dry-runs, uploads unlisted with mocked Google endpoints, then skips it on rerun', async () => {
    const directory = await project({ madeForKids: false, shorts: [short] });
    await mkdir(join(directory, 'render'), { recursive: true });
    const made = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '2', '-c:a', 'aac', join(directory, 'render', 'S1-no-cards.mp4')]);
    expect(made.status).toBe(0);
    const secret = join(directory, 'client.json');
    await writeFile(secret, JSON.stringify({ installed: { client_id: 'id.apps.googleusercontent.com', client_secret: 'shh' } }));
    const environment = { HOME: directory, PATH: process.env.PATH, FFMPEG_PATH: process.env.FFMPEG_PATH };

    const dry = io();
    expect(await runPublishCli(['upload', '--project', directory, '--variant', 'no-cards', '--dry-run'], dry, environment)).toBe(0);
    expect(JSON.parse(dry.output.join(''))).toMatchObject({ dryRun: true, planned: [{ id: 'S1', privacy: 'unlisted' }] });

    const requests: string[] = [];
    let metadata: Record<string, unknown> | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`);
      if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }));
      if (url.includes('uploadType=resumable')) {
        metadata = JSON.parse(String(init.body));
        return new Response(null, { status: 200, headers: { location: 'https://upload.example/s' } });
      }
      return new Response(JSON.stringify({ id: 'vid123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const openUrl = (url: string) => {
      const consent = new URL(url);
      const redirect = new URL(consent.searchParams.get('redirect_uri')!);
      redirect.search = new URLSearchParams({ code: 'c', state: consent.searchParams.get('state')! }).toString();
      void fetch(redirect);
    };
    const first = io();
    expect(await runPublishCli(['upload', '--project', directory, '--client-secret', secret, '--variant', 'no-cards'], first, environment, { fetch: fetchImpl, openUrl })).toBe(0);
    expect(JSON.parse(first.output.join(''))).toMatchObject({ ok: true, uploaded: [{ id: 'S1', videoId: 'vid123', url: 'https://youtube.com/shorts/vid123', privacy: 'unlisted' }] });
    expect(metadata).toMatchObject({ snippet: { title: short.title, description: 'Full: https://youtu.be/abcdefghijk\n\n#Shorts', categoryId: '22' }, status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false } });
    expect(JSON.parse(await readFile(join(directory, 'publish', 'uploads.json'), 'utf8'))).toMatchObject({ S1: { videoId: 'vid123' } });

    const again = io();
    const before = requests.length;
    expect(await runPublishCli(['upload', '--project', directory, '--client-secret', secret, '--variant', 'no-cards'], again, environment, { fetch: fetchImpl, openUrl })).toBe(0);
    expect(JSON.parse(again.output.join(''))).toMatchObject({ uploaded: [], skipped: [{ id: 'S1' }] });
    expect(requests.slice(before).some((request) => request.includes('upload'))).toBe(false);
  }, 60_000);
});
