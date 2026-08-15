import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FileCredentialStore } from './profile-store';

describe('file credential store', () => {
  test('round-trips a private profile and removes only that profile on logout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video2ctx-profile-'));
    const store = new FileCredentialStore(directory);
    const profile = {
      version: 1 as const,
      baseUrl: 'https://api.video2ctx.dev',
      token: 'private-session-token',
      createdAt: '2026-08-15T00:00:00.000Z',
    };

    await store.write(profile);

    await expect(store.read()).resolves.toEqual(profile);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, 'profile.json'))).mode & 0o777).toBe(0o600);
    }

    await store.delete();
    await expect(store.read()).resolves.toBeNull();
  });
});
