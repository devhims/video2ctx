export async function agentInstanceName(userId: string, conversationId: string): Promise<string> {
  const digest = await sha256Bytes(`agent-runtime\0${userId}\0${conversationId}`);
  return `conversation:${hex(digest)}`;
}

export async function userAccountInstanceName(userId: string): Promise<string> {
  const digest = await sha256Bytes(`user-account\0${userId}`);
  return `user:${hex(digest)}`;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
