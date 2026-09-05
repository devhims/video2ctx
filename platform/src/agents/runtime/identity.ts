export async function agentInstanceName(userId: string, conversationId: string): Promise<string> {
  const digest = await sha256Bytes(`agent-runtime\0${userId}\0${conversationId}`);
  return `conversation:${hex(digest)}`;
}

export async function userAccountInstanceName(userId: string): Promise<string> {
  const digest = await sha256Bytes(`user-account\0${userId}`);
  return `user:${hex(digest)}`;
}

export async function deterministicConversationId(userId: string, idempotencyKey: string): Promise<string> {
  const bytes = (await sha256Bytes(`agent-runtime-admission\0${userId}\0${idempotencyKey}`)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
