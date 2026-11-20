import { readFile } from 'node:fs/promises';

const UPLOAD_URI = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const MAX_ATTEMPTS = 4;

export class UploadError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

export type Privacy = 'unlisted' | 'private';

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacy: Privacy;
  madeForKids: boolean;
}

/** The videos.insert body: snippet and status only. */
export function videoResource(metadata: VideoMetadata) {
  return {
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId,
    },
    status: {
      privacyStatus: metadata.privacy,
      selfDeclaredMadeForKids: metadata.madeForKids,
    },
  };
}

async function apiError(response: Response): Promise<UploadError> {
  const json = await response.json().catch(() => ({})) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
  const reason = json.error?.errors?.[0]?.reason ?? String(response.status);
  const message = json.error?.message ?? response.statusText;
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') {
    return new UploadError('RATE_LIMITED', `YouTube upload limit reached (${reason}): ${message}`);
  }
  if (response.status === 401) return new UploadError('AUTH_REQUIRED', `YouTube rejected the access token: ${message}`);
  return new UploadError('UPSTREAM_ERROR', `YouTube refused the upload (${reason}): ${message}`, response.status >= 500);
}

/**
 * Upload one file with YouTube's resumable protocol: start a session with the metadata, then PUT
 * the bytes. After a dropped connection or a 5xx, ask how much arrived and send the rest.
 */
export async function uploadVideo(
  fetchImpl: typeof fetch,
  accessToken: string,
  file: string,
  metadata: VideoMetadata,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ videoId: string }> {
  const bytes = await readFile(file);
  const auth = { authorization: `Bearer ${accessToken}` };
  const start = await fetchImpl(UPLOAD_URI, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(bytes.length),
    },
    body: JSON.stringify(videoResource(metadata)),
  });
  if (!start.ok) throw await apiError(start);
  const session = start.headers.get('location');
  if (!session) throw new UploadError('INVALID_RESPONSE', 'YouTube did not return an upload session.');

  let offset = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      const body = bytes.subarray(offset);
      response = await fetchImpl(session, {
        method: 'PUT',
        headers: {
          ...auth,
          'content-type': 'video/mp4',
          ...(offset > 0 ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
        },
        body,
      });
    } catch {
      response = undefined;
    }
    if (response && (response.status === 200 || response.status === 201)) {
      const json = await response.json() as { id?: string };
      if (!json.id) throw new UploadError('INVALID_RESPONSE', 'YouTube finished the upload without a video id.');
      return { videoId: json.id };
    }
    if (response && response.status < 500 && response.status !== 308) throw await apiError(response);
    if (attempt === MAX_ATTEMPTS) break;
    await wait(1_000 * 2 ** (attempt - 1));
    // Ask how much YouTube already has, then resume from there.
    const probe = await fetchImpl(session, { method: 'PUT', headers: { ...auth, 'content-range': `bytes */${bytes.length}` } }).catch(() => undefined);
    if (probe && (probe.status === 200 || probe.status === 201)) {
      const json = await probe.json() as { id?: string };
      if (json.id) return { videoId: json.id };
    }
    const range = probe?.status === 308 ? /bytes=0-(\d+)/.exec(probe.headers.get('range') ?? '') : null;
    offset = range ? Number(range[1]) + 1 : 0;
  }
  throw new UploadError('UPSTREAM_ERROR', `Upload of ${file} did not finish after ${MAX_ATTEMPTS} attempts.`, true);
}
