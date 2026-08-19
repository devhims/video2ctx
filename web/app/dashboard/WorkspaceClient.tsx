'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  canDeleteAccount,
  confirmDashboardEmailConsent,
  CREDIT_BALANCE_EVENT,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DELETE_ACCOUNT_CONFIRMATION,
  emailConsentToConfirm,
  loadDashboardAccountData,
  pathWithoutEmailConsent,
  publishCreditBalance,
  type DashboardUsage,
  type DashboardNotification,
  type DashboardNotificationPreferences,
} from '../../lib/dashboard-data';
import { DashboardSidebar, Icon, type DashboardSection } from './DashboardSidebar';
import { useDashboardSession } from './DashboardSessionProvider';

type ProviderId = 'youtube';
type Section = DashboardSection;
type PlatformHealthState = 'checking' | 'healthy' | 'unavailable';
type EntityType = 'video' | 'channel' | 'playlist';
type SourceDataOption = 'transcript' | 'comments' | 'channel';
type Thumbnail = { url: string; width?: number; height?: number };
type SearchItem = {
  provider?: ProviderId; type: EntityType; id: string; title?: string; name?: string; description?: string;
  channel?: { id: string; name: string }; thumbnails: Thumbnail[]; durationText?: string;
  viewCountText?: string; publishedTimeText?: string; isLive?: boolean; videoCountText?: string;
};
type Segment = { text: string; startMs: number; endMs: number; durationMs: number };
type SourceMetadata = { source: string; fetchedAt: string; partial: boolean; warnings: string[] };
type Transcript = { videoId: string; segments: Segment[]; text: string; granularity?: 'segment' | 'word'; meta: SourceMetadata; track: { name: string; kind: string; languageCode: string } };
type CommentRecord = {
  id: string;
  author?: { id?: string; name?: string; thumbnails?: Thumbnail[] };
  text?: string;
  publishedTimeText?: string;
  likeCount?: number;
  likeCountText?: string;
  replyCount?: number;
  isPinned?: boolean;
  isHearted?: boolean;
};
type CommentPage = {
  videoId: string;
  comments: CommentRecord[];
  totalCount?: number;
  continuation?: string;
  meta: SourceMetadata;
};
type ChannelInfo = {
  id: string;
  name: string;
  handle?: string;
  thumbnails: Thumbnail[];
  url: string;
  about: {
    description?: string;
    links: Array<{ title: string; displayUrl: string; url: string }>;
    moreInfo: {
      canonicalChannelUrl: string;
      displayCanonicalChannelUrl?: string;
      joinedDate?: string;
      joinedDateText?: string;
      subscriberCount?: number;
      subscriberCountText?: string;
      videoCount?: number;
      videoCountText?: string;
      viewCount?: number;
      viewCountText?: string;
      businessEmailAvailable: boolean;
    };
  };
  meta: SourceMetadata;
};
type Project = { id: string; name: string; description?: string; item_count?: number };
type ProjectItem = { id: string; provider: ProviderId; entity_type: EntityType; entity_id: string; title?: string; note?: string; start_ms?: number | null; created_at?: number };
type ProjectDetail = Project & { items: ProjectItem[] };
type Monitor = {
  id: string; provider: ProviderId; kind: string; target: string; query_json?: string; cadence?: string;
  interval_minutes?: number; enabled: number; last_checked_at?: number; next_check_at?: number;
};
type Inspector = {
  provider: ProviderId;
  type: EntityType;
  id: string;
  data: Record<string, unknown>;
  requestedData: SourceDataOption[];
  unavailableData: SourceDataOption[];
  transcript?: Transcript;
  comments?: CommentPage;
  channel?: ChannelInfo;
};
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
type Usage = DashboardUsage;

const REQUEST_TIMEOUT_MS = 15_000;
const PLATFORM_HEALTH_TIMEOUT_MS = 5_000;
const PLATFORM_HEALTH_INTERVAL_MS = 5 * 60_000;
const YOUTUBE_API = '/v1/providers/youtube';
const SOURCE_DATA_OPTIONS: Record<SourceDataOption, { shortLabel: string; description: string }> = {
  transcript: { shortLabel: 'Transcript', description: 'Complete timestamped spoken text' },
  comments: { shortLabel: 'Comments', description: 'Paginated public comments and replies' },
  channel: { shortLabel: 'Channel info', description: 'Full creator profile, links, and totals' },
};
const MONITOR_INTERVAL_OPTIONS = [
  { minutes: 60, label: 'Hour' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 4320, label: '3 days' },
  { minutes: 10080, label: 'Week' },
] as const;

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
    publishCreditBalance(response.headers);
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      const code = payload?.error?.code;
      const message = response.status === 401 ? 'Sign in to continue.'
        : response.status === 402 ? 'Your credit balance is too low for this operation.'
        : response.status === 429 ? 'Too many requests. Wait a moment and try again.'
        : payload?.error?.message ?? `Request failed (${response.status})`;
      throw new PlatformApiError(response.status, code, message);
    }
    if (response.status === 204) return undefined as T;
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

export default function WorkspaceClient({ initialSection = 'trends', emailConsent }: { initialSection?: Section; emailConsent?: string }) {
  const { user, demoEnabled, signOut } = useDashboardSession();
  const [section, setSection] = useState<Section>(initialSection);
  const [query, setQuery] = useState('');
  const [selectedData, setSelectedData] = useState<SourceDataOption[]>(['transcript']);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [notifications, setNotifications] = useState<DashboardNotification[]>([]);
  const [notificationPreferences, setNotificationPreferences] = useState<DashboardNotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES);
  const [accountDataReady, setAccountDataReady] = useState(false);
  const [inspector, setInspector] = useState<Inspector | null>(null);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSignIn, setShowSignIn] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [operationLabel, setOperationLabel] = useState('');
  const [platformHealth, setPlatformHealth] = useState<PlatformHealthState>('checking');
  const [selectedProject, setSelectedProject] = useState<ProjectDetail | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [monitorSavingId, setMonitorSavingId] = useState<string>();
  const operationController = useRef<AbortController | null>(null);
  const projectController = useRef<AbortController | null>(null);
  const monitorBackfillAttempted = useRef(new Set<string>());
  const searchInput = useRef<HTMLInputElement>(null);
  const authenticated = Boolean(user) || demoEnabled;
  const playlistInput = isPlaylistUrl(query);

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
    const data = await loadDashboardAccountData((path) => api(path));
    setProjects(data.projects);
    setMonitors(data.monitors);
    setUsage(data.usage);
    setNotifications(data.notifications);
    setNotificationPreferences(data.notificationPreferences);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) { setAccountDataReady(false); return; }
    let cancelled = false;
    void refreshPrivateData().finally(() => {
      if (!cancelled) setAccountDataReady(true);
    });
    return () => { cancelled = true; };
  }, [authenticated, refreshPrivateData]);

  useEffect(() => {
    const updateCreditBalance = (event: Event) => {
      const balance = (event as CustomEvent<number>).detail;
      setUsage((current) => current ? { ...current, creditBalance: balance } : current);
    };
    window.addEventListener(CREDIT_BALANCE_EVENT, updateCreditBalance);
    return () => window.removeEventListener(CREDIT_BALANCE_EVENT, updateCreditBalance);
  }, []);

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
    if (requestedSection === 'trends' || requestedSection === 'discover' || requestedSection === 'projects' || requestedSection === 'monitors' || requestedSection === 'settings') {
      setSection(requestedSection);
    }
    const requestedQuery = params.get('q');
    if (requestedQuery) {
      setQuery(requestedQuery);
      setSection('discover');
      window.requestAnimationFrame(() => searchInput.current?.focus());
    }
  }, []);

  useEffect(() => () => {
    operationController.current?.abort(); projectController.current?.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let checking = false;
    let controller: AbortController | undefined;
    const checkPlatformHealth = async () => {
      if (checking) return;
      checking = true;
      controller = new AbortController();
      try {
        const health = await api<{ status?: string }>('/health', { cache: 'no-store', signal: controller.signal }, PLATFORM_HEALTH_TIMEOUT_MS);
        if (!cancelled) setPlatformHealth(health.status === 'ok' ? 'healthy' : 'unavailable');
      } catch (cause) {
        if (!cancelled && !isAbortError(cause)) setPlatformHealth('unavailable');
      } finally {
        checking = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkPlatformHealth();
    };
    void checkPlatformHealth();
    const interval = window.setInterval(() => void checkPlatformHealth(), PLATFORM_HEALTH_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const legacy = monitors.filter((monitor) =>
      isYouTubeChannelId(monitor.target) &&
      !monitorQueryMetadata(monitor).label &&
      !monitorBackfillAttempted.current.has(monitor.id));
    if (!legacy.length) return;
    legacy.forEach((monitor) => monitorBackfillAttempted.current.add(monitor.id));
    let cancelled = false;
    void Promise.all(legacy.map(async (monitor) => {
      try {
        const channel = await api<ChannelInfo>(`/v1/providers/${monitor.provider}/channels/${encodeURIComponent(monitor.target)}`);
        const query = { label: channel.name, handle: channel.handle };
        await api(`/v1/monitors/${monitor.id}`, { method: 'PATCH', body: JSON.stringify({ query }) });
        return { id: monitor.id, queryJson: JSON.stringify(query) };
      } catch { return null; }
    })).then((updates) => {
      if (cancelled) return;
      const byId = new Map(updates.filter((update): update is { id: string; queryJson: string } => Boolean(update)).map((update) => [update.id, update.queryJson]));
      if (byId.size) setMonitors((current) => current.map((monitor) => byId.has(monitor.id) ? { ...monitor, query_json: byId.get(monitor.id) } : monitor));
    });
    return () => { cancelled = true; };
  }, [monitors]);

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    const controller = beginOperation('Resolving your query…');
    setHasSearched(true);
    setInspector(null); setSection('discover');
    try {
      const resolved = await api<{ kind: EntityType | 'search'; provider?: ProviderId; id?: string; query?: string }>('/v1/resolve', {
        method: 'POST', body: JSON.stringify({ input: query }), signal: controller.signal,
      });
      if (resolved.kind === 'video' && resolved.id) {
        setOperationLabel('Opening the video and fetching your selected data…');
        await inspect('video', resolved.id, controller, resolved.provider ?? 'youtube', selectedData);
        return;
      }
      if (resolved.kind === 'playlist' && resolved.id) {
        setOperationLabel('Opening the playlist and loading its videos…');
        await inspect('playlist', resolved.id, controller, resolved.provider ?? 'youtube', selectedData);
        return;
      }
      if (resolved.kind !== 'search') {
        throw new Error('Sources opens videos and playlists. Paste a supported URL or search for a video by title or topic.');
      }
      setOperationLabel('Searching YouTube videos…');
      const params = new URLSearchParams({ q: resolved.query ?? query, type: 'video' });
      const data = await api<{ results: SearchItem[] }>(`${YOUTUBE_API}/search?${params}`, { signal: controller.signal });
      setItems(data.results.filter((item) => item.type === 'video').map((item) => ({ ...item, provider: 'youtube' })));
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Search failed.');
    } finally { finishOperation(controller); }
  };

  const inspect = async (
    type: EntityType,
    id: string,
    activeController?: AbortController,
    provider: ProviderId = 'youtube',
    requestedData: SourceDataOption[] = selectedData,
  ) => {
    const controller = activeController ?? beginOperation(type === 'video' ? 'Opening the video and fetching your selected data…' : 'Opening the source…');
    setError('');
    try {
      const plural = type === 'video' ? 'videos' : type === 'channel' ? 'channels' : 'playlists';
      const providerApi = `/v1/providers/${provider}`;
      const data = await api<Record<string, unknown>>(`${providerApi}/${plural}/${encodeURIComponent(id)}`, { signal: controller.signal });
      const next: Inspector = { provider, type, id, data, requestedData: type === 'video' ? [...requestedData] : [], unavailableData: [] };
      if (type === 'video') {
        setOperationLabel(`Fetching ${requestedData.map((option) => SOURCE_DATA_OPTIONS[option].shortLabel.toLowerCase()).join(', ')}…`);
        const channelId = String((data.channel as { id?: string } | undefined)?.id ?? '');
        await Promise.all(requestedData.map(async (option) => {
          try {
            if (option === 'transcript') next.transcript = await api<Transcript>(`${providerApi}/videos/${id}/transcript`, { signal: controller.signal });
            if (option === 'comments') {
              next.comments = await api<CommentPage>(`${providerApi}/videos/${id}/comments`, { signal: controller.signal });
            }
            if (option === 'channel' && channelId) next.channel = await api<ChannelInfo>(`${providerApi}/channels/${encodeURIComponent(channelId)}`, { signal: controller.signal });
          } catch (cause) {
            if (isAbortError(cause)) throw cause;
            next.unavailableData.push(option);
          }
        }));
      }
      setInspector(next);
    } catch (cause) { if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not open this source.'); }
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
    const channel = inspector.type === 'channel'
      ? { id: inspector.id, name: String(inspector.data.name ?? 'YouTube channel'), handle: String(inspector.data.handle ?? '') }
      : inspector.data.channel as { id?: string; name?: string; handle?: string } | undefined;
    const target = String(channel?.id ?? '');
    const label = String(channel?.name ?? '').trim() || 'YouTube channel';
    if (!target) { setError('This video does not include a channel that can be monitored.'); return; }
    const query = { label, handle: channel?.handle || undefined, sourceVideoId: inspector.type === 'video' ? inspector.id : undefined };
    try {
      const existing = monitors.find((monitor) => monitor.provider === inspector.provider && monitor.target === target);
      if (existing) await api(`/v1/monitors/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ query }) });
      else await api('/v1/monitors', { method: 'POST', body: JSON.stringify({ provider: inspector.provider, kind: 'channel', target, query }) });
      setNotice(existing ? `Already monitoring ${label}` : `Monitoring ${label} for new uploads`); await refreshPrivateData();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create monitor.'); }
  };

  const removeMonitor = async (id: string) => {
    try {
      await api(`/v1/monitors/${id}`, { method: 'DELETE' });
      setMonitors((current) => current.filter((monitor) => monitor.id !== id));
      setNotice('Monitor removed');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove monitor.'); }
  };

  const updateMonitorSchedule = async (id: string, intervalMinutes: number) => {
    setMonitorSavingId(id); setError('');
    try {
      const schedule = await api<{ intervalMinutes: number; enabled: boolean; nextCheckAt?: number }>(`/v1/monitors/${id}`, {
        method: 'PATCH', body: JSON.stringify({ intervalMinutes }),
      });
      setMonitors((current) => current.map((monitor) => monitor.id === id ? {
        ...monitor,
        interval_minutes: schedule.intervalMinutes,
        enabled: schedule.enabled ? 1 : 0,
        next_check_at: schedule.nextCheckAt,
      } : monitor));
      setNotice(`This monitor will check for new videos every ${monitorIntervalLabel(schedule.intervalMinutes)}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the monitoring schedule.');
    } finally {
      setMonitorSavingId(undefined);
    }
  };

  const markNotificationRead = async (id: string) => {
    const readAt = Date.now();
    setNotifications((current) => current.map((item) => item.id === id ? { ...item, read_at: readAt } : item));
    try {
      await api(`/v1/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
    } catch {
      setNotifications((current) => current.map((item) => item.id === id ? { ...item, read_at: null } : item));
    }
  };

  const markAllNotificationsRead = async () => {
    const unread = notifications.filter((item) => !item.read_at);
    if (!unread.length) return;
    await Promise.all(unread.map((item) => markNotificationRead(item.id)));
  };

  const openNotification = async (notification: DashboardNotification) => {
    if (!notification.read_at) await markNotificationRead(notification.id);
    try {
      const data = JSON.parse(notification.data_json) as { videoId?: string; provider?: ProviderId };
      if (data.videoId) {
        navigateTo('discover');
        await inspect('video', data.videoId, undefined, data.provider ?? 'youtube', selectedData);
      }
    } catch {
      navigateTo('monitors');
    }
  };

  const filteredSegments = useMemo(() => {
    const segments = inspector?.transcript?.segments ?? [];
    const normalized = transcriptQuery.trim().toLowerCase();
    return normalized ? segments.filter((segment) => segment.text.toLowerCase().includes(normalized)) : segments;
  }, [inspector, transcriptQuery]);

  const toggleSelectedData = (option: SourceDataOption) => {
    setSelectedData((current) => current.includes(option)
      ? current.length === 1 ? current : current.filter((value) => value !== option)
      : [...current, option]);
  };

  if (!authenticated) return <main className='auth-gate'>
    <p className='panel-label'>Private research workspace</p>
    <h1>Sign in to research YouTube</h1>
    <p>Data APIs now use your plan and credit balance. Sign in to search, inspect transcripts, and manage projects.</p>
    <button className='signin-button' onClick={() => setShowSignIn(true)}>Sign in</button>
    {showSignIn && <SignInDialog onClose={() => setShowSignIn(false)} />}
  </main>;

  return (
    <main className='workspace-shell'>
      <DashboardSidebar activeSection={section} onNavigate={navigateTo} projects={projects} onNewProject={() => setShowNewProject(true)} onOpenProject={(project) => void openProject(project)} onSignIn={() => setShowSignIn(true)} accountName={user?.name ?? (demoEnabled ? 'Local demo' : undefined)} credits={usage?.creditBalance} onSignOut={() => void signOut()} />
      <div className='workspace-main'>
        <header className='topbar'>
          <div><span className='topbar-context'>Research workspace</span><h1>{section === 'trends' ? 'Trend Lab' : section === 'discover' ? 'Sources' : section === 'projects' ? 'Projects' : section === 'monitors' ? 'Monitors' : 'Settings'}</h1></div>
          <div className='topbar-actions'>
            <span className={`sync-state ${platformHealth}`} role='status' aria-live='polite'><i />{platformHealth === 'healthy' ? 'Platform online' : platformHealth === 'checking' ? 'Checking platform' : 'Platform unavailable'}</span>
            {usage && <span className='credit-balance'>{usage.creditBalance} credits</span>}
            <NotificationMenu
              notifications={notifications}
              enabled={notificationPreferences.inApp}
              onOpen={(notification) => void openNotification(notification)}
              onMarkAll={() => void markAllNotificationsRead()}
              onSettings={() => navigateTo('settings')}
            />
          </div>
        </header>

        <div className='workspace-view' hidden={section !== 'trends'}><TrendLab onInspect={(id) => { navigateTo('discover'); void inspect('video', id); }} /></div>
        <div className='workspace-view' hidden={section !== 'discover'}>
          <>
            <section className='source-studio' aria-labelledby='source-studio-title'>
              <header className='source-studio-intro'>
                <p className='panel-label'>YouTube data studio</p>
                <h2 id='source-studio-title'>{playlistInput ? 'Open a playlist. Review every video.' : 'Find a video. Choose the data you need.'}</h2>
                <p>{playlistInput ? 'Playlist details and its video index are included. Open any video when you are ready to fetch deeper data.' : 'Use a title, topic, video URL, or playlist URL. Video details are included; the additional datasets are up to you.'}</p>
              </header>
              <form onSubmit={runSearch} className='source-studio-form'>
                <label className='source-query-label' htmlFor='workspace-search'>{playlistInput ? 'Playlist URL detected' : 'Video search or YouTube URL'}</label>
                <div className='source-query-row'>
                  <div data-playlist={playlistInput}><Icon name='search' size={19} /><input id='workspace-search' ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder='Search videos, or paste a video or playlist URL' autoComplete='off' /><kbd>{playlistInput ? 'PLAYLIST' : '⌘ K'}</kbd></div>
                  <button disabled={loading || !query.trim()}>{loading ? 'Working…' : playlistInput ? 'Open playlist' : 'Search videos'} <span aria-hidden='true'>→</span></button>
                </div>
                <fieldset className='source-data-picker'>
                  <legend>{playlistInput ? 'Include when you open a video from this playlist' : 'Include when a video opens'}</legend>
                  <div className='source-data-options'>
                    {(Object.keys(SOURCE_DATA_OPTIONS) as SourceDataOption[]).map((option) => {
                      const selected = selectedData.includes(option);
                      const isOnlySelection = selected && selectedData.length === 1;
                      return <label key={option} data-selected={selected} data-locked={isOnlySelection} title={isOnlySelection ? 'Choose another dataset before removing this one' : undefined}>
                        <input type='checkbox' checked={selected} disabled={isOnlySelection} onChange={() => toggleSelectedData(option)} />
                        <span aria-hidden='true'>{selected ? '✓' : '+'}</span>
                        <b>{SOURCE_DATA_OPTIONS[option].shortLabel}</b>
                        <small>{SOURCE_DATA_OPTIONS[option].description}</small>
                      </label>;
                    })}
                  </div>
                  <p><span>{playlistInput ? 'Playlist details and video index included' : 'Video details included'}</span> Select one or more datasets for any video you open.</p>
                </fieldset>
              </form>
            </section>

            {(loading || error || notice) && <div className='source-feedback'>
              {loading && <div className='operation-status' role='status' aria-live='polite'><span className='status-spinner' aria-hidden='true' /><div><strong>{operationLabel}</strong><small>Previous results stay available while this finishes.</small></div><button onClick={cancelOperation}>Cancel</button></div>}
              {error && <div className='alert error' role='alert'><span>{error}</span>{query.trim() && <button onClick={() => void runSearch()}>Retry</button>}</div>}
              {notice && <div className='alert success' role='status'><span>{notice}</span><button aria-label='Dismiss notification' onClick={() => setNotice('')}>×</button></div>}
            </div>}
            {inspector ? (
              <InspectorPanel key={`${inspector.provider}-${inspector.type}-${inspector.id}-${inspector.requestedData.join('-')}`} inspector={inspector} segments={filteredSegments} transcriptQuery={transcriptQuery} setTranscriptQuery={setTranscriptQuery} onClose={() => setInspector(null)} onSave={() => void saveInspector()} onMonitor={() => void addMonitor()} onOpenVideo={(id) => void inspect('video', id, undefined, inspector.provider, selectedData)} />
            ) : (
              <VideoSearchResults items={items} onInspect={(id, provider) => void inspect('video', id, undefined, provider, selectedData)} onStart={() => searchInput.current?.focus()} loading={loading} hasSearched={hasSearched} />
            )}
          </>
        </div>
        <div className='workspace-view' hidden={section !== 'projects'}><ProjectsView projects={projects} selectedProject={selectedProject} loading={projectLoading} error={projectError} onCreate={() => setShowNewProject(true)} onOpen={(project) => void openProject(project)} onBack={() => { setSelectedProject(null); setProjectError(''); }} onFindSources={() => { navigateTo('discover'); window.requestAnimationFrame(() => searchInput.current?.focus()); }} onOpenItem={(item) => { navigateTo('discover'); void inspect(item.entity_type, item.entity_id, undefined, item.provider); }} /></div>
        <div className='workspace-view' hidden={section !== 'monitors'}><MonitorsView monitors={monitors} knownChannel={inspectorChannel(inspector)} savingId={monitorSavingId} onFindSource={() => { navigateTo('discover'); window.requestAnimationFrame(() => searchInput.current?.focus()); }} onOpenTarget={(target) => { setQuery(target); navigateTo('discover'); window.requestAnimationFrame(() => searchInput.current?.focus()); }} onSchedule={(id, intervalMinutes) => void updateMonitorSchedule(id, intervalMinutes)} onRemove={(id) => void removeMonitor(id)} /></div>
        <div className='workspace-view' hidden={section !== 'settings'}><SettingsView email={user?.email} emailConsent={emailConsent} accountDataReady={accountDataReady} isDemo={demoEnabled} preferences={notificationPreferences} onPreferencesChange={setNotificationPreferences} /></div>
      </div>
      {showSignIn && <SignInDialog onClose={() => setShowSignIn(false)} />}
      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} onCreate={(name) => void createProject(name)} />}
    </main>
  );
}

function NotificationMenu({ notifications, enabled, onOpen, onMarkAll, onSettings }: {
  notifications: DashboardNotification[];
  enabled: boolean;
  onOpen: (notification: DashboardNotification) => void;
  onMarkAll: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unread = enabled ? notifications.filter((notification) => !notification.read_at).length : 0;

  return <div className='notification-menu'>
    <button className='notification-trigger' aria-label={unread ? `${unread} unread notifications` : 'Notifications'} aria-expanded={open} aria-haspopup='dialog' onClick={() => setOpen((current) => !current)}>
      <Icon name='bell' size={17} />
      {unread > 0 && <span>{unread > 9 ? '9+' : unread}</span>}
    </button>
    {open && <section className='notification-popover' role='dialog' aria-label='Notifications'>
      <header><div><strong>Notifications</strong><small>{enabled ? unread ? `${unread} unread` : 'You’re all caught up' : 'In-app alerts are off'}</small></div>{enabled && unread > 0 && <button onClick={onMarkAll}>Mark all read</button>}</header>
      {!enabled ? <div className='notification-empty'><p>Turn on in-app alerts to see new monitor matches here.</p><button onClick={() => { setOpen(false); onSettings(); }}>Open settings</button></div>
        : notifications.length ? <div className='notification-list'>{notifications.slice(0, 8).map((notification) => <button key={notification.id} data-unread={!notification.read_at} onClick={() => { setOpen(false); onOpen(notification); }}>
          <i aria-hidden='true' />
          <span><strong>{notification.title}</strong><small>{notification.body}</small><time>{relativeNotificationTime(notification.created_at)}</time></span>
        </button>)}</div>
        : <div className='notification-empty'><p>New videos found by your monitors will appear here.</p></div>}
      <footer><button onClick={() => { setOpen(false); onSettings(); }}>Notification settings</button></footer>
    </section>}
  </div>;
}

function SettingsView({ email, emailConsent, accountDataReady, isDemo, preferences, onPreferencesChange }: {
  email?: string;
  emailConsent?: string;
  accountDataReady: boolean;
  isDemo: boolean;
  preferences: DashboardNotificationPreferences;
  onPreferencesChange: (preferences: DashboardNotificationPreferences) => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [preferenceSaving, setPreferenceSaving] = useState<'inApp' | 'emailAlerts'>();
  const [preferenceMessage, setPreferenceMessage] = useState('');
  const [confirmationState, setConfirmationState] = useState<'idle' | 'confirming' | 'success' | 'error'>('idle');
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const attemptedEmailConsent = useRef<string | undefined>(undefined);
  const confirmed = canDeleteAccount(confirmation);

  const savePreference = async (key: 'inApp' | 'emailAlerts', value: boolean) => {
    const previous = preferences;
    const next = key === 'emailAlerts' && value
      ? { ...preferences, emailAlerts: false, emailAlertsPending: true }
      : { ...preferences, [key]: value, ...(key === 'emailAlerts' ? { emailAlertsPending: false } : {}) };
    onPreferencesChange(next);
    setPreferenceSaving(key);
    setPreferenceMessage('');
    try {
      const saved = await api<DashboardNotificationPreferences>('/v1/notification-preferences', {
        method: 'PUT', body: JSON.stringify({ [key]: value }),
      });
      onPreferencesChange(saved);
      setPreferenceMessage(key === 'emailAlerts' && value
        ? `Confirmation sent to ${email}. Email alerts remain off until you approve them.`
        : 'Notification preferences saved.');
    } catch (cause) {
      onPreferencesChange(previous);
      setPreferenceMessage(cause instanceof Error ? cause.message : 'Could not save notification preferences.');
    } finally {
      setPreferenceSaving(undefined);
    }
  };

  const confirmEmailDelivery = useCallback(async (confirmationToken: string) => {
    setConfirmationState('confirming');
    setConfirmationMessage('');
    try {
      const saved = await confirmDashboardEmailConsent(
        (path, options) => api<DashboardNotificationPreferences>(path, options),
        confirmationToken,
      );
      onPreferencesChange(saved);
      setConfirmationState('success');
      setConfirmationMessage(`Email alerts are now enabled for ${email}.`);
      window.history.replaceState(null, '', pathWithoutEmailConsent(window.location.pathname, window.location.search));
    } catch (cause) {
      setConfirmationState('error');
      setConfirmationMessage(cause instanceof Error ? cause.message : 'Could not confirm email alerts.');
    }
  }, [email, onPreferencesChange]);

  useEffect(() => {
    const confirmationToken = emailConsentToConfirm(
      emailConsent,
      email,
      accountDataReady,
      attemptedEmailConsent.current,
    );
    if (!confirmationToken) return;
    attemptedEmailConsent.current = confirmationToken;
    if (preferences.emailAlerts) {
      setConfirmationState('success');
      setConfirmationMessage(`Email alerts are already enabled for ${email}.`);
      window.history.replaceState(null, '', pathWithoutEmailConsent(window.location.pathname, window.location.search));
      return;
    }
    void confirmEmailDelivery(confirmationToken);
  }, [accountDataReady, confirmEmailDelivery, email, emailConsent, preferences.emailAlerts]);

  const deleteAccount = async () => {
    if (!email || !confirmed || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api<void>('/v1/account', { method: 'DELETE' }, 60_000);
      window.location.replace('/');
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'Could not delete your account.');
      setDeleting(false);
    }
  };

  return <section className='content-section standalone max-w-6xl'>
    <div className='section-heading'>
      <div><h2>Settings</h2><p>Choose how monitor updates reach you and manage your account.</p></div>
    </div>
    <article className='settings-notification-card' aria-labelledby='notification-settings-heading'>
      <div className='settings-notification-intro'>
        <span className='panel-label'>Monitor updates</span>
        <h3 className='settings-card-title' id='notification-settings-heading'>Notifications</h3>
        <p className='settings-card-copy'>Control each delivery channel independently. Changes apply to every monitor.</p>
      </div>
      <div className='settings-toggle-list'>
        {confirmationState !== 'idle' && <div className='settings-email-confirmation' data-state={confirmationState} role={confirmationState === 'error' ? 'alert' : 'status'} aria-live='polite'>
          <span><strong>{confirmationState === 'confirming' ? 'Confirming email alerts…' : confirmationState === 'success' ? 'Email alerts enabled' : 'Email confirmation failed'}</strong><small>{confirmationState === 'confirming' ? <>Checking the approval for <b>{email}</b>.</> : confirmationMessage}</small></span>
        </div>}
        <label className='settings-toggle-row'>
          <span><strong>In-app alerts</strong><small>Show new monitor matches in the notification inbox.</small></span>
          <input type='checkbox' role='switch' checked={preferences.inApp} disabled={Boolean(preferenceSaving)} onChange={(event) => void savePreference('inApp', event.target.checked)} />
          <i aria-hidden='true' />
        </label>
        <label className='settings-toggle-row' data-disabled={!email}>
          <span><strong>Email alerts</strong><small>{email
            ? preferences.emailAlerts
              ? <>Confirmed for <b>{email}</b>. New monitor matches can be emailed immediately.</>
              : preferences.emailAlertsPending
                ? <>Waiting for confirmation from <b>{email}</b>. Monitor emails remain off.</>
                : <>Off by default. Enabling sends a confirmation message to <b>{email}</b>.</>
            : 'Sign in with an account to enable email delivery.'}</small></span>
          <input type='checkbox' role='switch' checked={Boolean(email && (preferences.emailAlerts || preferences.emailAlertsPending))} disabled={!email || Boolean(preferenceSaving)} onChange={(event) => void savePreference('emailAlerts', event.target.checked)} />
          <i aria-hidden='true' />
        </label>
        {preferences.emailAlertsPending && email && <button className='settings-resend-confirmation' type='button' disabled={Boolean(preferenceSaving)} onClick={() => void savePreference('emailAlerts', true)}>Resend confirmation email</button>}
        {isDemo && <p className='settings-demo-note'>Email is disabled for the local demo identity so development checks cannot send to a placeholder address.</p>}
        {preferenceMessage && <p className='settings-save-status' role='status'>{preferenceMessage}</p>}
      </div>
    </article>
    <article className='grid grid-cols-[minmax(0,1fr)_auto] items-center gap-10 rounded-[var(--radius-dashboard-md)] border border-[var(--color-dashboard-rule)] bg-[var(--color-dashboard-surface)] p-6 max-[43.75rem]:grid-cols-1'>
      <div><span className='panel-label'>Signed-in account</span><h3 className='settings-card-title mt-2 mb-0'>{email ?? 'Local demo account'}</h3><p className='settings-card-copy mt-2 mb-0 max-w-[65ch]'>Personal API keys are managed separately from your account profile.</p></div>
      <Link className='button secondary no-underline max-[43.75rem]:w-full' href='/dashboard/developer'>Manage API keys</Link>
    </article>
    <article className='mt-6 grid grid-cols-[minmax(0,1fr)_minmax(17rem,24rem)] items-start gap-10 rounded-[var(--radius-dashboard-md)] border border-[color-mix(in_srgb,var(--color-dashboard-danger)_45%,var(--color-dashboard-rule))] bg-[color-mix(in_srgb,var(--color-dashboard-danger)_4%,var(--color-dashboard-surface))] p-6 max-[43.75rem]:grid-cols-1' aria-labelledby='delete-account-heading'>
      <div>
        <span className='panel-label !text-[var(--color-dashboard-danger)]'>Danger zone</span>
        <h3 className='settings-card-title mt-2 mb-0' id='delete-account-heading'>Delete account permanently</h3>
        <p className='settings-card-copy mt-2 mb-0 max-w-[65ch]'>This removes your projects, saved research, monitors, API keys, credit history, and connected accounts. This action cannot be undone.</p>
      </div>
      {email ? <div className='grid gap-2'>
        <label className='settings-confirm-label' htmlFor='delete-account-confirmation'>Type <strong>{DELETE_ACCOUNT_CONFIRMATION}</strong> to confirm</label>
        <input
          className='settings-confirm-input min-h-11 rounded-[var(--radius-dashboard-sm)] border border-[var(--color-dashboard-rule-strong)] bg-[var(--color-dashboard-surface)] px-3 text-[var(--color-dashboard-ink)]'
          id='delete-account-confirmation'
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete='off'
          spellCheck={false}
          placeholder={DELETE_ACCOUNT_CONFIRMATION}
          aria-describedby='delete-account-help'
          disabled={deleting}
        />
        <small className='text-[.7rem] text-[var(--color-dashboard-muted)]' id='delete-account-help'>The confirmation is case-sensitive.</small>
        <button className='settings-delete-button mt-2 min-h-11 cursor-pointer rounded-[var(--radius-dashboard-sm)] border border-[var(--color-dashboard-danger)] bg-[var(--color-dashboard-danger)] text-white hover:brightness-90 disabled:cursor-not-allowed disabled:opacity-45' disabled={!confirmed || deleting} onClick={() => void deleteAccount()}>
          {deleting ? 'Deleting account…' : 'Delete account permanently'}
        </button>
        {deleteError && <p className='settings-danger-message' role='alert'>{deleteError}</p>}
      </div> : <p className='settings-danger-message mt-2 mb-0 max-w-[65ch]'>Account deletion is unavailable for the local demo identity.</p>}
    </article>
  </section>;
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

function VideoSearchResults({ items, onInspect, onStart, loading, hasSearched }: { items: SearchItem[]; onInspect: (id: string, provider?: ProviderId) => void; onStart: () => void; loading: boolean; hasSearched: boolean }) {
  return <section className='source-results' aria-labelledby='source-results-title'>
    <header>
      <div><p className='panel-label'>Search results</p><h2 id='source-results-title'>{items.length ? 'Choose a video to inspect' : hasSearched ? 'No matching videos' : 'Search results will appear here'}</h2></div>
      {items.length ? <span>{items.length} videos{loading ? ' · refreshing' : ''}</span> : null}
    </header>
    {loading && !items.length ? <div className='source-result-skeletons' aria-label='Loading videos'>{Array.from({ length: 5 }).map((_, index) => <div key={index}><i /><span><b /><small /></span></div>)}</div> : null}
    {!items.length && !loading ? <div className='source-results-empty'><span aria-hidden='true'><Icon name='search' size={22} /></span><div><strong>{hasSearched ? 'Try a broader title or topic.' : 'One field handles search and direct URLs.'}</strong><p>{hasSearched ? 'You can also paste the exact YouTube video URL.' : 'Search by title or topic, then select a result to fetch only the datasets checked above.'}</p></div><button onClick={onStart}>{hasSearched ? 'Edit search' : 'Start searching'}</button></div> : null}
    {items.length ? <div className='source-result-list'>{items.map((item) => {
      const thumbnail = bestThumbnail(item.thumbnails);
      return <button key={`${item.provider ?? 'youtube'}-${item.id}`} onClick={() => onInspect(item.id, item.provider)}>
        <span className='source-result-thumb'>{thumbnail ? <img src={thumbnail.url} alt='' /> : <i>YT</i>}{item.durationText ? <time>{item.durationText}</time> : null}</span>
        <span className='source-result-copy'><b>{item.title ?? 'Untitled video'}</b><small>{item.channel?.name ?? 'YouTube video'}</small><em>{[item.viewCountText, item.publishedTimeText].filter(Boolean).join(' · ') || 'Ready to inspect'}</em></span>
        <span className='source-result-action'>Open <b aria-hidden='true'>→</b></span>
      </button>;
    })}</div> : null}
  </section>;
}

function InspectorPanel({ inspector, segments, transcriptQuery, setTranscriptQuery, onClose, onSave, onMonitor, onOpenVideo }: { inspector: Inspector; segments: Segment[]; transcriptQuery: string; setTranscriptQuery: (value:string)=>void; onClose:()=>void; onSave:()=>void; onMonitor:()=>void; onOpenVideo:(id:string)=>void }) {
  const title = String(inspector.data.title ?? inspector.data.name ?? inspector.id);
  const videoChannel = inspector.data.channel as { id?: string; name?: string; url?: string } | undefined;
  const panelOptions = inspector.requestedData.filter((option) => option !== 'channel');
  const [activePanel, setActivePanel] = useState<SourceDataOption>(panelOptions[0] ?? 'channel');
  const [commentPage, setCommentPage] = useState(inspector.comments);
  const [commentPagesLoaded, setCommentPagesLoaded] = useState(inspector.comments ? 1 : 0);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState('');

  const loadMoreComments = async () => {
    const continuation = commentPage?.continuation;
    if (!continuation || commentsLoading) return;
    setCommentsLoading(true);
    setCommentsError('');
    try {
      const params = new URLSearchParams({ continuation });
      const page = await api<CommentPage>(`/v1/providers/${inspector.provider}/videos/${encodeURIComponent(inspector.id)}/comments?${params}`);
      setCommentPage((current) => {
        if (!current) return page;
        const comments = new Map(current.comments.map((comment) => [comment.id, comment]));
        page.comments.forEach((comment) => comments.set(comment.id, comment));
        return {
          ...page,
          comments: [...comments.values()],
          totalCount: page.totalCount ?? current.totalCount,
          meta: {
            ...page.meta,
            warnings: [...new Set([...current.meta.warnings, ...page.meta.warnings])],
            partial: current.meta.partial || page.meta.partial,
          },
        };
      });
      setCommentPagesLoaded((count) => count + 1);
    } catch (cause) {
      setCommentsError(cause instanceof Error ? cause.message : 'Could not load the next comments page.');
    } finally {
      setCommentsLoading(false);
    }
  };

  if (inspector.type === 'playlist') return <PlaylistInspector inspector={inspector} onClose={onClose} onSave={onSave} onOpenVideo={onOpenVideo} />;
  if (inspector.type !== 'video') return <section className='inspector'><div className='inspector-head'><button className='back' onClick={onClose}>← Back to Sources</button></div><div className='entity-title'><div><span className={`type-pill ${inspector.type}`}>{inspector.type}</span><h2>{title}</h2><p>{String(inspector.data.description ?? '').slice(0,160)}</p></div></div><CatalogEntity inspector={inspector} /></section>;

  return <section className='source-inspector' aria-labelledby='source-detail-title'>
    <div className='source-inspector-toolbar'><button className='back' onClick={onClose}>← Back to results</button><div><button onClick={onMonitor}><Icon name='monitor' size={15} />Monitor channel</button><button onClick={onSave}><Icon name='plus' size={15} />Save to project</button></div></div>
    <header className='source-detail-head'>
      <div><p className='panel-label'>Video result</p><h2 id='source-detail-title'>{title}</h2><p>{[videoChannel?.name, String(inspector.data.publishedTimeText ?? ''), String(inspector.data.viewCountText ?? '')].filter(Boolean).join(' · ')}</p></div>
      <a href={String(inspector.data.url ?? `https://youtube.com/watch?v=${inspector.id}`)} target='_blank' rel='noreferrer'>Open on YouTube ↗</a>
    </header>

    <div className='source-overview-grid' data-channel={inspector.requestedData.includes('channel')}>
      <SourceVideoPreview inspector={inspector} title={title} />
      {inspector.requestedData.includes('channel') ? <SourceChannelOverview channel={inspector.channel} fallback={videoChannel} unavailable={inspector.unavailableData.includes('channel')} /> : null}
    </div>

    {panelOptions.length ? <>
      <div className='source-data-tabs' role='tablist' aria-label='Fetched video data'>
        {panelOptions.map((option) => <button key={option} type='button' role='tab' aria-selected={activePanel === option} className={activePanel === option ? 'active' : ''} onClick={() => setActivePanel(option)}>{SOURCE_DATA_OPTIONS[option].shortLabel}<span>{option === 'transcript' ? inspector.transcript?.segments.length ?? 0 : commentPage?.comments.length ?? 0}</span></button>)}
      </div>
      <section className='source-data-panel' role='tabpanel'>
        {activePanel === 'transcript' ? <TranscriptDataPanel inspector={inspector} segments={segments} transcriptQuery={transcriptQuery} setTranscriptQuery={setTranscriptQuery} /> : null}
        {activePanel === 'comments' ? <CommentsDataPanel unavailable={inspector.unavailableData.includes('comments')} page={commentPage} pagesLoaded={commentPagesLoaded} loading={commentsLoading} error={commentsError} onLoadMore={() => void loadMoreComments()} /> : null}
      </section>
    </> : null}

    <SourceApiGuide inspector={inspector} channelId={videoChannel?.id} />
  </section>;
}

function PlaylistInspector({ inspector, onClose, onSave, onOpenVideo }: { inspector: Inspector; onClose: () => void; onSave: () => void; onOpenVideo: (id: string) => void }) {
  const title = String(inspector.data.title ?? 'YouTube playlist');
  const channel = inspector.data.channel as { id?: string; name?: string; url?: string } | undefined;
  const videos = (inspector.data.videos ?? []) as SearchItem[];
  const thumbnail = bestThumbnail((inspector.data.thumbnails ?? videos[0]?.thumbnails ?? []) as Thumbnail[]);
  const playlistUrl = String(inspector.data.url ?? `https://youtube.com/playlist?list=${inspector.id}`);
  const returnedCount = videos.length;

  return <section className='source-inspector playlist-inspector' aria-labelledby='playlist-detail-title'>
    <div className='source-inspector-toolbar'><button className='back' onClick={onClose}>← Back to results</button><div><button onClick={onSave}><Icon name='plus' size={15} />Save playlist</button></div></div>
    <header className='source-detail-head'>
      <div><p className='panel-label'>Playlist result</p><h2 id='playlist-detail-title'>{title}</h2><p>{[channel?.name, String(inspector.data.videoCountText ?? `${returnedCount} videos returned`)].filter(Boolean).join(' · ')}</p></div>
      <a href={playlistUrl} target='_blank' rel='noreferrer'>Open on YouTube ↗</a>
    </header>

    <div className='playlist-overview'>
      <div className='playlist-cover'>{thumbnail ? <img src={thumbnail.url} alt={`Thumbnail for ${title}`} /> : <span aria-hidden='true'>YT</span>}<b>{String(inspector.data.videoCountText ?? `${returnedCount} videos`)}</b></div>
      <div><p className='panel-label'>Playlist summary</p><h3>{channel?.name ?? 'YouTube playlist'}</h3>{inspector.data.description ? <p>{String(inspector.data.description)}</p> : null}<dl><div><dt>Playlist ID</dt><dd>{inspector.id}</dd></div><div><dt>Videos returned</dt><dd>{returnedCount.toLocaleString()}</dd></div><div><dt>Result</dt><dd>{inspector.data.continuation ? 'More available' : 'Complete page'}</dd></div></dl></div>
    </div>

    <section className='playlist-videos' aria-labelledby='playlist-videos-title'>
      <header><div><p className='panel-label'>Video index</p><h3 id='playlist-videos-title'>Videos in this playlist</h3></div><span>{returnedCount} returned</span></header>
      {videos.length ? <div className='playlist-video-list'>{videos.map((video, index) => {
        const videoThumbnail = bestThumbnail(video.thumbnails ?? []);
        return <button key={video.id} onClick={() => onOpenVideo(video.id)}><span className='playlist-video-index'>{String(index + 1).padStart(2, '0')}</span><span className='source-result-thumb'>{videoThumbnail ? <img src={videoThumbnail.url} alt='' /> : <i>YT</i>}{video.durationText ? <time>{video.durationText}</time> : null}</span><span className='source-result-copy'><b>{video.title ?? 'Untitled video'}</b><small>{video.channel?.name ?? channel?.name ?? 'YouTube video'}</small><em>{[video.viewCountText, video.publishedTimeText].filter(Boolean).join(' · ') || 'Ready to inspect'}</em></span><span className='source-result-action'>Open video <b aria-hidden='true'>→</b></span></button>;
      })}</div> : <p className='source-data-unavailable'>No public videos were returned for this playlist.</p>}
      {inspector.data.continuation ? <p className='playlist-continuation'>More videos are available through the continuation returned by the API.</p> : null}
    </section>

    <aside className='source-api-guide playlist-api-guide' aria-labelledby='playlist-api-title'>
      <div><p className='panel-label'>Continue with the API</p><h3 id='playlist-api-title'>Use the playlist endpoint in production</h3><p>The response includes playlist metadata, its current video page, and a continuation when more videos are available. Open a video ID with the separate transcript, comments, or channel endpoints.</p><Link href='/dashboard/developer'>Create or manage an API key →</Link></div>
      <div className='source-api-endpoints'><div data-selected='true'><span>Playlist details and videos<b>selected</b></span><code>GET /v1/providers/youtube/playlists/{inspector.id}</code></div><div><span>Then open a video</span><code>GET /v1/providers/youtube/videos/{'{videoId}'}</code></div></div>
    </aside>
  </section>;
}

function SourceVideoPreview({ inspector, title }: { inspector: Inspector; title: string }) {
  const [playing, setPlaying] = useState(false);
  const thumbnail = bestThumbnail((inspector.data.thumbnails ?? []) as Thumbnail[]);
  return <article className='source-video-preview'>
    <div className='source-video-frame'>
      {playing ? <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(inspector.id)}?autoplay=1&rel=0`} title={`Play ${title}`} allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share' allowFullScreen /> : <button type='button' onClick={() => setPlaying(true)} aria-label={`Play ${title}`}><img src={thumbnail?.url ?? `https://i.ytimg.com/vi/${inspector.id}/hqdefault.jpg`} alt={`Thumbnail for ${title}`} /><span>Play video</span></button>}
    </div>
    <dl className='source-video-facts'>
      <div><dt>Views</dt><dd>{String(inspector.data.viewCountText ?? formatNumber(inspector.data.viewCount))}</dd></div>
      <div><dt>Duration</dt><dd>{String(inspector.data.durationText ?? '—')}</dd></div>
      <div><dt>Video ID</dt><dd>{inspector.id}</dd></div>
    </dl>
  </article>;
}

function SourceChannelOverview({ channel, fallback, unavailable }: { channel?: ChannelInfo; fallback?: { id?: string; name?: string; url?: string }; unavailable: boolean }) {
  const about = channel?.about;
  const info = about?.moreInfo;
  const identity = { id: String(channel?.id ?? fallback?.id ?? ''), name: String(channel?.name ?? fallback?.name ?? 'YouTube channel'), url: String(channel?.url ?? fallback?.url ?? '') };
  const avatar = bestThumbnail((channel?.thumbnails ?? []) as Thumbnail[]);
  const facts = [
    ['Subscribers', info?.subscriberCountText ?? (info?.subscriberCount != null ? info.subscriberCount.toLocaleString() : undefined)],
    ['Videos', info?.videoCountText ?? (info?.videoCount != null ? info.videoCount.toLocaleString() : undefined)],
    ['Channel views', info?.viewCountText ?? (info?.viewCount != null ? info.viewCount.toLocaleString() : undefined)],
    ['Joined', info?.joinedDateText ?? info?.joinedDate],
    ['Business email', info ? info.businessEmailAvailable ? 'Available on YouTube' : 'Not listed' : undefined],
    ['Channel ID', identity.id || undefined],
  ].filter((fact): fact is [string, string] => Boolean(fact[1]));

  return <aside className='source-channel-overview' aria-label='Channel information'>
    <div className='source-channel-identity'>{avatar ? <img src={avatar.url} alt='' /> : <span aria-hidden='true'>{identity.name.slice(0, 1).toUpperCase()}</span>}<div><p>Channel</p><h3>{identity.name}</h3>{channel?.handle ? <small>{String(channel.handle)}</small> : null}</div></div>
    {unavailable ? <p className='source-data-unavailable'>Channel details could not be returned for this video.</p> : <>
      {about?.description ? <p className='source-channel-description'>{about.description}</p> : null}
      {facts.length ? <dl className='source-channel-facts'>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
      <div className='source-channel-links'>{identity.url ? <a href={identity.url} target='_blank' rel='noreferrer'>{info?.displayCanonicalChannelUrl || 'View channel'} ↗</a> : null}{about?.links.map((link) => <a key={link.url} href={link.url} target='_blank' rel='noreferrer'>{link.title || link.displayUrl} ↗</a>)}</div>
      {channel?.meta ? <div className='source-channel-meta'><span>{channel.meta.partial ? 'Partial source response' : 'Complete source response'} · fetched {new Date(channel.meta.fetchedAt).toLocaleString()}</span>{channel.meta.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
    </>}
  </aside>;
}

function TranscriptDataPanel({ inspector, segments, transcriptQuery, setTranscriptQuery }: { inspector: Inspector; segments: Segment[]; transcriptQuery: string; setTranscriptQuery: (value: string) => void }) {
  if (inspector.unavailableData.includes('transcript')) return <p className='source-data-unavailable'>A transcript is not available for this video.</p>;
  if (!inspector.transcript) return <p className='source-data-unavailable'>No caption track was returned.</p>;
  return <>
    <header className='source-panel-head'><div><h3>{inspector.transcript.track.name}</h3><p>{inspector.transcript.meta.partial ? 'Partial transcript' : 'Complete transcript'} · {inspector.transcript.track.languageCode.toUpperCase()} · {inspector.transcript.track.kind} · {inspector.transcript.segments.length.toLocaleString()} moments</p></div><label><span className='sr-only'>Search transcript</span><input aria-label='Search transcript' value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} placeholder='Filter transcript…' /></label></header>
    {inspector.transcript.meta.warnings.length ? <p className='source-data-warning'>{inspector.transcript.meta.warnings.join(' ')}</p> : null}
    <ol className='source-transcript'>{segments.map((segment) => <li key={`${segment.startMs}-${segment.text}`}><a href={`https://youtube.com/watch?v=${inspector.id}&t=${Math.floor(segment.startMs / 1000)}s`} target='_blank' rel='noreferrer'>{formatTime(segment.startMs)}</a><p>{highlight(segment.text, transcriptQuery)}</p></li>)}</ol>
    {!segments.length ? <p className='source-data-unavailable'>No transcript moments match this filter.</p> : null}
  </>;
}

function CommentsDataPanel({ unavailable, page, pagesLoaded, loading, error, onLoadMore }: { unavailable: boolean; page?: CommentPage; pagesLoaded: number; loading: boolean; error: string; onLoadMore: () => void }) {
  if (unavailable) return <p className='source-data-unavailable'>Comments are unavailable or turned off for this video.</p>;
  const comments = page?.comments ?? [];
  if (!comments.length) return <p className='source-data-unavailable'>No public comments were returned.</p>;
  return <>
    <header className='source-panel-head'><div><h3>Audience response</h3><p>{comments.length.toLocaleString()} loaded across {pagesLoaded.toLocaleString()} {pagesLoaded === 1 ? 'page' : 'pages'}{page?.totalCount != null ? ` · ${page.totalCount.toLocaleString()} reported by YouTube` : ''}</p></div></header>
    {page?.meta.warnings.length ? <p className='source-data-warning'>{page.meta.warnings.join(' ')}</p> : null}
    <ol className='source-comments'>{comments.map((comment, index) => {
      const author = comment.author;
      const avatar = bestThumbnail(author?.thumbnails ?? []);
      return <li key={String(comment.id ?? index)} data-reply={comment.id.includes('.')}><div>{avatar ? <img src={avatar.url} alt='' /> : <span aria-hidden='true'>{String(author?.name ?? 'Viewer').slice(0, 1).toUpperCase()}</span>}<b>{author?.name ?? 'Viewer'}</b>{comment.isPinned ? <em>pinned</em> : null}{comment.isHearted ? <em>hearted</em> : null}</div><p>{String(comment.text ?? '')}</p><small>{[comment.publishedTimeText, comment.likeCountText ? `${comment.likeCountText} likes` : '', comment.replyCount ? `${comment.replyCount} replies` : '', comment.id.includes('.') ? 'reply' : ''].filter(Boolean).map(String).join(' · ')}</small></li>;
    })}</ol>
    <div className='source-comments-pagination'>
      <span>{page?.continuation ? 'More comments are available.' : 'All available comment pages are loaded.'}</span>
      {page?.continuation ? <button type='button' disabled={loading} onClick={onLoadMore}>{loading ? 'Loading…' : 'Load next page'}</button> : null}
    </div>
    {error ? <p className='source-data-warning' role='alert'>{error}</p> : null}
  </>;
}

function SourceApiGuide({ inspector, channelId }: { inspector: Inspector; channelId?: string }) {
  const endpoints = [
    { option: null, label: 'Video details', path: `/v1/providers/youtube/videos/${inspector.id}` },
    { option: 'transcript' as const, label: 'Full transcript', path: `/v1/providers/youtube/videos/${inspector.id}/transcript` },
    { option: 'comments' as const, label: 'Paginated comments', path: `/v1/providers/youtube/videos/${inspector.id}/comments` },
    ...(channelId ? [{ option: 'channel' as const, label: 'Channel About data', path: `/v1/providers/youtube/channels/${channelId}` }] : []),
  ];
  return <aside className='source-api-guide' aria-labelledby='source-api-title'>
    <div><p className='panel-label'>Continue with the API</p><h3 id='source-api-title'>Use this data in your workflow</h3><p>The dashboard follows the same continuation tokens as the API for comments. Transcript and channel requests return their complete endpoint responses.</p><Link href='/dashboard/developer'>Create or manage an API key →</Link></div>
    <div className='source-api-endpoints'>{endpoints.map((endpoint) => <div key={endpoint.path} data-selected={endpoint.option === null || inspector.requestedData.includes(endpoint.option)}><span>{endpoint.label}{endpoint.option && inspector.requestedData.includes(endpoint.option) ? <b>selected</b> : null}</span><code>GET {endpoint.path}</code></div>)}</div>
  </aside>;
}

function CatalogEntity({ inspector }: { inspector: Inspector }) {
  const videos = (inspector.data.videos ?? []) as SearchItem[];
  const playlists = (inspector.data.playlists ?? []) as SearchItem[];
  return <div className='catalog-layout'><div className='catalog-stats'><article><small>VIDEOS FOUND</small><strong>{videos.length}</strong></article><article><small>PLAYLISTS</small><strong>{playlists.length}</strong></article><article><small>INDEX STATE</small><strong>{inspector.data.continuation ? 'Partial' : 'Current'}</strong></article></div><div className='catalog-list'><h3>Catalog</h3>{[...videos,...playlists].slice(0,50).map((item)=><a key={item.id} href={item.type==='video'?`https://youtube.com/watch?v=${item.id}`:`https://youtube.com/playlist?list=${item.id}`} target='_blank' rel='noreferrer'><span>{item.type}</span><strong>{item.title}</strong><small>{item.viewCountText ?? item.videoCountText}</small></a>)}</div></div>;
}

function ProjectsView({ projects, selectedProject, loading, error, onCreate, onOpen, onBack, onFindSources, onOpenItem }: { projects: Project[]; selectedProject: ProjectDetail | null; loading: boolean; error: string; onCreate:()=>void; onOpen:(project:Project)=>void; onBack:()=>void; onFindSources:()=>void; onOpenItem:(item:ProjectItem)=>void }) {
  if (selectedProject) return <section className='content-section standalone project-detail'><div className='section-heading'><div><button className='back' onClick={onBack}>← All projects</button><h2>{selectedProject.name}</h2></div><button className='button primary' onClick={onFindSources}><Icon name='plus' size={15} />Add sources</button></div><p className='project-description'>{selectedProject.description || 'Saved sources, transcript moments, and evidence for this line of inquiry.'}</p><div className='project-item-list'>{selectedProject.items.map((item)=><article key={item.id}><span className={`type-pill ${item.entity_type}`}>{item.entity_type}</span><div><h3>{item.title || item.entity_id}</h3><p>{item.note || (item.start_ms != null ? `Saved moment at ${formatTime(item.start_ms)}` : 'Saved source')}</p></div><button onClick={() => onOpenItem(item)}>Open evidence →</button></article>)}{!selectedProject.items.length&&<div className='big-empty'><strong>This project is ready for evidence</strong><p>Find a video, channel, or playlist and save it here.</p><button className='button primary' onClick={onFindSources}>Find sources</button></div>}</div></section>;
  return <section className='content-section standalone'><div className='section-heading'><div><h2>Projects turn watching into research</h2><p>Group sources, transcript moments, and notes around one line of inquiry.</p></div>{projects.length>0&&<button className='button primary' onClick={onCreate}><Icon name='plus' size={15} />New project</button>}</div>{loading&&<div className='inline-status' role='status'><span className='status-spinner' aria-hidden='true'/>Opening project…</div>}{error&&<div className='alert error' role='alert'>{error}</div>}<div className='project-grid'>{projects.map((project,index)=><article key={project.id}><span className={`project-color c${index%4}`}/><h3>{project.name}</h3><p>{project.description || 'Videos, transcript moments, notes, and cited intelligence.'}</p><footer><b>{project.item_count ?? 0} sources</b><button onClick={() => onOpen(project)}>Open project →</button></footer></article>)}{!projects.length&&<div className='big-empty'><strong>No projects yet</strong><p>Create a project, then collect videos, channels, playlists, and exact transcript moments.</p><button className='button primary' onClick={onCreate}>Create first project</button></div>}</div></section>;
}

function MonitorsView({ monitors, knownChannel, savingId, onFindSource, onOpenTarget, onSchedule, onRemove }: { monitors: Monitor[]; knownChannel?: { id: string; name: string; handle?: string }; savingId?: string; onFindSource:()=>void; onOpenTarget:(target:string)=>void; onSchedule:(id:string, intervalMinutes:number)=>void; onRemove:(id:string)=>void }) {
  const activeCount = monitors.filter((monitor) => monitor.enabled).length;
  return <section className='content-section standalone monitor-section'><div className='section-heading'><div><h2>Monitor new videos</h2><p>We compare the latest public upload with the previous check and notify you when a new video appears.</p></div><span>{activeCount} active</span></div><div className='monitor-list'>{monitors.map((monitor) => {
    const details = monitorDetails(monitor, knownChannel);
    const channelWatch = monitor.kind === 'channel' || isYouTubeChannelId(monitor.target);
    const intervalMinutes = monitor.interval_minutes ?? 1440;
    return <article className='monitor-card' key={monitor.id}>
      <span className='pulse'/>
      <div className='monitor-copy'><div className='monitor-kicker'><small>{channelWatch ? 'Channel monitor' : 'Search monitor'}</small><span>{monitor.enabled ? 'Active' : 'Paused'}</span></div><h3>{details.label}</h3><p>{details.handle ? `${details.handle} · ` : ''}{channelWatch ? 'Checks the channel’s latest public upload.' : 'Checks the newest public search result.'} {monitorStatusText(monitor)}</p></div>
      <div className='monitor-controls'>
        <label><span>{channelWatch ? 'Check latest upload every' : 'Check search every'}</span><select aria-label={`Monitoring frequency for ${details.label}`} value={intervalMinutes} disabled={savingId === monitor.id} onChange={(event) => onSchedule(monitor.id, Number(event.target.value))}>{MONITOR_INTERVAL_OPTIONS.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}</select></label>
        <span className='monitor-actions'><button className='monitor-source-action' onClick={() => onOpenTarget(details.label)}>Open in Sources</button>{channelWatch ? <a className='monitor-channel-action' href={`https://www.youtube.com/channel/${encodeURIComponent(monitor.target)}`} target='_blank' rel='noreferrer'>View on YouTube <span aria-hidden='true'>↗</span></a> : null}<button className='monitor-delete-action' aria-label={`Delete monitor for ${details.label}`} title='Delete monitor' onClick={() => onRemove(monitor.id)}><Icon name='trash' size={15}/></button></span>
      </div>
    </article>;
  })}{!monitors.length&&<div className='big-empty'><strong>No channels watched yet</strong><p>Open any video, then choose Monitor channel to watch for new uploads.</p><button className='button primary' onClick={onFindSource}>Find a video</button></div>}</div></section>;
}

function monitorIntervalLabel(intervalMinutes: number): string {
  if (intervalMinutes === 60) return 'hour';
  if (intervalMinutes < 1440) return `${intervalMinutes / 60} hours`;
  if (intervalMinutes === 1440) return '24 hours';
  if (intervalMinutes === 10080) return 'week';
  return `${intervalMinutes / 1440} days`;
}

function monitorStatusText(monitor: Monitor): string {
  const next = monitor.next_check_at ? new Date(monitor.next_check_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : undefined;
  if (!monitor.last_checked_at) return next ? `First check ${next}` : `Runs every ${monitorIntervalLabel(monitor.interval_minutes ?? 1440)}.`;
  const last = new Date(monitor.last_checked_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return next ? `Last checked ${last} · Next ${next}` : `Last checked ${last}`;
}

function inspectorChannel(inspector: Inspector | null): { id: string; name: string; handle?: string } | undefined {
  if (!inspector) return undefined;
  if (inspector.type === 'channel') return { id: inspector.id, name: String(inspector.data.name ?? 'YouTube channel'), handle: String(inspector.data.handle ?? '') || undefined };
  const channel = inspector.data.channel as { id?: string; name?: string; handle?: string } | undefined;
  return channel?.id ? { id: channel.id, name: channel.name ?? 'YouTube channel', handle: channel.handle } : undefined;
}

function monitorDetails(monitor: Monitor, knownChannel?: { id: string; name: string; handle?: string }): { label: string; handle?: string } {
  const query = monitorQueryMetadata(monitor);
  if (query.label) return { label: query.label, handle: query.handle };
  if (knownChannel?.id === monitor.target) return { label: knownChannel.name, handle: knownChannel.handle };
  return { label: isYouTubeChannelId(monitor.target) ? 'YouTube channel' : monitor.target };
}

function monitorQueryMetadata(monitor: Monitor): { label?: string; handle?: string } {
  let query: { label?: string; handle?: string } = {};
  try {
    const parsed = monitor.query_json ? JSON.parse(monitor.query_json) as unknown : {};
    query = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as typeof query : {};
  } catch { query = {}; }
  return query;
}

function isYouTubeChannelId(value: string): boolean {
  return /^UC[A-Za-z0-9_-]{22}$/.test(value);
}

function SignInDialog({ onClose }: { onClose:()=>void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const [email,setEmail]=useState(''); const [message,setMessage]=useState('');
  const callbackURL=()=>`${window.location.pathname}${window.location.search}`;
  const magic=async(event:FormEvent)=>{event.preventDefault();const response=await fetch('/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,callbackURL:callbackURL()})});setMessage(response.ok?'Check your inbox for a secure sign-in link.':'Could not send the link.');};
  const google=async()=>{const response=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'google',callbackURL:callbackURL()})});const data=await response.json() as {url?:string};if(data.url)window.location.href=data.url;};
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

function formatTime(ms:number){const total=Math.floor(ms/1000);return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;}
function formatNumber(value:unknown){const number=Number(value);return Number.isFinite(number)?Intl.NumberFormat('en',{notation:'compact'}).format(number):'—';}
function formatDuration(seconds:number){const minutes=Math.round(seconds/60);return minutes >= 60 ? `${Math.floor(minutes/60)}h ${minutes%60}m` : `${minutes} minutes`;}
function relativeNotificationTime(timestamp:number){
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
function highlight(value:string,query:string){if(!query.trim())return value;const parts=value.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'ig'));return parts.map((part,index)=>part.toLowerCase()===query.toLowerCase()?<mark key={index}>{part}</mark>:part);}
function bestThumbnail(thumbnails: Thumbnail[]){return [...thumbnails].sort((a,b)=>(b.width??0)-(a.width??0))[0];}
function isPlaylistUrl(value:string){try{const url=new URL(value.trim());return ['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname)&&!url.searchParams.has('v')&&Boolean(url.searchParams.get('list'));}catch{return false;}}
