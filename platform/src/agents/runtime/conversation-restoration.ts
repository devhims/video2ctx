import { z } from 'zod';

const conversationCursorSchema = z.object({
  beforeTurnOrdinal: z.number().int().positive(),
});

export const conversationReadInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: conversationCursorSchema.optional(),
});

export type AgentConversationCursor = z.infer<typeof conversationCursorSchema>;
export type AgentConversationReadInput = z.input<typeof conversationReadInputSchema>;

export interface AgentConversationMessage {
  messageId: string;
  runId: string;
  conversationTurn: number;
  parentMessageId: string | null;
  role: 'user' | 'assistant';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationPage {
  messages: AgentConversationMessage[];
  nextCursor: AgentConversationCursor | null;
}

export function encodeConversationCursor(cursor: AgentConversationCursor): string {
  const parsed = conversationCursorSchema.parse(cursor);
  return base64UrlEncode(JSON.stringify(parsed));
}

export function decodeConversationCursor(value: string): AgentConversationCursor {
  const json = base64UrlDecode(value);
  return conversationCursorSchema.parse(JSON.parse(json));
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
