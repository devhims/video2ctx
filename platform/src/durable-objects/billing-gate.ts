/** Durable claims never expire while a provider request may still be in flight. */
export class BillingGate {
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS billing_checkouts (id TEXT PRIMARY KEY)');
    sql.exec('CREATE TABLE IF NOT EXISTS billing_checkout_writes (id TEXT PRIMARY KEY, operation TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS billing_deletion (id INTEGER PRIMARY KEY, claim TEXT, committed INTEGER NOT NULL DEFAULT 0)');
  }
  beginCheckout(id: string): boolean {
    if (this.sql.exec('SELECT id FROM billing_deletion UNION ALL SELECT id FROM billing_checkouts LIMIT 1').toArray().length) return false;
    this.sql.exec('INSERT INTO billing_checkouts (id) VALUES (?)', id);
    return true;
  }
  beginWrite(id: string, operation: 'customer-create' | 'checkout-create'): void {
    if (!this.sql.exec('SELECT id FROM billing_checkouts WHERE id=?', id).toArray().length) throw new Error('Billing claim is missing.');
    this.sql.exec("INSERT INTO billing_checkout_writes (id,operation,state,started_at) VALUES (?,?,'pending',?)", id, operation, Date.now());
  }
  finishWrite(id: string): void { this.sql.exec('DELETE FROM billing_checkout_writes WHERE id=?', id); }
  markUncertain(id: string): void { this.sql.exec("UPDATE billing_checkout_writes SET state='uncertain' WHERE id=?", id); }
  endCheckout(id: string): void {
    // A response failure does not prove that Polar rejected the accepted POST.
    if (this.sql.exec('SELECT id FROM billing_checkout_writes WHERE id=?', id).toArray().length) return;
    this.sql.exec('DELETE FROM billing_checkouts WHERE id=?', id);
  }
  // Keep the boolean contract for requests still served by an older Worker.
  beginDeletion(id: string): boolean { return this.claimDeletion(id) === 'acquired'; }
  claimDeletion(id: string): 'acquired' | 'checkout_pending' | 'deletion_in_progress' {
    if (this.sql.exec('SELECT id FROM billing_checkouts LIMIT 1').toArray().length) return 'checkout_pending';
    const row = this.sql.exec<{ claim: string | null }>('SELECT claim FROM billing_deletion WHERE id=1').toArray()[0];
    if (row?.claim) return 'deletion_in_progress';
    this.sql.exec('INSERT INTO billing_deletion (id,claim) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET claim=excluded.claim', id);
    return 'acquired';
  }
  commitDeletion(id: string): void {
    this.sql.exec('UPDATE billing_deletion SET committed=1 WHERE id=1 AND claim=?', id);
  }
  endDeletion(id: string): void {
    this.sql.exec('DELETE FROM billing_deletion WHERE claim=? AND committed=0', id);
    this.sql.exec('UPDATE billing_deletion SET claim=NULL WHERE claim=?', id);
  }
}
