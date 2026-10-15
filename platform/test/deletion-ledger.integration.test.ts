import { env as workerEnv, SELF, applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { expect, test } from 'vitest';
import { deleteAccountRecords } from '../src/lib/account-deletion';
import { creditBalance, reserveCredits, type CreditEnv } from '../src/lib/entitlements';

const env = workerEnv as Env;
const credits = { DB: env.DB } as CreditEnv;
async function create(id: string, email: string) {
  await env.DB.prepare('INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES (?,\'Test\',?,123,123)').bind(id,email).run();
}
async function adjust(id: string, amount: number) {
  await env.DB.prepare(`INSERT INTO credit_ledger (id,user_id,operation_id,entry_type,credits,created_at)
    VALUES (?,?,?,'adjustment',?,0)`).bind(crypto.randomUUID(),id,crypto.randomUUID(),amount).run();
}
async function history(email: string) {
  return (await env.DB.prepare('SELECT * FROM deleted_accounts WHERE email=? ORDER BY rowid').bind(email).all()).results;
}

test.each([340,0,-7,20000])('re-registration restores %i credits and never grants another onboarding allowance', async balance => {
  const email=`carry-${balance}@example.test`, first=`carry-first-${balance}`, second=`carry-second-${balance}`, third=`carry-third-${balance}`;
  await create(first,email); await adjust(first,balance-1000);
  await deleteAccountRecords(env.DB,{id:first,email});
  const original=await history(email);
  expect(original).toHaveLength(1);
  expect(original[0]).toMatchObject({user_id:first,remaining_credits:balance,signed_up_at:123,deletion_source:'self',deleted_by_user_id:first});
  expect(await env.DB.prepare('SELECT * FROM credit_ledger WHERE user_id=?').bind(first).first()).toBeNull();
  await create(second,`  ${email.toUpperCase()}  `);
  expect(await creditBalance(credits,second)).toBe(balance);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id=? AND operation_id='onboarding:v1'").bind(second).first('n')).toBe(0);
  await adjust(second,-1);
  await deleteAccountRecords(env.DB,{id:second,email});
  await create(third,email);
  expect(await creditBalance(credits,third)).toBe(balance-1);
  expect(await history(email)).toHaveLength(2);
  // Retrying the old deletion cannot replace history or delete the fresh user.
  await deleteAccountRecords(env.DB,{id:first,email});
  expect(await history(email)).toEqual([...original,expect.objectContaining({user_id:second,remaining_credits:balance-1})]);
  expect(await creditBalance(credits,third)).toBe(balance-1);
  const stored=await env.DB.prepare('SELECT COALESCE(SUM(credits),0) AS balance FROM credit_ledger WHERE user_id=?').bind(third).first('balance');
  expect(stored).toBe(balance-1);
});

test('outstanding reservations are not refunded into another signup and database deletion preserves billing references', async () => {
  const email='reserved-return@example.test'; await create('reserved-first',email);
  await env.DB.prepare(`INSERT INTO billing_accounts (user_id,provider_customer_id,plan,provider_updated_at,updated_at)
    VALUES ('reserved-first','polar-customer-reference','builder',0,0)`).run();
  await reserveCredits(credits,'reserved-first','in-flight',800,{});
  await env.DB.prepare("DELETE FROM user WHERE id='reserved-first'").run();
  expect((await history(email))[0]).toMatchObject({remaining_credits:200,polar_customer_id:'polar-customer-reference',plan:'builder',deletion_source:'database',deleted_by_user_id:null});
  await create('reserved-second',email);
  expect(await creditBalance(credits,'reserved-second')).toBe(200);
  expect(await env.DB.prepare("SELECT * FROM billing_accounts WHERE user_id='reserved-second'").first()).toBeNull();
});

test('ledger failure rolls back final deletion and a retry records one history row', async () => {
  const id='failed-ledger-delete',email='failed-ledger-delete@example.test';await create(id,email);await adjust(id,-600);
  await env.DB.prepare(`CREATE TRIGGER test_fail_deletion_audit BEFORE INSERT ON deleted_accounts
    WHEN NEW.user_id='failed-ledger-delete' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`).run();
  try {
    await expect(deleteAccountRecords(env.DB,{id,email})).rejects.toThrow('audit unavailable');
    expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(id).first()).not.toBeNull();
    expect(await creditBalance(credits,id)).toBe(400); expect(await history(email)).toEqual([]);
  } finally {await env.DB.prepare('DROP TRIGGER test_fail_deletion_audit').run();}
  await deleteAccountRecords(env.DB,{id,email});await deleteAccountRecords(env.DB,{id,email});
  expect(await history(email)).toHaveLength(1);
});

test('returning signup is atomic, does not reuse deleted IDs, and cannot duplicate normalized emails concurrently', async () => {
  const email='atomic-return@example.test';await create('atomic-first',email);await adjust('atomic-first',-1000);
  await deleteAccountRecords(env.DB,{id:'atomic-first',email});
  await expect(create('atomic-first',email)).rejects.toThrow('Deleted user IDs cannot be reused');
  await env.DB.prepare(`CREATE TRIGGER test_fail_returning_credit BEFORE INSERT ON credit_ledger
    WHEN NEW.user_id='atomic-second' BEGIN SELECT RAISE(ABORT,'carryover unavailable'); END`).run();
  try {
    await expect(create('atomic-second',email)).rejects.toThrow('carryover unavailable');
    expect(await env.DB.prepare("SELECT id FROM user WHERE id='atomic-second'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id FROM credit_accounts WHERE user_id='atomic-second'").first()).toBeNull();
  } finally {await env.DB.prepare('DROP TRIGGER test_fail_returning_credit').run();}
  const results=await Promise.allSettled([create('atomic-second',email),create('atomic-third',email.toUpperCase())]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const active=await env.DB.prepare('SELECT id FROM user WHERE lower(email)=?').bind(email).first<{id:string}>();
  expect(await creditBalance(credits,active!.id)).toBe(0);
  await expect(reserveCredits(credits,active!.id,'no-free-reset',1,{})).rejects.toMatchObject({status:402});
});

test('real Better Auth signups get fresh identities and carry the last balance across repeated deletion', async () => {
  const email='auth-repeat-signup@example.test';const ids:string[]=[];
  for(const expected of [1000,350,200]) {
    const response=await SELF.fetch('http://auth.test/__test/session',{method:'POST',body:JSON.stringify({email})});
    expect(response.status).toBe(200);
    const {user}=await response.json() as {user:{id:string;email:string}};ids.push(user.id);
    expect(await creditBalance(credits,user.id)).toBe(expected);
    if(expected===1000) await adjust(user.id,-650); else if(expected===350) await adjust(user.id,-150);
    await deleteAccountRecords(env.DB,user);
  }
  expect(new Set(ids).size).toBe(3); expect(await history(email)).toHaveLength(3);
});

test('migration preserves existing balances and backfills no invented deletion history', async () => {
  const migrationEnv=workerEnv as typeof workerEnv & {CREDIT_MIGRATION_DB:D1Database;TEST_MIGRATIONS:D1Migration[]};
  const db=migrationEnv.CREDIT_MIGRATION_DB;
  const index=migrationEnv.TEST_MIGRATIONS.findIndex(m=>m.name==='0026_deleted_accounts.sql');
  await applyD1Migrations(db,migrationEnv.TEST_MIGRATIONS.slice(0,index));
  await db.prepare("INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES ('pre-ledger','Existing','pre-ledger@example.test',0,0)").run();
  await db.prepare("INSERT INTO credit_ledger (id,user_id,operation_id,entry_type,credits,created_at) VALUES ('existing-spend','pre-ledger','spend','adjustment',-780,0)").run();
  await applyD1Migrations(db,migrationEnv.TEST_MIGRATIONS);
  expect(await db.prepare("SELECT available_credits FROM credit_accounts WHERE user_id='pre-ledger'").first('available_credits')).toBe(220);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM deleted_accounts').first('n')).toBe(0);
  await db.prepare("DELETE FROM user WHERE id='pre-ledger'").run();
  await db.prepare("INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES ('post-ledger','Returning','pre-ledger@example.test',0,0)").run();
  expect(await db.prepare("SELECT available_credits FROM credit_accounts WHERE user_id='post-ledger'").first('available_credits')).toBe(220);
});


test('credit carryover uses the latest recorded deletion even when deletion timestamps disagree', async () => {
  const email='ordered-history@example.test';await create('ordered-first',email);await adjust('ordered-first',-100);
  await deleteAccountRecords(env.DB,{id:'ordered-first',email});
  // Simulate clock skew or a lower-precision timestamp from an older Worker.
  await env.DB.prepare("UPDATE deleted_accounts SET deleted_at=9999999999999 WHERE user_id='ordered-first'").run();
  await create('ordered-second',email);await adjust('ordered-second',-800);
  await env.DB.prepare("DELETE FROM user WHERE id='ordered-second'").run();
  await create('ordered-third',email);
  expect(await creditBalance(credits,'ordered-third')).toBe(100);
});


test('idempotent user inserts for an existing account do not fail or refill its balance', async () => {
  const id='idempotent-existing-user',email='idempotent-existing@example.test';await create(id,email);await adjust(id,-700);
  await env.DB.prepare(`INSERT OR IGNORE INTO user (id,name,email,createdAt,updatedAt) VALUES (?,'Demo',?,0,0)`).bind(id,email).run();
  expect(await creditBalance(credits,id)).toBe(300);
});
