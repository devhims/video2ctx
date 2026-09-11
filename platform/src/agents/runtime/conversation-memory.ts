import type { ModelMessage } from 'ai';
import type { EvidencePacket } from '../contracts';
import { evidencePacketForModel } from './model-evidence';

export const MAX_CONVERSATION_MEMORY_TURNS = 8;
export const MAX_CONVERSATION_MEMORY_CHARACTERS = 64_000;

export interface ConversationTurn {
  userMessageId: string;
  assistantMessageId: string;
  user: string;
  assistant: string;
  resourceIds: string[];
  metadata?: EvidencePacket[];
}

export interface LinkedConversationTurn extends ConversationTurn {
  parentMessageId: string | null;
}

export type ConversationHistoryResolution =
  | { ok: true; history: ConversationTurn[] }
  | { ok: false; issue: 'cycle' | 'unavailable'; messageId: string };

export function resolveConversationHistory(
  parentMessageId: string | null,
  readTurn: (assistantMessageId: string) => LinkedConversationTurn | undefined,
): ConversationHistoryResolution {
  const newestFirst: ConversationTurn[] = [];
  const seen = new Set<string>();
  let cursor = parentMessageId;

  while (cursor && newestFirst.length < MAX_CONVERSATION_MEMORY_TURNS) {
    if (seen.has(cursor)) return { ok: false, issue: 'cycle', messageId: cursor };
    seen.add(cursor);
    const turn = readTurn(cursor);
    if (!turn) return { ok: false, issue: 'unavailable', messageId: cursor };
    newestFirst.push(turn);
    cursor = turn.parentMessageId;
  }

  return { ok: true, history: boundConversationHistory(newestFirst) };
}

/**
 * Selects the most recent complete turns that fit the model-memory budget.
 * Input is ordered from the direct parent toward older ancestors. Output is
 * chronological so it can be passed directly to a model.
 */
export function boundConversationHistory(
  newestFirst: readonly ConversationTurn[],
  options: { maxTurns?: number; maxCharacters?: number } = {},
): ConversationTurn[] {
  const maxTurns = options.maxTurns ?? MAX_CONVERSATION_MEMORY_TURNS;
  const maxCharacters = options.maxCharacters ?? MAX_CONVERSATION_MEMORY_CHARACTERS;
  const selected: ConversationTurn[] = [];
  let characters = 0;

  for (const turn of newestFirst) {
    if (selected.length >= maxTurns) break;
    const turnCharacters = turn.user.length + conversationAssistantMessage(turn).length;
    if (characters + turnCharacters > maxCharacters) break;
    selected.push(turn);
    characters += turnCharacters;
  }

  return selected.reverse();
}

export function conversationModelMessages(
  history: readonly ConversationTurn[],
  currentMessage: string,
  recoveredEvidence: readonly unknown[] = [],
): ModelMessage[] {
  const messages: ModelMessage[] = history.flatMap((turn): ModelMessage[] => [
    { role: 'user', content: turn.user },
    { role: 'assistant', content: conversationAssistantMessage(turn) },
  ]);
  const recovered = recoveredEvidence.length
    ? [
      '',
      'Available persisted evidence is included below. Historical metadata is labeled with its observation time.',
      'Reuse exact identifiers when relevant and do not repeat a provider operation unnecessarily.',
      JSON.stringify(recoveredEvidence),
    ].join('\n')
    : '';
  messages.push({ role: 'user', content: `${currentMessage}${recovered}` });
  return messages;
}

export function conversationAssistantMessage(turn: ConversationTurn): string {
  if (!turn.metadata?.length) return turn.assistant;
  return [turn.assistant, '', 'Recorded video metadata from this completed turn (historical observations, not current lookups):',
    JSON.stringify(turn.metadata.map(evidencePacketForModel))].join('\n');
}
