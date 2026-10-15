/** Durable claims never expire while a provider request may still be in flight. */
export class BillingGate {
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS billing_checkouts (id TEXT PRIMARY KEY)');
    sql.exec('CREATE TABLE IF NOT EXISTS billing_deletion (id INTEGER PRIMARY KEY, claim TEXT, committed INTEGER NOT NULL DEFAULT 0)');
  }
  beginCheckout(id: string): boolean {
    if (this.sql.exec('SELECT id FROM billing_deletion').toArray().length) return false;
    this.sql.exec('INSERT INTO billing_checkouts (id) VALUES (?)', id);
    return true;
  }
  endCheckout(id: string): void { this.sql.exec('DELETE FROM billing_checkouts WHERE id=?', id); }
  beginDeletion(id: string): boolean {
    if (this.sql.exec('SELECT id FROM billing_checkouts LIMIT 1').toArray().length) return false;
    const row = this.sql.exec<{ claim: string | null }>('SELECT claim FROM billing_deletion WHERE id=1').toArray()[0];
    if (row?.claim) return false;
    this.sql.exec('INSERT INTO billing_deletion (id,claim) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET claim=excluded.claim', id);
    return true;
  }
  commitDeletion(id: string): void {
    this.sql.exec('UPDATE billing_deletion SET committed=1 WHERE id=1 AND claim=?', id);
  }
  endDeletion(id: string): void {
    this.sql.exec('DELETE FROM billing_deletion WHERE claim=? AND committed=0', id);
    this.sql.exec('UPDATE billing_deletion SET claim=NULL WHERE claim=?', id);
  }
}
