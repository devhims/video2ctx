// Local UI fixtures only. The actual verified-email gate is covered by agent-route.test.ts.
import { createServer } from 'node:http';
const sessionId = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
const otherId = '5a04cf06-ea91-4b07-b892-ce87f63954de';
const failedId = 'f1611a8b-cb84-4305-a365-328bd06bedac';
const activeId = 'cd056140-7d4c-4516-bb9e-c97914439553';
const stamp = 1789111800000;
const summary = { sessionId, title: 'Fable and Astra: key takeaways', latestMessagePreview: 'Summarise the key takeaways from this video.', lastRunId: sessionId, runCount: 2, createdAt: stamp, updatedAt: stamp };
const summaries = [summary, { ...summary, sessionId: failedId, title: 'A comparison that failed', lastRunId: failedId, runCount: 1 }, { ...summary, sessionId: activeId, title: 'Research in progress', lastRunId: activeId, runCount: 1 }];
const message = (role, turn, id, status = 'completed') => ({ messageId: role === 'user' ? (turn === 1 ? '8a8671bd-5387-43dc-9031-65a69af2a40e' : otherId) : id, runId: id, conversationTurn: turn, parentMessageId: role === 'user' ? null : otherId, role, status, content: role === 'user' ? 'Summarise the key takeaways from this video.' : status === 'completed' ? '## Saved video analysis\n\nThe speaker compares **Fable and Astra** using practical examples.\n\n- Compare the claims against the transcript.\n- Treat personal experience as anecdotal evidence. [1]' : '', createdAt: stamp, updatedAt: stamp });
const success = id => ({ sessionId: id, runId: id, status: 'completed', request: { message: 'Summarise the key takeaways from this video.' }, result: { outcome: 'answered', answer: 'The speaker prefers Fable for coding and Astra for broader tasks. [1]\n\nUse Astra to prototype 3D scenes, then refine interactions with Fable. [1]', sources: [{ id: '1', title: 'Fable Vs Astra Debate Is Over', url: 'https://www.youtube.com/watch?v=P7bxbDSnZRM' }], warnings: [{ code: 'SOURCE_CAVEAT', message: 'These are the speaker’s experiences, not independent measurements.' }], coverage: { reviewedVideos: 1, targetVideos: 1 } }, billing: { creditsCharged: 2, creditsRemaining: 679 } });
const turns = new Map();
const admissions = new Map();
const tool = { toolCallId: 'transcript-1', name: 'get_video_transcript', operation: 'transcript', status: 'running', startedAt: stamp,
  input: { videoId: 'P7bxbDSnZRM', language: 'en' } };
const finishedTool = { ...tool, status: 'completed', finishedAt: stamp + 3800,
  output: { sourceCount: 1, excerptCount: 4, sources: [{ title: 'Fable Vs Astra Debate Is Over', videoId: 'P7bxbDSnZRM' }], warningCodes: [] } };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8797');
  const cookie = req.headers.cookie ?? '';
  const allowed = cookie.includes('agent-ui=allowed');
  const signedIn = /agent-ui=(allowed|denied|unavailable)/.test(cookie);
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/health') return reply(200, { ok: true });
  if (url.pathname === '/api/auth/get-session') return reply(200, signedIn ? { user: { id: 'fixture-user', name: 'Fixture account', email: 'fixture@example.test' }, session: { id: 'fixture-auth-session' } } : null);
  if (url.pathname.startsWith('/v1/agent')) {
    if (cookie.includes('agent-ui=unavailable')) return reply(503, { error: { code: 'AUTH_UNAVAILABLE' } });
    if (!allowed) return reply(signedIn ? 403 : 401, { error: { code: 'ADMIN_REQUIRED' } });
    if (url.pathname === '/v1/agent' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const key = req.headers['idempotency-key'];
      const existing = admissions.get(key);
      if (existing) return reply(202, existing.receipt);
      const id = input.sessionId ?? crypto.randomUUID(), runId = crypto.randomUUID();
      const receipt = { sessionId: id, runId, assistantMessageId: crypto.randomUUID(), status: 'pending',
        diagnostics: { userMessageId: crypto.randomUUID(), conversationTurn: 3 + [...turns.values()].filter(turn => turn.receipt.sessionId === id).length } };
      const turn = { receipt, message: input.message, connections: 0, completed: false };
      admissions.set(key, turn); turns.set(runId, turn);
      if (!summaries.some(row => row.sessionId === id)) summaries.push({ ...summary, sessionId: id, title: input.message, lastRunId: runId });
      if (input.message.includes('Retry this follow-up')) return reply(503, {});
      return reply(202, receipt);
    }
    const eventPath = /^\/v1\/agent\/([^/]+)\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (eventPath) {
      const [, id, runId] = eventPath;
      const turn = turns.get(runId);
      const send = snapshot => res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform' });
      if (runId === failedId) { send({ run: { sessionId: id, runId, status: 'failed', error: 'Classification returned an invalid routing decision.' }, phase: 'failed', tools: [] }); return res.end(); }
      const completed = { run: { ...success(id), runId, ...(turn ? { result: { ...success(id).result, answer: 'The follow-up highlights three practical differences. [1]' } } : {}) }, phase: 'completed', tools: [finishedTool] };
      if (turn?.completed || (!turn && id !== activeId)) { send(completed); return res.end(); }
      const timers = [];
      req.on('close', () => timers.forEach(clearTimeout));
      send({ run: { sessionId: id, runId, status: 'running' }, phase: 'research', tools: [tool] });
      if (turn && ++turn.connections === 1) {
        // End an active stream once to exercise restoration without a second POST.
        timers.push(setTimeout(() => res.end(), 700)); return;
      }
      timers.push(setTimeout(() => send({ run: { sessionId: id, runId, status: 'running' }, phase: 'finalization', tools: [finishedTool] }), 600));
      timers.push(setTimeout(() => { if (turn) turn.completed = true; send(completed); res.end(); }, 1400));
      return;
    }
    if (url.pathname === '/v1/agent/access') return reply(200, { enabled: true });
    if (url.pathname === '/v1/agent/sessions') {
      const q = url.searchParams.get('q');
      const rows = q ? summaries.filter(row => row.title.toLowerCase().includes(q.toLowerCase())) : summaries;
      return reply(200, { sessions: url.searchParams.has('cursor') ? [{ ...summary, sessionId: otherId, title: 'Earlier research session' }] : rows, nextCursor: q || url.searchParams.has('cursor') ? null : 'older-session-fixture' });
    }
    const detailId = /^\/v1\/agent\/sessions\/([^/]+)$/.exec(url.pathname)?.[1];
    if (detailId) {
      if (detailId === otherId) return reply(404, { error: { code: 'AGENT_SESSION_NOT_FOUND' } });
      const current = summaries.find(row => row.sessionId === detailId);
      if (!current) return reply(404, {});
      const older = url.searchParams.has('cursor');
      const status = detailId === failedId ? 'failed' : detailId === activeId ? 'running' : 'completed';
      const latestTurn = [...turns.values()].filter(turn => turn.receipt.sessionId === detailId).at(-1);
      if (latestTurn && !older) {
        const { receipt, message: content, completed } = latestTurn;
        return reply(200, { ...current, lastRunId: receipt.runId, messages: [message('user', 2, detailId), message('assistant', 2, detailId),
          { ...message('user', receipt.diagnostics.conversationTurn, receipt.runId), messageId: receipt.diagnostics.userMessageId, content },
          { ...message('assistant', receipt.diagnostics.conversationTurn, receipt.runId, completed ? 'completed' : 'running'), messageId: receipt.assistantMessageId }], nextCursor: null });
      }
      return reply(200, { ...current, messages: older ? [{ ...message('user', 1, otherId), content: 'Earlier request in this session.' }, { ...message('assistant', 1, otherId), messageId: failedId }] : [message('user', 2, detailId), message('assistant', 2, detailId, status)], nextCursor: detailId === sessionId && !older ? 'older-message-fixture' : null });
    }
    const runId = /^\/v1\/agent\/[^/]+\/runs\/([^/]+)$/.exec(url.pathname)?.[1];
    if (runId === failedId) return reply(200, { sessionId: failedId, runId, status: 'failed', error: 'Classification returned an invalid routing decision.' });
    if (runId) return reply(200, success(runId));
  }
  if (url.pathname === '/v1/projects') return reply(200, { projects: [] });
  if (url.pathname === '/v1/monitors') return reply(200, { monitors: [] });
  if (url.pathname === '/v1/notifications') return reply(200, { notifications: [] });
  if (url.pathname === '/v1/billing' || url.pathname === '/v1/notification-preferences') return reply(404, {});
  if (url.pathname === '/v1/usage') return reply(200, { creditBalance: 679 });
  return reply(200, {});
}).listen(8797, '127.0.0.1', () => console.log('Agent dashboard fixture server ready'));
