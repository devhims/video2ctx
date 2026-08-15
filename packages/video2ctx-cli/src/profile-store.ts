import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialStore, StoredProfile } from './auth';

export class FileCredentialStore implements CredentialStore {
  readonly profilePath: string;

  constructor(readonly directory: string) {
    this.profilePath = join(directory, 'profile.json');
  }

  async read(): Promise<StoredProfile | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.profilePath, 'utf8'));
      if (!isStoredProfile(parsed)) throw new Error('The video2ctx CLI profile is invalid. Sign in again.');
      return parsed;
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async write(profile: StoredProfile): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
    const temporaryPath = join(this.directory, `.profile-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, this.profilePath);
    if (process.platform !== 'win32') await chmod(this.profilePath, 0o600);
  }

  async delete(): Promise<void> {
    try {
      await unlink(this.profilePath);
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) throw error;
    }
  }
}

function isStoredProfile(value: unknown): value is StoredProfile {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'version' in value
    && value.version === 1
    && 'baseUrl' in value
    && typeof value.baseUrl === 'string'
    && 'token' in value
    && typeof value.token === 'string'
    && value.token.length > 0
    && 'createdAt' in value
    && typeof value.createdAt === 'string';
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
