import { AgentSessionProvider, Session, type SessionMessage } from 'agents/experimental/memory/session';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { EvidencePacket } from '../contracts';
import type { SessionEvidenceStore } from './session-evidence';
import { matchMarkers, type MatchMarkers } from './search-highlight';
import { withVisualProvenanceWarning } from './model-evidence';
import { createReadSavedEvidenceTool } from './saved-evidence-reader';

export interface HistoryEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ordinal: number;
  parentId: string | null;
  createdAt: number;
}

type SearchRow = { id: string; owner: string; content: string; metadata: string; marked?: string };
/** A matched row with the markers its highlight() used. */
type MatchedRow = SearchRow & { markers?: MatchMarkers };


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
    // Saved captions and comments are searched through the segment index read by read_saved_evidence.
    // Sessions created before that move still hold their old rows here; remove them once.
    if (sql.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_search_assets'`).toArray().length) {
      sql.exec('DROP TRIGGER IF EXISTS session_search_asset_delete');
      sql.exec(`DELETE FROM session_context_fts WHERE owner LIKE 'asset:%'`);
      sql.exec('DROP TABLE session_search_assets');
    }
    // Source-table triggers make deletion and memory corrections atomic with index maintenance.
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
    // Existing memory and packets are small SQLite records.
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
  private matches(scope: 'memory' | 'evidence', query: string, excludedOwners: readonly string[] = []): MatchedRow[] {
    // Literal tokens joined with AND support nonadjacent terms without exposing FTS operators.
    const tokens = queryTokens(query);
    if (!tokens.length) return [];
    // Exclusions apply before the limit, so excluded rows can never fill the top 20.
    const excluded = excludedOwners.length ? ` AND owner NOT IN (${excludedOwners.map(() => '?').join(',')})` : '';
    // A raw caption or comment packet copies entries of a saved original. Once that original has a
    // ready segment index, read_saved_evidence owns its text, so the copies are not search results.
    // Packets whose original is not indexed, such as unreadable legacy pages, stay searchable.
    // The bare packet_id comparison uses its primary key rather than scanning every packet per row.
    const duplicates = scope === 'evidence' ? ` AND NOT EXISTS (SELECT 1 FROM session_packets p
      WHERE owner LIKE 'packet:%' AND p.packet_id = substr(owner, 8)
      AND json_extract(p.packet_json,'$.kind') IN ('youtube_comments','youtube_transcript')
      AND NOT EXISTS (SELECT 1 FROM json_each(p.packet_json,'$.artifacts') a WHERE json_extract(a.value,'$.type')='youtube_transcript_analysis')
      AND EXISTS (SELECT 1 FROM json_each(p.versions_json) v WHERE v.value IN (SELECT version FROM session_original_assets WHERE status='ready')))` : '';
    const markers = matchMarkers();
    return this.sql
      .exec<SearchRow>(
        // highlight() reports where the tokenizer itself matched, so passages never re-derive matching.
        `SELECT id,owner,content,metadata,highlight(session_context_fts, 3, ?, ?) AS marked FROM session_context_fts
      WHERE session_context_fts MATCH ? AND scope=?${excluded}${duplicates} ORDER BY rank LIMIT 20`,
        markers.start,
        markers.end,
        tokens.map((t) => `"${t}"`).join(' AND '),
        scope,
        ...excludedOwners,
      )
      .toArray()
      .map((row) => ({ ...row, markers }));
  }
  searchMemory(query: string) {
    return this.matches('memory', query).flatMap((row) => {
      const record = this.sql
        .exec<{ memory_json: string }>('SELECT memory_json FROM session_memories WHERE id=?', row.id)
        .toArray()[0];
      return record ? [JSON.parse(record.memory_json)] : [];
    });
  }
  /** Saved analysis and other session findings. Exact captions and comments are read with read_saved_evidence. */
  async searchEvidence(store: SessionEvidenceStore, query: string) {
    const packets: EvidencePacket[] = [];
    const seen = new Set<string>();
    for (const row of this.matches('evidence', query)) {
      if (seen.has(row.id)) continue;
      for (const packet of store.evidenceForCitations([row.id])) {
        if (packet.assetVersions?.some((version) => !store.has(version))) continue;
        const excerpts = packet.excerpts.filter((excerpt) => excerpt.id === row.id);
        if (!excerpts.length) continue;
        // A single hit cannot show that its packet repeated one observation across frames, so warn first.
        packets.push({ ...withVisualProvenanceWarning(packet), packetId: `search:${row.id}`, excerpts, artifacts: [] });
        seen.add(row.id);
        break;
      }
    }
    return { packets: packets.filter((packet) => packet.assetVersions?.every((version) => store.has(version))) };
  }
  async tools(
    store: SessionEvidenceStore,
    onEvidence: (packets: EvidencePacket[], source?: 'search_context' | 'read_saved_evidence') => EvidencePacket[] | void,
    signal: AbortSignal,
    /** History-only routes search messages and memory, never saved source evidence. */
    options: { evidence?: boolean; runId?: string } = {},
  ): Promise<ToolSet> {
    const check = () => signal.throwIfAborted();
    const base = Session.create(this.history)
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
      });
    const session = options.evidence === false ? base : base
      .withContext('evidence', {
        provider: {
          get: async () =>
            'Search saved analysis across session assets: transcript and visual analysis, metadata and other findings. Queries match all words. Results contain version-specific citation IDs; older versions are labelled. For exact captions or comments, use read_saved_evidence; omit its assetVersion to search every saved original.',
          search: async (query) => {
            check();
            const found = await this.searchEvidence(store, query);
            check();
            // Only admitted hits reach the model; hits the run reserve cannot cover are withheld.
            const packets = onEvidence(found.packets, 'search_context') ?? found.packets;
            const withheld = found.packets.length - packets.length;
            return JSON.stringify({ packets, ...(withheld > 0 ? { withheld, note: 'Some matches were not loaded because the run credit reserve is exhausted.' } : {}) });
          },
        },
      });
    return {
      ...(await session.tools()),
      ...(options.evidence === false ? {} : { read_saved_evidence: createReadSavedEvidenceTool(store, onEvidence, signal, options.runId) }),
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

function queryTokens(query: string): string[] {
  return query.slice(0, 200).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
}
