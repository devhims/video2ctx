'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authClient } from '../../lib/auth-client';

type Mode = 'youtube' | 'inside' | 'ask';
type ProviderId = 'youtube';
type Section = 'trends' | 'discover' | 'projects' | 'monitors';
type EntityType = 'video' | 'channel' | 'playlist';
type Thumbnail = { url: string; width?: number; height?: number };
type SearchItem = {
  provider?: ProviderId; type: EntityType; id: string; title?: string; name?: string; description?: string;
  channel?: { id: string; name: string }; thumbnails: Thumbnail[]; durationText?: string;
  viewCountText?: string; publishedTimeText?: string; isLive?: boolean; videoCountText?: string;
};
type Segment = { text: string; startMs: number; endMs: number; durationMs: number };
type Transcript = { videoId: string; segments: Segment[]; text: string; track: { name: string; kind: string; languageCode: string } };
type Project = { id: string; name: string; description?: string; item_count?: number };
type ProjectItem = { id: string; provider: ProviderId; entity_type: EntityType; entity_id: string; title?: string; note?: string; start_ms?: number | null; created_at?: number };
type ProjectDetail = Project & { items: ProjectItem[] };
type Monitor = { id: string; provider: ProviderId; kind: string; target: string; enabled: number; last_checked_at?: number };
type Citation = { index: number; text: string; provider?: ProviderId; entityId?: string; startMs?: number; score: number };
type Answer = { answer: string; citations: Citation[] };
type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; citations?: Citation[]; failedQuestion?: string };
type ChatSession = { id: string; title: string; messages: ChatMessage[] };
type Inspector = { provider: ProviderId; type: EntityType; id: string; data: Record<string, unknown>; transcript?: Transcript; comments?: Array<Record<string, unknown>> };
type TrendVideo = {
  id: string; title: string; channel: { id: string; name: string }; thumbnails: Thumbnail[];
  durationSeconds?: number; publishedTimeText?: string; publishDate?: string; ageHours?: number;
  viewCount: number; viewsPerHour?: number; commentCount?: number; hashtags: string[]; keywords: string[];
  trendScore: number; trendBand: 'Breakout' | 'Rising' | 'Steady'; url: string;
};
type TrendReport = {
  provider: ProviderId; query: string; generatedAt: string; sampleSize: number; methodology: string;
  summary: { totalViews: number; medianViewsPerHour: number; publishedLast7Days: number; breakoutCount: number };
  videos: TrendVideo[];
  hashtags: Array<{ tag: string; videos: number; averageViewsPerHour: number; lift: number }>;
  titlePatterns: Array<{ term: string; videos: number; averageViewsPerHour: number }>;
  durationMix: Array<{ label: string; videos: number; averageViewsPerHour: number }>;
  plan: { angle: string; recommendedDurationSeconds?: number; titleIdeas: string[]; observedHashtags: string[]; evidence: string[] };
  warnings: string[];
};
type AiTrendPlan = {
  provider: ProviderId; model: '@cf/openai/gpt-oss-120b'; generatedAt: string; operationId: string;
  angle: string; audience: string; hook: string; recommendedDurationSeconds: number;
  outline: Array<{ section: string; goal: string }>;
  titleIdeas: string[]; hashtags: string[]; differentiation: string[];
  evidence: Array<{ claim: string; videoIds: string[] }>; caveats: string[];
};
type Usage = { plan: 'free' | 'pro'; monthlyCredits: number; creditBalance: number };

type IconName = 'home' | 'trend' | 'search' | 'folder' | 'monitor' | 'user' | 'spark' | 'plus';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    home: <><path d='M3.5 10.5 12 3.75l8.5 6.75' /><path d='M5.5 9.5v10h13v-10M9.5 19.5v-6h5v6' /></>,
    trend: <><path d='M4 17 9 12l3 3 8-9' /><path d='M15 6h5v5' /></>,
    search: <><circle cx='10.5' cy='10.5' r='5.75' /><path d='m15 15 4.5 4.5' /></>,
    folder: <><path d='M3.5 6.5h6l2 2h9v10.5h-17z' /><path d='M3.5 9h17' /></>,
    monitor: <><circle cx='12' cy='12' r='2.5' /><circle cx='12' cy='12' r='6.5' /><path d='M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2' /></>,
    user: <><circle cx='12' cy='8' r='3.25' /><path d='M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6' /></>,
    spark: <path d='M12 3.5c.6 4.7 2.8 6.9 7.5 7.5-4.7.6-6.9 2.8-7.5 7.5-.6-4.7-2.8-6.9-7.5-7.5 4.7-.6 6.9-2.8 7.5-7.5Z' />,
    plus: <path d='M12 5v14M5 12h14' />,
  };
  return <svg className='ui-icon' width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.75' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>{paths[name]}</svg>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const YOUTUBE_API = '/v1/providers/youtube';

async function api<T>(path: string, options: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const headers = new Headers(options.headers);
  if (['localhost', '127.0.0.1'].includes(window.location.hostname)) headers.set('x-demo-user', 'local-beta');
  if (options.body) headers.set('content-type', 'application/json');
  const controller = new AbortController();
  const parentSignal = options.signal;
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`/api/platform${path}`, { ...options, headers, credentials: 'include', signal: controller.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      const code = payload?.error?.code;
      const message = response.status === 401 ? 'Sign in to continue.'
        : response.status === 402 ? 'Your credit balance is too low for this operation.'
        : response.status === 429 ? 'Too many requests. Wait a moment and try again.'
        : payload?.error?.message ?? `Request failed (${response.status})`;
      throw new PlatformApiError(response.status, code, message);
    }
    return response.json() as Promise<T>;
  } catch (cause) {
    if (controller.signal.aborted) {
      if (timedOut) throw new Error('This is taking longer than expected. Check the connection and try again.');
      throw new DOMException('Request cancelled.', 'AbortError');
    }
    throw cause;
  } finally {
    window.clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

class PlatformApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
}

function isAbortError(cause: unknown) {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

export default function WorkspacePage() {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [clientReady, setClientReady] = useState(false);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [section, setSection] = useState<Section>('trends');
  const [mode, setMode] = useState<Mode>('youtube');
  const [query, setQuery] = useState('');
  const [entityFilter, setEntityFilter] = useState('all');
  const [duration, setDuration] = useState('');
  const [captionsOnly, setCaptionsOnly] = useState(false);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [inspector, setInspector] = useState<Inspector | null>(null);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSignIn, setShowSignIn] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [operationLabel, setOperationLabel] = useState('');
  const [sourceState, setSourceState] = useState<'checking' | 'live' | 'degraded'>('checking');
  const [selectedProject, setSelectedProject] = useState<ProjectDetail | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const projectController = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const authenticated = Boolean(session?.user) || demoEnabled;

  useEffect(() => {
    setDemoEnabled(['localhost', '127.0.0.1'].includes(window.location.hostname));
    setClientReady(true);
  }, []);

  const beginOperation = useCallback((label: string) => {
    operationController.current?.abort();
    const controller = new AbortController();
    operationController.current = controller;
    setOperationLabel(label); setLoading(true); setError('');
    return controller;
  }, []);

  const finishOperation = useCallback((controller: AbortController) => {
    if (operationController.current !== controller) return;
    operationController.current = null; setLoading(false); setOperationLabel('');
  }, []);

  const cancelOperation = useCallback(() => {
    const hadActiveOperation = Boolean(operationController.current);
    operationController.current?.abort();
    operationController.current = null; setLoading(false); setOperationLabel('');
    if (hadActiveOperation) setNotice('Cancelled. Your previous results are still here.');
  }, []);

  const navigateTo = useCallback((nextSection: Section) => {
    if (nextSection !== section) cancelOperation();
    setSection(nextSection);
    const params = new URLSearchParams(window.location.search);
    if (nextSection === 'trends') params.delete('section');
    else params.set('section', nextSection);
    const suffix = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${suffix ? `?${suffix}` : ''}`);
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [cancelOperation, section]);

  const refreshPrivateData = useCallback(async () => {
    if (!authenticated) return;
    const [projectData, monitorData, usageData] = await Promise.all([
      api<{ projects: Project[] }>('/v1/projects').catch(() => ({ projects: [] })),
      api<{ monitors: Monitor[] }>('/v1/monitors').catch(() => ({ monitors: [] })),
      api<Usage>('/v1/usage').catch(() => null),
    ]);
    setProjects(projectData.projects);
    setMonitors(monitorData.monitors);
    setUsage(usageData);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    void refreshPrivateData();
    api<{ results: SearchItem[] }>(`${YOUTUBE_API}/browse?category=music`)
      .then((data) => { setItems(data.results.slice(0, 12).map((item) => ({ ...item, provider: 'youtube' }))); setSourceState('live'); })
      .catch(() => {
        setItems([]); setSourceState('degraded');
      });
  }, [authenticated, refreshPrivateData]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || showSignIn || showNewProject) return;
      event.preventDefault(); setSection('discover');
      window.requestAnimationFrame(() => searchInput.current?.focus());
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [showNewProject, showSignIn]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedSection = params.get('section');
    if (requestedSection === 'trends' || requestedSection === 'discover' || requestedSection === 'projects' || requestedSection === 'monitors') {
      setSection(requestedSection);
    }
    const requestedQuery = params.get('q');
    if (requestedQuery) {
      setQuery(requestedQuery);
      setMode(params.get('mode') === 'inside' ? 'inside' : params.get('mode') === 'youtube' ? 'youtube' : 'ask');
      setSection('discover');
      window.requestAnimationFrame(() => searchInput.current?.focus());
    }
  }, []);

  useEffect(() => () => {
    operationController.current?.abort(); projectController.current?.abort();
  }, []);

  const runSearch = async (event?: FormEvent, requestedMode?: Mode) => {
    event?.preventDefault();
    if (!query.trim()) return;
    const activeMode = requestedMode ?? mode;
    const controller = beginOperation('Resolving your query…');
    setHasSearched(true);
    setAnswer(null); setInspector(null); setSection('discover');
    try {
      const resolved = await api<{ kind: EntityType | 'search'; provider?: ProviderId; id?: string; query?: string }>('/v1/resolve', {
        method: 'POST', body: JSON.stringify({ input: query }), signal: controller.signal,
      });
      if (resolved.kind !== 'search' && resolved.id) {
        setOperationLabel('Opening the source and gathering evidence…');
        await inspect(resolved.kind, resolved.id, controller, resolved.provider ?? 'youtube');
        return;
      }
      setOperationLabel(activeMode === 'ask' ? 'Building a cited answer…' : activeMode === 'inside' ? 'Searching indexed video moments…' : 'Searching live YouTube sources…');
      const params = new URLSearchParams({ q: resolved.query ?? query });
      if (activeMode === 'youtube') {
        params.set('type', entityFilter);
        if (duration) params.set('duration', duration);
        if (captionsOnly) params.set('captions', 'true');
        const data = await api<{ results: SearchItem[] }>(`${YOUTUBE_API}/search?${params}`, { signal: controller.signal });
        setItems(data.results.map((item) => ({ ...item, provider: 'youtube' })));
      } else if (activeMode === 'inside') {
        const data = await api<{ results: Citation[] }>(`/v1/search?${params}`, { signal: controller.signal });
        setItems(data.results.map((result) => evidenceToItem(result)));
      } else {
        const data = await api<Answer>('/v1/answers', {
          method: 'POST', body: JSON.stringify({ question: resolved.query ?? query }), signal: controller.signal,
        });
        setAnswer(data);
      }
      setSourceState('live');
    } catch (cause) {
      if (!isAbortError(cause)) { setError(cause instanceof Error ? cause.message : 'Search failed.'); setSourceState('degraded'); }
    } finally { finishOperation(controller); }
  };

  const inspect = async (
    type: EntityType,
    id: string,
    activeController?: AbortController,
    provider: ProviderId = 'youtube',
  ) => {
    const controller = activeController ?? beginOperation('Opening the source and gathering evidence…');
    setError(''); setAnswer(null);
    try {
      const plural = type === 'video' ? 'videos' : type === 'channel' ? 'channels' : 'playlists';
      const providerApi = `/v1/providers/${provider}`;
      const data = await api<Record<string, unknown>>(`${providerApi}/${plural}/${encodeURIComponent(id)}`, { signal: controller.signal });
      const next: Inspector = { provider, type, id, data };
      if (type === 'video') {
        setOperationLabel('Loading captions and audience evidence…');
        const [transcript, comments] = await Promise.all([
          api<Transcript>(`${providerApi}/videos/${id}/transcript`, { signal: controller.signal }).catch((cause) => { if (isAbortError(cause)) throw cause; return undefined; }),
          api<{ comments: Array<Record<string, unknown>> }>(`${providerApi}/videos/${id}/comments?all=true`, { signal: controller.signal }).catch((cause) => { if (isAbortError(cause)) throw cause; return { comments: [] }; }),
        ]);
        next.transcript = transcript;
        next.comments = comments.comments;
      }
      setInspector(next); setSourceState('live');
    } catch (cause) { if (!isAbortError(cause)) { setError(cause instanceof Error ? cause.message : 'Could not open this source.'); setSourceState('degraded'); } }
    finally { finishOperation(controller); }
  };

  const openProject = async (project: Project) => {
    projectController.current?.abort();
    const controller = new AbortController(); projectController.current = controller;
    setSection('projects'); setSelectedProject(null); setProjectLoading(true); setProjectError('');
    try {
      const detail = await api<ProjectDetail>(`/v1/projects/${project.id}`, { signal: controller.signal });
      setSelectedProject({ ...detail, item_count: detail.items.length });
    } catch (cause) {
      if (!isAbortError(cause)) setProjectError(cause instanceof Error ? cause.message : 'Could not open this project.');
    } finally {
      if (projectController.current === controller) { projectController.current = null; setProjectLoading(false); }
    }
  };

  const createProject = async (name: string) => {
    const project = await api<Project>('/v1/projects', { method: 'POST', body: JSON.stringify({ name }) });
    await refreshPrivateData(); setShowNewProject(false); setNotice(`Created ${project.name}`);
    return project;
  };

  const saveInspector = async () => {
    if (!inspector) return;
    try {
      const project = projects[0] ?? await createProject('Research inbox');
      const title = String(inspector.data.title ?? inspector.data.name ?? inspector.id);
      await api(`/v1/projects/${project.id}/items`, {
        method: 'POST', body: JSON.stringify({
          provider: inspector.provider, entityType: inspector.type, entityId: inspector.id, title,
          content: inspector.transcript?.segments.map((segment) => `[${segment.startMs}] ${segment.text}`).join('\n'),
        }),
      });
      await api('/v1/imports', {
        method: 'POST', body: JSON.stringify({ provider: inspector.provider, kind: inspector.type, entityId: inspector.id, projectId: project.id }),
      }).catch(() => null);
      setNotice(`Saved to ${project.name}`); await refreshPrivateData();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save source.'); }
  };

  const addMonitor = async () => {
    if (!inspector) return;
    const target = inspector.type === 'channel' ? inspector.id : String(inspector.data.channel ? (inspector.data.channel as { id?: string }).id : inspector.id);
    try {
      await api('/v1/monitors', { method: 'POST', body: JSON.stringify({ provider: inspector.provider, kind: inspector.type === 'channel' ? 'channel' : 'topic', target }) });
      setNotice('Monitor enabled'); await refreshPrivateData();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create monitor.'); }
  };

  const filteredSegments = useMemo(() => {
    const segments = inspector?.transcript?.segments ?? [];
    const normalized = transcriptQuery.trim().toLowerCase();
    return normalized ? segments.filter((segment) => segment.text.toLowerCase().includes(normalized)) : segments;
  }, [inspector, transcriptQuery]);

  const searchCopy = {
    youtube: { label: 'Search YouTube', placeholder: 'Search topics and channels, or paste a YouTube URL…', action: 'Find sources' },
    inside: { label: 'Search captions', placeholder: 'Find a claim, phrase, or example across indexed videos…', action: 'Find moments' },
    ask: { label: 'Ask with citations', placeholder: 'Ask a research question about your indexed sources…', action: 'Ask YouTube' },
  }[mode];

  if (sessionPending || !clientReady) return <main className='auth-gate'><p>Checking your session…</p></main>;
  if (!authenticated) return <main className='auth-gate'>
    <p className='panel-label'>Private research workspace</p>
    <h1>Sign in to research YouTube</h1>
    <p>Data APIs now use your plan and credit balance. Sign in to search, inspect transcripts, and manage projects.</p>
    <button className='signin-button' onClick={() => setShowSignIn(true)}>Sign in</button>
    {showSignIn && <SignInDialog onClose={() => setShowSignIn(false)} />}
  </main>;

  return (
    <main className='workspace-shell'>
      <Sidebar section={section} setSection={navigateTo} projects={projects} onNewProject={() => setShowNewProject(true)} onOpenProject={(project) => void openProject(project)} onSignIn={() => setShowSignIn(true)} accountName={session?.user.name ?? (demoEnabled ? 'Local demo' : undefined)} credits={usage?.creditBalance} onSignOut={() => void authClient.signOut()} />
      <div className='workspace-main'>
        <header className='topbar'>
          <div><span className='topbar-context'>Research workspace</span><h1>{section === 'trends' ? 'Trend Lab' : section === 'discover' ? 'Sources' : section === 'projects' ? 'Projects' : 'Monitors'}</h1></div>
          <div className='topbar-actions'><span className={`sync-state ${sourceState}`} role='status' aria-live='polite'><i />{sourceState === 'live' ? 'Sources live' : sourceState === 'checking' ? 'Checking sources' : 'Sources limited'}</span>{usage && <span className='credit-balance'>{usage.creditBalance} credits</span>}<a className='signin-button' href='/dashboard/developer'>API keys</a></div>
        </header>

        <div className='workspace-view' hidden={section !== 'trends'}><TrendLab onInspect={(id) => { navigateTo('discover'); void inspect('video', id); }} /></div>
        <div className='workspace-view' hidden={section !== 'discover'}>
          <>
            <section className='search-stage'>
              <div className='search-intro'>
                <div>
                  <h2>Find sources. Keep the evidence attached.</h2>
                  <p>Search YouTube, inspect exact moments, and ask questions without losing the source trail.</p>
                </div>
              </div>
              <div className='search-console'>
                <form onSubmit={runSearch} className='universal-search'>
                  <div className='search-entry'>
                    <label htmlFor='workspace-search'>{searchCopy.label}</label>
                    <div><Icon name='search' size={19} /><input id='workspace-search' ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchCopy.placeholder} /><kbd>⌘ K</kbd></div>
                  </div>
                  <button disabled={loading}>{loading ? 'Gathering…' : searchCopy.action} <span aria-hidden='true'>→</span></button>
                </form>
                <div className='search-controls'>
                  <div className='mode-tabs' role='tablist' aria-label='Search mode'>{(['youtube','inside','ask'] as Mode[]).map((value) => <button type='button' role='tab' aria-selected={mode === value} key={value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{value === 'youtube' ? 'YouTube' : value === 'inside' ? 'Captions' : 'Ask'}</button>)}</div>
                  {mode === 'youtube' && <div className='filter-row'><select aria-label='Source type' value={entityFilter} onChange={(event) => setEntityFilter(event.target.value)}><option value='all'>All types</option><option value='video'>Videos</option><option value='channel'>Channels</option><option value='playlist'>Playlists</option></select><select aria-label='Video duration' value={duration} onChange={(event) => setDuration(event.target.value)}><option value=''>Any duration</option><option value='short'>Under 4 min</option><option value='medium'>4–20 min</option><option value='long'>Over 20 min</option></select><label><input type='checkbox' checked={captionsOnly} onChange={(event) => setCaptionsOnly(event.target.checked)} /> Captions only</label></div>}
                </div>
              </div>
              <div className='prompt-starters'><span>Try an inquiry</span><button onClick={() => { setMode('ask'); setQuery('What are the strongest arguments and where do the speakers disagree?'); }}>Compare viewpoints</button><button onClick={() => { setMode('inside'); setQuery('Find every claim supported by a concrete example'); }}>Find evidence</button><button onClick={() => { setMode('youtube'); setQuery('AI video research'); }}>Explore a topic</button></div>
            </section>

            {loading && <div className='operation-status' role='status' aria-live='polite'><span className='status-spinner' aria-hidden='true' /><div><strong>{operationLabel}</strong><small>Previous results stay available while this finishes.</small></div><button onClick={cancelOperation}>Cancel</button></div>}
            {error && <div className='alert error' role='alert'><span>{error}</span>{query.trim() && <button onClick={() => void runSearch()}>Retry</button>}</div>}
            {notice && <div className='alert success' role='status'><span>{notice}</span><button aria-label='Dismiss notification' onClick={() => setNotice('')}>×</button></div>}
            {answer && <AnswerPanel answer={answer} />}
            {inspector ? (
              <InspectorPanel inspector={inspector} segments={filteredSegments} transcriptQuery={transcriptQuery} setTranscriptQuery={setTranscriptQuery} onClose={() => setInspector(null)} onSave={() => void saveInspector()} onMonitor={() => void addMonitor()} />
            ) : !answer && (
              <DiscoveryGrid items={items} projects={projects} monitors={monitors} sourceState={sourceState} onInspect={(type, id, provider) => void inspect(type, id, undefined, provider)} onStart={() => searchInput.current?.focus()} loading={loading} hasSearched={hasSearched} />
            )}
          </>
        </div>
        <div className='workspace-view' hidden={section !== 'projects'}><ProjectsView projects={projects} selectedProject={selectedProject} loading={projectLoading} error={projectError} onCreate={() => setShowNewProject(true)} onOpen={(project) => void openProject(project)} onBack={() => { setSelectedProject(null); setProjectError(''); }} onFindSources={() => { navigateTo('discover'); window.requestAnimationFrame(() => searchInput.current?.focus()); }} onOpenItem={(item) => { navigateTo('discover'); void inspect(item.entity_type, item.entity_id, undefined, item.provider); }} /></div>
        <div className='workspace-view' hidden={section !== 'monitors'}><MonitorsView monitors={monitors} onFindSource={() => { navigateTo('discover'); window.requestAnimationFrame(() => searchInput.current?.focus()); }} onOpenTarget={(target) => { setQuery(target); setMode('youtube'); navigateTo('discover'); window.requestAnimationFrame(() => searchInput.current?.focus()); }} /></div>
      </div>
      {showSignIn && <SignInDialog onClose={() => setShowSignIn(false)} />}
      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} onCreate={(name) => void createProject(name)} />}
    </main>
  );
}

function Sidebar({ section, setSection, projects, onNewProject, onOpenProject, onSignIn, accountName, credits, onSignOut }: { section: Section; setSection: (value: Section) => void; projects: Project[]; onNewProject: () => void; onOpenProject: (project: Project) => void; onSignIn: () => void; accountName?: string; credits?: number; onSignOut: () => void }) {
  return <aside className='sidebar'>
    <a className='brand workspace-brand' aria-label='all things youtube home' href='/'><span className='lens-brand-mark' aria-hidden='true'><i /></span><span className='lens-brand-type'><b>all things</b><strong>youtube</strong></span></a>
    <nav aria-label='Dashboard navigation'><a href='/'><span aria-hidden='true'><Icon name='home' /></span>Home</a><button aria-current={section === 'trends' ? 'page' : undefined} className={section === 'trends' ? 'active' : ''} onClick={() => setSection('trends')}><span aria-hidden='true'><Icon name='trend' /></span>Trend Lab</button><button aria-current={section === 'discover' ? 'page' : undefined} className={section === 'discover' ? 'active' : ''} onClick={() => setSection('discover')}><span aria-hidden='true'><Icon name='search' /></span>Sources</button><button aria-current={section === 'projects' ? 'page' : undefined} className={section === 'projects' ? 'active' : ''} onClick={() => setSection('projects')}><span aria-hidden='true'><Icon name='folder' /></span>Projects <em>{projects.length}</em></button><button aria-current={section === 'monitors' ? 'page' : undefined} className={section === 'monitors' ? 'active' : ''} onClick={() => setSection('monitors')}><span aria-hidden='true'><Icon name='monitor' /></span>Monitors</button><a href='/dashboard/developer'><span aria-hidden='true'>⌘</span>API keys</a></nav>
    <div className='sidebar-rule' />
    <div className='sidebar-label'><span>RECENT PROJECTS</span><button aria-label='Create a new project' onClick={onNewProject}>＋</button></div>
    <div className='project-links'>{projects.slice(0,5).map((project, index) => <button key={project.id} onClick={() => onOpenProject(project)}><span aria-hidden='true' className={`project-color c${index % 4}`} />{project.name}</button>)}{!projects.length && <p>Save a source to start.</p>}</div>
    <div className='account-card'>{accountName ? <><strong>{accountName}</strong><p>{credits === undefined ? 'Loading credit balance…' : `${credits} credits remaining`}</p><button onClick={onSignOut}><Icon name='user' size={15} />Sign out</button></> : <><strong>Keep your research private</strong><p>Sign in to sync projects and monitors across devices.</p><button onClick={onSignIn}><Icon name='user' size={15} />Sign in</button></>}</div>
  </aside>;
}

function TrendLab({ onInspect }: { onInspect: (id: string) => void }) {
  const [topic, setTopic] = useState('AI agents');
  const [report, setReport] = useState<TrendReport | null>(null);
  const [aiPlan, setAiPlan] = useState<AiTrendPlan | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestController = useRef<AbortController | null>(null);

  const runTopic = useCallback(async (value: string) => {
    const nextTopic = value.trim();
    if (!nextTopic) return;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    setTopic(nextTopic); setLoading(true); setError(''); setAiPlan(null); setAiError('');
    try {
      setReport(await api<TrendReport>(`${YOUTUBE_API}/trends?q=${encodeURIComponent(nextTopic)}&limit=8`, { signal: controller.signal }, 20_000));
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not research this topic.');
    } finally {
      if (requestController.current === controller) { requestController.current = null; setLoading(false); }
    }
  }, []);

  useEffect(() => () => requestController.current?.abort(), []);

  const cancelTrend = () => {
    requestController.current?.abort(); requestController.current = null; setLoading(false);
  };

  const generatePlan = async () => {
    if (!report) return;
    setAiLoading(true); setAiError('');
    const planSignals = {
      provider: report.provider,
      query: report.query,
      sampleSize: report.sampleSize,
      summary: report.summary,
      videos: report.videos.map((video) => ({
        id: video.id, title: video.title, channel: video.channel.name,
        viewsPerHour: video.viewsPerHour, viewCount: video.viewCount, ageHours: video.ageHours,
        durationSeconds: video.durationSeconds, trendBand: video.trendBand,
      })),
      hashtags: report.hashtags,
      titlePatterns: report.titlePatterns,
      durationMix: report.durationMix,
    };
    try {
      setAiPlan(await api<AiTrendPlan>('/v1/trends/plan', { method: 'POST', body: JSON.stringify({ report: planSignals }) }));
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : 'Could not generate the AI plan.');
    } finally { setAiLoading(false); }
  };

  const maxVelocity = Math.max(...(report?.videos.map((video) => video.viewsPerHour ?? 0) ?? [1]), 1);
  const maxDurationCount = Math.max(...(report?.durationMix.map((bucket) => bucket.videos) ?? [1]), 1);

  return <section className='trend-lab'>
    <header className='trend-command'>
      <div><h2>Compare topic momentum</h2><p>Scan fresh videos, inspect the strongest signals, and turn the evidence into a brief.</p></div>
      <form className='trend-search' onSubmit={(event) => { event.preventDefault(); void runTopic(topic); }}>
        <label htmlFor='trend-topic'>Topic or niche</label><div><input id='trend-topic' value={topic} onChange={(event) => setTopic(event.target.value)} placeholder='e.g. AI coding agents' /><button disabled={loading}>{loading ? 'Scanning…' : 'Research topic'} <span aria-hidden='true'>→</span></button></div>
        <small>Public signals only · no official YouTube API</small>
      </form>
    </header>
    <div className='trend-presets'><span>Quick scans</span>{['AI agents','Claude Code','faceless YouTube','personal finance'].map((preset) => <button key={preset} onClick={() => void runTopic(preset)}>{preset}</button>)}</div>

    {error && <div className='trend-alert' role='alert'><span>{error}</span><button onClick={() => void runTopic(topic)}>Retry scan</button></div>}
    {loading && !report && <TrendLoading onCancel={cancelTrend} />}
    {!loading && !report && !error && <div className='trend-empty'><div><span aria-hidden='true'><Icon name='trend' size={21} /></span><h3>Start with a topic you want to understand.</h3><p>We’ll compare a fresh public sample, surface momentum patterns, and keep the evidence attached.</p><button onClick={() => void runTopic(topic)}>Research “{topic}”</button></div></div>}
    {report && <>
      {loading && <div className='trend-refresh-status' role='status' aria-live='polite'><span className='status-spinner' aria-hidden='true' /><div><strong>Refreshing the topic sample…</strong><small>The previous report remains visible.</small></div><button onClick={cancelTrend}>Cancel</button></div>}
      <div className='trend-report-head'><div><p className='panel-label'>Live sample · {report.sampleSize} videos</p><h3>Momentum around “{report.query}”</h3></div><span>Updated {new Date(report.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div className='trend-kpis'>
        <article><span>MEDIAN PUBLISH-ADJUSTED REACH</span><strong>{formatNumber(report.summary.medianViewsPerHour)}</strong><small>average views/hour</small></article>
        <article><span>FRESH THIS WEEK</span><strong>{report.summary.publishedLast7Days}/{report.sampleSize}</strong><small>sampled videos</small></article>
        <article><span>BREAKOUT SIGNALS</span><strong>{report.summary.breakoutCount}</strong><small>relative to sample</small></article>
        <article><span>SAMPLE REACH</span><strong>{formatNumber(report.summary.totalViews)}</strong><small>current public views</small></article>
      </div>

      <div className='trend-dashboard-grid'>
        <article className='trend-card velocity-card'>
          <div className='trend-card-head'><div><p className='panel-label'>Momentum</p><h4>Average views/hour since publish</h4></div><span>First-scan estimate</span></div>
          <div className='velocity-chart'>{report.videos.slice(0,6).map((video) => <button key={video.id} onClick={() => onInspect(video.id)} title={video.title}><span>{video.title}</span><i><b style={{width:`${Math.max(4,((video.viewsPerHour ?? 0)/maxVelocity)*100)}%`}} /></i><strong>{formatNumber(video.viewsPerHour ?? 0)}/h</strong></button>)}</div>
        </article>

        <article className='trend-card scatter-card'>
          <div className='trend-card-head'><div><p className='panel-label'>Opportunity map</p><h4>Freshness × relative momentum</h4></div><span>Select a point to inspect</span></div>
          <div className='scatter-plot'><span className='axis-y'>More momentum</span><span className='axis-x'>Fresher →</span>{report.videos.map((video) => {
            const freshness = video.ageHours === undefined ? 10 : Math.max(5, 96 - Math.log10(video.ageHours + 1) * 29);
            const size = Math.max(12, Math.min(28, 12 + Math.log10(video.viewCount + 1) * 2.2));
            return <button key={video.id} aria-label={`${video.title}: ${formatNumber(video.viewsPerHour ?? 0)} views per hour, ${video.trendBand}`} className={`trend-dot ${video.trendBand.toLowerCase()}`} style={{left:`${freshness}%`,bottom:`${Math.max(8,video.trendScore * .78)}%`,width:size,height:size}} title={`${video.title} · ${formatNumber(video.viewsPerHour ?? 0)} views/hour`} onClick={() => onInspect(video.id)}><span>{video.title}</span></button>;
          })}</div>
          <div className='scatter-legend'><span><i className='breakout' />Breakout</span><span><i className='rising' />Rising</span><span><i className='steady' />Steady</span></div>
        </article>

        <article className='trend-card pattern-card'>
          <div className='trend-card-head'><div><p className='panel-label'>Format signal</p><h4>Which lengths are surfacing</h4></div><span>{report.sampleSize} videos</span></div>
          <div className='duration-chart'>{report.durationMix.map((bucket) => <div key={bucket.label}><span>{bucket.label}</span><i><b style={{height:`${Math.max(4,(bucket.videos/maxDurationCount)*100)}%`}} /></i><strong>{bucket.videos}</strong><small>{formatNumber(bucket.averageViewsPerHour)}/h avg</small></div>)}</div>
        </article>

        <article className='trend-card hashtag-card'>
          <div className='trend-card-head'><div><p className='panel-label'>Discovery language</p><h4>Observed hashtags & title terms</h4></div><span>Correlation, not causation</span></div>
          {report.hashtags.length ? <div className='hashtag-list'>{report.hashtags.slice(0,6).map((item) => <div key={item.tag}><strong>{item.tag}</strong><span>{item.videos} video{item.videos === 1 ? '' : 's'}</span><b>{item.lift ? `${item.lift.toFixed(1)}×` : '—'} velocity</b></div>)}</div> : <p className='no-hashtags'>No repeated visible hashtags appeared in this sample. Don’t force them—the topic and title pattern are stronger signals here.</p>}
          <div className='term-cloud'>{report.titlePatterns.slice(0,7).map((item, index) => <span key={item.term} style={{fontSize:`${11 + Math.max(0,4-index)}px`}}>{item.term}<small>{item.videos}</small></span>)}</div>
        </article>
      </div>

      <div className='trend-bottom-grid'>
        <article className='trend-leaders'>
          <div className='trend-card-head'><div><p className='panel-label'>Videos to study</p><h4>Current sample leaders</h4></div><span>Open any source</span></div>
          <div className='leader-list'>{report.videos.slice(0,5).map((video, index) => <button key={video.id} onClick={() => onInspect(video.id)}><span className='leader-rank'>{String(index+1).padStart(2,'0')}</span><div className='leader-thumb'>{video.thumbnails[0]?.url ? <img src={video.thumbnails[0].url} alt='' /> : <span>YT</span>}</div><div><strong>{video.title}</strong><small>{video.channel.name} · {video.publishedTimeText ?? video.publishDate ?? 'Published recently'}</small></div><span className={`signal-pill ${video.trendBand.toLowerCase()}`}>{video.trendBand}</span><div className='leader-metric'><strong>{formatNumber(video.viewsPerHour ?? 0)}/h</strong><small>{formatNumber(video.viewCount)} views</small></div></button>)}</div>
        </article>

        <aside className={`video-plan ${aiPlan ? 'ai-ready' : ''}`}>
          <div className='plan-head'><div><p className='panel-label'>Your video plan</p><h3>{aiPlan ? 'An AI-shaped brief, grounded in this sample.' : 'Turn these signals into a sharper brief.'}</h3></div>{aiPlan && <span>GPT-OSS 120B</span>}</div>
          {aiPlan ? <>
            <blockquote>{aiPlan.angle}</blockquote>
            <div className='plan-pair'><div className='plan-detail'><span>AUDIENCE</span><strong>{aiPlan.audience}</strong></div><div className='plan-detail'><span>RECOMMENDED LENGTH</span><strong>{formatDuration(aiPlan.recommendedDurationSeconds)}</strong></div></div>
            <div className='plan-hook'><span>OPENING HOOK</span><p>{aiPlan.hook}</p></div>
            <div className='plan-outline'><span>STORY ARC</span>{aiPlan.outline.map((item, index) => <div key={`${item.section}-${index}`}><b>{index + 1}</b><p><strong>{item.section}</strong><small>{item.goal}</small></p></div>)}</div>
            <div className='plan-titles'><span>TITLE OPTIONS</span>{aiPlan.titleIdeas.map((title) => <p key={title}>{title}</p>)}</div>
            <div className='plan-tags'><span>HASHTAGS TO TEST</span><div>{aiPlan.hashtags.length ? aiPlan.hashtags.map((tag) => <b key={tag}>{tag}</b>) : <small>No useful hashtag signal</small>}</div></div>
            <div className='plan-difference'><span>HOW TO DIFFERENTIATE</span><ul>{aiPlan.differentiation.map((item) => <li key={item}>{item}</li>)}</ul></div>
            <details className='plan-evidence'><summary>Evidence and limits</summary><ul>{aiPlan.evidence.map((item) => <li key={item.claim}>{item.claim} <small>Sources: {item.videoIds.join(', ')}</small></li>)}{aiPlan.caveats.map((item) => <li key={item}>{item}</li>)}</ul></details>
            <button className='plan-regenerate' disabled={aiLoading} onClick={() => void generatePlan()}>{aiLoading ? 'Thinking…' : 'Regenerate plan'}</button>
          </> : <>
            <blockquote>{report.plan.angle}</blockquote>
            <p className='plan-explainer'>The charts above are calculated. GPT-OSS 120B can now reason across those signals to choose an audience, hook, story arc, titles, and differentiation—with source IDs attached.</p>
            <button className='plan-generate' disabled={aiLoading} onClick={() => void generatePlan()}><span>✦</span>{aiLoading ? 'Building your plan…' : 'Generate with GPT-OSS 120B'}</button>
            <div className='plan-detail'><span>SIGNAL-BASED LENGTH</span><strong>{report.plan.recommendedDurationSeconds ? formatDuration(report.plan.recommendedDurationSeconds) : 'Test 8–12 min'}</strong></div>
            <div className='plan-tags'><span>OBSERVED REPEATED HASHTAGS</span><div>{report.plan.observedHashtags.length ? report.plan.observedHashtags.map((tag) => <b key={tag}>{tag}</b>) : <small>No repeated hashtag signal</small>}</div></div>
          </>}
          {aiError && <p className='plan-error'>{aiError}</p>}
        </aside>
      </div>
      <p className='trend-method'><strong>How to read this:</strong> {report.methodology}</p>
    </>}
  </section>;
}

function TrendLoading({ onCancel }: { onCancel: () => void }) {
  return <div className='trend-loading' role='status' aria-live='polite'><div className='loading-dots' aria-hidden='true'><i /><i /><i /></div><p><strong>Building a fresh topic sample…</strong><span>Searching, enriching, and comparing public video signals. This stops automatically if the source takes too long.</span></p><button onClick={onCancel}>Cancel scan</button></div>;
}

function DiscoveryGrid({ items, projects, monitors, sourceState, onInspect, onStart, loading, hasSearched }: { items: SearchItem[]; projects: Project[]; monitors: Monitor[]; sourceState: 'checking' | 'live' | 'degraded'; onInspect: (type: EntityType, id: string, provider?: ProviderId) => void; onStart: () => void; loading: boolean; hasSearched: boolean }) {
  const savedSources = projects.reduce((total, project) => total + (project.item_count ?? 0), 0);
  const activeMonitors = monitors.filter((monitor) => monitor.enabled).length;
  return <section className='content-section discovery-section'>
    <div className='research-layout'>
      <div className='source-inbox'>
        <div className='section-heading'><div><h2>{items.length ? 'Evidence to explore' : hasSearched ? 'No matching sources' : 'Open a source workspace'}</h2><p>{items.length ? 'Choose a result to inspect its captions, comments, and source details.' : hasSearched ? 'Try a broader topic, remove a filter, or paste a direct YouTube URL.' : 'Paste a video, channel, or playlist URL to begin with real source data.'}</p></div>{items.length ? <span>{items.length} sources · {loading ? 'previous results' : 'current results'}</span> : null}</div>
        {!items.length && !loading ? <div className='source-onboarding'><Icon name='search' size={22} /><div><strong>{hasSearched ? 'Nothing matched this search.' : 'Your source inbox is empty.'}</strong><p>{hasSearched ? 'Change the query or filters and search again.' : 'Start with a URL or search term. The result will replace this guide.'}</p></div><button onClick={onStart}>{hasSearched ? 'Edit search' : 'Paste a YouTube URL'}</button></div> : null}
        <div className='source-grid'>{loading && !items.length ? Array.from({length:4}).map((_,i)=><div className='source-card skeleton' key={i}/>) : items.map((item, index) => <button className={`source-card ${index === 0 ? 'featured' : ''}`} key={`${item.provider ?? 'youtube'}-${item.type}-${item.id}`} onClick={() => onInspect(item.type,item.id,item.provider)}>
          <div className='thumbnail'>{item.thumbnails?.[0]?.url ? <img src={item.thumbnails[0].url} alt='' /> : <div className='thumb-placeholder'>YT</div>}<span className={`type-pill ${item.type}`}>{item.type}</span>{item.durationText && <time>{item.durationText}</time>}</div>
          <div className='card-copy'><span className='evidence-label'><i />Ready to inspect</span><h3>{item.title ?? item.name}</h3><p>{item.channel?.name ?? item.description ?? `${item.videoCountText ?? ''}`}</p><div><span>{item.viewCountText ?? item.publishedTimeText ?? 'Source ready'}</span><b>Open evidence <span>→</span></b></div></div>
        </button>)}</div>
      </div>
      <aside className='research-pulse'>
        <div className='pulse-head'><div><p className='panel-label'>Workspace status</p><h3>Your research</h3></div><span className={`live-pill ${sourceState}`}><i />{sourceState === 'live' ? 'Live' : sourceState === 'checking' ? 'Checking' : 'Limited'}</span></div>
        <div className='pulse-stats'><article><strong>{projects.length}</strong><span>active projects</span></article><article><strong>{savedSources}</strong><span>saved sources</span></article><article><strong>{activeMonitors}</strong><span>signal monitors</span></article></div>
        <div className='pipeline-card'><div><span>Evidence pipeline</span><b>{sourceState === 'live' ? 'Healthy' : sourceState === 'checking' ? 'Checking' : 'Limited'}</b></div><ol><li className={sourceState === 'live' ? 'complete' : ''}><i>{sourceState === 'live' ? '✓' : '1'}</i><span><b>Source discovery</b><small>{sourceState === 'live' ? 'Live YouTube catalog' : sourceState === 'checking' ? 'Checking source access' : 'Retry a search to reconnect'}</small></span></li><li className='complete'><i>✓</i><span><b>Transcript index</b><small>Exact moments retained</small></span></li><li><i>3</i><span><b>Cited synthesis</b><small>Ready when you ask</small></span></li></ol></div>
        <p className='pulse-note'>Keep claims connected to the moment and source they came from.</p>
      </aside>
    </div>
  </section>;
}

function InspectorPanel({ inspector, segments, transcriptQuery, setTranscriptQuery, onClose, onSave, onMonitor }: { inspector: Inspector; segments: Segment[]; transcriptQuery: string; setTranscriptQuery: (value:string)=>void; onClose:()=>void; onSave:()=>void; onMonitor:()=>void }) {
  const title = String(inspector.data.title ?? inspector.data.name ?? inspector.id);
  const channel = inspector.data.channel as { name?: string } | undefined;
  const chatSection = useRef<HTMLDivElement>(null);
  const openChat = () => {
    chatSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => chatSection.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }), 350);
  };
  return <section className='inspector'>
    <div className='inspector-head'><button className='back' onClick={onClose}>← Back to discovery</button><div className='inspector-actions'><button onClick={onMonitor}><Icon name='monitor' size={15} />Monitor</button><button onClick={onSave}><Icon name='plus' size={15} />Save to project</button>{inspector.type === 'video' && <button className='primary' onClick={openChat}><Icon name='spark' size={15} />Open cited chat</button>}</div></div>
    <div className='entity-title'><div><span className={`type-pill ${inspector.type}`}>{inspector.type}</span><h2>{title}</h2><p>{channel?.name ?? String(inspector.data.description ?? '').slice(0,160)}</p></div><div className='data-health'><i /> Fresh from YouTube<br /><small>Partial sections degrade safely</small></div></div>
    {inspector.type === 'video' ? <>
      <div className='source-research-layout'>
        <section className='caption-workspace' aria-labelledby='caption-workspace-title'>
          <header className='workspace-panel-head'><div><p className='panel-label'>Source captions</p><h3 id='caption-workspace-title'>Transcript</h3></div><span>{inspector.transcript?.segments.length ?? 0} moments</span></header>
          <div className='caption-player'><div className='player'><iframe src={`https://www.youtube-nocookie.com/embed/${inspector.id}`} title={title} allowFullScreen /></div><div className='signal-strip'><span><b>{formatNumber(inspector.data.viewCount)}</b> views</span><span><b>{inspector.transcript?.segments.length ?? 0}</b> captions</span><span><b>{inspector.comments?.length ?? 0}</b> comments</span></div></div>
          <div className='transcript-toolbar'><div><p className='panel-label'>Synchronized transcript</p><strong>{inspector.transcript?.track.name ?? 'No caption track'}</strong> <span>{inspector.transcript?.track.kind}</span></div><label><span className='sr-only'>Search transcript</span><input aria-label='Search transcript' value={transcriptQuery} onChange={(event)=>setTranscriptQuery(event.target.value)} placeholder='Search captions…' /></label></div>
          <div className='segments'>{segments.slice(0,300).map((segment) => <a key={`${segment.startMs}-${segment.text}`} href={`https://youtube.com/watch?v=${inspector.id}&t=${Math.floor(segment.startMs/1000)}s`} target='_blank' rel='noreferrer'><time>{formatTime(segment.startMs)}</time><p>{highlight(segment.text, transcriptQuery)}</p></a>)}{!segments.length && <div className='empty-state'>No matching caption moments.</div>}</div>
        </section>
        <div className='chat-workspace' ref={chatSection}><SourceChat key={inspector.id} inspector={inspector} /></div>
      </div>
      <CommentSample comments={inspector.comments ?? []} />
    </> : <CatalogEntity inspector={inspector} />}
  </section>;
}

function SourceChat({ inspector }: { inspector: Inspector }) {
  const [sessions, setSessions] = useState<ChatSession[]>([{ id: 'chat-1', title: 'New chat', messages: [] }]);
  const [activeSessionId, setActiveSessionId] = useState('chat-1');
  const [question, setQuestion] = useState('');
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const sessionCounter = useRef(1);
  const messageCounter = useRef(0);
  const request = useRef<{ controller: AbortController; sessionId: string; question: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const chatLog = useRef<HTMLDivElement>(null);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];

  useEffect(() => () => request.current?.controller.abort(), []);
  useEffect(() => {
    if (chatLog.current) chatLog.current.scrollTop = chatLog.current.scrollHeight;
  }, [activeSession?.messages.length, activeSessionId, pendingSessionId]);

  const updateSession = (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
    setSessions((current) => current.map((session) => session.id === sessionId ? updater(session) : session));
  };

  const newChat = () => {
    sessionCounter.current += 1;
    const id = `chat-${sessionCounter.current}`;
    setSessions((current) => [...current, { id, title: `New chat ${sessionCounter.current}`, messages: [] }]);
    setActiveSessionId(id); setQuestion('');
    window.requestAnimationFrame(() => composer.current?.focus());
  };

  const stopAnswer = () => {
    const pending = request.current;
    if (!pending) return;
    pending.controller.abort();
    updateSession(pending.sessionId, (session) => ({ ...session, messages: [...session.messages, { id: `message-${++messageCounter.current}`, role: 'assistant', content: 'Response stopped. You can ask the question again when you’re ready.', failedQuestion: pending.question }] }));
    request.current = null; setPendingSessionId(null);
  };

  const sendQuestion = async (event?: FormEvent) => {
    event?.preventDefault();
    const nextQuestion = question.trim();
    if (!nextQuestion || pendingSessionId || !activeSession) return;
    const sessionId = activeSession.id;
    const previousMessages = activeSession.messages.filter((message) => !message.failedQuestion).slice(-6);
    const contextualQuestion = previousMessages.length ? `Continue this conversation about the same video source.\n\n${previousMessages.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.slice(0, 900)}`).join('\n')}\n\nUser's new question: ${nextQuestion}` : nextQuestion;
    const userMessage: ChatMessage = { id: `message-${++messageCounter.current}`, role: 'user', content: nextQuestion };
    updateSession(sessionId, (session) => ({ ...session, title: session.messages.length ? session.title : compactChatTitle(nextQuestion), messages: [...session.messages, userMessage] }));
    setQuestion(''); setPendingSessionId(sessionId);
    const controller = new AbortController(); request.current = { controller, sessionId, question: nextQuestion };
    try {
      const response = await api<Answer>('/v1/answers', { method: 'POST', body: JSON.stringify({ question: contextualQuestion, provider: inspector.provider, entityId: inspector.id }), signal: controller.signal }, 25_000);
      updateSession(sessionId, (session) => ({ ...session, messages: [...session.messages, { id: `message-${++messageCounter.current}`, role: 'assistant', content: response.answer, citations: response.citations }] }));
    } catch (cause) {
      if (!isAbortError(cause)) updateSession(sessionId, (session) => ({ ...session, messages: [...session.messages, { id: `message-${++messageCounter.current}`, role: 'assistant', content: cause instanceof Error ? cause.message : 'I could not create a cited answer. Save and index the source, then try again.', failedQuestion: nextQuestion }] }));
    } finally {
      if (request.current?.controller === controller) { request.current = null; setPendingSessionId(null); }
    }
  };

  const reuseFailedQuestion = (value: string) => {
    setQuestion(value); window.requestAnimationFrame(() => composer.current?.focus());
  };

  return <section className='source-chat' aria-labelledby='source-chat-title'>
    <div className='chat-heading'><div><p className='panel-label'>Research assistant</p><h3 id='source-chat-title'>Cited chat</h3><p>Ask, follow up, and keep every answer attached to the source.</p></div><span><i />{inspector.transcript?.segments.length ?? 0} source moments</span></div>
    <div className='chat-session-bar'><div className='chat-tabs' role='tablist' aria-label='Chat sessions'>{sessions.map((session) => <button type='button' role='tab' aria-selected={session.id === activeSessionId} className={session.id === activeSessionId ? 'active' : ''} key={session.id} onClick={() => setActiveSessionId(session.id)}><span aria-hidden='true'>◇</span>{session.title}</button>)}</div><button type='button' className='new-chat-button' aria-label='Start a new chat session' onClick={newChat}><b aria-hidden='true'>＋</b><span>New chat</span></button></div>
    <div className='chat-surface'>
      <div className='chat-log' ref={chatLog} role='log' aria-live='polite' aria-label={`Messages in ${activeSession.title}`}>
        {!activeSession.messages.length && pendingSessionId !== activeSession.id && <div className='chat-empty'><div className='chat-empty-mark' aria-hidden='true'><Icon name='spark' size={17} /></div><h4>Ask this video anything</h4><p>Answers stay grounded in the captions.</p><div>{['Summarize with evidence','Show the strongest claims','Find a concrete example'].map((prompt) => <button key={prompt} onClick={() => { setQuestion(prompt); composer.current?.focus(); }}>{prompt}</button>)}</div></div>}
        {activeSession.messages.map((message) => <ChatMessageBubble key={message.id} message={message} provider={inspector.provider} sourceId={inspector.id} onReuse={reuseFailedQuestion} />)}
        {pendingSessionId === activeSession.id && <article className='chat-message assistant pending'><div className='chat-avatar' aria-hidden='true'>✦</div><div className='chat-bubble'><span>Evidence assistant</span><div className='chat-thinking' role='status'><i /><i /><i /><b>Reading source moments…</b></div><button className='stop-answer' onClick={stopAnswer}>Stop generating</button></div></article>}
      </div>
      <form className='chat-composer' onSubmit={(event) => void sendQuestion(event)}>
        <label className='sr-only' htmlFor={`chat-question-${inspector.id}`}>Ask a question about this video</label><textarea ref={composer} id={`chat-question-${inspector.id}`} rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendQuestion(); } }} placeholder='Ask a follow-up about this video…' />
        <div><small>Enter to send · Shift + Enter for a new line</small><button disabled={!question.trim() || Boolean(pendingSessionId)}><Icon name='spark' size={14} />{pendingSessionId ? 'Answering…' : 'Ask with citations'}</button></div>
      </form>
    </div>
  </section>;
}

function ChatMessageBubble({ message, provider, sourceId, onReuse }: { message: ChatMessage; provider: ProviderId; sourceId: string; onReuse: (question: string) => void }) {
  return <article className={`chat-message ${message.role}${message.failedQuestion ? ' failed' : ''}`}><div className='chat-avatar' aria-hidden='true'>{message.role === 'user' ? 'You' : <Icon name='spark' size={15} />}</div><div className='chat-bubble'><span>{message.role === 'user' ? 'You' : 'Evidence assistant'}</span><p>{message.content}</p>{message.citations?.length ? <div className='chat-citations' aria-label='Sources cited in this answer'>{message.citations.map((citation) => <a key={`${message.id}-${citation.index}`} href={sourceUrl(citation.provider ?? provider, citation.entityId ?? sourceId, citation.startMs)} target='_blank' rel='noreferrer'><b>[{citation.index}]</b><span>{citation.text.slice(0,120)}{citation.text.length > 120 ? '…' : ''}</span><time>{citation.startMs !== undefined ? formatTime(citation.startMs) : 'source'}</time></a>)}</div> : null}{message.failedQuestion && <button className='retry-chat' onClick={() => onReuse(message.failedQuestion ?? '')}>Put question back in composer</button>}</div></article>;
}

function compactChatTitle(value: string) {
  return value.length > 34 ? `${value.slice(0, 34).trim()}…` : value;
}

function CatalogEntity({ inspector }: { inspector: Inspector }) {
  const videos = (inspector.data.videos ?? []) as SearchItem[];
  const playlists = (inspector.data.playlists ?? []) as SearchItem[];
  return <div className='catalog-layout'><div className='catalog-stats'><article><small>VIDEOS FOUND</small><strong>{videos.length}</strong></article><article><small>PLAYLISTS</small><strong>{playlists.length}</strong></article><article><small>INDEX STATE</small><strong>{inspector.data.continuation ? 'Partial' : 'Current'}</strong></article></div><div className='catalog-list'><h3>Catalog</h3>{[...videos,...playlists].slice(0,50).map((item)=><a key={item.id} href={item.type==='video'?`https://youtube.com/watch?v=${item.id}`:`https://youtube.com/playlist?list=${item.id}`} target='_blank' rel='noreferrer'><span>{item.type}</span><strong>{item.title}</strong><small>{item.viewCountText ?? item.videoCountText}</small></a>)}</div></div>;
}

function CommentSample({ comments }: { comments: Array<Record<string,unknown>> }) {
  return <div className='comments-card'><div className='section-heading compact'><div><p className='panel-label'>Audience evidence</p><h3>Comment preview</h3></div><span>Showing {Math.min(3, comments.length)} of {comments.length}</span></div>{comments.slice(0,3).map((comment,index)=><blockquote key={String(comment.id ?? index)}><p>{String(comment.text ?? '')}</p><footer>{String((comment.author as {name?:string})?.name ?? 'Viewer')} · {String(comment.likeCountText ?? 'recent')}</footer></blockquote>)}{!comments.length&&<p className='muted'>No comments returned.</p>}</div>;
}

function AnswerPanel({ answer }: { answer: Answer }) {
  return <section className='answer-panel'><div className='answer-mark'><Icon name='spark' size={17} /></div><div><p className='panel-label'>Cited synthesis</p><h2>Answer grounded in source moments</h2><div className='answer-copy'>{answer.answer}</div><div className='citations'>{answer.citations.map((citation)=><a key={citation.index} href={citation.entityId ? `https://youtube.com/watch?v=${citation.entityId}${citation.startMs !== undefined ? `&t=${Math.floor(citation.startMs/1000)}s` : ''}` : '#'} target='_blank' rel='noreferrer'><b>[{citation.index}]</b><span>{citation.text.slice(0,140)}…</span><time>{citation.startMs !== undefined ? formatTime(citation.startMs) : 'source'}</time></a>)}</div></div></section>;
}

function ProjectsView({ projects, selectedProject, loading, error, onCreate, onOpen, onBack, onFindSources, onOpenItem }: { projects: Project[]; selectedProject: ProjectDetail | null; loading: boolean; error: string; onCreate:()=>void; onOpen:(project:Project)=>void; onBack:()=>void; onFindSources:()=>void; onOpenItem:(item:ProjectItem)=>void }) {
  if (selectedProject) return <section className='content-section standalone project-detail'><div className='section-heading'><div><button className='back' onClick={onBack}>← All projects</button><h2>{selectedProject.name}</h2></div><button className='button primary' onClick={onFindSources}><Icon name='plus' size={15} />Add sources</button></div><p className='project-description'>{selectedProject.description || 'Saved sources, transcript moments, and evidence for this line of inquiry.'}</p><div className='project-item-list'>{selectedProject.items.map((item)=><article key={item.id}><span className={`type-pill ${item.entity_type}`}>{item.entity_type}</span><div><h3>{item.title || item.entity_id}</h3><p>{item.note || (item.start_ms != null ? `Saved moment at ${formatTime(item.start_ms)}` : 'Saved source')}</p></div><button onClick={() => onOpenItem(item)}>Open evidence →</button></article>)}{!selectedProject.items.length&&<div className='big-empty'><strong>This project is ready for evidence</strong><p>Find a video, channel, or playlist and save it here.</p><button className='button primary' onClick={onFindSources}>Find sources</button></div>}</div></section>;
  return <section className='content-section standalone'><div className='section-heading'><div><h2>Projects turn watching into research</h2><p>Group sources, transcript moments, and notes around one line of inquiry.</p></div>{projects.length>0&&<button className='button primary' onClick={onCreate}><Icon name='plus' size={15} />New project</button>}</div>{loading&&<div className='inline-status' role='status'><span className='status-spinner' aria-hidden='true'/>Opening project…</div>}{error&&<div className='alert error' role='alert'>{error}</div>}<div className='project-grid'>{projects.map((project,index)=><article key={project.id}><span className={`project-color c${index%4}`}/><h3>{project.name}</h3><p>{project.description || 'Videos, transcript moments, notes, and cited intelligence.'}</p><footer><b>{project.item_count ?? 0} sources</b><button onClick={() => onOpen(project)}>Open project →</button></footer></article>)}{!projects.length&&<div className='big-empty'><strong>No projects yet</strong><p>Create a project, then collect videos, channels, playlists, and exact transcript moments.</p><button className='button primary' onClick={onCreate}>Create first project</button></div>}</div></section>;
}

function MonitorsView({ monitors, onFindSource, onOpenTarget }: { monitors: Monitor[]; onFindSource:()=>void; onOpenTarget:(target:string)=>void }) {
  const activeCount = monitors.filter((monitor) => monitor.enabled).length;
  return <section className='content-section standalone'><div className='section-heading'><div><h2>Know what changed without refreshing</h2><p>Track new uploads and shifts in topic momentum.</p></div><span>{activeCount} active</span></div><div className='monitor-list'>{monitors.map((monitor)=><article key={monitor.id}><span className='pulse'/><div><small>{monitor.kind.toUpperCase()}</small><h3>{monitor.target}</h3><p>New uploads, keyword mentions, view velocity, and audience-theme changes.</p></div><div><b>{monitor.enabled ? 'Active' : 'Paused'}</b><small>{monitor.last_checked_at ? `Checked ${new Date(monitor.last_checked_at).toLocaleString()}` : 'First scan queued'}</small><button onClick={() => onOpenTarget(monitor.target)}>Open in Sources →</button></div></article>)}{!monitors.length&&<div className='big-empty'><strong>No monitors yet</strong><p>Start from a channel or topic, inspect it, then choose Monitor.</p><button className='button primary' onClick={onFindSource}>Find a source to monitor</button></div>}</div></section>;
}

function SignInDialog({ onClose }: { onClose:()=>void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const [email,setEmail]=useState(''); const [message,setMessage]=useState('');
  const magic=async(event:FormEvent)=>{event.preventDefault();const response=await fetch('/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,callbackURL:'/'})});setMessage(response.ok?'Check your inbox for a secure sign-in link.':'Could not send the link.');};
  const google=async()=>{const response=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'google',callbackURL:'/'})});const data=await response.json() as {url?:string};if(data.url)window.location.href=data.url;};
  return <div className='dialog-backdrop' onMouseDown={onClose}><div ref={dialogRef} className='dialog' role='dialog' aria-modal='true' aria-labelledby='sign-in-title' onMouseDown={(event)=>event.stopPropagation()}><button className='dialog-close' aria-label='Close sign-in dialog' onClick={onClose}>×</button><p className='panel-label'>Private workspace</p><h2 id='sign-in-title'>Sign in to your research</h2><p>Projects, notes, monitors, and YouTube sync stay private to you.</p><button className='google-button' onClick={()=>void google()}>Continue with Google</button><div className='or'><span/>or<span/></div><form onSubmit={magic}><label className='field-label' htmlFor='sign-in-email'>Email address</label><input id='sign-in-email' type='email' required value={email} onChange={(event)=>setEmail(event.target.value)} placeholder='you@example.com'/><button>Send magic link</button></form><small className='dialog-message' role='status' aria-live='polite'>{message || '\u00a0'}</small></div></div>;
}

function NewProjectDialog({ onClose,onCreate }: { onClose:()=>void;onCreate:(name:string)=>void }) { const dialogRef=useDialogFocus<HTMLFormElement>(onClose);const [name,setName]=useState('');return <div className='dialog-backdrop' onMouseDown={onClose}><form ref={dialogRef} className='dialog' role='dialog' aria-modal='true' aria-labelledby='new-project-title' onMouseDown={(event)=>event.stopPropagation()} onSubmit={(event)=>{event.preventDefault();if(name.trim())onCreate(name.trim());}}><button type='button' className='dialog-close' aria-label='Close new-project dialog' onClick={onClose}>×</button><p className='panel-label'>New project</p><h2 id='new-project-title'>Name this line of inquiry</h2><label className='field-label' htmlFor='project-name'>Project name</label><input id='project-name' autoFocus value={name} onChange={(event)=>setName(event.target.value)} placeholder='e.g. AI video research'/><button className='button primary' disabled={!name.trim()}>Create project</button></form></div>; }

function useDialogFocus<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    window.requestAnimationFrame(() => {
      const preferred = dialog?.querySelector<HTMLElement>('input[autofocus], input, button:not(.dialog-close)');
      preferred?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previouslyFocused?.focus(); };
  }, [onClose]);
  return dialogRef;
}

function evidenceToItem(result: Citation): SearchItem { return { provider:result.provider??'youtube',type:'video',id:result.entityId??result.index.toString(),title:result.text,description:`Match score ${Math.round(result.score*100)}% · ${result.startMs!==undefined?formatTime(result.startMs):'source'}`,thumbnails:[] }; }
function sourceUrl(provider: ProviderId, id: string, startMs?: number) { return provider === 'youtube' ? `https://youtube.com/watch?v=${id}${startMs !== undefined ? `&t=${Math.floor(startMs/1000)}s` : ''}` : '#'; }
function formatTime(ms:number){const total=Math.floor(ms/1000);return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;}
function formatNumber(value:unknown){const number=Number(value);return Number.isFinite(number)?Intl.NumberFormat('en',{notation:'compact'}).format(number):'—';}
function formatDuration(seconds:number){const minutes=Math.round(seconds/60);return minutes >= 60 ? `${Math.floor(minutes/60)}h ${minutes%60}m` : `${minutes} minutes`;}
function highlight(value:string,query:string){if(!query.trim())return value;const parts=value.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'ig'));return parts.map((part,index)=>part.toLowerCase()===query.toLowerCase()?<mark key={index}>{part}</mark>:part);}
