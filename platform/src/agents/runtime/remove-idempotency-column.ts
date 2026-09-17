/** Drop obsolete admission keys while retaining existing runs and queue entries. */
export function removeIdempotencyColumn(storage: DurableObjectStorage, table: 'agent_runs' | 'agent_admissions'): void {
  const columns = storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (!columns.some(column => column.name === 'idempotency_key')) return;

  // SQLite cannot drop a UNIQUE column directly. These application tables have
  // no foreign keys; rebuild atomically, preserving all other columns and indexes.
  const original = storage.sql.exec<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table,
  ).one().sql;
  const updated = original.replace(/\bidempotency_key\s+TEXT(?:\s+NOT\s+NULL)?(?:\s+UNIQUE)?\s*,/i, '');
  if (updated === original) throw new Error(`Unrecognized obsolete admission schema for ${table}.`);
  const replacement = `${table}_without_key`;
  const retainedColumns = columns.filter(column => column.name !== 'idempotency_key')
    .map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ');
  const indexes = storage.sql.exec<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL", table,
  ).toArray();
  storage.transactionSync(() => {
    storage.sql.exec(updated.replace(table, replacement));
    storage.sql.exec(`INSERT INTO ${replacement} (${retainedColumns}) SELECT ${retainedColumns} FROM ${table}`);
    storage.sql.exec(`DROP TABLE ${table}`);
    storage.sql.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
    for (const index of indexes) storage.sql.exec(index.sql);
  });
}
