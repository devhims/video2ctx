'use client';

import { agentToolLabel } from '../../../lib/agent-tool-labels';
import { platformRequest } from '../../../lib/platform-request';
import { projectItemPath } from '../dashboard-routes';

import { SessionAssets } from './SessionAssets';
import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeftIcon, ArrowUpRightIcon, ArrowClockwiseIcon, PlusIcon, MagnifyingGlassIcon, ChatCircleTextIcon, CheckIcon, CircleNotchIcon, CaretRightIcon, WarningCircleIcon, UserIcon, StarFourIcon } from '@phosphor-icons/react';
import { AgentPromptBar } from './AgentPromptBar';
import { AgentMarkdown } from './AgentMarkdown';
import { StreamingAgentMarkdown } from './StreamingAgentMarkdown';
import { useAgentSessionCache } from './AgentSessionCache';
import { SessionLoading } from './SessionLoading';
import { DashboardSkeleton } from '../DashboardSkeleton';
import { HistoryEmptyState } from '../HistoryEmptyState';
import { FramePreviews } from './FramePreviews';
import { useAccountResource } from '../DashboardDataProvider';
import { useRouter } from 'next/navigation';
import { DashboardHeader } from '../DashboardHeader';
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
  const projectsResource = useAccountResource('projects', []);
  const usageResource = useAccountResource('usage', null);
  const projects = projectsResource.data;
  const credits = usageResource.data?.creditBalance;
  const accountError = projectsResource.error || usageResource.error;
  return <main className='workspace-shell agent-workspace'>
    <DashboardSidebar activeSection='sessions' projects={projects} credits={credits}
      onNavigate={section => router.push(`/dashboard/${section === 'discover' ? 'sources' : section}`)}
      onNewProject={() => router.push('/dashboard/projects?newProject=1')}
      onOpenProject={project => router.push(`/dashboard/projects?project=${encodeURIComponent(project.id)}`)}
      onOpenProjectItem={(project, item) => router.push(projectItemPath(project.id, item))}
      onSignIn={() => router.push('/login?returnTo=%2Fdashboard%2Fsessions')} accountName={user?.name ?? user?.email}
      onSignOut={() => void signOut()} />
    <div className='workspace-main'>
      <DashboardHeader title='Agent'>{agentAccess && <Link href='/dashboard/sessions' prefetch={true} className='agent-new-session'><PlusIcon size={16} aria-hidden='true' />New session</Link>}</DashboardHeader>
      {accountError && <p role='alert'>{accountError}</p>}
      {children}
    </div>
  </main>;
}

export default function SessionsClient({ sessionId }: { sessionId?: string }) {
  const { agentAccess, adminAccess, accessReady } = useDashboardSession();
  return <section className={`agent-sessions ${sessionId ? 'agent-thread' : 'agent-home'}`}>
    {!accessReady ? <SessionLoading /> : !(agentAccess || (sessionId && adminAccess)) ? <div className='agent-empty'><h2>Agent sessions are not available</h2><p>Your account must have agent access to view sessions.</p><Link href='/dashboard'>Back to dashboard</Link></div>
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
    {!pendingMessage && <header className='agent-welcome'><h2>Ask about a video or topic</h2></header>}
    {pendingMessage && <div className='agent-messages'><PendingUserMessage message={pendingMessage} /></div>}
    <MessageComposer onSendAction={showPendingMessage} onAdmitted={receipt => router.push(`/dashboard/sessions/${receipt.sessionId}`)} />
    <div className='agent-history' hidden={!!pendingMessage}><SessionResults key={`${search}:${revision}`} search={search} searchForm={<form className='agent-search' onSubmit={(event: FormEvent) => { event.preventDefault(); setSearch(query.trim()); setRevision(value => value + 1); }}>
      <label className='sr-only' htmlFor='session-search'>Search your sessions</label>
      <div><MagnifyingGlassIcon size={17} aria-hidden='true' /><input id='session-search' value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder='Search sessions' /><button type='submit'>Search</button></div>
    </form>} /></div>
  </>;
}

function SessionResults({ search, searchForm }: { search: string; searchForm: ReactNode }) {
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
    {(page.sessions.length > 0 || search) && searchForm}
    <div className='agent-list-heading'><h3>{search ? 'Search results' : 'Recent sessions'}</h3><button className='agent-icon-button' aria-label='Refresh sessions' title='Refresh sessions' disabled={loading} onClick={() => setRevision(value => value + 1)}><ArrowClockwiseIcon size={16} aria-hidden='true' /></button></div>
    {error && <p role='alert' className='alert error'>{error}</p>}
    <div className='agent-session-list' aria-busy={loading}>
      {page.sessions.map(session => <Link key={session.sessionId} href={`/dashboard/sessions/${session.sessionId}`} className='agent-session-row'>
        <span className='agent-session-icon'><ChatCircleTextIcon size={19} aria-hidden='true' /></span><div className='agent-session-copy'><h3>{session.title || 'Untitled session'}</h3><p>{session.latestMessagePreview}</p></div>
        <div className='agent-session-meta'><time dateTime={new Date(session.updatedAt).toISOString()}>{formatTime(session.updatedAt)}</time><span>{session.runCount} {session.runCount === 1 ? 'run' : 'runs'} <ArrowUpRightIcon size={13} aria-hidden='true' /></span></div>
      </Link>)}
      {!page.sessions.length && !loading && !error && <HistoryEmptyState title={search ? 'No matching sessions' : 'No sessions yet'} description={search ? 'Try another topic or clear your search.' : 'Start a session above. Requests from the API also appear here.'} />}
    </div>
    {loading && !page.sessions.length && <div className='agent-loading' role='status'><span className='sr-only'>Loading sessions…</span><span /><span /><span /></div>}
    {page.nextCursor && <button className='agent-load-more' disabled={loading} onClick={() => void loadMore()}>Load more sessions</button>}
  </>;
}

function SessionHistory({ sessionId }: { sessionId: string }) {
  const cache = useAgentSessionCache();
  const { agentAccess } = useDashboardSession();
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
        { ...shared, messageId: receipt.agentMessageId, parentMessageId: receipt.diagnostics.userMessageId, role: 'assistant', status: receipt.status, content: '' },
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
    <div className='agent-thread-nav'>{agentAccess
      ? <Link className='agent-back' href='/dashboard/sessions' prefetch={true} onMouseEnter={() => void cache.loadList('').catch(() => {})} onFocus={() => void cache.loadList('').catch(() => {})}><ArrowLeftIcon size={14} aria-hidden='true' />All sessions</Link>
      : <Link className='agent-back' href='/dashboard/admin'><ArrowLeftIcon size={14} aria-hidden='true' />Back to admin</Link>}
      <button className='agent-icon-button' aria-label='Refresh session' title='Refresh session' disabled={loading || olderLoading || submitting} onClick={() => setRevision(value => value + 1)}><ArrowClockwiseIcon size={16} aria-hidden='true' /></button></div>
    {session && <header className='agent-heading'><div><h2>{session.title}</h2>
      <p className='agent-id'>Session ID: {sessionId}</p>
      {session.readOnly && <p role='status'>Admin debugging view. This session is read-only.</p>}</div></header>}
    {session && <SessionAssets sessionId={sessionId} readOnly={session.readOnly} revision={`${revision}:${session.messages.map(message=>message.status).join(',')}`} onDeleted={()=>setRevision(value=>value+1)} />}
    {error && <p className='alert error' role='alert'>{error}</p>}
    {loading && !session && <SessionLoading />}
    {session?.nextCursor && <button className='agent-load-more' disabled={olderLoading || loading} aria-busy={olderLoading} onClick={() => void loadOlder()}>Load older messages</button>}
    <div ref={messagesRef} className='agent-messages' aria-busy={loading}>
      {session?.messages.map(message => message.role === 'user'
        ? <article className='agent-message agent-user-message' key={message.messageId} data-message-id={message.messageId} tabIndex={-1} aria-label={session.readOnly ? 'User message' : 'Your message'}><UserMessageContent content={message.content} createdAt={message.createdAt} /></article>
        : <RunAnswer key={`${message.messageId}:${revision}`} sessionId={sessionId} message={message} initiallyOpen={message.runId === session.lastRunId} onProgress={onProgress} />)}
      {pendingMessage && <PendingUserMessage message={pendingMessage} />}
    </div>
    {session && !session.messages.length && !loading && <p>No messages are available for this session yet.</p>}
    {session && !session.readOnly && <div className='agent-composer-dock'><MessageComposer sessionId={sessionId} onAdmitted={onAdmitted} onSending={setSubmitting} onSendAction={showPendingMessage}
      disabled={loading} processing={session.messages.some(message => message.role === 'assistant' && isActiveAgentRun(message.status))} /></div>}
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
  return <article className='agent-message agent-assistant-message' aria-label='Agent message'>
    <span className='agent-avatar' aria-hidden='true'><StarFourIcon size={14} /></span>
    <div className='agent-message-body'>
    <header className='agent-message-header'><strong>Agent</strong><time dateTime={new Date(message.updatedAt).toISOString()}>{formatTime(message.updatedAt)}</time><span className={`agent-status status-${status}`}>{status}</span></header>
    {!open && <><AgentMarkdown>{message.content}</AgentMarkdown>{message.content && <AnswerActions answer={message.content} />}<button className='agent-answer-toggle' aria-expanded={open} onClick={() => setOpen(true)}>View sources and tool activity <CaretRightIcon size={13} aria-hidden='true' /></button></>}
    {open && <div className='agent-run-details'>
      {error && <p role='alert' className='alert error'>{error} <button onClick={() => setRevision(value => value + 1)}>Try again</button></p>}
      {!run && message.content && <><AgentMarkdown>{message.content}</AgentMarkdown><AnswerActions answer={message.content} /></>}
      {!run && !error && <DashboardSkeleton label={message.content ? 'Loading source details' : 'Getting started'} />}
      {run && !error && isActiveAgentRun(run.status) && <p className='agent-progress-label' role='status'><CircleNotchIcon className='agent-spin' size={15} aria-hidden='true' />{progress?.draft?.state === 'revising' ? 'Revising the answer.' : phaseLabel(progress?.phase)}</p>}
      {progress?.draft?.answer && !result && <StreamingAgentMarkdown text={progress.draft.answer} />}
      {progress && <ToolTrace tools={progress.tools} status={status} />}
      {run?.error && <div role='alert' className='alert error'><strong>This run failed</strong><p className='agent-answer'>{run.error}</p></div>}
      {run?.status === 'cancelled' && !result && <p>This run was cancelled before an answer was saved.</p>}
      {result && <>
        <div className='agent-result-meta'><span className={`agent-outcome outcome-${result.outcome}`}>{result.outcome.replaceAll('_', ' ')}</span>{result.coverage && <span>{result.coverage.reviewedVideos} {result.coverage.reviewedVideos === 1 ? 'video' : 'videos'} reviewed</span>}{run.billing && <span>{run.billing.creditsCharged} credits charged</span>}</div>
        {result.warnings.filter(warning => ['FINAL_SYNTHESIS_UNAVAILABLE', 'YOUTUBE_UNAVAILABLE'].includes(warning.code)).map(warning =>
          <div key={warning.code} role='alert' className='alert error'><strong>{warning.code === 'YOUTUBE_UNAVAILABLE' ? 'Source unavailable' : 'Answer incomplete'}</strong><p>{warning.message}</p></div>)}
        <AgentMarkdown sources={result.sources}>{result.answer}</AgentMarkdown>
        {result.answer && <AnswerActions answer={result.answer} />}
        {!!result.sources.length && <section className='agent-sources'><h3>Sources</h3><ul>{result.sources.map(source => {
          const href = safeSourceUrl(source.url);
          return <li key={source.id}>{href ? <a href={href} target='_blank' rel='noreferrer'><span className='agent-source-number'>[{source.id}]</span><span>{source.title}</span><ArrowUpRightIcon size={13} aria-hidden='true' /></a> : <span>[{source.id}] {source.title}</span>}</li>;
        })}</ul></section>}
        {!!result.warnings.length && <details className='agent-caveats'><summary>Source notes and limitations ({result.warnings.length})</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul></details>}
      </>}
    </div>}
    <footer className='agent-run-footer'>
      <p className='agent-id'>Run ID: {message.runId}</p>
    </footer>
    </div>
  </article>;
}

function UserMessageContent({ content, createdAt, pending = false }: { content: string; createdAt: number; pending?: boolean }) {
  return <>
    <span className='agent-avatar' aria-hidden='true'><UserIcon size={14} /></span>
    <div className='agent-message-body'>
      <header className='agent-message-header'><strong>You</strong><time dateTime={new Date(createdAt).toISOString()}>{formatTime(createdAt)}</time></header>
      <div className='agent-user-bubble agent-answer'>{content}</div>
      {pending && <span className='agent-delivery-status' role='status'>Sending…</span>}
    </div>
  </>;
}

interface PendingMessage { key: string; message: string; createdAt: number }

function PendingUserMessage({ message }: { message: PendingMessage }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    ref.current?.focus({ preventScroll: true });
  }, [message.key]);
  return <article ref={ref} className='agent-message agent-user-message agent-pending-message' tabIndex={-1} aria-label='Your message'>
    <UserMessageContent content={message.message} createdAt={message.createdAt} pending />
  </article>;
}

function MessageComposer({ sessionId, disabled = false, processing = false, onAdmitted, onSending, onSendAction }: {
  sessionId?: string; disabled?: boolean; processing?: boolean; onSending?: (sending: boolean) => void;
  onSendAction: (message: PendingMessage) => void; onAdmitted: (receipt: AgentAdmission, message: string) => void;
}) {
  const cache = useAgentSessionCache();
  const [draft, setDraft] = useState('');
  const [sending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  const submissionCount = useRef(0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || processing || inFlight.current || sending || !draft.trim()) return;
    const request = { message: draft.trim(), draft, key: String(++submissionCount.current), createdAt: Date.now() };
    inFlight.current = true;
    setDraft(''); setError(''); onSending?.(true);
    startTransition(async () => {
      onSendAction(request);
      try {
        const receipt = await sendAgentMessage(request.message, sessionId);
        // Commit the server messages and remove the optimistic message together.
        startTransition(() => {
          cache.recordAdmission(receipt, request.message);
          onAdmitted(receipt, request.message);
        });
        setUncertain(false);
      } catch (cause) {
        const unconfirmed = cause instanceof AgentSendError && cause.unconfirmed;
        setDraft(request.draft);
        setError(errorMessage(cause)); setUncertain(unconfirmed);
      } finally { inFlight.current = false; onSending?.(false); }
    });
  };
  return <><AgentPromptBar value={draft} onChange={setDraft} onSubmit={submit}
    label={sessionId ? 'Follow-up message' : 'Start a new session'}
    sendLabel={sending ? 'Sending…' : processing ? 'Agent is working…' : uncertain ? 'Send as new run' : sessionId ? 'Send follow-up' : 'Start session'}
    disabled={disabled || processing} sending={sending} processing={processing} uncertain={uncertain} error={error} />
    {uncertain && <Link href='/dashboard/sessions'>Check Sessions for the submitted run</Link>}
  </>;
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
function isStoryboardMetadata(tool: AgentProgress['tools'][number]) {
  if (tool.name !== 'get_video_storyboard') return false;
  if (tool.output?.storyboard) return tool.output.storyboard.mode === 'metadata';
  return typeof tool.input.videoId === 'string' && tool.input.maxSheets === undefined
    && tool.input.sheetIndexes === undefined && tool.input.timestampsMs === undefined;
}

function ToolTrace({ tools, status }: { tools: AgentProgress['tools']; status: AgentMessage['status'] }) {
  const [expanded, setExpanded] = useState(status !== 'completed');
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  // Collapse activity when the run completes, leaving it available for inspection.
  useEffect(() => { if (status === 'completed') setExpanded(false); }, [status]);
  if (!tools.length) return null;
  return <details className='agent-trace' open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Tool Activity ({tools.length})</summary>
    {expanded && <ol>{tools.map(tool => <li key={tool.toolCallId}>
      <details className='agent-tool-chip' open={!!expandedTools[tool.toolCallId]}><summary onClick={event => {
        event.preventDefault();
        setExpandedTools(current => ({ ...current, [tool.toolCallId]: !current[tool.toolCallId] }));
      }}>
        <span className={`agent-tool-icon status-${tool.status}`}>{tool.status === 'running' ? <CircleNotchIcon className='agent-spin' size={14} aria-hidden='true' />
          : tool.status === 'completed' ? <CheckIcon size={14} aria-hidden='true' /> : <WarningCircleIcon size={14} aria-hidden='true' />}</span>
        <span className='agent-tool-label'>
          <span className='agent-tool-name'>{agentToolLabel(tool)}</span>
          {tool.name === 'get_video_storyboard' && <span className='agent-tool-mode'>{isStoryboardMetadata(tool) ? 'Preview Details' : 'Preview Images'}</span>}
        </span>
        <span className='agent-tool-target'>{String(tool.input.videoId ?? tool.input.query ?? tool.input.channelId ?? '')}</span>
        <span className='sr-only'>{tool.status}</span>
        {(tool.finishedAt !== undefined || tool.status === 'interrupted' || tool.status === 'unknown') && <span className='agent-tool-timing'>
          {tool.finishedAt !== undefined && <span className='agent-tool-duration'>{tool.finishedAt - tool.startedAt < 100 ? '<0.1s' : `${((tool.finishedAt - tool.startedAt) / 1000).toFixed(1)}s`}</span>}
          {tool.status === 'interrupted' && <span className='agent-tool-duration'>Interrupted</span>}
          {tool.status === 'unknown' && <span className='agent-tool-duration'>Unknown status</span>}
        </span>}
        <CaretRightIcon className='agent-tool-caret' size={12} aria-hidden='true' /></summary>
        <div className='agent-tool-content'>
          {!!Object.keys(tool.input).length && <><h4>Input</h4><pre>{JSON.stringify(tool.input, null, 2)}</pre></>}
          {tool.name === 'get_video_frames' && tool.status === 'completed' && <>{tool.output?.sessionReused && <p className='agent-frame-note'>Used saved session images. No new frames were extracted.</p>}<FramePreviews frames={tool.output?.frames ?? []} /></>}
          {tool.name === 'get_video_storyboard' && tool.status === 'completed' && (isStoryboardMetadata(tool)
            ? <p className='agent-frame-note'>Metadata only. No images were downloaded or inspected.</p>
            : <FramePreviews kind='storyboard' frames={tool.output?.storyboard?.sheets ?? []} />)}
          {tool.output && <><h4>Result</h4><p>{tool.output.sourceCount} {tool.output.sourceCount === 1 ? 'source' : 'sources'} · {tool.output.excerptCount} evidence excerpts</p>
            <ul>{tool.output.sources.map((source, index) => <li key={index}>{source.title ?? source.videoId ?? source.channelId ?? 'YouTube source'}</li>)}</ul>
            {!!tool.output.warningCodes.length && <p>Notes: {tool.output.warningCodes.join(', ')}</p>}</>}
          {tool.status === 'failed' && <p>This tool did not complete successfully. Check the answer's source notes for any effect on coverage.</p>}
          {tool.status === 'interrupted' && <p>The run ended without a recorded result for this call. Some work may have been saved before it was interrupted. Duration is unavailable.</p>}
          {tool.status === 'unknown' && <p>This dashboard does not recognize the tool status. Refresh to load the latest version.</p>}
          {tool.status === 'running' && <p>Waiting for the tool result…</p>}
        </div>
      </details>
    </li>)}</ol>}
  </details>;
}

function AnswerActionIcon({ kind }: { kind: 'copy' | 'up' | 'down' }) {
  return <svg width={18} height={18} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.6} strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
    {kind === 'copy' ? <>
      <rect x={8} y={8} width={12} height={13} rx={3} />
      <path d='M15 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h2' />
    </> : <g transform={kind === 'down' ? 'translate(0 24) scale(1 -1)' : undefined}>
      <rect x={3} y={10} width={5} height={10} rx={2} />
      <path d='m8 10 3.2-6.4c.5-.9 1.8-.8 2.1.2.4 1.3.4 2.7 0 4L13 9h5a3 3 0 0 1 2.9 3.7l-1.2 5a3 3 0 0 1-2.9 2.3H11a3 3 0 0 1-3-3Z' />
    </g>}
  </svg>;
}

function AnswerActions({ answer }: { answer: string }) {
  return <div className='agent-answer-actions' role='group' aria-label='Answer actions'>
    <CopyAnswer answer={answer} />
    <button type='button' className='agent-answer-action' disabled aria-label='Upvote answer (coming soon)' title='Feedback coming soon'><AnswerActionIcon kind='up' /></button>
    <button type='button' className='agent-answer-action' disabled aria-label='Downvote answer (coming soon)' title='Feedback coming soon'><AnswerActionIcon kind='down' /></button>
  </div>;
}

function CopyAnswer({ answer }: { answer: string }) {
  const [status, setStatus] = useState('');
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(''), 2_000); return () => clearTimeout(timer); }, [status]);
  return <button type='button' className='agent-answer-action agent-copy-answer' aria-label={status || 'Copy answer'} title={status || 'Copy answer'} onClick={async () => {
    try { await navigator.clipboard.writeText(answer); setStatus('Copied'); }
    catch { setStatus('Could not copy'); }
  }}>{status === 'Copied' ? <CheckIcon size={18} aria-hidden='true' /> : status ? <WarningCircleIcon size={18} aria-hidden='true' /> : <AnswerActionIcon kind='copy' />}<span className='sr-only' aria-live='polite'>{status}</span></button>;
}

function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : 'Could not load sessions. Please try again.'; }
function formatTime(timestamp: number) { return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
