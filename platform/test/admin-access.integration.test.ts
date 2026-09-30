import { env, exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

const base = 'http://auth.test';
const worker = exports.default;
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(new URL(path, base), init));
async function session(email?: string): Promise<{ user: { id: string; email: string }; cookie: string }> {
  const response = await request('/__test/session', { method: 'POST', body: JSON.stringify({ email }) });
  expect(response.status).toBe(200);
  return response.json();
}
const headers = (cookie: string) => ({ cookie, origin: base, 'content-type': 'application/json' });
const access = (cookie: string) => request('/v1/admin/access', { headers: { cookie } });
const grant = (cookie: string, email: string) => request('/v1/admin/agent-access', { method: 'POST', headers: headers(cookie), body: JSON.stringify({ email }) });

describe('admin plugin and Agent access management', () => {
  test('an existing operator can use the plugin and manage D1 grants independently of Agent access', async () => {
    const admin = await session('bootstrap-admin@example.test');
    const tester = await session();
    expect((await access(admin.cookie)).status).toBe(200);
    const users = await request('/api/auth/admin/list-users?limit=10', { headers: { cookie: admin.cookie } });
    expect(users.status).toBe(200);
    expect(await users.json()).toMatchObject({ users: expect.any(Array), total: expect.any(Number) });
    expect((await request('/v1/admin/jobs', { headers: { cookie: admin.cookie } })).status).toBe(200);
    expect((await request('/v1/agent/access', { headers: { cookie: admin.cookie } })).status).toBe(403);

    expect((await grant(admin.cookie, `  ${tester.user.email.toUpperCase()}  `)).status).toBe(200);
    expect((await grant(admin.cookie, tester.user.email)).status).toBe(200);
    const list = await request(`/v1/admin/agent-access?q=${encodeURIComponent(tester.user.email)}&limit=1`, { headers: { cookie: admin.cookie } });
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    expect(await list.json()).toMatchObject({ total: 1, limit: 1, entries: [{ email: tester.user.email, createdAt: expect.any(Number) }] });
    expect((await request('/v1/agent/access', { headers: { cookie: tester.cookie } })).status).toBe(200);
    expect((await access(tester.cookie)).status).toBe(403);
    expect((await grant(tester.cookie, 'unauthorized@example.test')).status).toBe(403);
    expect((await request('/api/auth/admin/list-users', { headers: { cookie: tester.cookie } })).status).toBe(403);

    const remove = await request('/v1/admin/agent-access', { method: 'DELETE', headers: headers(admin.cookie), body: JSON.stringify({ email: tester.user.email }) });
    expect(remove.status).toBe(200);
    expect((await request('/v1/agent/access', { headers: { cookie: tester.cookie } })).status).toBe(403);
  });

  test('role changes, email verification, bans and session revocations are checked without cached admin claims', async () => {
    const admin = await session();
    expect((await access(admin.cookie)).status).toBe(403);
    await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(200);
    await env.DB.prepare('UPDATE user SET emailVerified=0 WHERE id=?').bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(403);
    await env.DB.prepare('UPDATE user SET emailVerified=1, banned=1 WHERE id=?').bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(403);
    await env.DB.prepare("UPDATE user SET banned=0, role='user' WHERE id=?").bind(admin.user.id).run();
    expect((await request('/api/auth/admin/list-users', { headers: { cookie: admin.cookie } })).status).toBe(403);
    await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(200);
    await env.DB.prepare('DELETE FROM session WHERE userId=?').bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(401);
  });

  test('requires a browser session and same-origin JSON mutations; rejects invalid email and pagination', async () => {
    const admin = await session();
    await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
    expect((await request('/v1/admin/access')).status).toBe(401);
    const credentials: Record<string, string>[] = [{ authorization: 'Bearer cli-token' }, { 'x-api-key': 'aty_key' }, { 'x-demo-user': 'admin' }];
    for (const credential of credentials) {
      for (const path of ['/v1/admin/access', '/v1/admin/agent-access', '/api/auth/admin/list-users']) {
        expect((await request(path, { headers: { cookie: admin.cookie, ...credential } })).status).toBe(403);
      }
    }
    for (const origin of ['', 'https://attacker.example']) {
      expect((await request('/v1/admin/agent-access', { method: 'POST', headers: { ...headers(admin.cookie), origin }, body: JSON.stringify({ email: 'target@example.test' }) })).status).toBe(403);
    }
    expect((await grant(admin.cookie, 'invalid')).status).toBe(422);
    expect((await request('/v1/admin/agent-access?limit=1000', { headers: headers(admin.cookie) })).status).toBe(422);
    expect((await grant(admin.cookie, 'not-signed-up@example.test')).status).toBe(200);
    expect((await request('/v1/admin/agent-access?q=not-signed-up&offset=1&limit=1', { headers: headers(admin.cookie) })).status).toBe(200);
  });

  test('impersonated sessions cannot manage access and the plugin delete shortcut stays disabled', async () => {
    const admin = await session();
    await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
    const removal = await request('/api/auth/admin/remove-user', { method: 'POST', headers: headers(admin.cookie), body: JSON.stringify({ userId: admin.user.id }) });
    expect(removal.status).toBe(404);
    await env.DB.prepare("UPDATE session SET impersonatedBy='another-operator' WHERE userId=?").bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(403);
  });
});

test('diagnostic traces require live admin sessions and export complete ordered call/result events', async () => {
  const admin=await session('trace-admin@example.test');
  const user=await session('trace-user@example.test');
  await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
  const runId=crypto.randomUUID(),traceId=crypto.randomUUID(),sessionId=crypto.randomUUID();
  const input={query:'complete input',nested:{array:Array.from({length:40},(_,i)=>i)}};
  const output={text:'full output '.repeat(300),nested:[{proof:true}]};
  const inputKey=`test-trace/${traceId}/input.json`,outputKey=`test-trace/${traceId}/output.json`;
  await env.RESEARCH.put(inputKey,JSON.stringify(input));
  await env.RESEARCH.put(outputKey,JSON.stringify(output));
  await env.DB.prepare(`INSERT INTO agent_tool_traces
    (trace_id,run_id,tool_call_id,user_id,session_id,tool_name,operation,source,run_status,status,started_at,finished_at,input_key,output_key,index_version,attempt,call_sequence,result_sequence)
    VALUES (?,?,?,?,?,'search_context','context','model','completed','completed',100,200,?,?,1,1,1,2)`)
    .bind(traceId,runId,'call-1',user.user.id,sessionId,inputKey,outputKey).run();
  await env.DB.prepare(`INSERT INTO agent_trace_runs VALUES (?,?,?,'completed',100,200,1,0,0,1)`)
    .bind(runId,user.user.id,sessionId).run();
  const paths=[`/v1/admin/agent-traces`,`/v1/admin/agent-traces/${runId}`,`/v1/admin/agent-traces/${runId}/calls/${traceId}`,`/v1/admin/agent-traces/${runId}/export`];
  for (const path of paths) {
    expect((await request(path)).status).toBe(401);
    expect((await request(path,{headers:{cookie:user.cookie}})).status).toBe(403);
    expect((await request(path,{headers:{cookie:admin.cookie,authorization:'Bearer cli'}})).status).toBe(403);
  }
  const list=await request('/v1/admin/agent-traces?status=&q='+runId,{headers:{cookie:admin.cookie}});
  expect(await list.json()).toMatchObject({runs:[{runId,callCount:1,status:'completed'}],nextOffset:null});
  const calls=await request(paths[1]!,{headers:{cookie:admin.cookie}});
  expect(await calls.json()).toMatchObject({runId,calls:[{traceId,callSequence:1,resultSequence:2}]});
  const detail=await request(paths[2]!,{headers:{cookie:admin.cookie}});
  expect(detail.headers.get('Cache-Control')).toBe('no-store');
  expect(await detail.json()).toMatchObject({input,output,payloadState:'complete'});
  const exported=await request(paths[3]!,{headers:{cookie:admin.cookie}});
  expect(exported.headers.get('Content-Type')).toContain('application/x-ndjson');
  const events=(await exported.text()).trim().split('\n').map(line=>JSON.parse(line));
  expect(events).toMatchObject([{type:'trace/header',version:1,runId},{type:'tool/call',seq:1,arguments:input},{type:'tool/result',seq:2,result:output}]);
  expect((await request(`/v1/admin/agent-traces/${runId}/calls/${crypto.randomUUID()}`,{headers:{cookie:admin.cookie}})).status).toBe(404);
  await env.DB.prepare('UPDATE agent_tool_traces SET deleted=1,index_version=2 WHERE trace_id=?').bind(traceId).run();
  expect(await (await request(paths[2]!,{headers:{cookie:admin.cookie}})).json()).toMatchObject({input:null,payloadState:'deleted'});
  await env.DB.prepare('DELETE FROM user WHERE id=?').bind(user.user.id).run();
  expect(await env.DB.prepare('SELECT trace_id FROM agent_tool_traces WHERE trace_id=?').bind(traceId).first()).toBeNull();
});

test('run status filters retain complete counts when call rows have mixed publication states',async()=>{
  const admin=await session('trace-summary-admin@example.test');
  await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
  const runId=crypto.randomUUID(),sessionId=crypto.randomUUID();
  for (const [index,runStatus] of ['completed','running'].entries()) {
    await env.DB.prepare(`INSERT INTO agent_tool_traces
      (trace_id,run_id,tool_call_id,user_id,session_id,tool_name,operation,source,run_status,status,started_at,index_version,attempt,call_sequence)
      VALUES (?,?,?,?,?,'context_read','context','model',?,'running',100,1,1,?)`)
      .bind(crypto.randomUUID(),runId,`call-${index}`,admin.user.id,sessionId,runStatus,index+1).run();
  }
  await env.DB.prepare("INSERT INTO agent_trace_runs VALUES (?,?,?,'completed',100,200,2,0,0,1)").bind(runId,admin.user.id,sessionId).run();
  for (const q of [runId,sessionId,admin.user.id]) {
    const response=await request(`/v1/admin/agent-traces?q=${q}&status=completed`,{headers:{cookie:admin.cookie}});
    expect(await response.json()).toMatchObject({runs:[{runId,status:'completed',callCount:2}]});
  }
  const running=await request(`/v1/admin/agent-traces?q=${runId}&status=running`,{headers:{cookie:admin.cookie}});
  expect(await running.json()).toMatchObject({runs:[]});
  const detail=await request(`/v1/admin/agent-traces/${runId}`,{headers:{cookie:admin.cookie}});
  expect(await detail.json()).toMatchObject({status:'completed',calls:[{status:'interrupted'},{status:'interrupted'}]});
});

test('oversized exports fail before streaming or reading payloads',async()=>{
  const admin=await session('trace-export-budget@example.test');
  await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
  const runId=crypto.randomUUID(),sessionId=crypto.randomUUID();
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<201)
    INSERT INTO agent_tool_traces
    (trace_id,run_id,tool_call_id,user_id,session_id,tool_name,operation,source,run_status,status,started_at,
      input_key,output_key,index_version,attempt,call_sequence,result_sequence)
    SELECT lower(hex(randomblob(16))),?,CAST(i AS TEXT),?,?,'context_read','context','model','completed','completed',
      100,'input.json','output.json',1,1,i*2,i*2+1 FROM n`).bind(runId,admin.user.id,sessionId).run();
  const response=await request(`/v1/admin/agent-traces/${runId}/export`,{headers:{cookie:admin.cookie}});
  expect(response.status).toBe(422);
  expect(response.headers.get('Content-Disposition')).toBeNull();
  expect(await response.json()).toMatchObject({error:{code:'TRACE_EXPORT_TOO_LARGE'}});
});
