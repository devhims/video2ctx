// Evaluation harness for indexed transcript retrieval (reference: .scratch/video-index-retrieval/PRD.md, Phase 0).
//
// offline  test/transcript-retrieval.eval.test.ts runs the platform's own passage builder, embeddings, chapters,
//          packer, routing and chapter extraction against local transcripts with real provider calls:
//            AGENT_INDEX_EVAL=1 FIREWORKS_API_KEY=... [JEV_API_KEY=...] AGENT_INDEX_TRANSCRIPTS=<dir> \
//              npx vitest run test/transcript-retrieval.eval.test.ts
// agent    Sends every question to a running local Worker and records answers, citations and latency.
//          Start the Worker once per arm with AGENT_TRANSCRIPT_RETRIEVAL=full or =index.
//            AGENT_TEST_TOKEN=... npx tsx scripts/eval-transcript-retrieval.ts agent --arm full
//            AGENT_TEST_TOKEN=... npx tsx scripts/eval-transcript-retrieval.ts agent --arm index --warm
//          Against a non-production local Worker, AGENT_EVAL_DEMO_USER=<name> replaces the token.
// sheet    Writes one blind grading sheet from every recorded agent arm.
// score    Reads the graded sheet and prints facts stated, wrong-claim answers, cited fact locations and latency per arm.
//
// Outputs go to --out (default ../.scratch/transcript-retrieval-eval). Transcripts and answers never enter git.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Fact { id: string; claim: string; evidence: number[][]; timeRanges: number[][]; optional?: boolean; name?: string; nameInCaptions?: boolean }
interface Question { id: string; set: 'test4' | 'react' | 'summary'; videoId: string; kind: string; wholeVideo: boolean; question: string; answer?: string; facts: Fact[]; mustNotClaim: string[] }
interface Fixtures { videos: Record<string, { title: string; captions: number; durationMs: number; creatorChapters?: { title: string; startMs: number }[] }>; questions: Question[] }

const [phase = 'agent', ...rest] = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : fallback;
};
const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, '../benchmarks/transcript-retrieval/questions.json'), 'utf8')) as Fixtures;
const out = resolve(flag('out', resolve(import.meta.dirname, '../../.scratch/transcript-retrieval-eval'))!);
mkdirSync(out, { recursive: true });
const save = (name: string, value: unknown) => writeFileSync(resolve(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 1), { mode: 0o600 });
const read = <T>(name: string): T => JSON.parse(readFileSync(resolve(out, name), 'utf8')) as T;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 6);
const scored = (question: Question) => question.facts.filter(fact => !fact.optional);
const targeted = (question: Question) => !question.wholeVideo && question.kind !== 'abstention';

interface AgentRow { id: string; arm: string; runId?: string; answer?: string; error?: string; elapsedMs: number; citations: { id: string; startMs?: number; endMs?: number }[]; warnings: string[]; factsCited?: number; facts: number }

async function agent() {
  const arm = flag('arm');
  if (!arm || !/^[a-z0-9-]+$/.test(arm)) throw new Error('Set --arm to a label such as full or index, matching the AGENT_TRANSCRIPT_RETRIEVAL value the Worker runs with.');
  const base = new URL(process.env.AGENT_EVAL_BASE_URL ?? 'http://127.0.0.1:8787');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('The harness only targets a local Worker.');
  // A tester API key, or a demo user on a non-production local Worker.
  const headers: Record<string, string> = { 'Content-Type': 'application/json',
    ...(process.env.AGENT_TEST_TOKEN ? { Authorization: `Bearer ${process.env.AGENT_TEST_TOKEN}` }
      : process.env.AGENT_EVAL_DEMO_USER ? { 'x-demo-user': process.env.AGENT_EVAL_DEMO_USER } : {}) };
  const only = flag('only')?.split(',');
  const questions = fixtures.questions.filter(question => !only || only.includes(question.id));
  const ask = async (message: string) => {
    const started = Date.now();
    const admitted = await fetch(new URL('/v1/agent?responseFormat=legacy', base), { method: 'POST', headers, body: JSON.stringify({ message }), signal: AbortSignal.timeout(30_000) });
    if (admitted.status !== 202) throw new Error(`Admission ${admitted.status}: ${(await admitted.text()).slice(0, 300)}`);
    const receipt = await admitted.json() as { sessionId: string; runId: string };
    while (Date.now() - started < 300_000) {
      await new Promise(resolve => setTimeout(resolve, 3_000));
      const poll = await fetch(new URL(`/v1/agent/${receipt.sessionId}/runs/${receipt.runId}?responseFormat=legacy`, base), { headers, signal: AbortSignal.timeout(15_000) });
      if (poll.status === 429) continue;
      const run = await poll.json() as { status: string; error?: string; result?: { answer: string; citations: { id: string; startMs?: number; endMs?: number }[]; warnings: { code: string }[] } };
      if (run.status === 'completed') return { runId: receipt.runId, elapsedMs: Date.now() - started, result: run.result! };
      if (['failed', 'cancelled'].includes(run.status)) throw new Error(`${run.status}: ${run.error ?? ''}`);
    }
    throw new Error('Run did not finish within 5 minutes.');
  };
  // The index arm answers from a ready index only. One warm-up question per video starts the build.
  if (arm.startsWith('index') && rest.includes('--warm')) {
    for (const videoId of new Set(questions.map(question => question.videoId))) {
      await ask(`What is this video about? https://youtu.be/${videoId}`).catch(error => console.warn('warm-up failed', videoId, String(error)));
    }
    const waitMs = Number(flag('wait-ms', '60000'));
    console.log(`waiting ${waitMs} ms for background index builds`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  const file = `agent-${arm}.json`;
  const rows: AgentRow[] = existsSync(resolve(out, file)) ? read<AgentRow[]>(file) : [];
  for (const question of questions) {
    if (rows.some(row => row.id === question.id && row.answer)) continue;
    const started = Date.now();
    try {
      const { runId, elapsedMs, result } = await ask(`${question.question}\n\nhttps://youtu.be/${question.videoId}`);
      const citations = result.citations.map(citation => ({ id: citation.id, startMs: citation.startMs, endMs: citation.endMs }));
      const factsCited = scored(question).filter(fact => fact.timeRanges.some(([a, b]) => citations.some(citation =>
        citation.startMs !== undefined && citation.startMs < b! && (citation.endMs ?? citation.startMs) > a!))).length;
      rows.push({ id: question.id, arm, runId, answer: result.answer, elapsedMs, citations, warnings: result.warnings.map(warning => warning.code), factsCited, facts: scored(question).length });
      console.log(question.id, arm, `${Math.round(elapsedMs / 1000)}s`, `fact locations cited ${factsCited}/${scored(question).length}`);
    } catch (error) {
      rows.push({ id: question.id, arm, error: String(error).slice(0, 300), elapsedMs: Date.now() - started, citations: [], warnings: [], facts: scored(question).length });
      console.warn(question.id, arm, String(error).slice(0, 200));
    }
    // A retried question replaces its earlier failure.
    save(file, [...new Map(rows.map(row => [row.id, row])).values()]);
  }
}

/** Every recorded arm, such as full, index or an index variant. */
const recordedArms = () => readdirSync(out).flatMap(name => /^agent-(.+)\.json$/.exec(name)?.[1] ?? []).sort();

function sheet() {
  const arms = recordedArms();
  const answers = arms.flatMap(arm => read<AgentRow[]>(`agent-${arm}.json`));
  const lines = ['# Transcript retrieval: blind grading sheet', '',
    'Grade against the transcript. Tick a fact only if the answer states all of its parts. Tick the last box if the answer states something the transcript contradicts or does not support. Answer IDs hide which path produced them.'];
  for (const question of fixtures.questions) {
    lines.push('', `## ${question.id}: ${question.question}`, '', ...(question.answer ? [`Reference: ${question.answer}`, ''] : []),
      ...scored(question).map(fact => `- FACT ${fact.id}: ${fact.claim}`),
      ...(question.mustNotClaim.length ? [`- MUST NOT CLAIM: ${question.mustNotClaim.join(' / ')}`] : []));
    for (const row of answers.filter(item => item.id === question.id).sort((a, b) => hash(`${a.arm}:${a.id}`).localeCompare(hash(`${b.arm}:${b.id}`))))
      lines.push('', `### answer ${hash(`${row.arm}:${row.id}`)}${row.error ? ' FAILED' : ''}`, row.answer ?? row.error ?? '', '',
        ...scored(question).map(fact => `- [ ] ${fact.id}`), '- [ ] contains a wrong claim');
  }
  save('review-sheet.md', lines.join('\n'));
  console.log(`wrote ${resolve(out, 'review-sheet.md')}`);
}

function score() {
  const text = readFileSync(resolve(out, flag('sheet', 'review-sheet.md')!), 'utf8');
  const grades: Record<string, { facts: Set<string>; wrong: boolean }> = {};
  let current = '';
  for (const line of text.split('\n')) {
    const answer = /^### answer ([0-9a-f]{6})/.exec(line);
    if (answer) { current = answer[1]!; grades[current] = { facts: new Set(), wrong: false }; continue; }
    const box = /^- \[([ xX])\] (.+)$/.exec(line);
    if (!box || !current || box[1] === ' ') continue;
    if (box[2] === 'contains a wrong claim') grades[current]!.wrong = true; else grades[current]!.facts.add(box[2]!.trim());
  }
  for (const arm of recordedArms()) {
    const rows = read<AgentRow[]>(`agent-${arm}.json`);
    for (const [label, keep] of [['targeted', targeted], ['whole video', (q: Question) => q.wholeVideo], ['abstention', (q: Question) => q.kind === 'abstention']] as const) {
      const group = rows.filter(row => keep(fixtures.questions.find(question => question.id === row.id)!));
      if (!group.length) continue;
      const graded = group.map(row => ({ row, grade: grades[hash(`${row.arm}:${row.id}`)] }));
      const facts = graded.reduce((sum, { row, grade }) => sum + scored(fixtures.questions.find(q => q.id === row.id)!).filter(fact => grade?.facts.has(fact.id)).length, 0);
      const total = group.reduce((sum, row) => sum + row.facts, 0);
      const median = [...group.map(row => row.elapsedMs)].sort((a, b) => a - b)[group.length >> 1]!;
      console.log(arm.padEnd(6), label.padEnd(12), `facts ${facts}/${total}`, `wrong-claim answers ${graded.filter(item => item.grade?.wrong).length}/${group.length}`,
        `fact locations cited ${group.reduce((s, r) => s + (r.factsCited ?? 0), 0)}/${total}`, `median ${Math.round(median / 1000)}s`, `ungraded ${graded.filter(item => !item.grade).length}`);
    }
  }
}

const phases: Record<string, () => unknown> = { agent, sheet, score };
if (!phases[phase]) throw new Error(`Unknown phase ${phase}. Use agent, sheet or score; the offline phase runs under Vitest.`);
await phases[phase]!();
