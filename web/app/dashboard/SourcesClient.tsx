'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import { redirect, useRouter, useSearchParams } from 'next/navigation';
import { platformRequest as api, isAbortError } from '../../lib/platform-request';
import { loadSourceData, videoIdFromInput, captionsUnavailable, retryableSourceDatasets } from '../../lib/source-data';

import { Checkbox } from './Checkbox';
import { HistoryEmptyState } from './HistoryEmptyState';

import { useAccountResource, useDashboardDraft, useDashboardCache } from './DashboardDataProvider';

import pageStyles from './DashboardPages.module.css';
import { Icon } from './DashboardSidebar';
import { useDashboardSession } from './DashboardSessionProvider';
import { SOURCES_HOME_EVENT } from './dashboard-routes';

import type { ProviderId, EntityType, SourceDataOption, Thumbnail, SearchItem, Segment, Transcript, CommentPage, ChannelInfo, Project, Inspector, RecentSource, SourceSnapshot } from './research-types';
import { DashboardSkeleton as SourceSkeleton } from './DashboardSkeleton';
const SOURCE_DATA_OPTIONS: Record<SourceDataOption, { shortLabel: string; description: string }> = {
  transcript: { shortLabel: 'Transcript', description: 'Complete timestamped spoken text' },
  comments: { shortLabel: 'Comments', description: 'Paginated public comments and replies' },
  channel: { shortLabel: 'Channel info', description: 'Full creator profile, links, and totals' },
};
async function fetchSourceData(inspector: Inspector, option: SourceDataOption, signal: AbortSignal, refresh = false) {
  const providerQuery = `provider=${encodeURIComponent(inspector.provider)}`;
  const result = await loadSourceData(async () => {
    if (option === 'transcript') inspector.transcript = await api<Transcript>(`/v1/videos/${encodeURIComponent(inspector.id)}/transcript?${providerQuery}${refresh ? '&refresh=true' : ''}`, { signal });
    if (option === 'comments') inspector.comments = await api<CommentPage>(`/v1/videos/${encodeURIComponent(inspector.id)}/comments?${providerQuery}&refresh=true`, { signal });
    if (option === 'channel') {
      const channelId = String((inspector.data.channel as { id?: string } | undefined)?.id ?? '');
      if (!channelId) throw new Error('The video response did not include a channel ID.');
      inspector.channel = await api<ChannelInfo>(`/v1/channels/${encodeURIComponent(channelId)}?${providerQuery}`, { signal });
    }
  });
  if (result.error !== undefined) inspector.dataErrors[option] = result.error;
  else delete inspector.dataErrors[option];
}

type SourceSave = { id: string; input: string; projectId: string | null; projectName: string; path: string; body: string };

export default function SourcesClient({ active }: {active:boolean}) {
  const params = useSearchParams();
  const cache = useDashboardCache();
  const router = useRouter();
  const { user, demoEnabled } = useDashboardSession();
  const [query, setQuery] = useDashboardDraft('source-query', '');
  const [selectedData, setSelectedData] = useDashboardDraft<SourceDataOption[]>('source-options', ['transcript']);
  const [items, setItems] = useDashboardDraft<SearchItem[]>('source-results', []);
  const [hasSearched, setHasSearched] = useDashboardDraft('source-searched', false);
  const projectsResource = useAccountResource('projects', []);
  const { data: projects } = projectsResource;
  const projectId = params.get('project');
  const projectName = projects.find(project => project.id === projectId)?.name ?? 'project';
  const [inspector, setInspector] = useDashboardDraft<Inspector | null>('source-inspector', null);
  const [transcriptQuery, setTranscriptQuery] = useDashboardDraft('transcript-query', '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingInspection, setPendingInspection] = useState<{ type: EntityType; id: string; input: string } | null>(null);
  const [operationLabel, setOperationLabel] = useState('');
  const [recentSources, setRecentSources] = useState<RecentSource[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [failedSaves, setFailedSaves] = useState<Array<SourceSave & { error: string }>>([]);
  const historyInput = useRef('');
  const pendingInput = useRef<string | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const authenticated = Boolean(user) || demoEnabled;
  const playlistInput = isPlaylistUrl(query);

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    setHistoryLoading(true); setHistoryError('');
    try {
      const result = await api<{ sources: RecentSource[] }>('/v1/sources/recent', { signal });
      setRecentSources(result.sources);
    } catch (cause) { if (!isAbortError(cause)) setHistoryError(cause instanceof Error ? cause.message : 'Could not load recent sources.'); }
    finally { if (!signal?.aborted) setHistoryLoading(false); }
  }, []);

  useEffect(() => {
    if (!active || !authenticated) return;
    const controller = new AbortController();
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, [active, authenticated, loadHistory]);

  const persistSource = async (save: SourceSave) => {
    try {
      const { source } = await api<{ source?: RecentSource }>(save.path, { method: 'POST', body: save.body });
      if (source) setRecentSources(current => [source, ...current.filter(item => item.id !== source.id)].slice(0, 30));
      setFailedSaves(current => current.filter(item => item.id !== save.id));
      if (save.projectId) {
        void cache.projectDetails.invalidate(save.projectId);
        // Reconcile counts even when a retry follows a lost successful response.
        void projectsResource.refresh();
        setNotice(`Added to ${save.projectName}`);
      }
    } catch (cause) {
      const failed = { ...save, error: cause instanceof Error ? cause.message : 'Could not save this source.' };
      setFailedSaves(current => [...current.filter(item => item.id !== save.id), failed]);
    }
  };

  const rememberSource = async (input: string, snapshot: SourceSnapshot) => {
    const request = snapshot.kind === 'search' ? { kind: snapshot.kind, selectedData: snapshot.selectedData }
      : { kind: snapshot.kind, inspector: {
        provider: snapshot.inspector.provider, type: snapshot.inspector.type, id: snapshot.inspector.id,
        requestedData: snapshot.inspector.requestedData, dataErrors: snapshot.inspector.dataErrors,
        loadedData: ['metadata', ...(['transcript', 'comments', 'channel'] as const).filter(field => snapshot.inspector[field])],
      } };
    await persistSource({ id: crypto.randomUUID(), input, projectId, projectName, path: '/v1/sources/recent',
      body: JSON.stringify({ input, snapshot: request, ...(projectId ? { projectId } : {}) }),
    });
  };

  const openRecentSource = async (entry: Pick<RecentSource, 'id'>, savedProjectId?: string) => {
    setPendingInspection(null);
    const controller = beginOperation('Loading saved source data…');
    try {
      const { source, snapshot } = await api<{ source: RecentSource; snapshot: SourceSnapshot }>(savedProjectId ? `/v1/projects/${encodeURIComponent(savedProjectId)}/sources/${encodeURIComponent(entry.id)}` : `/v1/sources/recent/${entry.id}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setQuery(source.input); historyInput.current = source.input; setTranscriptQuery('');
      if (!savedProjectId) {
        setRecentSources(current => [source, ...current.filter(item => item.id !== source.id)].slice(0, 30));
        if (projectId) void persistSource({ id: crypto.randomUUID(), input: source.input, projectId, projectName,
          path: `/v1/projects/${encodeURIComponent(projectId)}/sources`, body: JSON.stringify({ sourceId: source.id }),
        });
      }
      if (snapshot.kind === 'search') {
        setSelectedData(snapshot.selectedData); setItems(snapshot.items); setInspector(null); setHasSearched(true);
      } else {
        setItems([]); setHasSearched(false); setSelectedData(snapshot.inspector.requestedData.length ? snapshot.inspector.requestedData : ['transcript']);
        setInspector(snapshot.inspector);
      }
    } catch (cause) { if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not open recent source.'); }
    finally { finishOperation(controller); }
  };

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
    if (hadActiveOperation) {
      setInspector(current => current ? { ...current, loadingData: [], dataErrors: {
        ...current.dataErrors, ...Object.fromEntries((current.loadingData ?? []).map(item => [item, 'Request cancelled. Retry to finish loading.'])),
      } } : current);
      setNotice('Cancelled. Completed results are still available.');
    }
  }, []);

  const showRecentSources = useCallback(() => {
    cancelOperation(); setPendingInspection(null); setInspector(null); setItems([]); setHasSearched(false);
    setQuery(''); setTranscriptQuery(''); setError(''); setNotice('');
  }, [cancelOperation, setInspector, setItems, setHasSearched, setQuery, setTranscriptQuery]);

  useEffect(() => {
    window.addEventListener(SOURCES_HOME_EVENT, showRecentSources);
    return () => window.removeEventListener(SOURCES_HOME_EVENT, showRecentSources);
  }, [showRecentSources]);

  useEffect(() => () => { operationController.current?.abort(); }, []);
  useEffect(() => {
    if (!active) return;
    const shortcut=(event:KeyboardEvent)=>{if ((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();searchInput.current?.focus();}};
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
  },[active]);

  const clearLegacyLink = () => {
    pendingInput.current = null; setPendingInspection(null);
    const next = new URLSearchParams(params); next.delete('legacy'); next.delete('id'); next.delete('type');
    router.replace(`/dashboard/sources${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    const input = query.trim();
    if (pendingInspection && input === pendingInspection.input) {
      if (loading) return;
      const { type, id } = pendingInspection;
      const openingSearch = params.toString();
      const loaded = await inspect(type, id, undefined, 'youtube', selectedData, input);
      // Requests may finish after navigation. Never replace a newer route with this old link.
      if (loaded && window.location.pathname === '/dashboard/sources'
        && new URLSearchParams(window.location.search).toString() === openingSearch) clearLegacyLink();
      return;
    }
    setPendingInspection(null);
    if (params.has('legacy')) clearLegacyLink();
    const controller = beginOperation('Resolving your query…');
    setHasSearched(true);
    setInspector(null);
    try {
      const videoId = videoIdFromInput(query);
      const resolved = videoId ? { kind: 'video' as const, provider: 'youtube' as const, id: videoId }
        : await api<{ kind: EntityType | 'search'; provider?: ProviderId; id?: string; query?: string }>('/v1/resolve', {
        method: 'POST', body: JSON.stringify({ input: query }), signal: controller.signal,
      });
      if (resolved.kind === 'video' && resolved.id) {
        setHasSearched(false); setItems([]);
        setOperationLabel('Opening the video and fetching your selected data…');
        await inspect('video', resolved.id, controller, resolved.provider ?? 'youtube', selectedData, input);
        return;
      }
      if (resolved.kind === 'playlist' && resolved.id) {
        setHasSearched(false); setItems([]);
        setOperationLabel('Opening the playlist and loading its videos…');
        await inspect('playlist', resolved.id, controller, resolved.provider ?? 'youtube', selectedData, input);
        return;
      }
      if (resolved.kind !== 'search') {
        throw new Error('Sources opens videos and playlists. Paste a supported URL or search for a video by title or topic.');
      }
      setOperationLabel('Searching YouTube videos…');
      const params = new URLSearchParams({ q: resolved.query ?? query, type: 'video' });
      const data = await api<{ results: SearchItem[] }>(`/v1/search?provider=youtube&${params}`, { signal: controller.signal });
      const results = data.results.filter((item) => item.type === 'video').map((item) => ({ ...item, provider: 'youtube' as const }));
      setItems(results);
      await rememberSource(input, { kind: 'search', selectedData: [...selectedData], items: results });
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Search failed.');
    } finally { finishOperation(controller); }
  };

  // Publish each independent result immediately. Only channel info needs metadata.
  const loadVideoData = async (next: Inspector, datasets: Array<SourceDataOption | 'metadata'>, controller: AbortController, refresh = false) => {
    const input = historyInput.current;
    if (refresh) next.refreshData = [...new Set([...(next.refreshData ?? []), ...datasets])];
    next.loadingData = [...datasets];
    const publish = () => {
      if (operationController.current === controller && !controller.signal.aborted) {
        setInspector({ ...next, dataErrors: { ...next.dataErrors }, loadingData: [...(next.loadingData ?? [])] });
      }
    };
    publish();
    const load = async (dataset: SourceDataOption | 'metadata', work: () => Promise<void>) => {
      try { await work(); }
      finally {
        if (!next.dataErrors[dataset]) next.refreshData = next.refreshData?.filter(item => item !== dataset);
        next.loadingData = next.loadingData?.filter(item => item !== dataset);
        publish();
      }
    };
    const metadata = datasets.includes('metadata') ? load('metadata', async () => {
      const result = await loadSourceData(() => api<Record<string, unknown>>(`/v1/videos/${encodeURIComponent(next.id)}?provider=${encodeURIComponent(next.provider)}${next.refreshData?.includes('metadata') ? '&refresh=true' : ''}`, { signal: controller.signal }));
      if (result.error !== undefined) next.dataErrors.metadata = result.error;
      else { next.data = result.value; delete next.dataErrors.metadata; }
    }) : Promise.resolve();
    await Promise.all([metadata, ...datasets.filter((item): item is SourceDataOption => item !== 'metadata').map(option => load(option, async () => {
      if (option === 'channel') {
        await metadata;
        if (next.dataErrors.metadata) {
          next.dataErrors.channel = next.dataErrors.metadata;
          return;
        }
      }
      await fetchSourceData(next, option, controller.signal, next.refreshData?.includes(option));
    }))]);
    if (!controller.signal.aborted && operationController.current === controller) {
      await rememberSource(input, { kind: 'inspection', inspector: { ...next, loadingData: [] } });
    }
  };

  const inspect = async (
    type: EntityType, id: string, activeController?: AbortController,
    provider: ProviderId = 'youtube', requestedData: SourceDataOption[] = selectedData, input?: string,
  ) => {
    const controller = activeController ?? beginOperation('Fetching your selected data…');
    historyInput.current = input ?? `https://www.youtube.com/${type === 'video' ? `watch?v=${id}` : type === 'playlist' ? `playlist?list=${id}` : `channel/${id}`}`;
    setError('');
    try {
      if (type === 'video') {
        const next: Inspector = { provider, type, id, data: { id, url: `https://youtube.com/watch?v=${encodeURIComponent(id)}` }, requestedData: [...requestedData], dataErrors: {} };
        await loadVideoData(next, ['metadata', ...requestedData], controller);
      } else {
        const plural = type === 'channel' ? 'channels' : 'playlists';
        const data = await api<Record<string, unknown>>(`/v1/${plural}/${encodeURIComponent(id)}?provider=${encodeURIComponent(provider)}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          const next: Inspector = { provider, type, id, data, requestedData: [], dataErrors: {} };
          setInspector(next);
          await rememberSource(historyInput.current, { kind: 'inspection', inspector: next });
        }
      }
      return !controller.signal.aborted;
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not open this source.');
      return false;
    }
    finally { finishOperation(controller); }
  };

  const refreshVideoData = async () => {
    if (!inspector || loading) return;
    setNotice('');
    const controller = beginOperation('Refreshing video data…');
    const next = { ...inspector, dataErrors: { ...inspector.dataErrors } };
    try {
      await loadVideoData(next, ['metadata', ...next.requestedData.filter(option => option !== 'channel')], controller, true);
      if (operationController.current === controller && !controller.signal.aborted && !Object.keys(next.dataErrors).length) {
        setNotice('Video data refreshed.');
      }
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not refresh video data.');
    } finally { finishOperation(controller); }
  };

  const refreshComments = async () => {
    if (!inspector || loading) return;
    const controller = beginOperation('Fetching current comments…');
    try {
      await loadVideoData({ ...inspector, dataErrors: { ...inspector.dataErrors } }, ['comments'], controller);
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not refresh comments.');
    } finally { finishOperation(controller); }
  };

  const retrySourceData = async () => {
    if (!inspector || loading) return;
    const controller = beginOperation('Retrying failed source requests…');
    const next = { ...inspector, dataErrors: { ...inspector.dataErrors } };
    try {
      await loadVideoData(next, retryableSourceDatasets(next.dataErrors), controller);
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally { finishOperation(controller); }
  };

  useEffect(() => {
    if (pendingInput.current && (!active || params.get('legacy') !== '1')) {
      if (query === pendingInput.current) setQuery('');
      pendingInput.current = null; setPendingInspection(null);
    }
    if (!active) return;
    setPendingInspection(null);
    const q=params.get('q'), id=params.get('id'), type=params.get('type'), saved=params.get('saved');
    if (!saved && params.get('legacy') === '1' && id && (type === 'video' || type === 'channel' || type === 'playlist')) {
      // Older rows have no restorable snapshot. Gate provider reads without enabling project auto-save.
      showRecentSources();
      const input = `https://www.youtube.com/${type === 'video' ? `watch?v=${encodeURIComponent(id)}` : type === 'playlist' ? `playlist?list=${encodeURIComponent(id)}` : `channel/${encodeURIComponent(id)}`}`;
      pendingInput.current = input; setQuery(input); setPendingInspection({ type, id, input });
      return; // Keep the pending source in the URL for reload and failed-request retry.
    }
    if (q) { setQuery(q); searchInput.current?.focus(); }
    if (saved && projectId) void openRecentSource({ id: saved }, projectId);
    else if (id && (type==='video'||type==='channel'||type==='playlist')) void inspect(type,id);
    if (q||id||saved) { const next=new URLSearchParams(params); next.delete('q');next.delete('id');next.delete('type');next.delete('saved');router.replace(`/dashboard/sources${next.size?`?${next}`:''}`,{scroll:false}); }
  }, [active, params, router]);
  const createProject = async (name:string) => {
    const project = await api<Project>('/v1/projects',{method:'POST',body:JSON.stringify({name})});
    await projectsResource.refresh(); return project;
  };

  const saveInspector = async () => {
    if (!inspector) return;
    if (projectId) {
      await rememberSource(historyInput.current, { kind: 'inspection', inspector });
      return;
    }
    try {
      await cache.load('projects');
      if (cache.read('projects').error) throw new Error(cache.read('projects').error);
      const project = cache.read('projects').data?.[0] ?? await createProject('Research inbox');
      const title = String(inspector.data.title ?? inspector.data.name ?? inspector.id);
      await api(`/v1/projects/${project.id}/items`, {
        method: 'POST', body: JSON.stringify({
          provider: inspector.provider, entityType: inspector.type, entityId: inspector.id, title,
          content: inspector.transcript?.segments.map((segment) => `[${segment.startMs}] ${segment.text}`).join('\n'),
        }),
      });
      void cache.projectDetails.invalidate(project.id);
      setNotice(`Saved to ${project.name}`);
      await api('/v1/imports', {
        method: 'POST', body: JSON.stringify({ provider: inspector.provider, kind: inspector.type, entityId: inspector.id, projectId: project.id }),
      });
      await projectsResource.refresh();
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
      await cache.load('monitors');
      if (cache.read('monitors').error) throw new Error(cache.read('monitors').error);
      const monitors=cache.read('monitors').data??[];
      const existing = monitors.find((monitor) => monitor.provider === inspector.provider && monitor.target === target);
      if (existing) await api(`/v1/monitors/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ query }) });
      else await api('/v1/monitors', { method: 'POST', body: JSON.stringify({ provider: inspector.provider, kind: 'channel', target, query }) });
      setNotice(existing ? `Already monitoring ${label}` : `Monitoring ${label} for new uploads`); await cache.load('monitors',true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create monitor.'); }
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

  if (!authenticated) redirect('/login');

  return (
    <>
    {projectsResource.error && <div className="alert error" role="alert">{projectsResource.error} <button onClick={()=>void projectsResource.refresh()}>Retry projects</button></div>}
        <div className='workspace-view'>
          <>
            {projectId && <div className='source-project-context' role='status'>Adding sources to <strong>{projectName}</strong><Link href={`/dashboard/projects?project=${encodeURIComponent(projectId)}`}>View project</Link></div>}
            <section className='source-studio' aria-labelledby='source-studio-title'>
              <header className={pageStyles.intro}><h2 id='source-studio-title'>Search or paste a YouTube link</h2>{(inspector || hasSearched) && <button className={pageStyles.textAction} onClick={showRecentSources}>Recent sources</button>}</header>
              <form onSubmit={runSearch} className='source-studio-form'>
                <label className='source-query-label' htmlFor='workspace-search'>{playlistInput ? 'Playlist URL detected' : 'Video search or YouTube URL'}</label>
                <div className='source-query-row'>
                  <div data-playlist={playlistInput}><Icon name='search' size={19} /><input id='workspace-search' ref={searchInput} value={query} onChange={(event) => { setQuery(event.target.value); setPendingInspection(null); if (params.has('legacy')) clearLegacyLink(); }} placeholder='e.g. Opus 5.5 vs GPT 6 Astra, or a YouTube URL' autoComplete='off' /><kbd>{playlistInput ? 'PLAYLIST' : '⌘ K'}</kbd></div>
                  <button disabled={loading || !query.trim()}>{loading ? 'Working…' : pendingInspection ? 'Inspect using credits' : 'Inspect'} <span aria-hidden='true'>→</span></button>
                </div>
                {pendingInspection && <div className='source-refresh-row'><p role='status'>This project item has no saved source snapshot. Inspecting it fetches data and uses credits.</p>{!loading && <button type='button' onClick={() => { clearLegacyLink(); showRecentSources(); }}>Cancel</button>}</div>}
                <fieldset className='source-data-picker'>
                  <legend>Include with each video</legend>
                  <div className='source-data-options'>
                    {(Object.keys(SOURCE_DATA_OPTIONS) as SourceDataOption[]).map((option) => {
                      const selected = selectedData.includes(option);
                      const isOnlySelection = selected && selectedData.length === 1;
                      return <Checkbox
                        key={option}
                        checked={selected}
                        onCheckedChange={() => toggleSelectedData(option)}
                        disabled={isOnlySelection}
                        label={SOURCE_DATA_OPTIONS[option].shortLabel}
                        title={isOnlySelection ? 'Choose another dataset before removing this one' : SOURCE_DATA_OPTIONS[option].description}
                      />;
                    })}
                  </div>
                </fieldset>
              </form>
            </section>

            {(loading || error || notice) && <div className='source-feedback'>
              {loading && <div className='source-operation-loading'><SourceSkeleton label={operationLabel} lines={2} /><button type='button' onClick={cancelOperation}>Cancel</button></div>}
              {error && <div className='alert error' role='alert'><span>{error}</span>{query.trim() && <button onClick={() => void runSearch()}>Retry</button>}</div>}
              {notice && <div className='alert success' role='status'><span>{notice}</span><button aria-label='Dismiss notification' onClick={() => setNotice('')}>×</button></div>}
            </div>}
            {failedSaves.map(save => <div key={save.id} className='source-project-save-error alert error' role='alert'>
              <span>Could not save {save.input}{save.projectId ? ` to ${save.projectName}` : ''}: {save.error}</span>
              <button type='button' onClick={() => void persistSource(save)}>Retry saving</button>
            </div>)}
            {inspector ? (
              <InspectorPanel key={`${inspector.provider}-${inspector.type}-${inspector.id}-${inspector.requestedData.join('-')}`} inspector={inspector} retrying={loading} onRetry={() => void retrySourceData()} onOpenComments={() => void refreshComments()} onRefresh={() => void refreshVideoData()} segments={filteredSegments} transcriptQuery={transcriptQuery} setTranscriptQuery={setTranscriptQuery} onClose={() => { cancelOperation(); setInspector(null); }} onSave={() => void saveInspector()} onMonitor={() => void addMonitor()} onOpenVideo={(id) => void inspect('video', id, undefined, inspector.provider, selectedData)} />
            ) : (
              hasSearched || loading || items.length ? <VideoSearchResults items={items} onInspect={(id, provider) => void inspect('video', id, undefined, provider, selectedData)} onStart={() => searchInput.current?.focus()} loading={loading} hasSearched={hasSearched} failed={Boolean(error)} />
              : <section className='source-results' aria-labelledby='recent-sources-title'>
                <header><h2 id='recent-sources-title'>Recent sources</h2></header>
                {historyLoading && !recentSources.length ? <RecentSourcesSkeleton /> : null}
                {historyError ? <div className='alert error' role='alert'>{historyError} <button onClick={() => void loadHistory()}>Retry recent sources</button></div> : null}
                {!historyLoading && !historyError && !recentSources.length ? <HistoryEmptyState title='No recent sources yet' description='Search for a topic or paste a YouTube link above. Your recent sources will appear here.' /> : null}
                <div className='source-result-list recent-source-list' aria-busy={historyLoading}>{recentSources.map(source => <button key={source.id} onClick={() => void openRecentSource(source)}>
                  <span className='recent-source-visual'>{source.kind === 'search' ? <Icon name='search' size={20} /> : <><span aria-hidden='true'>YT</span>{source.thumbnailUrl && <img src={source.thumbnailUrl} alt='' loading='lazy' onError={event => { event.currentTarget.hidden = true; }} />}</>}</span>
                  <span className='source-result-copy'><b>{source.title}</b><small>{source.kind === 'search' ? 'Search' : source.input}</small><em>{new Date(source.updatedAt).toLocaleString()}</em></span>
                  <span className='source-result-action'>Open <b aria-hidden='true'>→</b></span>
                </button>)}</div>
              </section>
            )}
          </>
        </div>
        {historyError && (inspector || hasSearched || loading) ? <div className='alert error' role='alert'>{historyError}</div> : null}
    </>
  );
}

function RecentSourcesSkeleton() {
  return <div className='source-result-list recent-source-list' role='status' aria-label='Loading recent sources' aria-busy='true'>
    <span className='sr-only'>Loading recent sources</span>
    {[0, 1, 2].map(index => <div className='recent-source-skeleton' key={index} aria-hidden='true'>
      <span className='recent-source-visual' />
      <span className='source-result-copy'><b><i className='ui-bar' data-width='long' /></b><small><i className='ui-bar' data-width='medium' /></small><em><i className='ui-bar' data-width='short' /></em></span>
      <span className='source-result-action'><i className='ui-bar' /></span>
    </div>)}
  </div>;
}

function SourceChannelSkeleton() {
  return <aside className='source-channel-overview source-channel-skeleton' role='status' aria-label='Loading channel info'>
    <span className='sr-only'>Loading channel info</span>
    <div className='source-channel-identity' aria-hidden='true'>
      <span className='source-skeleton-media' />
      <div>
        <p><i className='ui-bar' data-width='short' /></p>
        <h3><i className='ui-bar' data-width='long' /></h3>
        <small><i className='ui-bar' data-width='medium' /></small>
      </div>
    </div>
    <p className='source-channel-description' aria-hidden='true'>
      <i className='ui-bar' /><i className='ui-bar' /><i className='ui-bar' data-width='medium' />
    </p>
    <dl className='source-channel-facts' aria-hidden='true'>
      {Array.from({ length: 6 }).map((_, index) => <div key={index}>
        <dt><i className='ui-bar' data-width='medium' /></dt>
        <dd><i className='ui-bar' data-width='long' /></dd>
      </div>)}
    </dl>
    <div className='source-channel-links' aria-hidden='true'>
      <i className='ui-bar' /><i className='ui-bar' /><i className='ui-bar' />
    </div>
  </aside>;
}

function VideoSearchResults({ items, onInspect, onStart, loading, hasSearched, failed }: { items: SearchItem[]; onInspect: (id: string, provider?: ProviderId) => void; onStart: () => void; loading: boolean; hasSearched: boolean; failed: boolean }) {
  return <section className='source-results' aria-labelledby='source-results-title'>
    <header className={!items.length && !hasSearched ? 'sr-only' : undefined}>
      <h2 id='source-results-title'>{items.length ? 'Results' : failed ? 'Search could not finish' : hasSearched && !loading ? 'No matching videos' : 'Search results'}</h2>
      {items.length ? <span>{items.length} videos{loading ? ' · refreshing' : ''}</span> : null}
    </header>
    {loading && !items.length ? <div className='source-result-skeletons' role='status' aria-label='Loading videos'>{Array.from({ length: 5 }).map((_, index) => <div key={index} aria-hidden='true'><i /><span><b /><small /></span></div>)}</div> : null}
    {!items.length && !loading && !failed ? <div className={pageStyles.emptyState}><span className={pageStyles.rowIcon}><Icon name='search' size={21} /></span><div><h3>{hasSearched ? 'Try another search' : 'Your sources will appear here'}</h3><p>{hasSearched ? 'Try another topic or paste a YouTube URL.' : 'Open a result to view your selected datasets.'}</p>{hasSearched && <button className={pageStyles.textAction} onClick={onStart}>Edit search →</button>}</div></div> : null}
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

function InspectorPanel({ inspector, onRetry, onOpenComments, onRefresh, retrying, segments, transcriptQuery, setTranscriptQuery, onClose, onSave, onMonitor, onOpenVideo }: { inspector: Inspector; onRetry: () => void; onOpenComments: () => void; onRefresh: () => void; retrying: boolean; segments: Segment[]; transcriptQuery: string; setTranscriptQuery: (value:string)=>void; onClose:()=>void; onSave:()=>void; onMonitor:()=>void; onOpenVideo:(id:string)=>void }) {
  const title = String(inspector.data.title ?? inspector.data.name ?? inspector.id);
  const videoChannel = inspector.data.channel as { id?: string; name?: string; url?: string } | undefined;
  const panelOptions = inspector.requestedData.filter((option) => option !== 'channel');
  const metadataLoading = Boolean(inspector.loadingData?.includes('metadata')) && !inspector.data.title;
  const refreshing = inspector.loadingData?.some(dataset => inspector.refreshData?.includes(dataset));
  const savedData = [inspector.data, inspector.transcript, inspector.comments].some(value => {
    const state = (value as { freshness?: { state?: string } } | undefined)?.freshness?.state;
    return state === 'stored' || state === 'stale';
  });
  const [activePanel, setActivePanel] = useState<SourceDataOption>(panelOptions[0] ?? 'channel');
  const [commentPage, setCommentPage] = useState(inspector.comments);
  const [commentPagesLoaded, setCommentPagesLoaded] = useState(inspector.comments ? 1 : 0);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState('');
  useEffect(() => { setCommentPage(inspector.comments); setCommentPagesLoaded(inspector.comments ? 1 : 0); setCommentsError(''); }, [inspector.comments]);

  const loadMoreComments = async () => {
    const continuation = commentPage?.continuation;
    if (!continuation || commentsLoading) return;
    setCommentsLoading(true);
    setCommentsError('');
    try {
      const params = new URLSearchParams({ continuation, refresh: 'true' });
      const page = await api<CommentPage>(`/v1/videos/${encodeURIComponent(inspector.id)}/comments?provider=${encodeURIComponent(inspector.provider)}&${params}`);
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
    <div className='source-inspector-toolbar'><button className='back' onClick={onClose}>← Back to results</button><div><button onClick={onMonitor}><Icon name='monitor' size={15} />Monitor channel</button><button onClick={onSave} disabled={inspector.loadingData?.includes('transcript')}><Icon name='plus' size={15} />Save to project</button></div></div>
    <header className='source-detail-head'>
      <div>
        <p className='panel-label'>Video result</p>
        <h2 id='source-detail-title'>{metadataLoading
          ? <><span className='sr-only'>{title}</span><i className='ui-bar' aria-hidden='true' /><i className='ui-bar' data-width='medium' aria-hidden='true' /></>
          : title}</h2>
        {metadataLoading
          ? <p role='status' aria-label='Loading video details'><span className='sr-only'>Loading video details</span><i className='ui-bar' data-width='medium' aria-hidden='true' /></p>
          : <p>{[videoChannel?.name, String(inspector.data.publishedTimeText ?? ''), String(inspector.data.viewCountText ?? '')].filter(Boolean).join(' · ')}</p>}
      </div>
      <a href={String(inspector.data.url ?? `https://youtube.com/watch?v=${inspector.id}`)} target='_blank' rel='noreferrer'>Open on YouTube ↗</a>
    </header>

    {savedData || refreshing ? <div className='source-refresh-row'>
      <span role='status'>{refreshing ? 'Refreshing data from YouTube…' : 'Showing saved data'}</span>
      <button type='button' onClick={onRefresh} disabled={retrying || commentsLoading}
        title='Fetch video details and the selected transcript and comments again from YouTube'>
        {refreshing ? 'Refreshing…' : 'Refresh data'}
      </button>
    </div> : null}

    {inspector.dataErrors.metadata ? <p role='alert' className='source-data-unavailable'>{inspector.dataErrors.metadata}</p> : null}
    <div className='source-overview-grid' data-channel={inspector.requestedData.includes('channel')}>
      <SourceVideoPreview inspector={inspector} title={title} />
      {inspector.requestedData.includes('channel') && inspector.loadingData?.includes('channel') ? <SourceChannelSkeleton /> : inspector.requestedData.includes('channel') ? <SourceChannelOverview channel={inspector.channel} fallback={videoChannel} error={inspector.dataErrors.channel} /> : null}
    </div>

    {panelOptions.length ? <>
      <div className='source-data-tabs' role='tablist' aria-label='Fetched video data'>
        {panelOptions.map((option) => <button key={option} type='button' role='tab' aria-selected={activePanel === option} className={activePanel === option ? 'active' : ''} onClick={() => { setActivePanel(option); if (option === 'comments' && !retrying && !commentsLoading) onOpenComments(); }}>{SOURCE_DATA_OPTIONS[option].shortLabel}<span>{option === 'transcript' ? inspector.transcript?.segments.length ?? 0 : commentPage?.comments.length ?? 0}</span></button>)}
      </div>
      <section className='source-data-panel' role='tabpanel'>
        {activePanel === 'transcript' ? <TranscriptDataPanel inspector={inspector} segments={segments} transcriptQuery={transcriptQuery} setTranscriptQuery={setTranscriptQuery} /> : null}
        {activePanel === 'comments' && inspector.loadingData?.includes('comments') && !commentPage ? <SourceSkeleton label='Loading comments' variant='panel' lines={6} /> : activePanel === 'comments' ? <CommentsDataPanel initialError={inspector.dataErrors.comments} page={commentPage} pagesLoaded={commentPagesLoaded} loading={commentsLoading || Boolean(inspector.loadingData?.includes('comments'))} error={commentsError} onLoadMore={() => void loadMoreComments()} /> : null}
      </section>
    </> : null}

    {!retrying && retryableSourceDatasets(inspector.dataErrors).length > 0 ? <div className='source-retry-actions'><button type='button' onClick={onRetry}><ArrowClockwiseIcon size={16} aria-hidden='true' />Retry failed requests</button></div> : null}
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

    <details className={pageStyles.disclosure}><summary>API details</summary><div className='source-api-guide playlist-api-guide'>
      <div><p>Playlist details include a video page and a continuation token for more results.</p><Link href='/dashboard/developer'>Create or manage an API key →</Link></div>
      <div className='source-api-endpoints'><div data-selected='true'><span>Playlist details and videos<b>selected</b></span><code>GET /v1/playlists/{inspector.id}?provider=youtube</code></div><div><span>Then open a video</span><code>GET /v1/videos/{'{videoId}'}?provider=youtube</code></div></div>
    </div></details>
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

function SourceChannelOverview({ channel, fallback, error }: { channel?: ChannelInfo; fallback?: { id?: string; name?: string; url?: string }; error?: string }) {
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
    {error ? <p role='alert' className='source-data-unavailable'>{error}</p> : <>
      {about?.description ? <p className='source-channel-description'>{about.description}</p> : null}
      {facts.length ? <dl className='source-channel-facts'>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
      <div className='source-channel-links'>{identity.url ? <a href={identity.url} target='_blank' rel='noreferrer'>{info?.displayCanonicalChannelUrl || 'View channel'} ↗</a> : null}{about?.links.map((link) => <a key={link.url} href={link.url} target='_blank' rel='noreferrer'>{link.title || link.displayUrl} ↗</a>)}</div>
      {channel?.meta ? <div className='source-channel-meta'><span>{channel.meta.partial ? 'Partial source response' : 'Complete source response'} · fetched {new Date(channel.meta.fetchedAt).toLocaleString()}</span>{channel.meta.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
    </>}
  </aside>;
}

function TranscriptDataPanel({ inspector, segments, transcriptQuery, setTranscriptQuery }: { inspector: Inspector; segments: Segment[]; transcriptQuery: string; setTranscriptQuery: (value: string) => void }) {
  if (inspector.loadingData?.includes('transcript') && (!inspector.transcript || inspector.dataErrors.transcript)) return <SourceSkeleton label='Loading transcript' variant='panel' lines={7} />;
  if (captionsUnavailable(inspector.dataErrors.transcript) && !inspector.transcript) return <HistoryEmptyState title='No captions available' description='This video does not have captions available on YouTube, so there is no transcript to display.' />;
  if (inspector.dataErrors.transcript && !inspector.transcript) return <p role='alert' className='source-data-unavailable'>{inspector.dataErrors.transcript}</p>;
  if (!inspector.transcript) return <p className='source-data-unavailable'>No caption track was returned.</p>;
  return <>
    {inspector.dataErrors.transcript ? <p role='alert' className='source-data-unavailable'>{inspector.dataErrors.transcript} Showing the previously loaded transcript.</p> : null}
    <header className='source-panel-head'><div><h3>{inspector.transcript.track.name}</h3><p>{inspector.transcript.meta.partial ? 'Partial transcript' : 'Complete transcript'} · {inspector.transcript.track.languageCode.toUpperCase()} · {inspector.transcript.track.kind} · {inspector.transcript.segments.length.toLocaleString()} moments</p></div><label><span className='sr-only'>Search transcript</span><input aria-label='Search transcript' value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} placeholder='Filter transcript…' /></label></header>
    {inspector.transcript.meta.warnings.length ? <p className='source-data-warning'>{inspector.transcript.meta.warnings.join(' ')}</p> : null}
    <ol className='source-transcript'>{segments.map((segment) => <li key={`${segment.startMs}-${segment.text}`}><a href={`https://youtube.com/watch?v=${inspector.id}&t=${Math.floor(segment.startMs / 1000)}s`} target='_blank' rel='noreferrer'>{formatTime(segment.startMs)}</a><p>{highlight(segment.text, transcriptQuery)}</p></li>)}</ol>
    {!segments.length ? <p className='source-data-unavailable'>No transcript moments match this filter.</p> : null}
  </>;
}

function CommentsDataPanel({ initialError, page, pagesLoaded, loading, error, onLoadMore }: { initialError?: string; page?: CommentPage; pagesLoaded: number; loading: boolean; error: string; onLoadMore: () => void }) {
  if (initialError && !page) return <p role='alert' className='source-data-unavailable'>{initialError}</p>;
  const comments = page?.comments ?? [];
  if (!comments.length) return <>{initialError ? <p role='alert' className='source-data-unavailable'>{initialError}</p> : null}<p className='source-data-unavailable'>No public comments were returned.</p></>;
  return <>
    {initialError ? <p role='alert' className='source-data-unavailable'>{initialError} Showing the previously loaded comments.</p> : null}
    <header className='source-panel-head'><div><h3>Audience response</h3><p>{comments.length.toLocaleString()} loaded across {pagesLoaded.toLocaleString()} {pagesLoaded === 1 ? 'page' : 'pages'}{page?.totalCount != null ? ` · ${page.totalCount.toLocaleString()} reported by YouTube` : ''}</p></div></header>
    {page?.meta.warnings.length ? <p className='source-data-warning'>{page.meta.warnings.join(' ')}</p> : null}
    <ol className='source-comments'>{comments.map((comment, index) => {
      const author = comment.author;
      const avatar = bestThumbnail(author?.thumbnails ?? []);
      return <li key={String(comment.id ?? index)} data-reply={comment.id.includes('.')}><div>{avatar ? <img src={avatar.url} alt='' /> : <span aria-hidden='true'>{String(author?.name ?? 'Viewer').slice(0, 1).toUpperCase()}</span>}<b>{author?.name ?? 'Viewer'}</b>{comment.isPinned ? <em>pinned</em> : null}{comment.isHearted ? <em>hearted</em> : null}</div><p>{String(comment.text ?? '')}</p><small>{[comment.publishedTimeText, comment.likeCountText ? `${comment.likeCountText} likes` : '', comment.replyCount ? `${comment.replyCount} replies` : '', comment.id.includes('.') ? 'reply' : ''].filter(Boolean).map(String).join(' · ')}</small></li>;
    })}</ol>
    <div className='source-comments-pagination'>
      <span>{page?.continuation ? 'More comments are available.' : 'All available comment pages are loaded.'}</span>
      {page?.continuation ? <button type='button' disabled={loading} aria-busy={loading} onClick={onLoadMore}>Load next page</button> : null}
    </div>
    {error ? <p className='source-data-warning' role='alert'>{error}</p> : null}
  </>;
}

function SourceApiGuide({ inspector, channelId }: { inspector: Inspector; channelId?: string }) {
  const endpoints = [
    { option: null, label: 'Video details', path: `/v1/videos/${inspector.id}?provider=${encodeURIComponent(inspector.provider)}` },
    { option: 'transcript' as const, label: 'Full transcript', path: `/v1/videos/${inspector.id}/transcript?provider=${encodeURIComponent(inspector.provider)}` },
    { option: 'comments' as const, label: 'Paginated comments', path: `/v1/videos/${inspector.id}/comments?provider=${encodeURIComponent(inspector.provider)}` },
    ...(channelId ? [{ option: 'channel' as const, label: 'Channel About data', path: `/v1/channels/${channelId}?provider=${encodeURIComponent(inspector.provider)}` }] : []),
  ];
  return <details className={pageStyles.disclosure}><summary>API details</summary><div className='source-api-guide'>
    <div><p>Comments use continuation tokens for pagination. Transcript and channel endpoints return complete responses.</p><Link href='/dashboard/developer'>Create or manage an API key →</Link></div>
    <div className='source-api-endpoints'>{endpoints.map((endpoint) => <div key={endpoint.path} data-selected={endpoint.option === null || inspector.requestedData.includes(endpoint.option)}><span>{endpoint.label}{endpoint.option && inspector.requestedData.includes(endpoint.option) ? <b>selected</b> : null}</span><code>GET {endpoint.path}</code></div>)}</div>
  </div></details>;
}

function CatalogEntity({ inspector }: { inspector: Inspector }) {
  const videos = (inspector.data.videos ?? []) as SearchItem[];
  const playlists = (inspector.data.playlists ?? []) as SearchItem[];
  return <div className='catalog-layout'><div className='catalog-stats'><article><small>VIDEOS FOUND</small><strong>{videos.length}</strong></article><article><small>PLAYLISTS</small><strong>{playlists.length}</strong></article><article><small>INDEX STATE</small><strong>{inspector.data.continuation ? 'Partial' : 'Current'}</strong></article></div><div className='catalog-list'><h3>Catalog</h3>{[...videos,...playlists].slice(0,50).map((item)=><a key={item.id} href={item.type==='video'?`https://youtube.com/watch?v=${item.id}`:`https://youtube.com/playlist?list=${item.id}`} target='_blank' rel='noreferrer'><span>{item.type}</span><strong>{item.title}</strong><small>{item.viewCountText ?? item.videoCountText}</small></a>)}</div></div>;
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
