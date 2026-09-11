'use client';

import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeftIcon, ArrowUpRightIcon, ArrowClockwiseIcon, PlusIcon, MagnifyingGlassIcon, ChatCircleTextIcon, CheckIcon, CircleNotchIcon, CaretRightIcon, WarningCircleIcon, YoutubeLogoIcon, CopyIcon } from '@phosphor-icons/react';
import { AgentPromptBar } from './AgentPromptBar';
import { AgentMarkdown } from './AgentMarkdown';
import { useAgentSessionCache } from './AgentSessionCache';
import { SessionLoading } from './SessionLoading';
import type { DashboardProject } from '../../../lib/dashboard-data';
import { useRouter } from 'next/navigation';
import { DashboardSidebar } from '../DashboardSidebar';
import { useDashboardSession } from '../DashboardSessionProvider';
import {
  agentSessionListSchema, agentSessionDetailSchema, fetchAgentData,
  mergeAgentMessages, safeSourceUrl, isActiveAgentRun, sendAgentMessage, watchAgentRun, AgentSendError,
  type AgentSessionList, type AgentSessionDetail, type AgentMessage, type AgentAdmission, type AgentProgress,
} from '../../../lib/agent-sessions';

export function AgentShell({ children }: { children: ReactNode }) {
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
  return <main className='workspace-shell agent-workspace'>
    <DashboardSidebar activeSection='sessions' projects={projects} credits={credits}
      onNavigate={section => router.push(`/dashboard?section=${section}`)}
      onNewProject={() => router.push('/dashboard?section=projects')}
      onOpenProject={() => router.push('/dashboard?section=projects')}
      onSignIn={() => router.push('/dashboard')} accountName={user?.name ?? user?.email}
      onSignOut={() => void signOut()} />
    <div className='workspace-main'>
      <header className='topbar'><div><span className='topbar-context'>Research workspace</span><h1>Agent</h1></div><Link href='/dashboard/sessions' prefetch={true} className='agent-new-session'><PlusIcon size={16} aria-hidden='true' />New session</Link></header>
      {children}
    </div>
  </main>;
}

export default function SessionsClient({ sessionId }: { sessionId?: string }) {
  const { agentAccess } = useDashboardSession();
  return <section className={`agent-sessions ${sessionId ? 'agent-thread' : 'agent-home'}`}>
    {!agentAccess ? <div className='agent-empty'><h2>Agent sessions are not available</h2><p>Your account must have agent access to view sessions.</p><Link href='/dashboard'>Back to dashboard</Link></div>
      : sessionId ? <SessionHistory key={sessionId} sessionId={sessionId} /> : <SessionList />}
  </section>;
}

function SessionList() {
  const router = useRouter();
  const [pendingMessage, showPendingMessage] = useOptimistic<PendingMessage | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  // Remount the paginated list when the query changes so older requests cannot overwrite a new search.
  return <>
    {!pendingMessage && <header className='agent-welcome'><h2>What would you like to learn?</h2><p>Explore a video, research a channel, or connect the dots across sources.</p></header>}
    {pendingMessage && <div className='agent-messages'><PendingUserMessage message={pendingMessage} /></div>}
    <MessageComposer onSendAction={showPendingMessage} onAdmitted={receipt => router.push(`/dashboard/sessions/${receipt.sessionId}`)} />
    <div hidden={!!pendingMessage}><form className='agent-search' onSubmit={(event: FormEvent) => { event.preventDefault(); setSearch(query.trim()); setRevision(value => value + 1); }}>
      <label className='sr-only' htmlFor='session-search'>Search your sessions</label>
      <div><MagnifyingGlassIcon size={17} aria-hidden='true' /><input id='session-search' value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder='Search sessions' /><button type='submit'>Search</button></div>
    </form>
    <SessionResults key={`${search}:${revision}`} search={search} /></div>
  </>;
}

function SessionResults({ search }: { search: string }) {
  const cache = useAgentSessionCache();
  const [page, setPage] = useState<AgentSessionList>(() => cache.readList(search) ?? { sessions: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void cache.loadList(search, revision > 0)
      .then(page => { if (!cancelled) setPage(page); })
      .catch(cause => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cache, search, revision]);

  const loadMore = async () => {
    if (!page.nextCursor || loading) return;
    setLoading(true); setError('');
    try {
      const next = await fetchAgentData(`/sessions?${new URLSearchParams({ q: search, limit: '20', cursor: page.nextCursor })}`, agentSessionListSchema);
      const merged = { ...next, sessions: [...new Map([...page.sessions, ...next.sessions].map(session => [session.sessionId, session])).values()] };
      setPage(merged); cache.saveList(search, merged);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  };
  return <>
    <div className='agent-list-heading'><h3>{search ? 'Search results' : 'Recent sessions'}</h3><button className='agent-icon-button' aria-label='Refresh sessions' title='Refresh sessions' disabled={loading} onClick={() => setRevision(value => value + 1)}><ArrowClockwiseIcon size={16} aria-hidden='true' /></button></div>
    {error && <p role='alert' className='alert error'>{error}</p>}
    <div className='agent-session-list' aria-busy={loading}>
      {page.sessions.map(session => <Link key={session.sessionId} href={`/dashboard/sessions/${session.sessionId}`} className='agent-session-row'>
        <span className='agent-session-icon'><ChatCircleTextIcon size={19} aria-hidden='true' /></span><div className='agent-session-copy'><h3>{session.title || 'Untitled session'}</h3><p>{session.latestMessagePreview}</p></div>
        <div className='agent-session-meta'><time dateTime={new Date(session.updatedAt).toISOString()}>{formatTime(session.updatedAt)}</time><span>{session.runCount} {session.runCount === 1 ? 'run' : 'runs'} <ArrowUpRightIcon size={13} aria-hidden='true' /></span></div>
      </Link>)}
      {!page.sessions.length && !loading && !error && <div className='agent-empty'><h3>{search ? 'No matching sessions' : 'No sessions yet'}</h3><p>{search ? 'Try another topic or clear your search.' : 'Start a session above. Requests from the API also appear here.'}</p></div>}
    </div>
    {loading && !page.sessions.length && <div className='agent-loading' role='status'><span className='sr-only'>Loading sessions…</span><span /><span /><span /></div>}
    {page.nextCursor && <button className='agent-load-more' disabled={loading} onClick={() => void loadMore()}>Load more sessions</button>}
  </>;
}

function SessionHistory({ sessionId }: { sessionId: string }) {
  const cache = useAgentSessionCache();
  const messagesRef = useRef<HTMLDivElement>(null);
  const [pendingMessage, showPendingMessage] = useOptimistic<PendingMessage | null>(null);
  const [session, setSession] = useState<AgentSessionDetail | undefined>(() => cache.readSessionPreview(sessionId));
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

  useEffect(() => {
    const messageId = cache.pendingFocus(sessionId);
    if (!messageId) return;
    const element = messagesRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      // Scroll synchronously with focus so incoming snapshots cannot restart an animation.
      element.scrollIntoView({ block: 'start', behavior: 'instant' });
      element.focus({ preventScroll: true });
      cache.clearFocus(sessionId);
    });
    return () => cancelAnimationFrame(frame);
  }, [cache, sessionId, session?.messages]);

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
    <div className='agent-thread-nav'><Link className='agent-back' href='/dashboard/sessions' prefetch={true} onMouseEnter={() => void cache.loadList('').catch(() => {})} onFocus={() => void cache.loadList('').catch(() => {})}><ArrowLeftIcon size={14} aria-hidden='true' />All sessions</Link>
      <button className='agent-icon-button' aria-label='Refresh session' title='Refresh session' disabled={loading || olderLoading || submitting} onClick={() => setRevision(value => value + 1)}><ArrowClockwiseIcon size={16} aria-hidden='true' /></button></div>
    {session && <header className='agent-heading'><div><h2>{session.title}</h2>
      <details className='agent-session-info'><summary>Session details</summary><p className='agent-id'>Session ID: {sessionId}</p></details></div></header>}
    {error && <p className='alert error' role='alert'>{error}</p>}
    {loading && !session && <SessionLoading />}
    {session?.nextCursor && <button className='agent-load-more' disabled={olderLoading || loading} onClick={() => void loadOlder()}>{olderLoading ? 'Loading…' : 'Load older messages'}</button>}
    <div ref={messagesRef} className='agent-messages' aria-busy={loading}>
      {session?.messages.map(message => message.role === 'user'
        ? <article className='agent-message agent-user-message' key={message.messageId} data-message-id={message.messageId} tabIndex={-1} aria-label='Your message'><header><strong>You</strong><time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time></header><div className='agent-answer'>{message.content}</div></article>
        : <RunAnswer key={`${message.messageId}:${revision}`} sessionId={sessionId} message={message} initiallyOpen={message.runId === session.lastRunId} onProgress={onProgress} />)}
      {pendingMessage && <PendingUserMessage message={pendingMessage} />}
    </div>
    {session && !session.messages.length && !loading && <p>No messages are available for this session yet.</p>}
    {session && <div className='agent-composer-dock'><MessageComposer sessionId={sessionId} onAdmitted={onAdmitted} onSending={setSubmitting} onSendAction={showPendingMessage}
      disabled={loading || session.messages.some(message => message.role === 'assistant' && isActiveAgentRun(message.status))} /></div>}
  </>;
}

function RunAnswer({ sessionId, message, initiallyOpen, onProgress }: {
  sessionId: string; message: AgentMessage; initiallyOpen: boolean; onProgress: (progress: AgentProgress) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen || !message.content);
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
    <header><span className='agent-avatar'><YoutubeLogoIcon size={17} aria-hidden='true' /></span><strong>Agent</strong><span className={`agent-status status-${status}`}>{status}</span><time dateTime={new Date(message.updatedAt).toISOString()}>{formatTime(message.updatedAt)}</time></header>
    {!open && <><AgentMarkdown>{message.content}</AgentMarkdown><button className='agent-answer-toggle' aria-expanded={open} onClick={() => setOpen(true)}>View sources and tool activity <CaretRightIcon size={13} aria-hidden='true' /></button></>}
    {open && <div className='agent-run-details'>
      {error && <p role='alert' className='alert error'>{error} <button onClick={() => setRevision(value => value + 1)}>Try again</button></p>}
      {!run && message.content && <AgentMarkdown>{message.content}</AgentMarkdown>}
      {!run && !error && <p className='agent-progress-label' role='status'><CircleNotchIcon className='agent-spin' size={15} aria-hidden='true' />{message.content ? 'Loading source details…' : 'Getting started…'}</p>}
      {run && !error && isActiveAgentRun(run.status) && <p className='agent-progress-label' role='status'><CircleNotchIcon className='agent-spin' size={15} aria-hidden='true' />{phaseLabel(progress?.phase)}</p>}
      {progress && <ToolTrace tools={progress.tools} />}
      {run?.error && <div className='alert error'><strong>This run failed</strong><p className='agent-answer'>{run.error}</p></div>}
      {run?.status === 'cancelled' && !result && <p>This run was cancelled before an answer was saved.</p>}
      {result && <>
        <div className='agent-result-meta'><span className={`agent-outcome outcome-${result.outcome}`}>{result.outcome.replaceAll('_', ' ')}</span>{result.coverage && <span>{result.coverage.reviewedVideos} {result.coverage.reviewedVideos === 1 ? 'video' : 'videos'} reviewed</span>}{run.billing && <span>{run.billing.creditsCharged} credits charged</span>}</div>
        <AgentMarkdown>{result.answer}</AgentMarkdown>
        {!!result.sources.length && <section className='agent-sources'><h3>Sources</h3><ul>{result.sources.map(source => {
          const href = safeSourceUrl(source.url);
          return <li key={source.id}>{href ? <a href={href} target='_blank' rel='noreferrer'><span className='agent-source-number'>[{source.id}]</span><span>{source.title}</span><ArrowUpRightIcon size={13} aria-hidden='true' /></a> : <span>[{source.id}] {source.title}</span>}</li>;
        })}</ul></section>}
        {!!result.warnings.length && <details className='agent-caveats'><summary>Source notes and limitations ({result.warnings.length})</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul></details>}
      </>}
      <div className='agent-answer-actions'>{result && <CopyAnswer answer={result.answer} />}<details><summary>Run details</summary><p className='agent-id'>Run ID: {message.runId}</p></details></div>
    </div>}
  </article>;
}

interface PendingMessage { key: string; message: string }

function PendingUserMessage({ message }: { message: PendingMessage }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    ref.current?.focus({ preventScroll: true });
  }, [message.key]);
  return <article ref={ref} className='agent-message agent-user-message agent-pending-message' tabIndex={-1} aria-label='Your message'>
    <header><strong>You</strong><span className='agent-delivery-status' role='status'>Sending…</span></header>
    <div className='agent-answer'>{message.message}</div>
  </article>;
}

function MessageComposer({ sessionId, disabled = false, onAdmitted, onSending, onSendAction }: {
  sessionId?: string; disabled?: boolean; onSending?: (sending: boolean) => void;
  onSendAction: (message: PendingMessage) => void; onAdmitted: (receipt: AgentAdmission, message: string) => void;
}) {
  const cache = useAgentSessionCache();
  const [draft, setDraft] = useState('');
  const [sending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  const attempt = useRef<(PendingMessage & { draft: string }) | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || inFlight.current || sending || !draft.trim()) return;
    // Keep the exact body and key when admission may have succeeded upstream.
    const request = attempt.current ?? { message: draft.trim(), draft, key: crypto.randomUUID() };
    attempt.current = request;
    inFlight.current = true;
    setDraft(''); setError(''); onSending?.(true);
    startTransition(async () => {
      onSendAction(request);
      try {
        const receipt = await sendAgentMessage(request.message, request.key, sessionId);
        // Commit the server messages and remove the optimistic message together.
        startTransition(() => {
          cache.recordAdmission(receipt, request.message);
          onAdmitted(receipt, request.message);
        });
        attempt.current = null; setUncertain(false);
      } catch (cause) {
        const retryable = cause instanceof AgentSendError && cause.retryable;
        setDraft(request.draft);
        setError(errorMessage(cause)); setUncertain(retryable);
        if (!retryable) attempt.current = null;
      } finally { inFlight.current = false; onSending?.(false); }
    });
  };
  return <AgentPromptBar value={draft} onChange={setDraft} onSubmit={submit}
    label={sessionId ? 'Follow-up message' : 'Start a new session'}
    sendLabel={sending ? 'Sending…' : uncertain ? 'Retry sending' : sessionId ? 'Send follow-up' : 'Start session'}
    disabled={disabled} sending={sending} uncertain={uncertain} error={error} />;
}

function phaseLabel(phase?: AgentProgress['phase']) {
  switch (phase) {
    case 'classification': return 'Understanding your request.';
    case 'research': return 'Researching YouTube sources.';
    case 'finalization': return 'Writing and checking the answer.';
    default: return 'Waiting for the run to start.';
  }
}

// Compact disclosure rows follow Beautiful UI's Tool Chips pattern.
function ToolTrace({ tools }: { tools: AgentProgress['tools'] }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const running = tools.some(tool => tool.status === 'running');
  const open = expanded ?? running;
  if (!tools.length) return null;
  return <div className='agent-trace'>
    <button className='agent-trace-toggle' aria-expanded={open} onClick={() => setExpanded(!open)}>
      <CaretRightIcon size={13} className={open ? 'is-open' : ''} aria-hidden='true' />
      Tool activity ({tools.length})<span>{running ? 'In progress' : `${tools.filter(tool => tool.status === 'completed').length} completed`}</span>
    </button>
    {open && <ol>{tools.map(tool => <li key={tool.toolCallId}>
      <details className='agent-tool-chip'><summary>
        <span className={`agent-tool-icon status-${tool.status}`}>{tool.status === 'running' ? <CircleNotchIcon className='agent-spin' size={14} aria-hidden='true' />
          : tool.status === 'completed' ? <CheckIcon size={14} aria-hidden='true' /> : <WarningCircleIcon size={14} aria-hidden='true' />}</span>
        <span className='agent-tool-name'>{tool.name.replaceAll('_', ' ')}</span>
        <span className='agent-tool-target'>{String(tool.input.videoId ?? tool.input.query ?? tool.input.channelId ?? '')}</span>
        <span className='sr-only'>{tool.status}</span>
        {tool.finishedAt !== undefined && <span className='agent-tool-duration'>{Math.max(0, (tool.finishedAt - tool.startedAt) / 1000).toFixed(1)}s</span>}
        <CaretRightIcon className='agent-tool-caret' size={12} aria-hidden='true' /></summary>
        <div className='agent-tool-content'>
          {!!Object.keys(tool.input).length && <><h4>Input</h4><pre>{JSON.stringify(tool.input, null, 2)}</pre></>}
          {tool.output && <><h4>Result</h4><p>{tool.output.sourceCount} {tool.output.sourceCount === 1 ? 'source' : 'sources'} · {tool.output.excerptCount} evidence excerpts</p>
            <ul>{tool.output.sources.map((source, index) => <li key={index}>{source.title ?? source.videoId ?? source.channelId ?? 'YouTube source'}</li>)}</ul>
            {!!tool.output.warningCodes.length && <p>Notes: {tool.output.warningCodes.join(', ')}</p>}</>}
          {tool.status === 'failed' && <p>This tool did not complete successfully. Check the answer's source notes for any effect on coverage.</p>}
          {tool.status === 'running' && <p>Waiting for the tool result…</p>}
        </div>
      </details>
    </li>)}</ol>}
  </div>;
}

function CopyAnswer({ answer }: { answer: string }) {
  const [status, setStatus] = useState('');
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(''), 2_000); return () => clearTimeout(timer); }, [status]);
  return <button className='agent-copy-answer' onClick={() => {
    void navigator.clipboard.writeText(answer).then(() => setStatus('Copied'), () => setStatus('Could not copy'));
  }}><CopyIcon size={14} aria-hidden='true' /><span aria-live='polite'>{status || 'Copy answer'}</span></button>;
}

function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : 'Could not load sessions. Please try again.'; }
function formatTime(timestamp: number) { return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
