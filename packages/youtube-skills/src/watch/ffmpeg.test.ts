import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { resolveFfmpegExecutable } from './ffmpeg';

const directories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function executable(name = 'ffmpeg'): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-watch-ffmpeg-'));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
  return { directory, path };
}

describe('youtube-watch private FFmpeg executable resolution', () => {
  test('resolves a bare executable name from PATH without launching it', async () => {
    const fake = await executable();

    await expect(resolveFfmpegExecutable('ffmpeg', {
      PATH: [fake.directory, '/usr/bin'].join(delimiter),
    })).resolves.toBe(fake.path);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  test('accepts an explicit executable path', async () => {
    const fake = await executable('custom-ffmpeg');

    await expect(resolveFfmpegExecutable(fake.path, {})).resolves.toBe(fake.path);
  });

  test('classifies an executable absent from PATH as a missing dependency', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youtube-watch-empty-path-'));
    directories.push(directory);

    await expect(resolveFfmpegExecutable('ffmpeg', { PATH: directory })).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
      retryable: false,
    });
  });
});
