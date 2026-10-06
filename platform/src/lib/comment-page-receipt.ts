import { z } from 'zod';
import { ApiError } from './http';
import type { VideoAssetKey, VideoAssetReference } from './video-catalog';

export const commentPageReceiptSchema = z.string().regex(/^v1\.[a-f0-9]{64}\.[a-f0-9]{64}$/);
const encoder = new TextEncoder();

async function signingKey(env: Env) {
  if (!env.BETTER_AUTH_SECRET) throw new ApiError(503, 'SOURCE_STORAGE_UNAVAILABLE', 'Source retention is unavailable.');
  return crypto.subtle.importKey('raw', encoder.encode(env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function payload(userId: string, asset: VideoAssetReference) {
  return encoder.encode(JSON.stringify(['comment-page-v1', userId, asset.videoId, asset.kind, asset.variant, asset.contentHash]));
}

/** Sign the version returned with the provider response, never a later catalog lookup. */
export async function issueCommentPageReceipt(env: Env, userId: string, key: VideoAssetKey, versions?: VideoAssetReference[]): Promise<string> {
  const asset = versions?.find(asset => asset.videoId === key.videoId && asset.kind === key.kind && asset.variant === key.variant);
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.contentHash)) throw new ApiError(503, 'SOURCE_ASSET_NOT_SAVED', 'The comments response has no retained version.');
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), payload(userId, asset));
  const hex = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
  return `v1.${asset.contentHash}.${hex}`;
}

/** Account, video and continuation are bound to an immutable version. Receipts survive storage retries. */
export async function verifyCommentPageReceipt(env: Env, userId: string, key: VideoAssetKey, receipt: string): Promise<VideoAssetReference> {
  const parsed = commentPageReceiptSchema.safeParse(receipt);
  if (!parsed.success) throw new ApiError(422, 'INVALID_SOURCE_RECEIPT', 'A valid comments page receipt is required.');
  const [, contentHash, hex] = parsed.data.split('.');
  const asset = { ...key, contentHash: contentHash! };
  const signature = Uint8Array.from(hex!.match(/../g)!, byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify('HMAC', await signingKey(env), signature, payload(userId, asset))) {
    throw new ApiError(403, 'INVALID_SOURCE_RECEIPT', 'This comments page receipt does not belong to this request.');
  }
  return asset;
}
