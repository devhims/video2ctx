import { parseSegmentCitation, usableTranscriptSegment } from './transcript-segments';
import { AgentSessionProvider, Session, type SessionMessage } from 'agents/experimental/memory/session';
import { evidencePacketForModel } from './model-evidence';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { EvidencePacket } from '../contracts';
import type { SessionEvidenceStore, TranscriptReads } from './session-evidence';

const SEARCH_RESULT_LIMIT = 20;
/** Ranked candidate page size, not a limit on the whole search. */
const SEARCH_CANDIDATE_LIMIT = 200;

export interface HistoryEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ordinal: number;
  parentId: string | null;
  createdAt: number;
}

type SearchRow = { id: string; owner: string; content: string; metadata: string };
type MatchRow = Omit<SearchRow, 'content'>;

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
    sql.exec('CREATE TABLE IF NOT EXISTS session_search_format (version INTEGER PRIMARY KEY)');
    sql.exec('CREATE TABLE IF NOT EXISTS session_search_index_failures (version TEXT PRIMARY KEY, failed_at INTEGER NOT NULL)');
    sql.exec(`CREATE TRIGGER IF NOT EXISTS session_search_index_failure_delete AFTER DELETE ON session_assets BEGIN
      DELETE FROM session_search_index_failures WHERE version=OLD.version;
    END`);
    if (!sql.exec('SELECT 1 FROM session_search_format WHERE version=3').toArray().length) {
      // Format 2 already contains exact captions. Add search windows from SQLite,
      // without invalidating any index or reading transcript blobs on upgrade.
      const versions = sql.exec<{ owner: string }>(`SELECT DISTINCT owner FROM session_context_fts
        WHERE owner LIKE 'asset:%' AND id GLOB 'evidence:*:segment:*'`).toArray();
      for (const { owner } of versions) {
        const captions = sql.exec<SearchRow>('SELECT id,owner,content,metadata FROM session_context_fts WHERE owner=?', owner)
          .toArray().filter(row => parseSegmentCitation(row.id))
          .sort((a, b) => parseSegmentCitation(a.id)!.index - parseSegmentCitation(b.id)!.index);
        this.indexTranscript(owner.slice(6), captions.map(row => ({ id: row.id, text: row.content, sourceId: 'migration' })));
      }
      // Retain older chunks as a candidate index for query-relevant upgrades.
      sql.exec('INSERT INTO session_search_format VALUES (3)');
    }
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
      WHERE packet_id NOT LIKE 'session:%'
      AND EXISTS (SELECT 1 FROM json_each(p.packet_json,'$.excerpts') e
        WHERE json_extract(e.value,'$.text') IS NOT NULL AND json_extract(e.value,'$.id') NOT GLOB 'evidence:*:segment:*')
      AND NOT EXISTS (SELECT 1 FROM session_context_fts WHERE owner='packet:' || p.packet_id)`)) {
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
    for (const excerpt of packet.excerpts.filter(excerpt => !parseSegmentCitation(excerpt.id))) this.insert(excerpt.id, owner, 'evidence', excerpt.text, { packetId: id });
  }
  indexTranscript(version: string, excerpts: EvidencePacket['excerpts']) {
    const owner = `asset:${version}`;
    this.sql.exec('DELETE FROM session_context_fts WHERE owner=?', owner);
    const usable = excerpts.filter(excerpt => parseSegmentCitation(excerpt.id)?.version === version && usableTranscriptSegment(excerpt.text));
    for (const excerpt of usable) this.insert(excerpt.id, owner, 'evidence', excerpt.text, { version });
    // Search-only windows contain up to ten captions and overlap by half. Models still receive flat,
    // original segments; the window carries all IDs needed to resolve its evidence.
    for (let start = 0; start < usable.length;) {
      const window: typeof usable = [];
      let characters = 0;
      for (const excerpt of usable.slice(start, start + 10)) {
        if (window.length && (characters + excerpt.text.length > 2_000 ||
          parseSegmentCitation(excerpt.id)!.index !== parseSegmentCitation(window.at(-1)!.id)!.index + 1)) break;
        window.push(excerpt);
        characters += excerpt.text.length + 1;
      }
      if (window.length > 1) this.insert(window[0]!.id, owner, 'evidence', window.map(excerpt => excerpt.text).join(' '),
        { version, segmentIds: window.map(excerpt => excerpt.id) });
      start += Math.max(1, Math.floor(window.length / 2));
    }
    this.sql.exec('INSERT OR IGNORE INTO session_search_assets VALUES (?)', version);
    this.sql.exec('DELETE FROM session_search_index_failures WHERE version=?', version);
  }
  indexFailures(): Map<string, number> {
    return new Map(this.sql.exec<{ version: string; failed_at: number }>('SELECT version, failed_at FROM session_search_index_failures')
      .toArray().map(row => [row.version, row.failed_at]));
  }
  recordIndexFailure(version: string) {
    this.sql.exec('INSERT OR REPLACE INTO session_search_index_failures VALUES (?, ?)', version, Date.now());
  }
  legacyCandidates(query?: string): Set<string> {
    const tokens = query === undefined ? undefined : searchTokens(query);
    const match = tokens?.length ? ' AND session_context_fts MATCH ?' : '';
    return new Set(this.sql.exec<{ owner: string }>(`SELECT DISTINCT owner FROM session_context_fts
      WHERE owner LIKE 'asset:%' AND json_extract(metadata,'$.offset') IS NOT NULL${match}`,
      ...(tokens?.length ? [tokens.map(token => `"${token}"`).join(' OR ')] : []))
      .toArray().map(row => row.owner.slice(6)));
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
  private matches(scope: 'memory' | 'evidence', query: string, excludedOwners: readonly string[] = [], limit = SEARCH_RESULT_LIMIT, offset = 0): MatchRow[] {
    // Literal tokens joined with AND support nonadjacent terms without exposing FTS operators.
    const tokens = searchTokens(query);
    if (!tokens.length) return [];
    // Exclude owners and deduplicate stable IDs before the result limit.
    // Materialize FTS scores before windowing, since rank must run in the FTS query.
    const excluded = excludedOwners.length ? ` AND owner NOT IN (${excludedOwners.map(() => '?').join(',')})` : '';
    return this.sql
      .exec<MatchRow>(
        `WITH matches AS MATERIALIZED (
        SELECT id,owner,metadata,rank AS score FROM session_context_fts
        WHERE session_context_fts MATCH ? AND scope=?${excluded}
          AND json_extract(metadata,'$.offset') IS NULL
          ${tokens.length === 1 ? "AND json_extract(metadata,'$.segmentIds') IS NULL" : ''}
      ), unique_matches AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY score,owner) AS occurrence FROM matches
      )
      SELECT id,owner,metadata FROM unique_matches
      WHERE occurrence=1 ORDER BY score,id LIMIT ? OFFSET ?`,
        tokens.map((t) => `"${t}"`).join(' AND '),
        scope,
        ...excludedOwners,
        limit,
        offset,
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
  async searchEvidence(store: SessionEvidenceStore, query: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const reads: TranscriptReads = new Map();
    const indexing = await store.ensureSearchIndexed(query, reads);
    const packets: EvidencePacket[] = [];
    const seen = new Set<string>();
    // Long transcripts indexed before the length limit existed are left out of the query itself.
    // Their index rows stay, so raising the limit makes them searchable again without reindexing.
    const excluded = new Set(store.overLimitTranscriptVersions().map((version) => `asset:${version}`));
    const generation = store.generation();
    const tokens = searchTokens(query);
    const terms = [...foldedTokens(tokens.join(' '))];
    // Quoted FTS tokens containing separators carry phrase constraints. Keep
    // the whole candidate when independent-word trimming cannot preserve them.
    const canTrim = tokens.every(token => /^[a-z0-9]+$/i.test(token));
    // Share reads across index repair and every resolution batch, including failures.
    const resolvedIds = new Set<string>();
    const texts = new Map<string, string>();
    const found: EvidencePacket[] = [];
    const available = new Map<string, boolean>();
    const unreadable = new Set<string>();
    const isAvailable = (version: string) => {
      let value = available.get(version);
      if (value === undefined) available.set(version, value = store.has(version) && !excluded.has(`asset:${version}`));
      return value;
    };
    let results = 0;
    // Fetch successive pages until twenty distinct results or index exhaustion.
    // Removing unreadable owners restarts pagination against the smaller index;
    // cached reads and resolved IDs prevent repeating source reads on restart.
    let offset = 0;
    while (results < SEARCH_RESULT_LIMIT) {
      signal?.throwIfAborted();
      const rows = this.matches('evidence', query, [...excluded], SEARCH_CANDIDATE_LIMIT, offset);
      if (!rows.length) break;
      let unreadableFound = false;
      for (let start = 0; start < rows.length && results < SEARCH_RESULT_LIMIT; start += SEARCH_RESULT_LIMIT) {
        signal?.throwIfAborted();
        const candidates = rows.slice(start, start + SEARCH_RESULT_LIMIT).map(row => {
          const metadata = JSON.parse(row.metadata) as { version?: string; segmentIds?: string[]; packetId?: string };
          return { row, metadata, ids: metadata.segmentIds ?? [row.id] };
        }).filter(({ metadata }) => !metadata.version || isAvailable(metadata.version));
        const missing = [...new Set(candidates.flatMap(candidate => candidate.ids))].filter(id => !resolvedIds.has(id));
        if (missing.length) {
          const resolved = await store.evidenceForCitations(missing, reads);
          signal?.throwIfAborted();
          // Deletion can change citation availability between batches.
          if (generation !== store.generation()) return { packets: [], ...indexing };
          found.push(...resolved);
          for (const id of missing) resolvedIds.add(id);
          for (const packet of resolved) for (const excerpt of packet.excerpts) texts.set(excerpt.id, excerpt.text);
        }
        for (const version of new Set(candidates.flatMap(({ metadata }) => metadata.version ? [metadata.version] : []))) {
          if (reads.has(version) && await reads.get(version) === null) {
            excluded.add(`asset:${version}`);
            available.set(version, false);
            unreadable.add(version);
            unreadableFound = true;
          }
        }
        for (const { row, metadata, ids: windowIds } of candidates) {
          if (results >= SEARCH_RESULT_LIMIT) break;
          if (metadata.version && !isAvailable(metadata.version)) continue;
          const ids = new Set(metadata.segmentIds && canTrim ? coveringSpan(windowIds, texts, terms) : windowIds);
          if ([...ids].every(id => seen.has(id))) continue;
          const before = packets.length;
          for (const packet of found) {
            if (packet.assetVersions?.some(version => !store.has(version))) continue;
            const excerpts = packet.excerpts.filter(excerpt => ids.has(excerpt.id) && !seen.has(excerpt.id));
            if (!excerpts.length) continue;
            packets.push({ ...packet, packetId: `search:${row.id}:${packets.length}${metadata.version ? ':segments' : ''}`, excerpts, artifacts: [] });
            for (const excerpt of excerpts) seen.add(excerpt.id);
          }
          if (packets.length > before) results++;
        }
      }
      if (rows.length < SEARCH_CANDIDATE_LIMIT) break;
      offset = unreadableFound ? 0 : offset + rows.length;
    }
    // Indexed transcripts whose blobs are now unreadable are a coverage gap too.
    // Indexing reports only unindexed versions, so the counts do not overlap.
    const unavailableTranscripts = (indexing.unavailableTranscripts ?? 0) + unreadable.size;
    return { packets: packets.filter((packet) => packet.assetVersions?.every((version) => store.has(version))),
      pendingTranscripts: indexing.pendingTranscripts, ...(unavailableTranscripts ? { unavailableTranscripts } : {}) };
  }
  async tools(
    store: SessionEvidenceStore,
    onEvidence: (packets: EvidencePacket[]) => EvidencePacket[] | void,
    signal: AbortSignal,
    /** History-only routes search messages and memory, never saved source evidence. */
    options: { evidence?: boolean } = {},
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
            'Search transcript passages and saved visual/comment analysis across session assets. Queries match all words. Results contain version-specific citation IDs; older versions are labelled.',
          search: async (query) => {
            check();
            const found = await this.searchEvidence(store, query, signal);
            check();
            // Only admitted hits reach the model; hits the run reserve cannot cover are withheld.
            const packets = onEvidence(found.packets) ?? found.packets;
            const withheld = found.packets.length - packets.length;
            return JSON.stringify({ packets: packets.map(evidencePacketForModel), ...(found.pendingTranscripts ? { pendingTranscripts: found.pendingTranscripts, indexingNote: 'Some saved transcript indexes are still being prepared. Search again to include another batch.' } : {}), ...(found.unavailableTranscripts ? { unavailableTranscripts: found.unavailableTranscripts, unavailableNote: 'Some saved transcripts could not be read and are not searchable. Treat them as a coverage gap; searching again will not help.' } : {}), ...(withheld > 0 ? { withheld, note: 'Some matches were not loaded because the run credit reserve is exhausted.' } : {}) });
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

function searchTokens(query: string): string[] {
  return query.slice(0, 200).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
}

/**
 * Approximates the FTS5 unicode61 tokenizer: letters and digits only (so `_`
 * separates words, as in the index), case-folded, diacritics removed.
 */
function foldedTokens(text: string): Set<string> {
  return new Set(text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** The shortest contiguous run of captions containing every query term, or the whole window if any term is unaccounted for. */
function coveringSpan(ids: string[], texts: ReadonlyMap<string, string>, terms: readonly string[]): string[] {
  if (ids.some(id => /[^\x00-\x7f]/.test(texts.get(id) ?? ''))) return ids;
  const captionTerms = ids.map(id => foldedTokens(texts.get(id) ?? ''));
  const wanted = terms.filter(term => captionTerms.some(tokens => tokens.has(term)));
  // FTS matched every term in this window. If trimming cannot find one, its
  // tokenization disagrees with the index; never discard the actual match.
  if (wanted.length < terms.length) return ids;
  let best = { start: 0, end: ids.length - 1 };
  for (let start = 0; start < ids.length; start++) {
    const covered = new Set<string>();
    for (let end = start; end < ids.length && end - start < best.end - best.start; end++) {
      for (const term of wanted) if (captionTerms[end]!.has(term)) covered.add(term);
      if (covered.size === wanted.length) { best = { start, end }; break; }
    }
  }
  return ids.slice(best.start, best.end + 1);
}
