import type { WebhookCustomerStateChangedPayload } from '@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload';
import { WebhookOrderPaidPayload$inboundSchema } from '@polar-sh/sdk/models/components/webhookorderpaidpayload';
import { env as workerEnv, SELF, applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { expect, test } from 'vitest';
import { deleteAccountRecords } from '../src/lib/account-deletion';
import { creditBalance, enforceImportLimit, entitlements, reserveCredits, type CreditEnv } from '../src/lib/entitlements';

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
  await create(first,email); await adjust(first,balance-5000);
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
  await reserveCredits(credits,'reserved-first','in-flight',4800,{});
  await env.DB.prepare("DELETE FROM user WHERE id='reserved-first'").run();
  expect((await history(email))[0]).toMatchObject({remaining_credits:200,polar_customer_id:'polar-customer-reference',plan:'builder',deletion_source:'database',deleted_by_user_id:null});
  await create('reserved-second',email);
  expect(await creditBalance(credits,'reserved-second')).toBe(200);
  expect(await env.DB.prepare("SELECT * FROM billing_accounts WHERE user_id='reserved-second'").first()).toBeNull();
});

test('ledger failure rolls back final deletion and a retry records one history row', async () => {
  const id='failed-ledger-delete',email='failed-ledger-delete@example.test';await create(id,email);await adjust(id,-4600);
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
  const email='atomic-return@example.test';await create('atomic-first',email);await adjust('atomic-first',-5000);
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
  for(const expected of [5000,350,200]) {
    const response=await SELF.fetch('http://auth.test/__test/session',{method:'POST',body:JSON.stringify({email})});
    expect(response.status).toBe(200);
    const {user}=await response.json() as {user:{id:string;email:string}};ids.push(user.id);
    expect(await creditBalance(credits,user.id)).toBe(expected);
    if(expected===5000) await adjust(user.id,-4650); else if(expected===350) await adjust(user.id,-150);
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
  const email='ordered-history@example.test';await create('ordered-first',email);await adjust('ordered-first',-4100);
  await deleteAccountRecords(env.DB,{id:'ordered-first',email});
  // Simulate clock skew or a lower-precision timestamp from an older Worker.
  await env.DB.prepare("UPDATE deleted_accounts SET deleted_at=9999999999999 WHERE user_id='ordered-first'").run();
  await create('ordered-second',email);await adjust('ordered-second',-800);
  await env.DB.prepare("DELETE FROM user WHERE id='ordered-second'").run();
  await create('ordered-third',email);
  expect(await creditBalance(credits,'ordered-third')).toBe(100);
});


test('idempotent user inserts for an existing account do not fail or refill its balance', async () => {
  const id='idempotent-existing-user',email='idempotent-existing@example.test';await create(id,email);await adjust(id,-4700);
  await env.DB.prepare(`INSERT OR IGNORE INTO user (id,name,email,createdAt,updatedAt) VALUES (?,'Demo',?,0,0)`).bind(id,email).run();
  expect(await creditBalance(credits,id)).toBe(300);
});

// Billing review regressions exercise the real D1 projection and ownership transfer.
test.each(['before signup','after signup'] as const)('review: delayed paid refund reconciles %s and replay cannot refill credits', async timing => {
  const {applyPaidOrder,applyRefundedOrder}=await import('../src/lib/billing');
  const billingEnv={DB:env.DB,POLAR_BUILDER_PRODUCT_ID:'builder-product',BUILDER_MONTHLY_CREDITS:'10000',STARTER_ONBOARDING_CREDITS:'1000'};
  const email=`review-refund-${timing.replace(' ','-')}@example.test`,id=`refund-origin-${timing}`;
  await create(id,email);
  const paid=reviewPaidOrder(id);
  await applyPaidOrder(billingEnv,paid);
  await deleteAccountRecords(env.DB,{id,email});
  const refund=reviewRefund(paid);
  if(timing==='before signup') await applyRefundedOrder(billingEnv,refund);
  const successor=`refund-successor-${timing}`;await create(successor,email);
  if(timing==='after signup') await applyRefundedOrder(billingEnv,refund);
  expect(await creditBalance(credits,successor)).toBe(1000);
  await expect(reserveCredits(credits,successor,'cannot-spend-refunded-credits',5000,{})).rejects.toMatchObject({status:402});
  await adjust(successor,-100);
  await applyRefundedOrder(billingEnv,refund);
  expect(await creditBalance(credits,successor)).toBe(900);
  await deleteAccountRecords(env.DB,{id:successor,email});await create(`refund-third-${timing}`,email);
  await applyRefundedOrder(billingEnv,refund);
  expect(await creditBalance(credits,`refund-third-${timing}`)).toBe(900);
});

test('review: an authenticated admin email change cannot transfer a deleted balance twice', async () => {
  const {createAuth}=await import('../src/lib/auth');
  const response=await SELF.fetch('http://auth.test/__test/session',{method:'POST',body:JSON.stringify({email:'review-email-admin@example.test'})});
  const admin=await response.json() as {user:{id:string};cookie:string};
  await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
  const email='review-original@example.test';await create('review-first',email);await adjust('review-first',-4660);
  await deleteAccountRecords(env.DB,{id:'review-first',email});await create('review-second',email);
  const auth=createAuth(env,{waitUntil:()=>{}});
  await auth.api.adminUpdateUser({body:{userId:'review-second',data:{email:'review-renamed@example.test'}},headers:new Headers({cookie:admin.cookie,origin:env.APP_ORIGIN})});
  await create('review-third',email);
  expect(await creditBalance(credits,'review-second')+await creditBalance(credits,'review-third')).toBe(340);
});

function reviewPaidOrder(userId:string) {
  return WebhookOrderPaidPayload$inboundSchema.parse({type:'order.paid',timestamp:'2026-10-15T10:00:00Z',data:reviewOrderBody(userId)});
}

function reviewOrderBody(userId:string,externalId:string|null=userId) {
  const at='2026-10-15T10:00:00Z';
  return {
    id:`order-${userId}`,created_at:at,modified_at:null,status:'paid',paid:true,
    subtotal_amount:2000,discount_amount:0,net_amount:2000,tax_amount:0,total_amount:2000,
    applied_balance_amount:0,due_amount:0,refunded_amount:0,refunded_tax_amount:0,
    currency:'usd',billing_reason:'subscription_cycle',billing_name:null,billing_address:null,
    invoice_number:'TEST-INVOICE',is_invoice_generated:true,customer_id:`customer-${userId}`,
    product_id:'builder-product',discount_id:null,subscription_id:`subscription-${userId}`,checkout_id:null,
    metadata:{app_user_id:userId},platform_fee_amount:0,platform_fee_currency:null,description:'Test Builder order',
    customer:{id:`customer-${userId}`,created_at:at,modified_at:null,metadata:{},external_id:externalId,
      email:null,email_verified:true,type:'individual',name:null,billing_address:null,tax_id:null,
      organization_id:'test-organization',deleted_at:null as string|null,avatar_url:''},
    product:null,discount:null,subscription:null,items:[],
  };
}

const reviewBillingEnv={DB:env.DB,POLAR_BUILDER_PRODUCT_ID:'builder-product',BUILDER_MONTHLY_CREDITS:'10000',STARTER_ONBOARDING_CREDITS:'1000'};
async function paidDeleted(id:string,email:string) {
  const {applyPaidOrder}=await import('../src/lib/billing');
  await create(id,email);const paid=reviewPaidOrder(id);await applyPaidOrder(reviewBillingEnv,paid);
  await deleteAccountRecords(env.DB,{id,email});return paid;
}
function reviewRefund(paid:ReturnType<typeof reviewPaidOrder>) {
  return {...paid,type:'order.refunded' as const,timestamp:new Date('2026-10-15T12:00:00Z'),data:{...paid.data,status:'refunded' as const,refundedAmount:paid.data.totalAmount}};
}

async function deliverSignedEvent(type:string,data:ReturnType<typeof reviewOrderBody>,at:string) {
  const {Webhook}=await import('standardwebhooks');
  const body=JSON.stringify({type,timestamp:at,data});
  const timestamp=new Date(),id=crypto.randomUUID();
  return SELF.fetch('http://auth.test/api/auth/polar/webhooks',{method:'POST',body,headers:{
    'content-type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(timestamp.getTime()/1000)),
    'webhook-signature':new Webhook(env.POLAR_WEBHOOK_SECRET).sign(id,timestamp,body),
  }});
}
async function deliverSignedRefund(userId:string,externalId:string|null=userId) {
  const at='2026-10-15T12:00:00Z';
  const data=reviewOrderBody(userId,externalId);
  data.status='refunded';data.refunded_amount=2000;data.customer.deleted_at=at;
  return deliverSignedEvent('order.refunded',data,at);
}

test.each(['before signup','after signup','after two transfers'] as const)('signed delayed refund reconciles %s, retains audit history, and is replay safe', async timing => {
  const id=`signed-${timing.replaceAll(' ','-')}`,email=`${id}@example.test`;
  await paidDeleted(id,email);
  if(timing==='before signup') expect((await deliverSignedRefund(id)).status).toBe(200);
  let successor=`${id}-second`;await create(successor,email);
  if(timing==='after two transfers') {
    await deleteAccountRecords(env.DB,{id:successor,email});successor=`${id}-third`;await create(successor,email);
  }
  if(timing!=='before signup') expect((await deliverSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,successor)).toBe(1000);
  await expect(reserveCredits(credits,successor,'signed-refund-spend',5000,{})).rejects.toMatchObject({status:402});
  await adjust(successor,-100);
  const responses=await Promise.all([deliverSignedRefund(id),deliverSignedRefund(id)]);
  expect(responses.map(r=>r.status)).toEqual([200,200]);
  expect(await creditBalance(credits,successor)).toBe(900);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM account_credit_refunds WHERE order_id=?').bind(`order-${id}`).first('n')).toBe(1);
  expect((await history(email))[0]).toMatchObject({remaining_credits:10000});
  expect(await env.DB.prepare('SELECT * FROM billing_accounts WHERE user_id=?').bind(successor).first()).toBeNull();
});

test('refund can reconcile the unclaimed tail after multiple deletions and a cleared Polar external ID', async () => {
  const id='signed-anonymized',email='signed-anonymized@example.test';await paidDeleted(id,email);
  await create('signed-anonymized-second',email);
  await deleteAccountRecords(env.DB,{id:'signed-anonymized-second',email});
  expect((await deliverSignedRefund(id,null)).status).toBe(200);
  await create('signed-anonymized-third',email);
  expect(await creditBalance(credits,'signed-anonymized-third')).toBe(1000);
  expect((await history(email)).map(row=>row.remaining_credits)).toEqual([10000,10000]);
});

test('refund before deletion and replay after transfer cannot reset already spent Starter credits', async () => {
  const {applyPaidOrder,applyRefundedOrder}=await import('../src/lib/billing');
  const id='refunded-before-delete',email='refunded-before-delete@example.test';await create(id,email);
  const paid=reviewPaidOrder(id);await applyPaidOrder(reviewBillingEnv,paid);
  await applyRefundedOrder(reviewBillingEnv,reviewRefund(paid));await adjust(id,-100);
  await deleteAccountRecords(env.DB,{id,email});await create('refunded-before-delete-second',email);
  await applyRefundedOrder(reviewBillingEnv,reviewRefund(paid));
  expect(await creditBalance(credits,'refunded-before-delete-second')).toBe(900);
});

test('a replay repairs a refund acknowledged without reconciliation by an older Worker', async () => {
  const {applyRefundedOrder}=await import('../src/lib/billing');
  const id='acknowledged-refund',email='acknowledged-refund@example.test';const paid=await paidDeleted(id,email);
  await env.DB.prepare("INSERT INTO processed_events (source,event_id,processed_at,payload_hash) VALUES ('polar',?,0,'old-worker')")
    .bind(`order.refunded:${paid.data.id}`).run();
  await create('acknowledged-refund-second',email);
  await applyRefundedOrder(reviewBillingEnv,reviewRefund(paid));
  expect(await creditBalance(credits,'acknowledged-refund-second')).toBe(1000);
  await adjust('acknowledged-refund-second',-100);
  await applyRefundedOrder(reviewBillingEnv,reviewRefund(paid));
  expect(await creditBalance(credits,'acknowledged-refund-second')).toBe(900);
});

test('refund reconciliation rolls back the balance when the durable receipt fails, then succeeds on retry', async () => {
  const {applyRefundedOrder}=await import('../src/lib/billing');
  const id='receipt-failure',email='receipt-failure@example.test';const paid=await paidDeleted(id,email);
  await create('receipt-failure-second',email);
  await env.DB.prepare(`CREATE TRIGGER test_refund_receipt_failure BEFORE INSERT ON account_credit_refunds
    WHEN NEW.original_user_id='receipt-failure' BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`).run();
  try {
    await expect(applyRefundedOrder(reviewBillingEnv,reviewRefund(paid))).rejects.toThrow('receipt unavailable');
    expect(await creditBalance(credits,'receipt-failure-second')).toBe(10000);
    expect(await env.DB.prepare('SELECT * FROM processed_events WHERE event_id=?').bind(`order.refunded:${paid.data.id}`).first()).toBeNull();
  } finally {await env.DB.prepare('DROP TRIGGER test_refund_receipt_failure').run();}
  await applyRefundedOrder(reviewBillingEnv,reviewRefund(paid));
  expect(await creditBalance(credits,'receipt-failure-second')).toBe(1000);
});

test('a stale ancestor refund cannot overwrite a successor payment with newer billing state', async () => {
  const {applyPaidOrder,applyRefundedOrder}=await import('../src/lib/billing');
  const id='stale-ancestor-refund',email='stale-ancestor-refund@example.test';const paid=await paidDeleted(id,email);
  await create('newer-payment-successor',email);
  const newer=reviewPaidOrder('newer-payment-successor');newer.timestamp=new Date('2026-10-16T12:00:00Z');
  await applyPaidOrder({...reviewBillingEnv,BUILDER_MONTHLY_CREDITS:'20000'},newer);
  await applyRefundedOrder(reviewBillingEnv,reviewRefund(paid));
  expect(await creditBalance(credits,'newer-payment-successor')).toBe(20000);
  expect(await env.DB.prepare("SELECT plan,provider_customer_id FROM billing_accounts WHERE user_id='newer-payment-successor'").first())
    .toEqual({plan:'builder',provider_customer_id:'customer-newer-payment-successor'});
});

test('a refund for a different Polar customer never changes the transferred balance', async () => {
  const {applyRefundedOrder}=await import('../src/lib/billing');
  const id='wrong-refund-customer',email='wrong-refund-customer@example.test';const paid=await paidDeleted(id,email);
  await create('wrong-refund-successor',email);
  const refund=reviewRefund(paid);refund.data.customerId='unrelated-customer';
  await applyRefundedOrder(reviewBillingEnv,refund);
  expect(await creditBalance(credits,'wrong-refund-successor')).toBe(10000);
});

test('a failed successor signup rolls back its nonzero carryover claim', async () => {
  const email='failed-transfer-claim@example.test';await create('failed-claim-first',email);await adjust('failed-claim-first',-4660);
  await deleteAccountRecords(env.DB,{id:'failed-claim-first',email});
  await env.DB.prepare(`CREATE TRIGGER test_failed_transfer_claim BEFORE INSERT ON credit_ledger
    WHEN NEW.user_id='failed-claim-second' BEGIN SELECT RAISE(ABORT,'opening balance unavailable'); END`).run();
  try {
    await expect(create('failed-claim-second',email)).rejects.toThrow('opening balance unavailable');
    expect(await env.DB.prepare("SELECT transferred_to_user_id FROM account_credit_carryovers WHERE user_id='failed-claim-first'").first('transferred_to_user_id')).toBeNull();
  } finally {await env.DB.prepare('DROP TRIGGER test_failed_transfer_claim').run();}
  await create('failed-claim-second',email);
  expect(await creditBalance(credits,'failed-claim-second')).toBe(340);
});

test('legacy refund-before-deletion is not applied again when its old Worker had no receipt', async () => {
  const {applyPaidOrder,applyRefundedOrder}=await import('../src/lib/billing');
  const id='legacy-refund-first',email='legacy-refund@example.test';await create(id,email);
  const paid=reviewPaidOrder(id);await applyPaidOrder(reviewBillingEnv,paid);
  // Seed the real pre-ledger refund entry, then usage and later cancellation
  // metadata. Deletion must preserve its receipt before cascading the ledger.
  await env.DB.prepare(`INSERT INTO credit_ledger (id,user_id,operation_id,entry_type,credits,created_at)
    VALUES ('legacy-refund-entry',?,?,'adjustment',-9000,0)`).bind(id,`polar:refund:${paid.data.id}`).run();
  await adjust(id,-100);
  await env.DB.prepare("UPDATE billing_accounts SET plan='starter',status='inactive',provider_updated_at=? WHERE user_id=?")
    .bind(reviewRefund(paid).timestamp.getTime(),id).run();
  await env.DB.prepare("INSERT INTO processed_events (source,event_id,processed_at,payload_hash) VALUES ('polar',?,0,'legacy-refund')")
    .bind(`order.refunded:${paid.data.id}`).run();
  await deleteAccountRecords(env.DB,{id,email});await create('legacy-refund-second',email);
  await applyRefundedOrder(reviewBillingEnv,reviewRefund(paid));
  expect(await creditBalance(credits,'legacy-refund-second')).toBe(900);
});

test('later customer cancellation state cannot shield carried paid credits from a delayed refund', async () => {
  const {applyPaidOrder,applyRefundedOrder}=await import('../src/lib/billing');
  const id='cancellation-before-refund',email='cancellation-before-refund@example.test';await create(id,email);
  const paid=reviewPaidOrder(id);await applyPaidOrder(reviewBillingEnv,paid);
  // Customer deletion/cancellation updates billing state but does not grant credits.
  await env.DB.prepare("UPDATE billing_accounts SET plan='starter',status='inactive',provider_updated_at=? WHERE user_id=?")
    .bind(new Date('2026-10-15T13:00:00Z').getTime(),id).run();
  await deleteAccountRecords(env.DB,{id,email});await create('cancellation-refund-successor',email);
  await applyRefundedOrder(reviewBillingEnv,reviewRefund(paid));
  expect(await creditBalance(credits,'cancellation-refund-successor')).toBe(1000);
});

test('refund resolves ownership inside the transaction when another deletion and signup race it', async () => {
  const {applyRefundedOrder}=await import('../src/lib/billing');
  const id='refund-ownership-race',email='refund-ownership-race@example.test';const paid=await paidDeleted(id,email);
  await create('refund-race-second',email);
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
  const batch:D1Database['batch']=async <T>(statements:D1PreparedStatement[])=>{entered();await held;return env.DB.batch<T>(statements);};
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='batch') return batch;
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const refund=applyRefundedOrder({...reviewBillingEnv,DB:db},reviewRefund(paid));
  await ready;
  try {
    await deleteAccountRecords(env.DB,{id:'refund-race-second',email});await create('refund-race-third',email);
  } finally {release();}
  await refund;
  expect(await creditBalance(credits,'refund-race-third')).toBe(1000);
  expect(await env.DB.prepare('SELECT owner_user_id FROM account_credit_refunds WHERE order_id=?').bind(paid.data.id).first('owner_user_id')).toBe('refund-race-third');
});


test.each(['newer','older'] as const)('review 298b945: legacy %s payment ordering stays recoverable until signed replay', async ordering => {
  const {applyPaidOrder}=await import('../src/lib/billing');
  const id=`legacy-${ordering}-payment`,email=`${id}@example.test`;
  await create(id,email);
  const earlier=reviewPaidOrder(id);earlier.timestamp=new Date('2026-10-14T10:00:00Z');
  await applyPaidOrder(reviewBillingEnv,earlier);
  const newer=reviewPaidOrder(id);newer.data.id=`newer-${id}`;newer.timestamp=new Date(ordering==='newer'?'2026-10-16T10:00:00Z':'2026-10-15T11:00:00Z');
  await applyPaidOrder(reviewBillingEnv,newer);
  // Reproduce pre-0026 storage: local receipt time, no provider event timestamp.
  await env.DB.prepare("UPDATE credit_ledger SET metadata_json=json_remove(metadata_json,'$.providerEventAt'),created_at=? WHERE user_id=? AND operation_id GLOB 'polar:order:*'")
    .bind(new Date('2026-10-16T10:01:00Z').getTime(),id).run();
  await env.DB.prepare('DELETE FROM account_credit_payments WHERE user_id=?').bind(id).run();
  await deleteAccountRecords(env.DB,{id,email});await create(`${id}-second`,email);
  expect((await deliverSignedRefund(id)).status).toBe(500);
  expect(await creditBalance(credits,`${id}-second`)).toBe(10000);
  expect(await env.DB.prepare('SELECT * FROM account_credit_refunds WHERE order_id=?').bind(earlier.data.id).first()).toBeNull();
  expect(await env.DB.prepare('SELECT * FROM processed_events WHERE event_id=?').bind(`order.refunded:${earlier.data.id}`).first()).toBeNull();
  // A replay enriches the saved grant after its user/ledger have cascaded away.
  const replay=reviewOrderBody(id,null);replay.id=newer.data.id;
  expect((await deliverSignedEvent('order.paid',replay,newer.timestamp.toISOString())).status).toBe(200);
  expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(id).first()).toBeNull();
  expect((await deliverSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,`${id}-second`)).toBe(ordering==='newer'?10000:1000);
  expect(await env.DB.prepare('SELECT outcome FROM account_credit_refunds WHERE order_id=?').bind(earlier.data.id).first('outcome')).toBe(ordering==='newer'?'superseded':'applied');
});

test('review 298b945: a skipped live refund cannot poison recovery after deletion', async () => {
  const {applyPaidOrder}=await import('../src/lib/billing');
  const id='skipped-live-refund',email=`${id}@example.test`;await create(id,email);
  await applyPaidOrder(reviewBillingEnv,reviewPaidOrder(id));
  // A later cancellation is not a newer credit grant.
  await env.DB.prepare("UPDATE billing_accounts SET plan='starter',status='inactive',provider_updated_at=? WHERE user_id=?")
    .bind(new Date('2026-10-15T13:00:00Z').getTime(),id).run();
  expect((await deliverSignedRefund(id)).status).toBe(200);
  await deleteAccountRecords(env.DB,{id,email});await create(`${id}-second`,email);
  expect((await deliverSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,`${id}-second`)).toBe(1000);
  await expect(reserveCredits(credits,`${id}-second`,'review-block-refunded-spend',5000,{})).rejects.toMatchObject({status:402});
});


test.each(['unclaimed','transferred'] as const)('real migration retains legacy paid grants for %s refund recovery', async timing => {
  const {applyPaidOrder,applyRefundedOrder}=await import('../src/lib/billing');
  const migrationEnv=workerEnv as typeof workerEnv & {CREDIT_MIGRATION_DB:D1Database;TEST_MIGRATIONS:D1Migration[]};
  const db=migrationEnv.CREDIT_MIGRATION_DB;
  const index=migrationEnv.TEST_MIGRATIONS.findIndex(m=>m.name==='0026_deleted_accounts.sql');
  await applyD1Migrations(db,migrationEnv.TEST_MIGRATIONS.slice(0,index));
  const id=`upgrade-${timing}`,email=`${id}@example.test`;
  const newerAt=new Date('2026-10-16T10:00:00Z').getTime();
  await db.prepare("INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES (?,'Legacy',?,0,0)").bind(id,email).run();
  await db.prepare("INSERT INTO billing_accounts (user_id,provider_customer_id,plan,status,provider_updated_at,updated_at) VALUES (?,?,'builder','active',?,?)")
    .bind(id,`customer-${id}`,newerAt,newerAt).run();
  // This shared migration database may already have the launch trigger from an earlier case.
  // Model the legacy account's original 1,000-credit balance explicitly.
  await db.prepare("UPDATE credit_ledger SET credits=1000,metadata_json='{\"allowance\":1000}' WHERE user_id=? AND operation_id='onboarding:v1'").bind(id).run();
  for(const [orderId,amount,at] of [[`order-${id}`,9000,new Date('2026-10-14T10:01:00Z').getTime()],[`newer-${id}`,0,newerAt+60000]] as const) {
    await db.prepare("INSERT INTO credit_ledger (id,user_id,operation_id,entry_type,credits,metadata_json,created_at) VALUES (?,?,?,'grant',?,'{\"kind\":\"billing-cycle\"}',?)")
      .bind(orderId,id,`polar:order:${orderId}`,amount,at).run();
    await db.prepare("INSERT INTO processed_events (source,event_id,processed_at,payload_hash) VALUES ('polar',?,?,'legacy')")
      .bind(`order.paid:${orderId}`,at).run();
  }
  await applyD1Migrations(db,migrationEnv.TEST_MIGRATIONS);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM account_credit_payments WHERE user_id=? AND event_exact=0').bind(id).first('n')).toBe(2);
  const billingEnv={...reviewBillingEnv,DB:db};
  await db.prepare('DELETE FROM user WHERE id=?').bind(id).run();
  const signup=()=>db.prepare("INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES (?,'Returning',?,0,0)").bind(`${id}-second`,email).run();
  if(timing==='transferred') await signup();
  await expect(applyRefundedOrder(billingEnv,reviewRefund(reviewPaidOrder(id)))).rejects.toMatchObject({status:503});
  expect(await db.prepare('SELECT order_id FROM account_credit_refunds WHERE order_id=?').bind(`order-${id}`).first()).toBeNull();
  const newer=reviewPaidOrder(id);newer.data.id=`newer-${id}`;newer.timestamp=new Date(newerAt);
  await applyPaidOrder(billingEnv,newer);
  await applyRefundedOrder(billingEnv,reviewRefund(reviewPaidOrder(id)));
  if(timing==='unclaimed') await signup();
  expect(await creditBalance({...credits,DB:db},`${id}-second`)).toBe(10000);
});

test('a refund ignored by an old Worker while live is repaired before and after deletion', async () => {
  const {applyPaidOrder}=await import('../src/lib/billing');
  const id='old-live-ack',email=`${id}@example.test`;await create(id,email);
  await applyPaidOrder(reviewBillingEnv,reviewPaidOrder(id));
  await env.DB.prepare("INSERT INTO processed_events (source,event_id,processed_at,payload_hash) VALUES ('polar',?,0,'old-worker')")
    .bind(`order.refunded:order-${id}`).run();
  expect((await deliverSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,id)).toBe(1000);
  await adjust(id,-100);await deleteAccountRecords(env.DB,{id,email});await create(`${id}-second`,email);
  expect((await deliverSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,`${id}-second`)).toBe(900);
});

test('refunded billing metadata alone cannot falsely prove a carryover was reconciled', async () => {
  const id='false-refunded-state',email=`${id}@example.test`;await paidDeleted(id,email);
  await env.DB.prepare("UPDATE account_credit_carryovers SET billing_status='refunded' WHERE user_id=?").bind(id).run();
  expect((await deliverSignedRefund(id)).status).toBe(200);
  await create(`${id}-second`,email);
  expect(await creditBalance(credits,`${id}-second`)).toBe(1000);
});


test('an ignored refund ledger insert stays retryable instead of writing a false handled receipt', async () => {
  const id='ignored-refund-write',email=`${id}@example.test`;
  const {applyPaidOrder}=await import('../src/lib/billing');await create(id,email);
  await applyPaidOrder(reviewBillingEnv,reviewPaidOrder(id));
  await env.DB.prepare(`CREATE TRIGGER test_skip_refund_write BEFORE INSERT ON credit_ledger
    WHEN NEW.user_id='ignored-refund-write' AND NEW.operation_id GLOB 'polar:refund:*'
    BEGIN SELECT RAISE(IGNORE); END`).run();
  try {
    expect((await deliverSignedRefund(id)).status).toBe(500);
    expect(await creditBalance(credits,id)).toBe(10000);
    expect(await env.DB.prepare('SELECT * FROM account_credit_refunds WHERE order_id=?').bind(`order-${id}`).first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM processed_events WHERE event_id=?').bind(`order.refunded:order-${id}`).first()).toBeNull();
    expect(await env.DB.prepare('SELECT plan FROM billing_accounts WHERE user_id=?').bind(id).first('plan')).toBe('builder');
  } finally {await env.DB.prepare('DROP TRIGGER test_skip_refund_write').run();}
  expect((await deliverSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,id)).toBe(1000);
});


test('a skipped carryover update cannot be mistaken for a completed refund', async () => {
  const id='ignored-carryover-write',email=`${id}@example.test`;await paidDeleted(id,email);
  await env.DB.prepare("UPDATE account_credit_carryovers SET billing_status='refunded',credit_updated_at=? WHERE user_id=?")
    .bind(new Date('2026-10-15T12:00:00Z').getTime(),id).run();
  await env.DB.prepare(`CREATE TRIGGER test_skip_carryover_refund BEFORE UPDATE ON account_credit_carryovers
    WHEN NEW.user_id='ignored-carryover-write' BEGIN SELECT RAISE(IGNORE); END`).run();
  try {
    expect((await deliverSignedRefund(id)).status).toBe(500);
    expect(await env.DB.prepare('SELECT available_credits FROM account_credit_carryovers WHERE user_id=?').bind(id).first('available_credits')).toBe(10000);
    expect(await env.DB.prepare('SELECT order_id FROM account_credit_refunds WHERE order_id=?').bind(`order-${id}`).first()).toBeNull();
    expect(await env.DB.prepare('SELECT event_id FROM processed_events WHERE event_id=?').bind(`order.refunded:order-${id}`).first()).toBeNull();
  } finally {await env.DB.prepare('DROP TRIGGER test_skip_carryover_refund').run();}
  expect((await deliverSignedRefund(id)).status).toBe(200);
  await create(`${id}-second`,email);expect(await creditBalance(credits,`${id}-second`)).toBe(1000);
});

test('refund follows a live user deletion that commits before its credit transaction', async () => {
  const {applyPaidOrder,applyRefundedOrder}=await import('../src/lib/billing');
  const id='live-refund-delete-race',email=`${id}@example.test`;await create(id,email);
  const paid=reviewPaidOrder(id);await applyPaidOrder(reviewBillingEnv,paid);
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
  const batch:D1Database['batch']=async <T>(statements:D1PreparedStatement[])=>{entered();await held;return env.DB.batch<T>(statements);};
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='batch') return batch;
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const refund=applyRefundedOrder({...reviewBillingEnv,DB:db},reviewRefund(paid));
  await ready;
  try {await deleteAccountRecords(env.DB,{id,email});await create(`${id}-second`,email);}
  finally {release();}
  await refund;
  expect(await creditBalance(credits,`${id}-second`)).toBe(1000);
  expect(await env.DB.prepare('SELECT user_id FROM billing_accounts WHERE user_id IN (?,?)').bind(id,`${id}-second`).first()).toBeNull();
});


function octoberActiveState(userId:string):WebhookCustomerStateChangedPayload {
  return {
    type:'customer.state_changed',timestamp:new Date('2026-10-03T10:00:00Z'),
    data:{id:`customer-${userId}`,externalId:userId,activeSubscriptions:[{
      id:`subscription-${userId}`,productId:'builder-product',status:'active',cancelAtPeriodEnd:true,
      currentPeriodStart:new Date('2026-10-01T00:00:00Z'),currentPeriodEnd:new Date('2026-11-01T00:00:00Z'),
    }]},
  } as WebhookCustomerStateChangedPayload;
}
async function octoberSignedRefund(userId:string) {
  const data=reviewOrderBody(userId);data.status='refunded';data.refunded_amount=2000;
  return deliverSignedEvent('order.refunded',data,'2026-10-02T10:00:00Z');
}
const accessEnv:Env={...env,STARTER_DAILY_IMPORTS:'10',BUILDER_DAILY_IMPORTS:'200'};

test.each(['fresh','replay repair'] as const)('applied signed refund revokes Builder access despite newer cancellation metadata: %s', async mode => {
  const {applyPaidOrder,syncCustomerState,getBillingSummary}=await import('../src/lib/billing');
  const id=`refund-access-${mode.replace(' ','-')}`,email=`${id}@example.test`;await create(id,email);
  const paid=reviewPaidOrder(id);paid.timestamp=new Date('2026-10-01T10:00:00Z');
  await applyPaidOrder(reviewBillingEnv,paid);await syncCustomerState(reviewBillingEnv,octoberActiveState(id));
  await expect(enforceImportLimit(accessEnv,id,await entitlements(accessEnv,id),true)).resolves.toBeUndefined();
  if(mode==='replay repair') {
    // The previous Worker committed the reset/receipt but left plan=builder.
    await env.DB.prepare("INSERT INTO credit_ledger (id,user_id,operation_id,entry_type,credits,created_at) VALUES (?,?,?,'adjustment',-9000,0)")
      .bind(crypto.randomUUID(),id,`polar:refund:order-${id}`).run();
    await env.DB.prepare("INSERT INTO account_credit_refunds (order_id,original_user_id,customer_id,owner_user_id,outcome,event_at) VALUES (?,?,?,?,'applied',?)")
      .bind(`order-${id}`,id,`customer-${id}`,id,new Date('2026-10-02T10:00:00Z').getTime()).run();
    await env.DB.prepare("INSERT INTO processed_events (source,event_id,processed_at,payload_hash) VALUES ('polar',?,0,'prior-worker')")
      .bind(`order.refunded:order-${id}`).run();
  }
  expect((await octoberSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,id)).toBe(1000);
  expect(await env.DB.prepare('SELECT outcome FROM account_credit_refunds WHERE order_id=?').bind(`order-${id}`).first('outcome')).toBe('applied');
  await expect(enforceImportLimit(accessEnv,id,await entitlements(accessEnv,id),true)).rejects.toMatchObject({status:403,code:'BUILDER_REQUIRED'});
  expect(await getBillingSummary(accessEnv,id)).toMatchObject({plan:'starter',status:'refunded',cancelAtPeriodEnd:true});
  expect(await env.DB.prepare('SELECT provider_updated_at FROM billing_accounts WHERE user_id=?').bind(id).first('provider_updated_at'))
    .toBe(octoberActiveState(id).timestamp.getTime());
  await adjust(id,-100);expect((await octoberSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,id)).toBe(900);
  // A later active snapshot must not re-enable refunded access.
  const later=octoberActiveState(id);later.timestamp=new Date('2026-10-04T10:00:00Z');
  await syncCustomerState(reviewBillingEnv,later);
  await expect(enforceImportLimit(accessEnv,id,await entitlements(accessEnv,id),true)).rejects.toMatchObject({status:403,code:'BUILDER_REQUIRED'});
});


test('a newer fulfilled payment keeps Builder access when an older refund follows newer metadata', async () => {
  const {applyPaidOrder,syncCustomerState,getBillingSummary}=await import('../src/lib/billing');
  const id='refund-access-newer-payment',email=`${id}@example.test`;await create(id,email);
  const paid=reviewPaidOrder(id);paid.timestamp=new Date('2026-10-01T10:00:00Z');
  await applyPaidOrder(reviewBillingEnv,paid);
  const newer=reviewPaidOrder(id);newer.data.id=`newer-${id}`;newer.timestamp=new Date('2026-10-02T12:00:00Z');
  await applyPaidOrder(reviewBillingEnv,newer);await syncCustomerState(reviewBillingEnv,octoberActiveState(id));
  expect((await octoberSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,id)).toBe(10000);
  expect(await env.DB.prepare('SELECT outcome FROM account_credit_refunds WHERE order_id=?').bind(`order-${id}`).first('outcome')).toBe('superseded');
  await expect(enforceImportLimit(accessEnv,id,await entitlements(accessEnv,id),true)).resolves.toBeUndefined();
  expect(await getBillingSummary(accessEnv,id)).toMatchObject({plan:'builder',status:'active'});
});

test('replaying an applied refund preserves a later fulfilled payment and subsequent spending', async () => {
  const {applyPaidOrder,syncCustomerState,getBillingSummary}=await import('../src/lib/billing');
  const id='refund-access-later-payment',email=`${id}@example.test`;await create(id,email);
  const paid=reviewPaidOrder(id);paid.timestamp=new Date('2026-10-01T10:00:00Z');
  await applyPaidOrder(reviewBillingEnv,paid);await syncCustomerState(reviewBillingEnv,octoberActiveState(id));
  expect((await octoberSignedRefund(id)).status).toBe(200);
  expect(await entitlements(accessEnv,id)).toMatchObject({plan:'starter'});
  const newer=reviewPaidOrder(id);newer.data.id=`newer-${id}`;newer.timestamp=new Date('2026-10-04T10:00:00Z');
  await applyPaidOrder(reviewBillingEnv,newer);await adjust(id,-100);
  expect((await octoberSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,id)).toBe(9900);
  await expect(enforceImportLimit(accessEnv,id,await entitlements(accessEnv,id),true)).resolves.toBeUndefined();
  expect(await getBillingSummary(accessEnv,id)).toMatchObject({plan:'builder',status:'active'});
});

test('failed refund access reconciliation rolls back credits, receipts and acknowledgement together', async () => {
  const {applyPaidOrder,syncCustomerState}=await import('../src/lib/billing');
  const id='refund-access-rollback',email=`${id}@example.test`;await create(id,email);
  const paid=reviewPaidOrder(id);paid.timestamp=new Date('2026-10-01T10:00:00Z');
  await applyPaidOrder(reviewBillingEnv,paid);await syncCustomerState(reviewBillingEnv,octoberActiveState(id));
  await env.DB.prepare(`CREATE TRIGGER test_fail_refund_access BEFORE UPDATE ON billing_accounts
    WHEN NEW.user_id='refund-access-rollback' AND NEW.status='refunded'
    BEGIN SELECT RAISE(ABORT,'access unavailable'); END`).run();
  try {
    expect((await octoberSignedRefund(id)).status).toBe(500);
    expect(await creditBalance(credits,id)).toBe(10000);
    expect(await env.DB.prepare('SELECT order_id FROM account_credit_refunds WHERE order_id=?').bind(`order-${id}`).first()).toBeNull();
    expect(await env.DB.prepare('SELECT event_id FROM processed_events WHERE event_id=?').bind(`order.refunded:order-${id}`).first()).toBeNull();
  } finally {await env.DB.prepare('DROP TRIGGER test_fail_refund_access').run();}
  expect((await octoberSignedRefund(id)).status).toBe(200);
  expect(await creditBalance(credits,id)).toBe(1000);
  await expect(enforceImportLimit(accessEnv,id,await entitlements(accessEnv,id),true)).rejects.toMatchObject({status:403,code:'BUILDER_REQUIRED'});
});


function holdBillingBatch() {
  let enter!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{enter=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  const batch:D1Database['batch']=async <T>(statements:D1PreparedStatement[])=>{enter();await held;return env.DB.batch<T>(statements);};
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='batch') return batch;
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return {db,ready,release:()=>release()};
}

test.each([false,true])('an in-flight snapshot cannot restore Builder after refund, cancel-at-period-end=%s', async cancelAtPeriodEnd => {
  const {applyPaidOrder,syncCustomerState,getBillingSummary}=await import('../src/lib/billing');
  const id=`refund-snapshot-race-${cancelAtPeriodEnd}`,email=`${id}@example.test`;await create(id,email);
  const paid=reviewPaidOrder(id);paid.timestamp=new Date('2026-10-01T10:00:00Z');
  await applyPaidOrder(reviewBillingEnv,paid);
  const state=octoberActiveState(id);state.data.activeSubscriptions[0]!.cancelAtPeriodEnd=cancelAtPeriodEnd;
  const held=holdBillingBatch();
  const snapshot=syncCustomerState({...reviewBillingEnv,DB:held.db},state);
  await held.ready;
  let response!:Response;
  try {response=await octoberSignedRefund(id);} finally {held.release();}
  await snapshot;
  expect(response.status).toBe(200);
  expect(await creditBalance(credits,id)).toBe(1000);
  expect(await env.DB.prepare('SELECT outcome FROM account_credit_refunds WHERE order_id=?').bind(`order-${id}`).first('outcome')).toBe('applied');
  await expect(enforceImportLimit(accessEnv,id,await entitlements(accessEnv,id),true)).rejects.toMatchObject({status:403,code:'BUILDER_REQUIRED'});
  expect(await getBillingSummary(accessEnv,id)).toMatchObject({plan:'starter',status:'refunded',cancelAtPeriodEnd});
  expect(await env.DB.prepare('SELECT event_id FROM processed_events WHERE event_id=?')
    .bind(`customer.state_changed:customer-${id}:${state.timestamp.toISOString()}`).first()).not.toBeNull();
});

test.each([false,true])('an in-flight snapshot cannot undo a newer fulfilled payment after refund, cancel-at-period-end=%s', async cancelAtPeriodEnd => {
  const {applyPaidOrder,syncCustomerState,getBillingSummary}=await import('../src/lib/billing');
  const id=`payment-snapshot-race-${cancelAtPeriodEnd}`,email=`${id}@example.test`;await create(id,email);
  const paid=reviewPaidOrder(id);paid.timestamp=new Date('2026-10-01T10:00:00Z');
  await applyPaidOrder(reviewBillingEnv,paid);expect((await octoberSignedRefund(id)).status).toBe(200);
  const state=octoberActiveState(id);state.data.activeSubscriptions[0]!.cancelAtPeriodEnd=cancelAtPeriodEnd;
  const held=holdBillingBatch();
  const snapshot=syncCustomerState({...reviewBillingEnv,DB:held.db},state);
  await held.ready;
  const newer=reviewPaidOrder(id);newer.data.id=`newer-${id}`;newer.timestamp=new Date('2026-10-02T12:00:00Z');
  try {await applyPaidOrder(reviewBillingEnv,newer);} finally {held.release();}
  await snapshot;
  expect(await creditBalance(credits,id)).toBe(10000);
  await expect(enforceImportLimit(accessEnv,id,await entitlements(accessEnv,id),true)).resolves.toBeUndefined();
  expect(await getBillingSummary(accessEnv,id)).toMatchObject({plan:'builder',status:'active',cancelAtPeriodEnd});
});
