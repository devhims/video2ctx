// Deliberately fixed destination: an edited environment variable must not exfiltrate the key.
export const ORIGIN = 'https://api.video2ctx.dev';
export const VIDEO_ID = 'dQw4w9WgXcQ';
export const MESSAGE = `Summarize only the transcript of https://youtu.be/${VIDEO_ID} in one sentence and cite transcript evidence. Do not search for other videos or use storyboards or frames.`;
export const LIMITS = Object.freeze({ transcriptMs: 125000, requestMs: 15000, pollMs: 240000, polls: 30, intervalMs: 8000, bodyBytes: 1048576 });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const validReceipt = value => uuid(value?.sessionId) && uuid(value?.runId);
export class CheckError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export function safeFailure(error) {
  return { status: 'failed', code: error instanceof CheckError ? error.code : 'INTERNAL_ERROR',
    ...(error instanceof CheckError && error.status ? { httpStatus: error.status } : {}) };
}
export function client(key, fetcher = fetch) {
  return async (path, { method = 'GET', body, timeoutMs = LIMITS.requestMs } = {}) => {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new CheckError('REQUEST_TIMEOUT'));
    }, timeoutMs); });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetcher(`${ORIGIN}${path}`, {
          method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: controller.signal,
        });
        // Never log or parse error bodies: they may echo credentials or private content.
        if (!response.ok) { await response.body?.cancel(); throw new CheckError('HTTP_ERROR', response.status); }
        if (method === 'POST' && response.status !== 202) { await response.body?.cancel(); throw new CheckError('INVALID_ADMISSION_STATUS', response.status); }
        const reader = response.body?.getReader();
        if (!reader) throw new CheckError('INVALID_JSON');
        let bytes = 0;
        const decoder = new TextDecoder(); let text = '';
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > LIMITS.bodyBytes) throw new CheckError('RESPONSE_TOO_LARGE');
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally { await reader.cancel().catch(() => {}); }
        try { return JSON.parse(text); } catch { throw new CheckError('INVALID_JSON'); }
      })()]);
    } catch (error) {
      if (error instanceof CheckError) throw error;
      throw new CheckError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
export async function transcriptCheck(request) {
  const value = await request(`/v1/providers/youtube/videos/${VIDEO_ID}/transcript?format=segments`, { timeoutMs: LIMITS.transcriptMs });
  if (value?.videoId !== VIDEO_ID || typeof value.text !== 'string' || !value.text.trim()
    || !Array.isArray(value.segments) || !value.segments.length
    || !value.segments.every(s => typeof s.text === 'string' && Number.isFinite(s.startMs) && s.startMs >= 0)
    || value.meta?.partial === true) throw new CheckError('INVALID_TRANSCRIPT');
  return { status: 'passed', segments: value.segments.length };
}
export async function submitAgent(request) {
  // Caller persists the admission intent before this non-idempotent POST.
  return request('/v1/agent?responseFormat=compact', { method: 'POST', body: { message: MESSAGE } });
}
export async function pollAgent(request, receipt, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!validReceipt(receipt)) throw new CheckError('INVALID_RECEIPT');
  const deadline = now() + LIMITS.pollMs;
  for (let attempt = 0; attempt < LIMITS.polls && now() < deadline; attempt++) {
    let run;
    try {
      run = await request(`/v1/agent/${receipt.sessionId}/runs/${receipt.runId}?responseFormat=compact&include=evidence`,
        { timeoutMs: Math.min(LIMITS.requestMs, deadline - now()) });
    } catch (error) {
      // Avoid retry storms and honor arbitrary server cooldowns by deferring to the next cron.
      return { ...safeFailure(error), status: 'inconclusive', terminal: false };
    }
    if (run?.runId !== receipt.runId || run?.sessionId !== receipt.sessionId) return { status: 'failed', code: 'RUN_ID_MISMATCH', terminal: false };
    if (['failed', 'cancelled'].includes(run.status)) return { status: 'failed', code: `AGENT_${run.status.toUpperCase()}`, terminal: true };
    if (run.status === 'completed') {
      const result = run.result;
      const transcriptSource = Array.isArray(result?.sources) && result.sources.find(s => s.videoId === VIDEO_ID);
      const cited = transcriptSource && Array.isArray(result.evidence) && result.evidence.some(e => e.sourceId === transcriptSource.id && e.id?.startsWith(`transcript:${VIDEO_ID}:`));
      const passed = result?.outcome === 'answered' && typeof result.answer === 'string' && result.answer.trim().length > 0 && cited && result.answer.includes(`[${transcriptSource.id}]`);
      return { status: passed ? 'passed' : 'failed', ...(passed ? {} : { code: 'INVALID_AGENT_ANSWER' }), terminal: true };
    }
    if (!['pending', 'running'].includes(run.status)) return { status: 'failed', code: 'INVALID_RUN_STATUS', terminal: false };
    const wait = Math.min(LIMITS.intervalMs, deadline - now());
    if (wait > 0 && attempt + 1 < LIMITS.polls) await sleep(wait);
  }
  return { status: 'inconclusive', code: 'POLL_WINDOW_EXPIRED', terminal: false };
}
