import { ApiError, base64Url } from './http';

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const bytes = decodeBase64(secret);
  if (bytes.byteLength !== 32) {
    throw new ApiError(500, 'INVALID_ENCRYPTION_KEY', 'OAuth encryption key must contain 32 bytes.');
  }
  return crypto.subtle.importKey('raw', new Uint8Array(bytes).buffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    new TextEncoder().encode(value)
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string, secret: string): Promise<string> {
  const [iv, payload] = value.split('.');
  if (!iv || !payload) throw new ApiError(500, 'INVALID_CIPHERTEXT', 'Stored token is invalid.');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(decodeBase64(iv)).buffer },
    await encryptionKey(secret),
    new Uint8Array(decodeBase64(payload)).buffer
  );
  return new TextDecoder().decode(decrypted);
}
