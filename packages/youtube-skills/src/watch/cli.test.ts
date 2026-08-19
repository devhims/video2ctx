import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { YouTubeClientError } from 'all-things-youtube';
import {
  runWatchCli,
  type WatchCliDependencies,
  type WatchCliIo,
} from './cli';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function capture(): WatchCliIo & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return { output, errors, stdout: (value) => output.push(value), stderr: (value) => errors.push(value) };
}

function fetchDependency(): Pick<WatchCliDependencies, 'createFetch'> & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {});
  return {
    close,
    createFetch: () => ({ fetch: vi.fn() as unknown as typeof fetch, close }),
  };
}

async function markedWorkspace(videoId = 'abcdefghijk'): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'youtube-ctx-'));
  directories.push(workspace);
  await writeFile(join(workspace, '.youtube-ctx-workspace.json'), JSON.stringify({
    schema: 'youtube-ctx-workspace', version: 1, videoId, createdAt: new Date().toISOString(),
  }));
  return workspace;
}

describe('youtube-ctx visual CLI', () => {
  test('creates a marked index workspace and persists only normalized index data', async () => {
    const io = capture();
    const workspace = await mkdtemp(join(tmpdir(), 'youtube-ctx-'));
    directories.push(workspace);
    const getWatchIndex = vi.fn(async () => ({
      videoId: 'abcdefghijk',
      strategy: 'storyboard-transcript',
      storyboard: { sheets: [{ path: join(workspace, 'sheet.jpg') }] },
      transcript: { text: 'Hello' },
      meta: { partial: false, warnings: [] },
    }));
    const fetchResource = fetchDependency();

    const code = await runWatchCli([
      'index', '--video-id', 'abcdefghijk', '--lang', 'en', '--granularity', 'word',
    ], io, {}, {
      ...fetchResource,
      getWatchIndex,
      createWorkspace: async () => workspace,
    });

    expect(code).toBe(0);
    expect(getWatchIndex).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'abcdefghijk', outputDir: workspace, lang: 'en', granularity: 'word',
    }));
    const result = JSON.parse(io.output[0]!);
    expect(result.workspace).toBe(workspace);
    const marker = JSON.parse(await readFile(join(workspace, '.youtube-ctx-workspace.json'), 'utf8'));
    expect(marker).toMatchObject({ schema: 'youtube-ctx-workspace', version: 1, videoId: 'abcdefghijk' });
    const persisted = await readFile(join(workspace, 'index.json'), 'utf8');
    expect(persisted).not.toContain('googlevideo');
    expect(fetchResource.close).toHaveBeenCalledOnce();
  });

  test('converts decimal seconds to milliseconds and returns partial frame results', async () => {
    const io = capture();
    const workspace = await markedWorkspace();
    const extractFrames = vi.fn(async () => ({
      videoId: 'abcdefghijk', frames: [{ timestampMs: 1_250, path: '/tmp/frame.jpg' }],
      failures: [{ timestampMs: 2_000, code: 'FRAME_EXTRACTION_FAILED' }],
      meta: { partial: true, warnings: ['One frame failed.'] },
    }));

    const code = await runWatchCli([
      'frames', '--workspace', workspace, '--timestamps', '1.25,2', '--max-width', '1280',
    ], io, {}, { ...fetchDependency(), extractFrames });

    expect(code).toBe(0);
    const canonicalWorkspace = await realpath(workspace);
    expect(extractFrames).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'abcdefghijk', timestampsMs: [1_250, 2_000], outputDir: canonicalWorkspace, maxWidth: 1280,
    }));
    expect(JSON.parse(io.output[0]!).meta.partial).toBe(true);
  });

  test('preserves structured missing-FFmpeg errors', async () => {
    const io = capture();
    const workspace = await markedWorkspace();
    const extractFrames = vi.fn(async () => {
      throw new YouTubeClientError('DEPENDENCY_MISSING', 'FFmpeg is required.');
    });

    const code = await runWatchCli([
      'frames', '--workspace', workspace, '--timestamps', '10',
    ], io, {}, { ...fetchDependency(), extractFrames });

    expect(code).toBe(1);
    expect(JSON.parse(io.errors[0]!)).toEqual({
      error: { code: 'DEPENDENCY_MISSING', message: 'FFmpeg is required.', retryable: false },
    });
  });

  test('cleans a marked temporary workspace and rejects unrelated directories', async () => {
    const workspace = await markedWorkspace();
    const cleanIo = capture();

    expect(await runWatchCli(['cleanup', '--workspace', workspace], cleanIo)).toBe(0);
    await expect(access(workspace)).rejects.toBeDefined();
    directories.splice(directories.indexOf(workspace), 1);

    const unrelated = await mkdtemp(join(tmpdir(), 'unrelated-'));
    directories.push(unrelated);
    const rejectIo = capture();
    expect(await runWatchCli(['cleanup', '--workspace', unrelated], rejectIo)).toBe(2);
    expect(JSON.parse(rejectIo.errors[0]!).error.code).toBe('INVALID_INPUT');
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  test('enforces the 30 timestamp budget before invoking extraction', async () => {
    const workspace = await markedWorkspace();
    const io = capture();
    const extractFrames = vi.fn();
    const timestamps = Array.from({ length: 31 }, (_, index) => String(index)).join(',');

    const code = await runWatchCli([
      'frames', '--workspace', workspace, '--timestamps', timestamps,
    ], io, {}, { ...fetchDependency(), extractFrames });

    expect(code).toBe(2);
    expect(extractFrames).not.toHaveBeenCalled();
  });

  test('prints youtube-ctx visual help without constructing a client', async () => {
    const io = capture();
    const createFetch = vi.fn();

    expect(await runWatchCli(['--help'], io, {}, { createFetch })).toBe(0);
    expect(io.output.join('')).toContain('youtube-ctx visual');
    expect(io.output.join('')).toContain('watch.mjs index');
    expect(createFetch).not.toHaveBeenCalled();
  });
});
