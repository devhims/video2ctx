import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

const MAX_SEARCH_TEXT_LENGTH = 32_000;
const MAX_TITLE_LENGTH = 80;
const MAX_PREVIEW_LENGTH = 240;
const MAX_SEARCH_TOKENS = 12;

const recordSessionInputSchema = z.object({
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  message: z.string().trim().min(1).max(10_000),
  updatedAt: z.number().int().nonnegative(),
});

const sessionCursorSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  conversationId: z.string().uuid(),
});

const listSessionsInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: sessionCursorSchema.optional(),
});

export type RecordSessionInput = z.infer<typeof recordSessionInputSchema>;
export type UserSessionCursor = z.infer<typeof sessionCursorSchema>;
export type ListUserSessionsInput = z.input<typeof listSessionsInputSchema>;

export interface UserSessionSummary {
  conversationId: string;
  title: string;
  latestMessagePreview: string;
  lastRunId: string;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserSessionPage {
  sessions: UserSessionSummary[];
  nextCursor: UserSessionCursor | null;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  conversation_id: string;
  title: string;
  search_text: string;
  latest_message_preview: string;
  last_run_id: string;
  run_count: number;
  created_at: number;
  updated_at: number;
}

interface SessionRunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  conversation_id: string;
}

export class UserAccountDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  recordSession(value: RecordSessionInput): UserSessionSummary {
    const input = recordSessionInputSchema.parse(value);
    const existingRun = this.ctx.storage.sql.exec<SessionRunRow>(
      'SELECT run_id, conversation_id FROM user_session_runs WHERE run_id = ? LIMIT 1',
      input.runId,
    ).toArray()[0];
    if (existingRun && existingRun.conversation_id !== input.conversationId) {
      throw new Error('A run cannot belong to more than one user session.');
    }

    const existing = this.readSession(input.conversationId);
    const title = existing?.title ?? titleFromMessage(input.message);
    const isNewRun = !existingRun;
    const advancesLatest = !existing || input.updatedAt >= existing.updated_at;
    const searchText = isNewRun
      ? appendSearchText(existing?.search_text ?? '', input.message)
      : existing?.search_text ?? input.message;
    const latestMessagePreview = advancesLatest
      ? previewFromMessage(input.message)
      : existing!.latest_message_preview;
    const lastRunId = advancesLatest ? input.runId : existing!.last_run_id;
    const createdAt = existing?.created_at ?? input.updatedAt;
    const updatedAt = advancesLatest ? input.updatedAt : existing!.updated_at;
    const runCount = (existing?.run_count ?? 0) + (isNewRun ? 1 : 0);

    if (isNewRun) {
      this.ctx.storage.sql.exec(
        'INSERT INTO user_session_runs (run_id, conversation_id, created_at) VALUES (?, ?, ?)',
        input.runId,
        input.conversationId,
        input.updatedAt,
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO user_sessions (
        conversation_id, title, search_text, latest_message_preview,
        last_run_id, run_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        title = excluded.title,
        search_text = excluded.search_text,
        latest_message_preview = excluded.latest_message_preview,
        last_run_id = excluded.last_run_id,
        run_count = excluded.run_count,
        updated_at = excluded.updated_at`,
      input.conversationId,
      title,
      searchText,
      latestMessagePreview,
      lastRunId,
      runCount,
      createdAt,
      updatedAt,
    );
    this.ctx.storage.sql.exec(
      'DELETE FROM user_sessions_fts WHERE conversation_id = ?',
      input.conversationId,
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO user_sessions_fts (conversation_id, title, search_text) VALUES (?, ?, ?)',
      input.conversationId,
      title,
      searchText,
    );

    return {
      conversationId: input.conversationId,
      title,
      latestMessagePreview,
      lastRunId,
      runCount,
      createdAt,
      updatedAt,
    };
  }

  listSessions(value: ListUserSessionsInput = {}): UserSessionPage {
    const input = listSessionsInputSchema.parse(value);
    const fetchLimit = input.limit + 1;
    const ftsQuery = input.query ? buildFtsQuery(input.query) : '';
    if (input.query && !ftsQuery) return { sessions: [], nextCursor: null };

    const rows = ftsQuery
      ? this.searchRows(ftsQuery, input.cursor, fetchLimit)
      : this.listRows(input.cursor, fetchLimit);
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const last = pageRows.at(-1);
    return {
      sessions: pageRows.map(toSessionSummary),
      nextCursor: hasMore && last
        ? { updatedAt: last.updated_at, conversationId: last.conversation_id }
        : null,
    };
  }

  getSession(conversationId: string): UserSessionSummary | null {
    const parsedConversationId = z.string().uuid().parse(conversationId);
    const row = this.readSession(parsedConversationId);
    return row ? toSessionSummary(row) : null;
  }

  private listRows(cursor: UserSessionCursor | undefined, limit: number): SessionRow[] {
    if (!cursor) {
      return this.ctx.storage.sql.exec<SessionRow>(
        `SELECT * FROM user_sessions
        ORDER BY updated_at DESC, conversation_id DESC
        LIMIT ?`,
        limit,
      ).toArray();
    }
    return this.ctx.storage.sql.exec<SessionRow>(
      `SELECT * FROM user_sessions
      WHERE updated_at < ? OR (updated_at = ? AND conversation_id < ?)
      ORDER BY updated_at DESC, conversation_id DESC
      LIMIT ?`,
      cursor.updatedAt,
      cursor.updatedAt,
      cursor.conversationId,
      limit,
    ).toArray();
  }

  private searchRows(query: string, cursor: UserSessionCursor | undefined, limit: number): SessionRow[] {
    if (!cursor) {
      return this.ctx.storage.sql.exec<SessionRow>(
        `SELECT sessions.*
        FROM user_sessions_fts
        JOIN user_sessions AS sessions USING (conversation_id)
        WHERE user_sessions_fts MATCH ?
        ORDER BY sessions.updated_at DESC, sessions.conversation_id DESC
        LIMIT ?`,
        query,
        limit,
      ).toArray();
    }
    return this.ctx.storage.sql.exec<SessionRow>(
      `SELECT sessions.*
      FROM user_sessions_fts
      JOIN user_sessions AS sessions USING (conversation_id)
      WHERE user_sessions_fts MATCH ?
        AND (sessions.updated_at < ? OR (sessions.updated_at = ? AND sessions.conversation_id < ?))
      ORDER BY sessions.updated_at DESC, sessions.conversation_id DESC
      LIMIT ?`,
      query,
      cursor.updatedAt,
      cursor.updatedAt,
      cursor.conversationId,
      limit,
    ).toArray();
  }

  private readSession(conversationId: string): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>(
      'SELECT * FROM user_sessions WHERE conversation_id = ? LIMIT 1',
      conversationId,
    ).toArray()[0];
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        search_text TEXT NOT NULL,
        latest_message_preview TEXT NOT NULL,
        last_run_id TEXT NOT NULL,
        run_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS user_sessions_updated_idx
      ON user_sessions (updated_at DESC, conversation_id DESC)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_session_runs (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS user_session_runs_conversation_idx
      ON user_session_runs (conversation_id, created_at)
    `);
    this.ctx.storage.sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS user_sessions_fts
      USING fts5(conversation_id UNINDEXED, title, search_text, tokenize = 'unicode61')
    `);
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (1, ?)',
      Date.now(),
    );
  }
}

export function titleFromMessage(message: string): string {
  const normalized = normalizeText(message);
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TITLE_LENGTH - 3)}...`;
}

export function previewFromMessage(message: string): string {
  const normalized = normalizeText(message);
  if (normalized.length <= MAX_PREVIEW_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}

export function buildFtsQuery(query: string): string {
  const tokens = normalizeText(query)
    .match(/[\p{L}\p{N}_]+/gu)
    ?.slice(0, MAX_SEARCH_TOKENS) ?? [];
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
}

export function encodeSessionCursor(cursor: UserSessionCursor): string {
  const parsed = sessionCursorSchema.parse(cursor);
  return base64UrlEncode(JSON.stringify(parsed));
}

export function decodeSessionCursor(value: string): UserSessionCursor {
  const json = base64UrlDecode(value);
  return sessionCursorSchema.parse(JSON.parse(json));
}

function appendSearchText(existing: string, message: string): string {
  return [existing, normalizeText(message)]
    .filter(Boolean)
    .join('\n')
    .slice(-MAX_SEARCH_TEXT_LENGTH);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toSessionSummary(row: SessionRow): UserSessionSummary {
  return {
    conversationId: row.conversation_id,
    title: row.title,
    latestMessagePreview: row.latest_message_preview,
    lastRunId: row.last_run_id,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
