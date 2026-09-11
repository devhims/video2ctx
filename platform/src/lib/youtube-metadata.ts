/** A request-level bot challenge is not evidence that the video is unavailable.
 * Keep legitimate login requirements (private or age-restricted videos) intact. */
export function isVideoMetadataBotChallenge(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('availability' in value)) return false;
  const availability = value.availability;
  if (!availability || typeof availability !== 'object') return false;
  return 'status' in availability && availability.status === 'LOGIN_REQUIRED'
    && 'reason' in availability && typeof availability.reason === 'string'
    && /confirm\b.*\bnot a bot\b/i.test(availability.reason);
}
