export const MAX_FRAMES = 6;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export function invalidInput(message) {
  return Object.assign(new Error(message), { code: 'INVALID_INPUT', retryable: false });
}

export function parseFrameRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['videoId', 'timestampsMs', 'maxWidth'].includes(key))) {
    throw invalidInput('Supply videoId, timestampsMs, and optionally maxWidth.');
  }
  const { videoId, timestampsMs, maxWidth = 1920 } = value;
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw invalidInput('videoId must be an 11-character YouTube video ID.');
  }
  if (!Array.isArray(timestampsMs) || !timestampsMs.length || timestampsMs.length > MAX_FRAMES
    || timestampsMs.some(time => !Number.isSafeInteger(time) || time < 0)) {
    throw invalidInput('Supply 1 to 6 nonnegative integer timestampsMs in milliseconds.');
  }
  if (!Number.isSafeInteger(maxWidth) || maxWidth < 320 || maxWidth > 1920) {
    throw invalidInput('maxWidth must be an integer from 320 to 1920.');
  }
  return { videoId, timestampsMs: [...new Set(timestampsMs)].sort((a, b) => a - b), maxWidth };
}
