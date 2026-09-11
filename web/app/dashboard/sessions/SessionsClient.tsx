'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { DashboardProject } from '../../../lib/dashboard-data';
import { useRouter } from 'next/navigation';
import { DashboardSidebar } from '../DashboardSidebar';
import { useDashboardSession } from '../DashboardSessionProvider';
import {
  agentSessionListSchema, agentSessionDetailSchema, fetchAgentData,
  mergeAgentMessages, safeSourceUrl, isActiveAgentRun, sendAgentMessage, watchAgentRun, AgentSendError,
  type AgentSessionList, type AgentSessionDetail, type AgentMessage, type AgentAdmission, type AgentProgress,
} from '../../../lib/agent-sessions';

export default function SessionsClient({ sessionId }: { sessionId?: string }) {
  const router = useRouter();
  const { user, agentAccess, signOut } = useDashboardSession();
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [credits, setCredits] = useState<number>();
  useEffect(() => {
    if (!user || !agentAccess) return;
    const controller = new AbortController();
    const load = async () => {
      const get = async (path: string) => {
        const response = await fetch(`/api/platform/v1/${path}`, { credentials: 'include', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Account information unavailable');
        return response.json();
      };
      const [projectData, usage] = await Promise.allSettled([get('projects'), get('usage')]);
      if (controller.signal.aborted) return;
      if (projectData.status === 'fulfilled') setProjects(projectData.value.projects);
      if (usage.status === 'fulfilled') setCredits(usage.value.creditBalance);
    };
    void load();
    return () => controller.abort();
  }, [user?.id, agentAccess]);
  return <main className='workspace-shell'>
    <DashboardSidebar activeSection='sessions' projects={projects} credits={credits}
      onNavigate={section => router.push(`/dashboard?section=${section}`)}
      onNewProject={() => router.push('/dashboard?section=projects')}
      onOpenProject={() => router.push('/dashboard?section=projects')}
      onSignIn={() => router.push('/dashboard')} accountName={user?.name ?? user?.email}
      onSignOut={() => void signOut()} />
    <div className='workspace-main'>
      <header className='topbar'><div><span className='topbar-context'>Research workspace</span><h1>Agent sessions</h1></div></header>
      <section className='agent-sessions'>
        {!agentAccess ? <div className='agent-empty'><h2>Agent sessions are not available</h2><p>Your account must have agent access to view sessions.</p><Link href='/dashboard'>Back to dashboard</Link></div>
          : sessionId ? <SessionHistory sessionId={sessionId} /> : <SessionList />}
      </section>
    </div>
  </main>;
}

function SessionList() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  // Remount the paginated list when the query changes so older requests cannot overwrite a new search.
  return <>
    <header className='agent-heading'><div><p className='panel-label'>Your research history</p><h2>Pick up where you left off.</h2><p>Continue a session or start a new YouTube research request.</p></div></header>
    <MessageComposer onAdmitted={receipt => router.push(`/dashboard/sessions/${receipt.sessionId}`)} />
    <form className='agent-search' onSubmit={(event: FormEvent) => { event.preventDefault(); setSearch(query.trim()); setRevision(value => value + 1); }}>
      <label htmlFor='session-search'>Search your sessions</label>
      <div><input id='session-search' value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder='Search by topic or request' /><button type='submit'>Search</button></div>
    </form>
    <SessionResults key={`${search}:${revision}`} search={search} />
  </>;
}

function SessionResults({ search }: { search: string }) {
  const [page, setPage] = useState<AgentSessionList>({ sessions: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetchAgentData(`/sessions?${new URLSearchParams({ q: search, limit: '20' })}`, agentSessionListSchema, controller.signal)
      .then(setPage).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, revision]);

  const loadMore = async () => {
    if (!page.nextCursor || loading) return;
    setLoading(true); setError('');
    try {
      const next = await fetchAgentData(`/sessions?${new URLSearchParams({ q: search, limit: '20', cursor: page.nextCursor })}`, agentSessionListSchema);
      setPage(previous => ({ ...next, sessions: [...new Map([...previous.sessions, ...next.sessions].map(session => [session.sessionId, session])).values()] }));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  };
  return <>
    <div className='agent-list-heading'><h3>{search ? 'Search results' : 'Recent sessions'}</h3><button disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh</button></div>
    {error && <p role='alert' className='alert error'>{error}</p>}
    <div className='agent-session-list' aria-busy={loading}>
      {page.sessions.map(session => <Link key={session.sessionId} href={`/dashboard/sessions/${session.sessionId}`} className='agent-session-row'>
        <div><h3>{session.title || 'Untitled session'}</h3><p>{session.latestMessagePreview}</p></div>
        <div className='agent-session-meta'><time dateTime={new Date(session.updatedAt).toISOString()}>{formatTime(session.updatedAt)}</time><span>{session.runCount} {session.runCount === 1 ? 'run' : 'runs'} <span aria-hidden='true'>↗</span></span></div>
      </Link>)}
      {!page.sessions.length && !loading && !error && <div className='agent-empty'><h3>{search ? 'No matching sessions' : 'No sessions yet'}</h3><p>{search ? 'Try another topic or clear your search.' : 'Start a session above. Requests from the API also appear here.'}</p></div>}
    </div>
    {loading && <p role='status'>Loading sessions…</p>}
    {page.nextCursor && <button className='agent-load-more' disabled={loading} onClick={() => void loadMore()}>Load more sessions</button>}
  </>;
}

function SessionHistory({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<AgentSessionDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [olderLoading, setOlderLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const onProgress = useCallback((progress: AgentProgress) => {
    setSession(current => current ? { ...current, messages: current.messages.map(message =>
      message.role === 'assistant' && message.runId === progress.run.runId
        ? { ...message, status: progress.run.status, content: progress.run.result?.answer ?? message.content } : message) } : current);
  }, []);
  const onAdmitted = (receipt: AgentAdmission, content: string) => {
    const now = Date.now();
    const shared = { runId: receipt.runId, conversationTurn: receipt.diagnostics.conversationTurn, createdAt: now, updatedAt: now };
    setSession(current => current ? { ...current, lastRunId: receipt.runId, updatedAt: now, runCount: current.runCount + 1,
      messages: mergeAgentMessages(current.messages, [
        { ...shared, messageId: receipt.diagnostics.userMessageId, parentMessageId: null, role: 'user', status: 'completed', content },
        { ...shared, messageId: receipt.assistantMessageId, parentMessageId: receipt.diagnostics.userMessageId, role: 'assistant', status: receipt.status, content: '' },
      ]) } : current);
  };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetchAgentData(`/sessions/${sessionId}?limit=10`, agentSessionDetailSchema, controller.signal)
      .then(setSession).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, revision]);

  const loadOlder = async () => {
    if (!session?.nextCursor || olderLoading) return;
    setOlderLoading(true); setError('');
    try {
      const older = await fetchAgentData(`/sessions/${sessionId}?${new URLSearchParams({ limit: '10', cursor: session.nextCursor })}`, agentSessionDetailSchema);
      setSession(current => current ? { ...current, messages: mergeAgentMessages(current.messages, older.messages), nextCursor: older.nextCursor } : older);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setOlderLoading(false); }
  };
  return <>
    <Link className='agent-back' href='/dashboard/sessions'>← All sessions</Link>
    <header className='agent-heading'><div><p className='panel-label'>Session history</p><h2>{session?.title ?? 'Loading session…'}</h2><p className='agent-id'>Session ID: {sessionId}</p></div><button disabled={loading || olderLoading || submitting} onClick={() => setRevision(value => value + 1)}>Refresh</button></header>
    {error && <p className='alert error' role='alert'>{error}</p>}
    {loading && <p role='status'>Loading messages…</p>}
    {session?.nextCursor && <button className='agent-load-more' disabled={olderLoading || loading} onClick={() => void loadOlder()}>{olderLoading ? 'Loading…' : 'Load older messages'}</button>}
    <div className='agent-messages' aria-busy={loading}>
      {session?.messages.map(message => message.role === 'user'
        ? <article className='agent-message agent-user-message' key={message.messageId}><header><strong>You</strong><time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time></header><div className='agent-answer'>{message.content}</div></article>
        : <RunAnswer key={`${message.messageId}:${revision}`} sessionId={sessionId} message={message} initiallyOpen={message.runId === session.lastRunId} onProgress={onProgress} />)}
    </div>
    {session && !session.messages.length && !loading && <p>No messages are available for this session yet.</p>}
    {session && <MessageComposer sessionId={sessionId} onAdmitted={onAdmitted} onSending={setSubmitting}
      disabled={loading || session.messages.some(message => message.role === 'assistant' && isActiveAgentRun(message.status))} />}
  </>;
}

function RunAnswer({ sessionId, message, initiallyOpen, onProgress }: {
  sessionId: string; message: AgentMessage; initiallyOpen: boolean; onProgress: (progress: AgentProgress) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [progress, setProgress] = useState<AgentProgress>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    // Keep an active run connected even when its answer details are collapsed.
    if (!open && !isActiveAgentRun(message.status)) return;
    const controller = new AbortController();
    void watchAgentRun(sessionId, message.runId, controller.signal, snapshot => {
      if (controller.signal.aborted) return;
      setProgress(snapshot); setError(''); onProgress(snapshot);
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [open, sessionId, message.runId, revision, onProgress]);
  const run = progress?.run;
  const status = run?.status ?? message.status;
  const result = run?.result;
  return <article className='agent-message agent-assistant-message'>
    <header><strong>Agent</strong><span className={`agent-status status-${status}`}>{status}</span><time dateTime={new Date(message.updatedAt).toISOString()}>{formatTime(message.updatedAt)}</time></header>
    <button className='agent-answer-toggle' aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide answer details' : 'View answer and sources'}</button>
    {!open && <p className='agent-answer-preview'>{message.content.replace(/\[cite:[^\]]+\]/g, '') || (isActiveAgentRun(status) ? 'This run is still in progress.' : 'Open this run to view its result.')}</p>}
    {open && <div className='agent-run-details'>
      {error && <p role='alert' className='alert error'>{error} <button onClick={() => setRevision(value => value + 1)}>Try again</button></p>}
      {!run && !error && <p role='status'>Loading answer…</p>}
      {run && !error && isActiveAgentRun(run.status) && <p role='status'>{phaseLabel(progress?.phase)} Live updates are connected.</p>}
      {progress && <ToolTrace tools={progress.tools} />}
      {run?.error && <div className='alert error'><strong>This run failed</strong><p className='agent-answer'>{run.error}</p></div>}
      {run?.status === 'cancelled' && !result && <p>This run was cancelled before an answer was saved.</p>}
      {result && <>
        <div className='agent-result-meta'><span>{result.outcome.replaceAll('_', ' ')}</span>{result.coverage && <span>{result.coverage.reviewedVideos} {result.coverage.reviewedVideos === 1 ? 'video' : 'videos'} reviewed</span>}{run.billing && <span>{run.billing.creditsCharged} credits charged</span>}</div>
        <div className='agent-answer'>{result.answer}</div>
        {!!result.sources.length && <section className='agent-sources'><h3>Sources</h3><ul>{result.sources.map(source => {
          const href = safeSourceUrl(source.url);
          return <li key={source.id}><span>[{source.id}]</span>{href ? <a href={href} target='_blank' rel='noreferrer'>{source.title} ↗</a> : <span>{source.title}</span>}</li>;
        })}</ul></section>}
        {!!result.warnings.length && <details className='agent-caveats'><summary>Source notes and limitations ({result.warnings.length})</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul></details>}
      </>}
      <p className='agent-id'>Run ID: {message.runId}</p>
    </div>}
  </article>;
}

function MessageComposer({ sessionId, disabled = false, onAdmitted, onSending }: {
  sessionId?: string; disabled?: boolean; onSending?: (sending: boolean) => void; onAdmitted: (receipt: AgentAdmission, message: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{ message: string; key: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || sending || !draft.trim()) return;
    // Keep the exact body and key when admission may have succeeded upstream.
    const request = attempt.current ?? { message: draft.trim(), key: crypto.randomUUID() };
    attempt.current = request;
    setSending(true); onSending?.(true); setError('');
    try {
      const receipt = await sendAgentMessage(request.message, request.key, sessionId);
      onAdmitted(receipt, request.message);
      setDraft(''); attempt.current = null; setUncertain(false);
    } catch (cause) {
      const retryable = cause instanceof AgentSendError && cause.retryable;
      setError(errorMessage(cause)); setUncertain(retryable);
      if (!retryable) attempt.current = null;
    } finally { setSending(false); onSending?.(false); }
  };
  return <form className='agent-composer' onSubmit={event => void submit(event)}>
    <label htmlFor='agent-message'>{sessionId ? 'Follow-up message' : 'Start a new session'}</label>
    <textarea id='agent-message' value={draft} onChange={event => setDraft(event.target.value)}
      readOnly={sending || uncertain} maxLength={10_000} rows={3}
      aria-describedby='agent-composer-help' placeholder={sessionId ? 'Ask a follow-up or explore another detail…' : 'Paste a YouTube URL or describe what you want to research…'} />
    <div className='agent-composer-footer'><p id='agent-composer-help'>{disabled ? 'Wait for the active run to finish before sending another message.' : sessionId ? 'The agent uses the prior turns in this session. Each new run uses credits.' : 'Research videos, channels, transcripts, comments, and sampled frames.'}</p>
      <button type='submit' disabled={disabled || sending || !draft.trim()}>{sending ? 'Sending…' : uncertain ? 'Retry sending' : sessionId ? 'Send follow-up' : 'Start session'}</button></div>
    {error && <p className='alert error' role='alert'>{error}</p>}
  </form>;
}

function phaseLabel(phase?: AgentProgress['phase']) {
  switch (phase) {
    case 'classification': return 'Understanding your request.';
    case 'research': return 'Researching YouTube sources.';
    case 'finalization': return 'Writing and checking the answer.';
    default: return 'Waiting for the run to start.';
  }
}

function ToolTrace({ tools }: { tools: AgentProgress['tools'] }) {
  return <details className='agent-trace' open={tools.some(tool => tool.status === 'running')}>
    <summary>Tool activity ({tools.length})</summary>
    {!tools.length && <p>No tool calls were recorded for this run.</p>}
    <ol>{tools.map(tool => <li key={tool.toolCallId}>
      <details><summary><span>{tool.name.replaceAll('_', ' ')}</span><span className={`agent-status status-${tool.status}`}>{tool.status}</span>
        {tool.finishedAt !== undefined && <span>{Math.max(0, (tool.finishedAt - tool.startedAt) / 1000).toFixed(1)}s</span>}</summary>
        {!!Object.keys(tool.input).length && <><h4>Input</h4><pre>{JSON.stringify(tool.input, null, 2)}</pre></>}
        {tool.output && <><h4>Result</h4><p>{tool.output.sourceCount} sources · {tool.output.excerptCount} evidence excerpts</p>
          <ul>{tool.output.sources.map((source, index) => <li key={index}>{source.title ?? source.videoId ?? source.channelId ?? 'YouTube source'}</li>)}</ul>
          {!!tool.output.warningCodes.length && <p>Notes: {tool.output.warningCodes.join(', ')}</p>}</>}
        {tool.status === 'failed' && <p>This tool did not complete successfully. Check the answer’s source notes for any effect on coverage.</p>}
        {tool.status === 'running' && <p>Waiting for the tool result…</p>}
      </details>
    </li>)}</ol>
  </details>;
}

function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : 'Could not load sessions. Please try again.'; }
function formatTime(timestamp: number) { return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
