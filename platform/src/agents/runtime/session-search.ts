import { AgentSessionProvider, Session, type SessionMessage } from 'agents/experimental/memory/session';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { EvidencePacket } from '../contracts';
import type { SessionEvidenceStore } from './session-evidence';

export interface HistoryEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ordinal: number;
  parentId: string | null;
  createdAt: number;
}

type SearchRow = { id: string; owner: string; content: string; metadata: string };

/** The only dependency on the experimental SDK. agents is pinned in package.json. */
export class SessionSearch {
  private readonly history: AgentSessionProvider;
  private readonly session: Session;
  constructor(private readonly sql: SqlStorage) {
    const provider = {
      sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
        return sql
          .exec(strings.join('?'), ...values.map((value) => (typeof value === 'boolean' ? Number(value) : value)))
          .toArray() as T[];
      },
    };
    this.history = new AgentSessionProvider(provider, 'conversation');
    this.session = new Session(this.history);
    sql.exec('CREATE TABLE IF NOT EXISTS session_history_runs (id TEXT PRIMARY KEY, revision TEXT NOT NULL)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS session_history_index (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, role TEXT NOT NULL)',
    );
    sql.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS session_context_fts USING fts5(id UNINDEXED, owner UNINDEXED, scope UNINDEXED, content, metadata UNINDEXED)',
    );
    sql.exec('CREATE TABLE IF NOT EXISTS session_search_assets (version TEXT PRIMARY KEY)');
    // Source-table triggers make deletion and memory corrections atomic with index maintenance.
    sql.exec(`CREATE TRIGGER IF NOT EXISTS session_search_asset_delete AFTER DELETE ON session_assets BEGIN
      DELETE FROM session_context_fts WHERE owner='asset:' || OLD.version;
      DELETE FROM session_search_assets WHERE version=OLD.version;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS session_search_packet_delete AFTER DELETE ON session_packets BEGIN
      DELETE FROM session_context_fts WHERE owner='packet:' || OLD.packet_id;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS session_search_memory_delete AFTER DELETE ON session_memories BEGIN
      DELETE FROM session_context_fts WHERE owner='memory:' || OLD.id;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS session_search_memory_insert AFTER INSERT ON session_memories BEGIN
      DELETE FROM session_context_fts WHERE owner='memory:' || NEW.id;
      INSERT INTO session_context_fts (id,owner,scope,content,metadata)
      VALUES (NEW.id,'memory:' || NEW.id,'memory',json_extract(NEW.memory_json,'$.topic') || ' ' || json_extract(NEW.memory_json,'$.text'),NEW.memory_json);
    END`);
    // Existing memory and packets are small SQLite records. Raw transcripts backfill lazily, one asset at a time.
    sql.exec(`INSERT INTO session_context_fts (id,owner,scope,content,metadata)
      SELECT id,'memory:' || id,'memory',json_extract(memory_json,'$.topic') || ' ' || json_extract(memory_json,'$.text'),memory_json
      FROM session_memories m WHERE NOT EXISTS (SELECT 1 FROM session_context_fts WHERE owner='memory:' || m.id)`);
    for (const row of sql.exec<{
      packet_id: string;
      packet_json: string;
    }>(`SELECT packet_id,packet_json FROM session_packets p
      WHERE packet_id NOT LIKE 'session:%' AND NOT EXISTS (SELECT 1 FROM session_context_fts WHERE owner='packet:' || p.packet_id)`)) {
      this.indexPacket(row.packet_id, JSON.parse(row.packet_json));
    }
  }

  markHistoryRun(id: string, revision: string) {
    this.sql.exec('INSERT OR REPLACE INTO session_history_runs VALUES (?, ?)', id, revision);
  }
  historyCount() {
    return this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM session_history_index').one().count;
  }
  upsertHistory(entry: HistoryEntry) {
    const message: SessionMessage = {
      id: entry.id,
      role: entry.role,
      parts: [{ type: 'text', text: entry.text }],
      createdAt: new Date(entry.createdAt),
    };
    const previous = this.history.getMessage(entry.id);
    if (!previous) this.history.appendMessage(message, entry.parentId);
    else if (previous.parts[0]?.text !== entry.text) this.history.updateMessage(message);
    this.sql.exec('INSERT OR REPLACE INTO session_history_index VALUES (?, ?, ?)', entry.id, entry.ordinal, entry.role);
  }
  removeHistory(ids: string[]) {
    this.history.deleteMessages(ids);
    for (const id of ids) this.sql.exec('DELETE FROM session_history_index WHERE id=?', id);
  }
  clearHistory() {
    this.history.clearMessages();
    this.sql.exec('DELETE FROM session_history_index');
    this.sql.exec('DELETE FROM session_history_runs');
  }
  readHistory(offset = 0, role?: 'user' | 'assistant') {
    const rows = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM session_history_index
      WHERE (? IS NULL OR role=?) ORDER BY ordinal,id LIMIT 21 OFFSET ?`,
        role ?? null,
        role ?? null,
        offset,
      )
      .toArray();
    const messages = rows.slice(0, 20).flatMap(({ id }) => {
      const message = this.history.getMessage(id);
      return message
        ? [
            {
              id,
              role: message.role,
              text: message.parts.map((part) => part.text ?? '').join('\n'),
              createdAt: message.createdAt,
            },
          ]
        : [];
    });
    return { messages, nextOffset: rows.length > 20 ? offset + 20 : undefined };
  }
  async searchHistory(query: string) {
    // Session.search uses its SDK-maintained FTS index. It searches a literal phrase.
    const results = await this.session.search(query.slice(0, 200), { limit: 20 });
    return results.flatMap((result) => {
      const current = this.history.getMessage(result.id);
      return current ? [{ ...result, content: current.parts.map((part) => part.text ?? '').join(' ') }] : [];
    });
  }
  indexPacket(id: string, packet: EvidencePacket) {
    if (id.startsWith('session:')) return;
    const owner = `packet:${id}`;
    this.sql.exec('DELETE FROM session_context_fts WHERE owner=?', owner);
    for (const excerpt of packet.excerpts) this.insert(excerpt.id, owner, 'evidence', excerpt.text, { packetId: id });
  }
  indexTranscript(version: string, excerpts: EvidencePacket['excerpts']) {
    const owner = `asset:${version}`;
    this.sql.exec('DELETE FROM session_context_fts WHERE owner=?', owner);
    excerpts.forEach((excerpt, index) =>
      this.insert(`evidence:${version}:${index}`, owner, 'evidence', excerpt.text, { version, offset: index }),
    );
    this.sql.exec('INSERT OR IGNORE INTO session_search_assets VALUES (?)', version);
  }
  private insert(id: string, owner: string, scope: string, content: string, metadata: unknown) {
    this.sql.exec(
      'INSERT INTO session_context_fts (id,owner,scope,content,metadata) VALUES (?, ?, ?, ?, ?)',
      id,
      owner,
      scope,
      content,
      JSON.stringify(metadata),
    );
  }
  private matches(scope: 'memory' | 'evidence', query: string): SearchRow[] {
    // Literal tokens joined with AND support nonadjacent terms without exposing FTS operators.
    const tokens = query
      .slice(0, 200)
      .match(/[\p{L}\p{N}_]+/gu)
      ?.slice(0, 20);
    if (!tokens?.length) return [];
    return this.sql
      .exec<SearchRow>(
        `SELECT id,owner,content,metadata FROM session_context_fts
      WHERE session_context_fts MATCH ? AND scope=? ORDER BY rank LIMIT 20`,
        tokens.map((t) => `"${t}"`).join(' AND '),
        scope,
      )
      .toArray();
  }
  searchMemory(query: string) {
    return this.matches('memory', query).flatMap((row) => {
      const record = this.sql
        .exec<{ memory_json: string }>('SELECT memory_json FROM session_memories WHERE id=?', row.id)
        .toArray()[0];
      return record ? [JSON.parse(record.memory_json)] : [];
    });
  }
  async searchEvidence(store: SessionEvidenceStore, query: string) {
    await store.ensureSearchIndexed();
    const packets: EvidencePacket[] = [];
    const seen = new Set<string>();
    for (const row of this.matches('evidence', query)) {
      if (seen.has(row.id)) continue;
      const metadata = JSON.parse(row.metadata) as { version?: string; offset?: number; packetId?: string };
      const found = metadata.version
        ? store.has(metadata.version)
          ? (await store.readEvidence(metadata.version, metadata.offset)).packets
          : []
        : store.evidenceForCitations([row.id]);
      for (const packet of found) {
        if (packet.assetVersions?.some((version) => !store.has(version))) continue;
        const excerpts = packet.excerpts.filter((excerpt) => excerpt.id === row.id);
        if (!excerpts.length) continue;
        packets.push({ ...packet, packetId: `search:${row.id}`, excerpts, artifacts: [] });
        seen.add(row.id);
        break;
      }
    }
    return { packets: packets.filter((packet) => packet.assetVersions?.every((version) => store.has(version))) };
  }
  async tools(
    store: SessionEvidenceStore,
    onEvidence: (packets: EvidencePacket[]) => void,
    signal: AbortSignal,
  ): Promise<ToolSet> {
    const check = () => signal.throwIfAborted();
    const session = Session.create(this.history)
      .withContext('history', {
        provider: {
          get: async () =>
            'Search all user messages and completed answers in this session, including older turns. Results may include other conversation branches. Use a short literal phrase.',
          search: async (query) => {
            check();
            const result = await this.searchHistory(query);
            check();
            return JSON.stringify(result);
          },
        },
      })
      .withContext('memory', {
        provider: {
          get: async () =>
            'Search saved findings, user context and open questions. Findings are pointers; read evidence to substantiate video claims.',
          search: async (query) => {
            check();
            return JSON.stringify(this.searchMemory(query));
          },
        },
      })
      .withContext('evidence', {
        provider: {
          get: async () =>
            'Search transcript passages and saved visual/comment analysis across session assets. Queries match all words. Results contain version-specific citation IDs; older versions are labelled.',
          search: async (query) => {
            check();
            const result = await this.searchEvidence(store, query);
            check();
            onEvidence(result.packets);
            return JSON.stringify(result);
          },
        },
      });
    return {
      ...(await session.tools()),
      read_session_history: tool({
        description:
          'Read all persisted session user messages or completed answers chronologically, including failed-run user messages and older turns. For listing messages, paginate until nextOffset is absent. Results may span conversation branches. Source-deleted answers are omitted.',
        inputSchema: z.object({
          offset: z.number().int().min(0).default(0),
          role: z.enum(['user', 'assistant']).optional(),
        }),
        execute: async ({ offset, role }) => {
          check();
          return this.readHistory(offset, role);
        },
      }),
    };
  }
}
