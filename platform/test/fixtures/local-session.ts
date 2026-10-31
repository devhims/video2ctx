import { DatabaseSync } from 'node:sqlite';
import { SessionEvidenceStore } from '../../src/agents/runtime/session-evidence';

export function localSession() {
  const database = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...values: import('node:sqlite').SQLInputValue[]) {
    const rows = database.prepare(query).all(...values);
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`); return rows[0]; },
      [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  const objects = new Map<string, string>();
  const bucket = { put: async (key: string, text: string) => { objects.set(key, text); },
    get: async (key: string) => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
    delete: async (key: string) => { objects.delete(key); } } as unknown as R2Bucket;
  return new SessionEvidenceStore(sql, bucket, `replay/${crypto.randomUUID()}/`, undefined, undefined, undefined, 7200);
}
