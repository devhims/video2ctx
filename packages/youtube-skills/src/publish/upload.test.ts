import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { uploadVideo, videoResource } from './upload';

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });
const metadata = { title: 'T', description: 'D', tags: ['a'], categoryId: '22', privacy: 'unlisted' as const, madeForKids: false };

async function videoFile(size = 200): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'publish-upload-'));
  directories.push(directory);
  const path = join(directory, 'S1.mp4');
  await writeFile(path, Buffer.alloc(size, 1));
  return path;
}

type Step = (url: string, init: RequestInit) => Response | Error;

function scripted(steps: Step[]) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const result = steps.shift()!(url, init);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const started = () => new Response(null, { status: 200, headers: { location: 'https://upload.example/session' } });

describe('uploadVideo', () => {
  test('starts a resumable session with unlisted metadata, then sends the file', async () => {
    const file = await videoFile();
    const { seen, fetchImpl } = scripted([started, () => new Response(JSON.stringify({ id: 'vid123' }), { status: 200 })]);
    await expect(uploadVideo(fetchImpl, 'tok', file, metadata, async () => {})).resolves.toEqual({ videoId: 'vid123' });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(videoResource(metadata));
    expect(videoResource(metadata).status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: false });
    expect((seen[0]!.init.headers as Record<string, string>)['x-upload-content-length']).toBe('200');
    expect(seen[1]!.url).toBe('https://upload.example/session');
  });

  test('resumes from the byte YouTube reports after a dropped connection', async () => {
    const file = await videoFile();
    const { seen, fetchImpl } = scripted([
      started,
      () => new Error('socket hang up'),
      () => new Response(null, { status: 308, headers: { range: 'bytes=0-99' } }),
      () => new Response(JSON.stringify({ id: 'vid456' }), { status: 201 }),
    ]);
    await expect(uploadVideo(fetchImpl, 'tok', file, metadata, async () => {})).resolves.toEqual({ videoId: 'vid456' });
    expect((seen[3]!.init.headers as Record<string, string>)['content-range']).toBe('bytes 100-199/200');
    expect((seen[3]!.init.body as Buffer).length).toBe(100);
  });

  test('reports YouTube quota limits clearly', async () => {
    const file = await videoFile();
    const { fetchImpl } = scripted([() => new Response(JSON.stringify({ error: { message: 'no', errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 })]);
    await expect(uploadVideo(fetchImpl, 'tok', file, metadata, async () => {})).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
