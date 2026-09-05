import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { agentRunReceiptSchema, agentTurnResultSchema } from '../src/agents/contracts';

// Exercise the deployed Worker path, including its real GLM model factory,
// processor, persistence, access controls, and billing. Never load API secrets
// from a source file or use a separate model implementation for the smoke test.
async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('AGENT_TEST_BASE_URL=http://127.0.0.1:8787 AGENT_TEST_TOKEN=<admin token> npm run test:agent:live\nOptional: AGENT_TEST_NON_ADMIN_TOKEN to verify admin denial; AGENT_TEST_MESSAGE to replace the research prompt.\nUse a running local Worker configured with GLM, agent access enabled, and an authenticated test account.');
    return;
  }
  const base = new URL(process.env.AGENT_TEST_BASE_URL ?? 'http://127.0.0.1:8787');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'The live smoke test must target a local Worker.');
  const token = process.env.AGENT_TEST_TOKEN;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const nonAdminToken = process.env.AGENT_TEST_NON_ADMIN_TOKEN;
  if (nonAdminToken) {
    const response = await fetch(new URL('/v1/agent/sessions', base), {
      headers: { Authorization: `Bearer ${nonAdminToken}` }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 403, 'A non-admin token must be denied in admins mode');
    console.log('PASS non-admin access denied');
  } else {
    console.log('SKIP non-admin live check: set AGENT_TEST_NON_ADMIN_TOKEN to enable it.');
  }
  const failures: string[] = [];
  for (const [route, message] of [
    ['topic_research', process.env.AGENT_TEST_MESSAGE ?? 'Research the best design skills for frontend developers using Claude Code. Use one YouTube search and cite the evidence.'],
    ['inspect_video', 'Summarize https://youtu.be/Ct-mtWqV3Ro. You must use get_video_storyboard to analyze its visual presentation and get_video_transcript to summarize the discussion. Cite both visual and transcript evidence.'],
  ] as const) {
    try {
      const started = Date.now();
      const response = await fetch(new URL('/v1/agent?responseFormat=legacy', base), {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': `smoke-${crypto.randomUUID()}` },
        body: JSON.stringify({ message }), signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 202, `Admission failed: ${await response.clone().text()}`);
      const receipt = agentRunReceiptSchema.parse(await response.json());
      let complete = false;
      while (Date.now() - started < 120_000) {
        const poll = await fetch(new URL(`/v1/agent/${receipt.conversationId}/runs/${receipt.runId}?responseFormat=legacy`, base), {
          headers, signal: AbortSignal.timeout(10_000),
        });
        if (poll.status === 429) {
          const seconds = Number(poll.headers.get('Retry-After'));
          const waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000;
          await delay(Math.min(waitMs, Math.max(0, 120_000 - (Date.now() - started))));
          continue;
        }
        assert.equal(poll.status, 200, `Polling failed: ${await poll.clone().text()}`);
        const run = await poll.json() as { status: string; route?: { route: string }; result?: unknown; error?: string };
        assert(!['failed', 'cancelled'].includes(run.status), `${route} run ${receipt.runId} failed: ${run.error ?? run.status}`);
        if (run.status === 'completed') {
          assert.equal(run.route?.route, route);
          const result = agentTurnResultSchema.parse(run.result);
          assert(!result.warnings.some(warning => warning.code === 'PARTIAL_EVIDENCE'), 'Expected a full answer, received partial evidence');
          assert(result.citations.length > 0, 'An answer must contain citations');
          assert(result.billing.creditsCharged > 0, 'Evidence usage must be charged');
          if (route === 'topic_research' && !process.env.AGENT_TEST_MESSAGE) {
            assert.equal((run.route as { researchBreadth?: string }).researchBreadth, 'comparative', 'Recommendations should select comparative research');
            const reviewedVideos = new Set(result.artifacts
              .filter(artifact => artifact.type === 'youtube_transcript_analysis')
              .map(artifact => artifact.data.videoId));
            assert.equal(reviewedVideos.size, 4, 'Comparative research should analyze four distinct videos');
            assert(!result.warnings.some(warning => warning.code === 'RESEARCH_COVERAGE_SHORTFALL'), 'Expected the research coverage target to be met');
          }
          if (route === 'inspect_video') {
            assert(result.citations.some(citation => citation.sourceId.endsWith(':transcript')), 'Inspect must cite transcript evidence');
            assert(result.citations.some(citation => citation.id.startsWith('storyboard:')), 'Inspect must cite visual evidence');
            assert(result.artifacts.some(artifact => artifact.type.includes('storyboard')), 'Inspect must include a storyboard artifact');
          }
          console.log(JSON.stringify({ route, runId: receipt.runId, elapsedMs: Date.now() - started,
            citations: result.citations.length, billing: result.billing, status: 'passed' }));
          complete = true;
          break;
        }
        await delay(3000);
      }
      assert(complete, `${route} did not complete within the smoke test polling window`);
    } catch (error) {
      const failure = error instanceof Error ? error.message : `${route} failed`;
      failures.push(failure);
      console.error(failure);
    }
  }
  assert.equal(failures.length, 0, `${failures.length} live task(s) failed`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Live smoke test failed'); process.exitCode = 1; });
