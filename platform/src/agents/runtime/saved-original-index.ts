import { z } from 'zod';
import type { Comment, CommentsPage, Transcript } from 'all-things-youtube';
import type { EvidencePacket } from '../contracts';
import { completeTranscriptEvidence } from '../providers/youtube/tools/get-video-transcript';

/**
 * A per-session segment index of original saved captions and comments, written once when an
 * asset is saved (or on its first read, for assets saved earlier). Reads and searches use only
 * Durable Object SQLite, never R2. FTS5's porter stemmer matches inflections: "mix" finds "mixing".
 */
export const SAVED_ORIGINAL_INDEX_FORMAT = 1;
/** Matches may span this many consecutive captions; a sentence is often split across cues. */
const CAPTION_WINDOW = 3;
/** Captions shown either side of a caption match, so a quote is read in context. */
const CAPTION_RADIUS = 2;
const COMMENT_CHUNK = 1_500;

type Excerpt = EvidencePacket['excerpts'][number];
export type SavedOriginalKind = 'transcript' | 'comments';
export interface SavedOriginalMeta { partial?: boolean; warnings: string[]; continuation?: boolean }
export type SavedOriginalBuild =
  | { status: 'ready'; entries: Array<{ excerpt: Excerpt; searchText: string }>; meta: SavedOriginalMeta }
  | { status: 'unreadable'; reason: string };

const captionShape = z.object({ segments: z.array(z.object({
  text: z.string(), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(),
})) });
const commentShape = z.object({ id: z.string(), text: z.string(), author: z.object({ name: z.string() }),
  get replies() { return z.array(commentShape).optional(); },
});
const commentsShape = z.object({ comments: z.array(commentShape) });

export function ensureSavedOriginalSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS session_original_assets (version TEXT PRIMARY KEY, format INTEGER NOT NULL,
    status TEXT NOT NULL, total INTEGER NOT NULL, meta_json TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS session_original_segments (id INTEGER PRIMARY KEY, version TEXT NOT NULL,
    position INTEGER NOT NULL, start_ms INTEGER, end_ms INTEGER, search_text TEXT NOT NULL, excerpt_json TEXT NOT NULL,
    UNIQUE (version, position))`);
  // External content: the segment rows hold the text once; FTS5 holds only the stemmed index.
  sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS session_original_fts USING fts5(search_text,
    content='session_original_segments', content_rowid='id', tokenize='porter unicode61')`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS session_original_segment_insert AFTER INSERT ON session_original_segments BEGIN
    INSERT INTO session_original_fts (rowid, search_text) VALUES (NEW.id, NEW.search_text);
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS session_original_segment_delete AFTER DELETE ON session_original_segments BEGIN
    INSERT INTO session_original_fts (session_original_fts, rowid, search_text) VALUES ('delete', OLD.id, OLD.search_text);
  END`);
  // Deleting a saved asset (including account deletion) removes its index in the same statement.
  sql.exec(`CREATE TRIGGER IF NOT EXISTS session_original_asset_delete AFTER DELETE ON session_assets BEGIN
    DELETE FROM session_original_segments WHERE version=OLD.version;
    DELETE FROM session_original_assets WHERE version=OLD.version;
  END`);
}

/** The exact excerpts read_saved_evidence returns, with the text each one is searched by. */
export function buildSavedOriginal(asset: { version: string; kind: SavedOriginalKind; videoId: string }, value: unknown): SavedOriginalBuild {
  if (!(asset.kind === 'transcript' ? captionShape : commentsShape).safeParse(value).success)
    return { status: 'unreadable', reason: 'Saved source data has an unreadable caption or comment structure.' };
  const sourceId = `youtube:${asset.videoId}:${asset.kind}`;
  const source = value as Transcript | CommentsPage;
  const meta: SavedOriginalMeta = { warnings: source.meta?.warnings ?? [],
    ...(source.meta?.partial !== undefined ? { partial: source.meta.partial } : {}),
    ...(asset.kind === 'comments' ? { continuation: Boolean((source as CommentsPage).continuation) } : {}) };
  if (asset.kind === 'transcript') {
    const excerpts = completeTranscriptEvidence(asset.videoId, (source as Transcript).segments, sourceId).excerpts;
    return { status: 'ready', meta, entries: excerpts.map((excerpt, index) => ({
      excerpt: { ...excerpt, id: `saved:${asset.version}:caption:${index}` }, searchText: searchableText(excerpt.text) })) };
  }
  return { status: 'ready', meta, entries: flattenComments((source as CommentsPage).comments).flatMap(({ comment, position }) => {
    // Split long comments without discarding their tail or changing their words.
    const suffix = `\nAuthor: ${comment.author.name.slice(0, 200)}\nComment ID: ${comment.id.slice(0, 200)}\nSaved position: ${position.map(index => index + 1).join('.')}`;
    // Every chunk is searched by the whole comment and its author, never the attribution labels.
    const searchText = searchableText(`${comment.text} ${comment.author.name}`);
    const chunks: Array<{ excerpt: Excerpt; searchText: string }> = [];
    for (let offset = 0; offset < comment.text.length; offset += COMMENT_CHUNK) {
      chunks.push({ searchText, excerpt: { id: `saved:${asset.version}:comment:${position.join(':')}:${offset / COMMENT_CHUNK}`,
        sourceId, text: comment.text.slice(offset, offset + COMMENT_CHUNK) + suffix } });
    }
    return chunks;
  }) };
}

/** Replace one version's index. Callers own the transaction boundary. */
export function writeSavedOriginalIndex(sql: SqlStorage, version: string, built: SavedOriginalBuild): void {
  sql.exec('DELETE FROM session_original_segments WHERE version=?', version);
  if (built.status === 'ready') built.entries.forEach(({ excerpt, searchText }, position) => sql.exec(
    'INSERT INTO session_original_segments (version, position, start_ms, end_ms, search_text, excerpt_json) VALUES (?, ?, ?, ?, ?, ?)',
    version, position, excerpt.startMs ?? null, excerpt.endMs ?? null, searchText, JSON.stringify(excerpt)));
  sql.exec('INSERT OR REPLACE INTO session_original_assets VALUES (?, ?, ?, ?, ?)', version, SAVED_ORIGINAL_INDEX_FORMAT,
    built.status, built.status === 'ready' ? built.entries.length : 0,
    JSON.stringify(built.status === 'ready' ? built.meta : { reason: built.reason }));
}

export type SavedOriginalIndexState =
  | { status: 'ready'; total: number; meta: SavedOriginalMeta }
  | { status: 'unreadable'; reason: string };

/** The current-format index for a version, or undefined when it must be (re)built. */
export function savedOriginalIndexState(sql: SqlStorage, version: string): SavedOriginalIndexState | undefined {
  const row = sql.exec<{ format: number; status: string; total: number; meta_json: string }>(
    'SELECT format, status, total, meta_json FROM session_original_assets WHERE version=?', version).toArray()[0];
  if (!row || row.format !== SAVED_ORIGINAL_INDEX_FORMAT) return undefined;
  const meta = JSON.parse(row.meta_json);
  return row.status === 'ready' ? { status: 'ready', total: row.total, meta } : { status: 'unreadable', reason: meta.reason };
}

export interface SavedOriginalQuery { kind: SavedOriginalKind; words?: string[]; startMs?: number; endMs?: number; offset: number; limit: number }

/** Select matching positions in order, then load only the requested page of excerpts. */
export function selectSavedOriginals(sql: SqlStorage, version: string, total: number, query: SavedOriginalQuery) {
  const anchors = timeFilteredPositions(sql, version, query);
  let matching: number[];
  if (!query.words?.length) matching = anchors ? [...anchors].sort((a, b) => a - b) : range(total);
  else if (query.kind === 'comments') {
    // Comments never mix authors: every word must occur in the same comment.
    matching = positionsMatching(sql, version, query.words.map(phrase).join(' AND ')).sort((a, b) => a - b);
  } else {
    // Captions can split a phrase across cues: every word must occur within a short caption window.
    const sets = query.words.map(word => new Set(positionsMatching(sql, version, phrase(word))));
    const candidates = new Set([...sets[0]!].flatMap(position => range(CAPTION_WINDOW).map(back => position - back)));
    const selected = new Set<number>();
    for (const start of candidates) {
      if (start < 0 || (anchors && !anchors.has(start))) continue;
      if (!sets.every(set => range(CAPTION_WINDOW).some(step => set.has(start + step)))) continue;
      for (let position = Math.max(0, start - CAPTION_RADIUS); position <= Math.min(total - 1, start + CAPTION_RADIUS); position++) selected.add(position);
    }
    matching = [...selected].sort((a, b) => a - b);
  }
  const requested = matching.slice(query.offset, query.offset + query.limit);
  const byPosition = new Map(requested.length ? sql.exec<{ position: number; excerpt_json: string }>(
    `SELECT position, excerpt_json FROM session_original_segments WHERE version=? AND position IN (${requested.map(() => '?').join(',')})`,
    version, ...requested).toArray().map(row => [row.position, JSON.parse(row.excerpt_json) as Excerpt]) : []);
  const page: Excerpt[] = [];
  let characters = 0;
  for (const position of requested) {
    const excerpt = byPosition.get(position);
    if (!excerpt) continue;
    const size = JSON.stringify(excerpt).length;
    if (characters + size > 12_000) break;
    page.push(excerpt);
    characters += size;
  }
  return { matching: matching.length, page };
}

/** Indexed versions containing the first query word; per-version selection applies the full match rules. */
export function savedOriginalVersionsMatching(sql: SqlStorage, words: readonly string[]): string[] {
  if (!words.length) return [];
  return sql.exec<{ version: string }>(`SELECT DISTINCT s.version FROM session_original_fts f
    JOIN session_original_segments s ON s.id = f.rowid WHERE session_original_fts MATCH ?`, phrase(words[0]!)).toArray().map(row => row.version);
}

/**
 * Words for a saved-evidence query, normalized exactly like indexed text. Apostrophes are
 * removed rather than split on, so "don't" is one word and never matches a stray "t".
 */
export function savedOriginalQueryWords(query: string): string[] {
  return searchableText(query).match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function searchableText(text: string): string {
  return text.toLowerCase().replace(/(?<=[\p{L}\p{N}])['’‘](?=[\p{L}\p{N}])/gu, '');
}

function phrase(word: string): string {
  return `"${word.replace(/"/g, '')}"`;
}

function positionsMatching(sql: SqlStorage, version: string, match: string): number[] {
  return sql.exec<{ position: number }>(`SELECT s.position FROM session_original_fts f
    JOIN session_original_segments s ON s.id = f.rowid
    WHERE session_original_fts MATCH ? AND s.version = ?`, match, version).toArray().map(row => row.position);
}

function timeFilteredPositions(sql: SqlStorage, version: string, query: SavedOriginalQuery): Set<number> | undefined {
  if (query.startMs === undefined && query.endMs === undefined) return undefined;
  return new Set(sql.exec<{ position: number }>(`SELECT position FROM session_original_segments WHERE version=?
    AND (? IS NULL OR COALESCE(end_ms, start_ms, 0) >= ?) AND (? IS NULL OR COALESCE(start_ms, 0) <= ?)`,
  version, query.startMs ?? null, query.startMs ?? null, query.endMs ?? null, query.endMs ?? null).toArray().map(row => row.position));
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function flattenComments(comments: Comment[]) {
  const pending = comments.map((comment, index) => ({ comment, position: [index] })).reverse();
  const entries: typeof pending = [];
  while (pending.length) {
    const entry = pending.pop()!;
    entries.push(entry);
    for (let index = (entry.comment.replies?.length ?? 0) - 1; index >= 0; index--) {
      pending.push({ comment: entry.comment.replies[index]!, position: [...entry.position, index] });
    }
  }
  return entries;
}
