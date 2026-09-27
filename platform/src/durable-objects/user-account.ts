import { AgentAdmissionQueue } from '../agents/runtime/admission-queue';
import type { AgentRequest, AgentAdmission } from '../agents/contracts';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { RECENT_SOURCE_LIMIT, saveReferencedSourceSchema, sourceReferenceSchema, sourceIdentity, type RecentSource, type SaveReferencedSource, type SourceReference } from '../lib/source-history';

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
  readonly #admissions: AgentAdmissionQueue;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#admissions = new AgentAdmissionQueue(ctx, env, { assertActive: () => this.assertActive(),
      register: id => this.registerConversation(id), record: input => this.recordSession(input) });
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      this.#admissions.initialize();
    });
  }

  enqueueAgentRun(request: AgentRequest, admission: AgentAdmission) { return this.#admissions.enqueue(request, admission); }
  async pendingAgentRun(conversationId: string, runId?: string) {
    this.assertActive();
    return this.#admissions.pending(conversationId, runId);
  }
  async alarm(): Promise<void> { await this.#admissions.alarm(); }

  registerConversation(conversationId: string): void {
    this.assertActive();
    if (this.#admissions.pending(conversationId)) throw new Error('Conversation admission is pending.');
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO agent_conversations (conversation_id) VALUES (?)',
      z.string().uuid().parse(conversationId));
  }

  beginDeletion(): string[] {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO account_deletion (id) VALUES (1)');
    return this.ctx.storage.sql.exec<{ conversation_id: string }>(
      'SELECT conversation_id FROM agent_conversations UNION SELECT conversation_id FROM user_sessions',
    ).toArray().map(row => row.conversation_id);
  }

  finishDeletion(): void {
    this.#admissions.clear();
    this.ctx.storage.sql.exec('DELETE FROM user_sessions_fts');
    this.ctx.storage.sql.exec('DELETE FROM user_session_runs');
    this.ctx.storage.sql.exec('DELETE FROM user_sessions');
    this.ctx.storage.sql.exec('DELETE FROM agent_conversations');
    this.ctx.storage.sql.exec('DELETE FROM recent_sources');
    // Keep only a tombstone so already-authenticated requests cannot recreate data.
  }

  private assertActive(): void {
    if (this.ctx.storage.sql.exec('SELECT id FROM account_deletion LIMIT 1').toArray().length) {
      throw new Error('Account deletion is in progress.');
    }
  }

  saveSource(value: SaveReferencedSource): RecentSource {
    this.assertActive();
    const input = saveReferencedSourceSchema.parse(value);
    const snapshot = JSON.stringify(input.snapshot);
    const key = sourceIdentity(input);
    const existing = this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM recent_sources WHERE source_key = ?', key).toArray()[0];
    const entry: RecentSource = { id: existing?.id ?? crypto.randomUUID(), input: input.input,
      title: input.title,
      kind: input.snapshot.kind, updatedAt: this.nextSourceUpdate(),
      ...(input.snapshot.kind === 'inspection' && input.snapshot.inspector.thumbnailUrl ? { thumbnailUrl: input.snapshot.inspector.thumbnailUrl } : {}) };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT INTO recent_sources (id, source_key, input, title, kind, updated_at, snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_key) DO UPDATE SET
        input=excluded.input, title=excluded.title, kind=excluded.kind, updated_at=excluded.updated_at, snapshot=excluded.snapshot`,
        entry.id, key, entry.input, entry.title, entry.kind, entry.updatedAt, snapshot);
      this.ctx.storage.sql.exec(`DELETE FROM recent_sources WHERE id NOT IN
        (SELECT id FROM recent_sources ORDER BY updated_at DESC, rowid DESC LIMIT ?)`, RECENT_SOURCE_LIMIT);
    });
    return entry;
  }

  listSources(): RecentSource[] {
    this.assertActive();
    return this.ctx.storage.sql.exec<{ id: string; input: string; title: string; kind: RecentSource['kind']; updated_at: number; thumbnail_url: string | null }>(
      `SELECT id, input, title, kind, updated_at, json_extract(snapshot, '$.inspector.thumbnailUrl') AS thumbnail_url
       FROM recent_sources ORDER BY updated_at DESC, rowid DESC LIMIT ?`, RECENT_SOURCE_LIMIT,
    ).toArray().map(({ updated_at, thumbnail_url, ...row }) => ({ ...row, updatedAt: updated_at, ...(thumbnail_url ? { thumbnailUrl: thumbnail_url } : {}) }));
  }

  listSourceReferences() {
    return this.listSources().map(source => ({ source, snapshot: source.kind === 'inspection' && !source.thumbnailUrl
      ? sourceReferenceSchema.parse(JSON.parse(this.ctx.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM recent_sources WHERE id = ?', source.id).one().snapshot)) : null }));
  }

  cacheSourceThumbnail(id: string, url: string): void {
    this.assertActive();
    this.ctx.storage.sql.exec(`UPDATE recent_sources SET snapshot = json_set(snapshot, '$.inspector.thumbnailUrl', ?)
      WHERE id = ? AND kind = 'inspection' AND json_extract(snapshot, '$.inspector.thumbnailUrl') IS NULL`, z.string().url().parse(url), z.string().uuid().parse(id));
  }

  getSource(id: string): { source: RecentSource; snapshot: SourceReference } | null {
    this.assertActive();
    const row = this.ctx.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM recent_sources WHERE id = ?', z.string().uuid().parse(id)).toArray()[0];
    if (!row) return null;
    this.ctx.storage.sql.exec('UPDATE recent_sources SET updated_at = ? WHERE id = ?', this.nextSourceUpdate(), id);
    return { source: this.listSources().find(source => source.id === id)!, snapshot: sourceReferenceSchema.parse(JSON.parse(row.snapshot)) };
  }

  private nextSourceUpdate(): number {
    const latest = this.ctx.storage.sql.exec<{ latest: number | null }>('SELECT MAX(updated_at) AS latest FROM recent_sources').one().latest;
    return Math.max(Date.now(), (latest ?? 0) + 1);
  }

  recordSession(value: RecordSessionInput): UserSessionSummary {
    this.assertActive();
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

  /** Stable pagination for operator migrations, unaffected by session activity. */
  listSessionAssetMigrationTargets(after?: string) {
    if (after !== undefined) z.string().uuid().parse(after);
    const rows = this.ctx.storage.sql.exec<{ conversation_id: string }>(
      'SELECT conversation_id FROM user_sessions WHERE conversation_id>? ORDER BY conversation_id LIMIT 101',
      after ?? '',
    ).toArray();
    return {
      conversationIds: rows.slice(0, 100).map(row => row.conversation_id),
      nextCursor: rows.length > 100 ? rows[99]!.conversation_id : null,
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
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS recent_sources (
      id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, input TEXT NOT NULL, title TEXT NOT NULL,
      kind TEXT NOT NULL, updated_at INTEGER NOT NULL, snapshot TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS account_deletion (id INTEGER PRIMARY KEY)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS agent_conversations (conversation_id TEXT PRIMARY KEY)');
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
