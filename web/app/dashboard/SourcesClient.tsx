'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import { redirect, useRouter, useSearchParams } from 'next/navigation';
import { platformRequest as api, isAbortError } from '../../lib/platform-request';
import { loadSourceData, videoIdFromInput, isVideoId, captionsUnavailable, retryableSourceDatasets } from '../../lib/source-data';

import { Checkbox } from './Checkbox';
import { HistoryEmptyState } from './HistoryEmptyState';

import { useAccountResource, useDashboardDraft, useDashboardCache } from './DashboardDataProvider';

import pageStyles from './DashboardPages.module.css';
import { Icon } from './DashboardSidebar';
import { useDashboardSession } from './DashboardSessionProvider';
import { SOURCES_HOME_EVENT, projectItemPath } from './dashboard-routes';

import type { ProviderId, EntityType, SourceDataOption, Thumbnail, SearchItem, Segment, Transcript, CommentPage, ChannelInfo, Project, ProjectItem, Inspector, RecentSource, SourceSnapshot } from './research-types';
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
    if (option === 'comments') { inspector.comments = await api<CommentPage>(`/v1/videos/${encodeURIComponent(inspector.id)}/comments?${providerQuery}&refresh=true`, { signal }); inspector.commentPagesLoaded = 1; delete inspector.commentsReceipt; }
    if (option === 'channel') {
      const channelId = String((inspector.data.channel as { id?: string } | undefined)?.id ?? '');
      if (!channelId) throw new Error('The video response did not include a channel ID.');
      inspector.channel = await api<ChannelInfo>(`/v1/channels/${encodeURIComponent(channelId)}?${providerQuery}`, { signal });
    }
  });
  if (result.error !== undefined) inspector.dataErrors[option] = result.error;
  else delete inspector.dataErrors[option];
}

type SourceSave = { id: string; input: string; projectId: string | null; projectName: string; path: string; body: string; method?: 'POST' | 'PUT'; retains?: boolean; generation?: number; comments?: boolean };
type SourceReceipt = { sourceId: string; sourceRevision: string } | { savedRevision: string };
type ProjectRestore = { item: ProjectItem } & ({ state: 'restored'; origin: 'pin' | 'project-source' | 'recent' | 'storage'; recovered: boolean;
  source: RecentSource; snapshot: SourceSnapshot; sourceRevision?: string; savedText?: string; missingData: string[] }
  | { state: 'unavailable'; input?: string | null });
/** The saved project item currently shown. It only chooses the explicit Save destination; it never enables auto-save. */
type OpenedItem = { projectId: string; itemId: string; kind: 'project-source' | 'item'; entity: string; startMs: number | null; retained: boolean; generation: number };
type PendingSourceSave = { generation: number; promise: Promise<{ source?: RecentSource; sourceRevision?: string } | null> };
/** The list a video was opened from, so Back returns to it instead of Recent sources. */
type SourceParent = { kind: 'live'; inspector: Inspector; query: string; input: string; selectedData: SourceDataOption[];
  receipt: SourceReceipt | null; pending: PendingSourceSave | null }
  | { kind: 'saved'; projectId: string; itemId: string; list: 'playlist' | 'results'; childItemId: string };
const PENDING_LINK_PARAMS = ['legacy', 'id', 'type', 'openProject', 'saved'];

function sourceRequest(snapshot: SourceSnapshot) {
  return snapshot.kind === 'search' ? { kind: snapshot.kind, selectedData: snapshot.selectedData }
    : { kind: snapshot.kind, inspector: {
      provider: snapshot.inspector.provider, type: snapshot.inspector.type, id: snapshot.inspector.id,
      requestedData: snapshot.inspector.requestedData, dataErrors: snapshot.inspector.dataErrors,
      ...(snapshot.inspector.comments && snapshot.inspector.commentsReceipt ? { commentsReceipt: snapshot.inspector.commentsReceipt } : {}),
      loadedData: ['metadata', ...(['transcript', 'comments', 'channel'] as const).filter(field => snapshot.inspector[field])],
    } };
}

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
  // Opening saved content must never enable the independent Add sources mode.
  const projectId = params.has('saved') || params.has('openProject') ? null : params.get('project');
  const projectName = projects.find(project => project.id === projectId)?.name ?? 'project';
  const [inspector, setInspector] = useDashboardDraft<Inspector | null>('source-inspector', null);
  const [transcriptQuery, setTranscriptQuery] = useDashboardDraft('transcript-query', '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [commentsRetaining, setCommentsRetaining] = useState(false);
  const [opened, setOpened] = useState<OpenedItem | null>(null);
  const projectView = Boolean(opened || params.has('saved'));
  const [saving, setSaving] = useState(false);
  const [operationLabel, setOperationLabel] = useState('');
  const [recentSources, setRecentSources] = useState<RecentSource[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [failedSaves, setFailedSaves] = useState<Array<SourceSave & { error: string }>>([]);
  const historyInput = useRef('');
  const openedItem = useRef<OpenedItem | null>(null);
  const retryAction = useRef<(() => Promise<unknown>) | null>(null);
  // Each displayed inspection has a generation; its Recent receipt pins exactly that version.
  const inspectionGeneration = useRef(0);
  const sourceReceipt = useRef<{ generation: number; receipt: SourceReceipt } | null>(null);
  const pendingSourceSave = useRef<PendingSourceSave | null>(null);
  const parentSource = useRef<SourceParent | null>(null);
  const [parentList, setParentList] = useState<'playlist' | 'results' | null>(null);
  const savingSource = useRef(false);
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

  const persistSource = async <T extends { source?: RecentSource; sourceRevision?: string }>(save: SourceSave): Promise<T | null> => {
    try {
      const response = await api<T>(save.path, { method: save.method ?? 'POST', body: save.body });
      const { source } = response;
      if (save.generation === inspectionGeneration.current && source && response.sourceRevision) {
        sourceReceipt.current = { generation: save.generation, receipt: { sourceId: source.id, sourceRevision: response.sourceRevision } };
        const commentsReceipt = { sourceId: source.id, sourceRevision: response.sourceRevision };
        setInspector(current => current?.comments ? { ...current, commentsReceipt } : current);
        if (save.comments) setCommentsRetaining(false);
      }
      if (source) setRecentSources(current => [source, ...current.filter(item => item.id !== source.id)].slice(0, 30));
      setFailedSaves(current => current.filter(item => item.id !== save.id));
      if (save.projectId) {
        void cache.projectDetails.invalidate(save.projectId);
        // Reconcile counts even when a retry follows a lost successful response.
        void projectsResource.refresh();
        setNotice(save.retains ? `Saved to ${save.projectName}` : `Added to ${save.projectName}`);
      }
      return response;
    } catch (cause) {
      const failed = { ...save, error: cause instanceof Error ? cause.message : 'Could not save this source.' };
      setFailedSaves(current => [...current.filter(item => item.id !== save.id), failed]);
      return null;
    }
  };

  const rememberSource = async (input: string, snapshot: SourceSnapshot, destination: { id: string | null; name: string } = { id: projectId, name: projectName }) => {
    const generation = inspectionGeneration.current;
    const promise = persistSource<{ source?: RecentSource; sourceRevision?: string }>({ id: crypto.randomUUID(), input, generation, projectId: destination.id, projectName: destination.name, path: '/v1/sources/recent',
      body: JSON.stringify({ input, snapshot: sourceRequest(snapshot), ...(destination.id ? { projectId: destination.id } : {}) }),
    });
    if (snapshot.kind === 'inspection') pendingSourceSave.current = { generation, promise };
    const saved = await promise;
    // Only the inspection still on screen may supply the version that Save pins.
    if (snapshot.kind === 'inspection' && inspectionGeneration.current === generation) {
      sourceReceipt.current = saved?.source && saved.sourceRevision ? { generation, receipt: { sourceId: saved.source.id, sourceRevision: saved.sourceRevision } } : null;
    }
  };

  /** A new displayed inspection: earlier Recent receipts no longer describe what is on screen. */
  const nextInspection = () => {
    sourceReceipt.current = null; pendingSourceSave.current = null;
    setCommentsRetaining(false);
    return ++inspectionGeneration.current;
  };

  const forgetOpenedItem = () => { openedItem.current = null; setOpened(null); };
  const setParent = (parent: SourceParent | null) => {
    parentSource.current = parent;
    setParentList(parent ? parent.kind === 'saved' ? parent.list : 'playlist' : null);
  };

  const openRecentSource = async (entry: Pick<RecentSource, 'id'>) => {
    forgetOpenedItem(); setParent(null);
    if (hasPendingLink(params)) clearPendingLink();
    const controller = beginOperation('Loading saved source data…');
    try {
      const { source, snapshot, sourceRevision } = await api<{ source: RecentSource; snapshot: SourceSnapshot; sourceRevision?: string }>(`/v1/sources/recent/${entry.id}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const generation = nextInspection();
      if (sourceRevision) sourceReceipt.current = { generation, receipt: { sourceId: source.id, sourceRevision } };
      setQuery(source.input); historyInput.current = source.input; setTranscriptQuery('');
      setRecentSources(current => [source, ...current.filter(item => item.id !== source.id)].slice(0, 30));
      if (projectId) void persistSource({ id: crypto.randomUUID(), input: source.input, projectId, projectName,
        path: `/v1/projects/${encodeURIComponent(projectId)}/sources`, body: JSON.stringify({ sourceId: source.id }),
      });
      if (snapshot.kind === 'search') {
        setSelectedData(snapshot.selectedData); setItems(snapshot.items); setInspector(null); setHasSearched(true);
      } else {
        setItems([]); setHasSearched(false); setSelectedData(snapshot.inspector.requestedData.length ? snapshot.inspector.requestedData : ['transcript']);
        setInspector({ ...snapshot.inspector, ...(sourceRevision ? { commentsReceipt: { sourceId: source.id, sourceRevision } } : {}) });
      }
    } catch (cause) { if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not open recent source.'); }
    finally { finishOperation(controller); }
  };

  /** True while the address is still the link that started this work. */
  const isCurrentLink = (openingSearch: string) => window.location.pathname === '/dashboard/sources'
    && new URLSearchParams(window.location.search).toString() === openingSearch;

  /** Replace the address only while it is still the link that started this work. */
  const replaceIfCurrent = (openingSearch: string, remove: string[]) => {
    if (!isCurrentLink(openingSearch)) return;
    const next = new URLSearchParams(openingSearch); remove.forEach(name => next.delete(name));
    router.replace(`/dashboard/sources${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  /** Every saved project item opens from storage for free. Nothing here fetches from YouTube. */
  const openProjectItem = async (openProject: string, itemId: string, openingSearch: string) => {
    if (openedItem.current?.projectId !== openProject || openedItem.current.itemId !== itemId) forgetOpenedItem();
    // Only the saved member opened from a list keeps that list as its Back destination.
    const parent = parentSource.current;
    if (parent && !(parent.kind === 'saved' && parent.projectId === openProject && parent.childItemId === itemId)) setParent(null);
    const controller = beginOperation('Loading saved source data…');
    setInspector(null); setItems([]); setHasSearched(false); setNotice('');
    try {
      const result = await api<ProjectRestore>(`/v1/projects/${encodeURIComponent(openProject)}/sources/items/${encodeURIComponent(itemId)}`, { signal: controller.signal });
      // A free open that finishes after navigation must not repaint a newer page or project context.
      if (controller.signal.aborted || !isCurrentLink(openingSearch)) return;
      const generation = nextInspection();
      const context: OpenedItem = { projectId: openProject, itemId, kind: result.item.source_id ? 'project-source' : 'item',
        entity: `${result.item.entity_type}:${result.item.entity_id}`, startMs: result.item.start_ms ?? null,
        retained: result.state === 'restored' && !result.recovered, generation };
      openedItem.current = context; setOpened(context);
      if (result.state === 'unavailable') {
        setQuery('');
        setError('Saved data is currently unavailable. Retry loading from storage at no cost.');
        retryAction.current = () => openProjectItem(openProject, itemId, openingSearch);
        return;
      }
      if (result.sourceRevision) sourceReceipt.current = { generation, receipt: { savedRevision: result.sourceRevision } };
      setQuery(result.source.input); historyInput.current = result.source.input; setTranscriptQuery('');
      if (result.snapshot.kind === 'search') {
        setSelectedData(result.snapshot.selectedData); setItems(result.snapshot.items); setInspector(null); setHasSearched(true);
      } else {
        const { item } = result;
        setItems([]); setHasSearched(false); setSelectedData(result.snapshot.inspector.requestedData.length ? result.snapshot.inspector.requestedData : ['transcript']);
        setInspector({ ...result.snapshot.inspector, ...(result.savedText ? { savedText: result.savedText } : {}),
          ...(item.start_ms != null ? { savedMoment: { startMs: item.start_ms, note: item.note } } : {}) });
      }
      if (result.missingData.length) setNotice('Some saved data is currently unavailable. Retry loading from storage at no cost.');
      else if (result.origin === 'storage') setNotice('Recovered from data already stored for this saved item.');
      replaceIfCurrent(openingSearch, PENDING_LINK_PARAMS);
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentLink(openingSearch)) return;
      setError(cause instanceof Error ? cause.message : 'Could not open this project item.');
      // Storage failures are retryable, never treated as missing data.
      retryAction.current = () => openProjectItem(openProject, itemId, openingSearch);
    } finally { finishOperation(controller); }
  };

  const beginOperation = useCallback((label: string) => {
    operationController.current?.abort();
    const controller = new AbortController();
    operationController.current = controller;
    retryAction.current = null;
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
    cancelOperation(); setCommentsRetaining(false); setInspector(null); setItems([]); setHasSearched(false);
    openedItem.current = null; setOpened(null); retryAction.current = null;
    parentSource.current = null; setParentList(null);
    setQuery(''); setTranscriptQuery(''); setError(''); setNotice('');
    const next = new URLSearchParams(window.location.search);
    if (next.has('saved') || next.has('legacy')) {
      PENDING_LINK_PARAMS.forEach(name => next.delete(name));
      router.replace(`/dashboard/sources${next.size ? `?${next}` : ''}`, { scroll: false });
    }
  }, [cancelOperation, setInspector, setItems, setHasSearched, setQuery, setTranscriptQuery, router]);

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

  const hasPendingLink = (search: URLSearchParams) => search.get('legacy') === '1' || search.has('saved');

  /** Leave the pending link: the user cancelled, edited the input, or explicitly inspected it. */
  const clearPendingLink = () => {
    const next = new URLSearchParams(params); PENDING_LINK_PARAMS.forEach(name => next.delete(name));
    router.replace(`/dashboard/sources${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    retryAction.current = null;
    if (!query.trim()) return;
    const input = query.trim();
    forgetOpenedItem(); setParent(null);
    if (hasPendingLink(params)) clearPendingLink();
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
    if (type === 'video' && !isVideoId(id)) {
      // A malformed ID names no video: nothing is fetched or remembered.
      setError('Invalid video ID.');
      finishOperation(controller);
      return false;
    }
    forgetOpenedItem();
    nextInspection();
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

  const reloadOpenedItem = () => {
    const item = openedItem.current;
    if (item) return openProjectItem(item.projectId, item.itemId, new URLSearchParams(window.location.search).toString());
  };

  const openVideo = async (id: string, provider: ProviderId = 'youtube') => {
    const item = openedItem.current;
    if (!item) {
      // Remember a live playlist (and its pending Recent save) so Back can restore exactly what was shown.
      if (inspector?.type === 'playlist') {
        const existing = parentSource.current;
        // A second callback from the same rendered playlist must not recapture after the first child began.
        if (existing?.kind === 'live' && existing.inspector === inspector) { await inspect('video', id, undefined, provider, selectedData); return; }
        const generation = inspectionGeneration.current;
        setParent({ kind: 'live', inspector, query, input: historyInput.current, selectedData: [...selectedData],
          receipt: sourceReceipt.current?.generation === generation ? sourceReceipt.current.receipt : null,
          pending: pendingSourceSave.current?.generation === generation ? pendingSourceSave.current : null });
      } else setParent(null);
      await inspect('video', id, undefined, provider, selectedData); return;
    }
    const openingSearch = new URLSearchParams(window.location.search).toString();
    try {
      const project = await api<{ items: ProjectItem[] }>(`/v1/projects/${encodeURIComponent(item.projectId)}`);
      if (openedItem.current !== item || !isCurrentLink(openingSearch)) return;
      const video = project.items.find(entry => entry.provider === provider && entry.entity_type === 'video' && entry.entity_id === id && entry.start_ms == null)
        ?? project.items.find(entry => entry.provider === provider && entry.entity_type === 'video' && entry.entity_id === id);
      if (!video) { setNotice('This video has no saved data in this project. Only the result list was saved.'); return; }
      setParent({ kind: 'saved', projectId: item.projectId, itemId: item.itemId, list: inspector?.type === 'playlist' ? 'playlist' : 'results', childItemId: video.id });
      router.push(`/dashboard/sources?openProject=${encodeURIComponent(item.projectId)}&saved=${encodeURIComponent(video.id)}`);
    } catch (cause) { if (openedItem.current === item && isCurrentLink(openingSearch)) setError(cause instanceof Error ? cause.message : 'Could not load saved project sources.'); }
  };

  /** Back from an opened source: return to the list it came from, otherwise to Sources. */
  const closeInspector = () => {
    const parent = parentSource.current;
    setParent(null);
    if (!parent) { cancelOperation(); setInspector(null); forgetOpenedItem(); return; }
    // Leaving the child invalidates its outstanding work without a cancellation notice.
    operationController.current?.abort(); operationController.current = null;
    setLoading(false); setOperationLabel(''); setError(''); setNotice(''); retryAction.current = null; setCommentsRetaining(false);
    if (parent.kind === 'saved') {
      forgetOpenedItem(); setInspector(null);
      // Reopen the saved list from storage: free, with its project origin and its own saved version.
      router.replace(projectItemPath(parent.projectId, { id: parent.itemId } as ProjectItem), { scroll: false });
      return;
    }
    forgetOpenedItem();
    const generation = nextInspection();
    setQuery(parent.query); historyInput.current = parent.input; setTranscriptQuery('');
    setSelectedData(parent.selectedData); setItems([]); setHasSearched(false); setInspector(parent.inspector);
    if (parent.receipt) sourceReceipt.current = { generation, receipt: parent.receipt };
    else if (parent.pending) {
      // The playlist's own Recent save is still in flight: bind its result to the restored view, never the child's.
      const promise = parent.pending.promise.then(saved => {
        if (inspectionGeneration.current === generation) {
          sourceReceipt.current = saved?.source && saved.sourceRevision ? { generation, receipt: { sourceId: saved.source.id, sourceRevision: saved.sourceRevision } } : null;
        }
        return saved;
      });
      pendingSourceSave.current = { generation, promise };
    }
  };

  const backLabel = parentList === 'playlist' ? '← Back to playlist' : parentList === 'results' || items.length ? '← Back to results' : '← Back to Sources';

  const loadMoreComments = async () => {
    if (!inspector || openedItem.current || loading || commentsRetaining || !inspector.comments?.continuation) return;
    const current = inspector, input = historyInput.current;
    const controller = beginOperation('Loading another comments page…');
    try {
      const pending = pendingSourceSave.current;
      if (pending?.generation === inspectionGeneration.current) await pending.promise;
      if (!sourceReceipt.current || !('sourceId' in sourceReceipt.current.receipt)) {
        await rememberSource(input, { kind: 'inspection', inspector: current });
      }
      if (controller.signal.aborted) return;
      const receipt = sourceReceipt.current?.receipt;
      if (!receipt || !('sourceId' in receipt)) throw new Error('Save the current comments before loading another page. Retry saving the source.');
      const continuation = current.comments!.continuation!;
      const page = await api<CommentPage>(`/v1/videos/${encodeURIComponent(current.id)}/comments?provider=${encodeURIComponent(current.provider)}&${new URLSearchParams({ continuation, refresh: 'true', retain: 'true' })}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!page.pageReceipt) throw new Error('The comments response did not include its saved version. Reload Sources after the platform update.');
      const comments = new Map(current.comments!.comments.map(comment => [comment.id, comment]));
      page.comments.forEach(comment => comments.set(comment.id, comment));
      const generation = nextInspection();
      setInspector({ ...current, comments: { ...page, comments: [...comments.values()], totalCount: page.totalCount ?? current.comments!.totalCount, meta: { ...page.meta,
        warnings: [...new Set([...current.comments!.meta.warnings, ...page.meta.warnings])], partial: current.comments!.meta.partial || page.meta.partial } },
        commentPagesLoaded: (current.commentPagesLoaded ?? 1) + 1 });
      setCommentsRetaining(true);
      const promise = persistSource<{ source?: RecentSource; sourceRevision?: string }>({ id: crypto.randomUUID(), input, generation, comments: true,
        projectId, projectName, path: `/v1/sources/recent/${encodeURIComponent(receipt.sourceId)}/comments`,
        body: JSON.stringify({ sourceRevision: receipt.sourceRevision, continuation, pageReceipt: page.pageReceipt, ...(projectId ? { projectId } : {}) }) });
      pendingSourceSave.current = { generation, promise };
      await promise;
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not load another comments page.');
    } finally { finishOperation(controller); }
  };

  const refreshVideoData = async () => {
    if (openedItem.current) { await reloadOpenedItem(); return; }
    if (!inspector || loading || commentsRetaining) return;
    setNotice('');
    const controller = beginOperation('Refreshing video data…');
    nextInspection();
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
    if (openedItem.current) { await reloadOpenedItem(); return; }
    if (!inspector || loading || commentsRetaining) return;
    const controller = beginOperation('Fetching current comments…');
    nextInspection();
    try {
      await loadVideoData({ ...inspector, dataErrors: { ...inspector.dataErrors } }, ['comments'], controller);
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not refresh comments.');
    } finally { finishOperation(controller); }
  };

  const retrySourceData = async () => {
    if (openedItem.current) { await reloadOpenedItem(); return; }
    if (!inspector || loading || commentsRetaining) return;
    const controller = beginOperation('Retrying failed source requests…');
    nextInspection();
    const next = { ...inspector, dataErrors: { ...inspector.dataErrors } };
    try {
      await loadVideoData(next, retryableSourceDatasets(next.dataErrors), controller);
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally { finishOperation(controller); }
  };

  useEffect(() => {
    if (!active) return;
    const q=params.get('q'), id=params.get('id'), type=params.get('type'), saved=params.get('saved');
    if (saved) {
      const openProject = params.get('openProject');
      if (!openProject && params.get('project')) {
        // Older snapshot links carried project=, which also meant Add sources. Open without that mode.
        const next = new URLSearchParams(params); next.set('openProject', params.get('project')!); next.delete('project');
        router.replace(`/dashboard/sources?${next}`, { scroll: false });
        return;
      }
      // The link stays until the item is shown, so reload and unavailable retries keep working.
      if (openProject) { void openProjectItem(openProject, saved, params.toString()); return; }
    }
    if (params.get('legacy') === '1' && id && (type === 'video' || type === 'channel' || type === 'playlist')) {
      showRecentSources();
      setError('Open this saved source from its project to load stored data at no cost.');
      return;
    }
    if (q) { setQuery(q); searchInput.current?.focus(); }
    if (q || id) setParent(null);
    if (id && (type==='video'||type==='channel'||type==='playlist')) void inspect(type,id);
    if (q||id||saved) { const next=new URLSearchParams(params); next.delete('q');next.delete('id');next.delete('type');next.delete('saved');router.replace(`/dashboard/sources${next.size?`?${next}`:''}`,{scroll:false}); }
  }, [active, params, router]);
  const createProject = async (name:string) => {
    const project = await api<Project>('/v1/projects',{method:'POST',body:JSON.stringify({name})});
    await projectsResource.refresh(); return project;
  };

  const saveInspector = async () => {
    if (!inspector || savingSource.current || loading || commentsRetaining) return;
    const current = inspector, input = historyInput.current, generation = inspectionGeneration.current;
    const receiptAtSave = sourceReceipt.current;
    // Capture this view's own pending Recent save now: a later navigation replaces the current refs.
    const pendingAtSave = pendingSourceSave.current?.generation === generation ? pendingSourceSave.current : null;
    const snapshot: SourceSnapshot = { kind: 'inspection', inspector: current };
    if (projectId) {
      await rememberSource(input, snapshot);
      return;
    }
    const openedHere = openedItem.current?.entity === `${current.type}:${current.id}` ? openedItem.current : null;
    savingSource.current = true; setSaving(true);
    try {
      await cache.load('projects');
      if (cache.read('projects').error) throw new Error(cache.read('projects').error);
      const list = cache.read('projects').data ?? [];
      // An opened item saves back to its own project. If that project is missing from the list, keep the
      // explicit target and let the owned API reject it rather than silently writing another project.
      const project = openedHere
        ? list.find(entry => entry.id === openedHere.projectId) ?? { id: openedHere.projectId, name: 'its project' }
        : list[0] ?? await createProject('Research inbox');
      const retain = async (itemId: string) => {
        let receipt: SourceReceipt | null = receiptAtSave?.generation === generation ? receiptAtSave.receipt : null;
        if (!receipt && pendingAtSave) {
          // Pin exactly what the captured save returned, whatever view is current when it settles.
          const saved = await pendingAtSave.promise;
          receipt = saved?.source && saved.sourceRevision ? { sourceId: saved.source.id, sourceRevision: saved.sourceRevision } : null;
        } else if (!receipt) {
          const pendingSave = pendingSourceSave.current;
          if (pendingSave?.generation === generation) await pendingSave.promise;
          receipt = sourceReceipt.current?.generation === generation ? sourceReceipt.current.receipt : null;
        }
        await persistSource({ id: crypto.randomUUID(), input, projectId: project.id, projectName: project.name, method: 'PUT', retains: true,
          path: `/v1/projects/${encodeURIComponent(project.id)}/sources/items/${encodeURIComponent(itemId)}/snapshot`,
          body: JSON.stringify(receipt ?? { input, snapshot: sourceRequest(snapshot) }) });
      };
      if (openedHere?.kind === 'project-source') {
        // Keep the same row and the displayed revision, including recovery from another owned reference.
        if (openedHere.retained && openedHere.generation === generation) setNotice(`Already saved in ${project.name}`);
        else await retain(openedHere.itemId);
        return;
      }
      const title = String(current.data.title ?? current.data.name ?? current.id);
      // A reopened moment keeps its own item: same start time, and its existing content and note are left alone.
      const moment = openedHere?.kind === 'item' && openedHere.startMs !== null ? openedHere.startMs : null;
      const saved = await api<{ id: string; existing?: boolean }>(`/v1/projects/${encodeURIComponent(project.id)}/items`, {
        method: 'POST', body: JSON.stringify(moment !== null
          ? { provider: current.provider, entityType: current.type, entityId: current.id, title, startMs: moment }
          : { provider: current.provider, entityType: current.type, entityId: current.id, title,
            content: current.transcript?.segments.map((segment) => `[${segment.startMs}] ${segment.text}`).join('\n') }),
      });
      void cache.projectDetails.invalidate(project.id);
      if (openedHere?.kind === 'item' && openedHere.itemId === saved.id && openedHere.retained && openedHere.generation === generation) {
        setNotice(`Already saved in ${project.name}`);
      } else {
        // Copy the displayed Recent or recovered revision; keep the same request for a failed-save retry.
        await retain(saved.id);
      }
      await projectsResource.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save source.'); }
    finally { savingSource.current = false; setSaving(false); }
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
            {!projectId && opened && <div className='source-project-context' role='status'>Opened from <strong>{projects.find(project => project.id === opened.projectId)?.name ?? 'project'}</strong><Link href={`/dashboard/projects?project=${encodeURIComponent(opened.projectId)}`}>View project</Link></div>}
            <section className='source-studio' aria-labelledby='source-studio-title'>
              <header className={pageStyles.intro}><h2 id='source-studio-title'>{projectView ? 'Saved project source' : 'Search or paste a YouTube link'}</h2>{(projectView || inspector || hasSearched) && <button className={pageStyles.textAction} onClick={showRecentSources}>Recent sources</button>}</header>
              {!projectView && <form onSubmit={runSearch} className='source-studio-form'>
                <label className='source-query-label' htmlFor='workspace-search'>{playlistInput ? 'Playlist URL detected' : 'Video search or YouTube URL'}</label>
                <div className='source-query-row'>
                  <div data-playlist={playlistInput}><Icon name='search' size={19} /><input id='workspace-search' ref={searchInput} value={query} onChange={(event) => { setQuery(event.target.value); if (hasPendingLink(params)) clearPendingLink(); }} placeholder='e.g. Opus 5.5 vs GPT 6 Astra, or a YouTube URL' autoComplete='off' /><kbd>{playlistInput ? 'PLAYLIST' : '⌘ K'}</kbd></div>
                  <button disabled={loading || !query.trim()}>{loading ? 'Working…' : 'Inspect'} <span aria-hidden='true'>→</span></button>
                </div>
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
              </form>}
            </section>

            {(loading || error || notice) && <div className='source-feedback'>
              {loading && <div className='source-operation-loading'><SourceSkeleton label={operationLabel} lines={2} /><button type='button' onClick={cancelOperation}>Cancel</button></div>}
              {error && <div className='alert error' role='alert'><span>{error}</span>{(retryAction.current || query.trim()) && <button onClick={() => { const retry = retryAction.current; retryAction.current = null; void (retry ? retry() : openedItem.current ? reloadOpenedItem() : runSearch()); }}>Retry</button>}</div>}
              {notice && <div className='alert success' role='status'><span>{notice}</span><button aria-label='Dismiss notification' onClick={() => setNotice('')}>×</button></div>}
            </div>}
            {failedSaves.map(save => <div key={save.id} className='source-project-save-error alert error' role='alert'>
              <span>{save.retains ? `Saved ${save.input} to ${save.projectName}, but its data is not retained yet: ${save.error}` : <>Could not save {save.input}{save.projectId ? ` to ${save.projectName}` : ''}: {save.error}</>}</span>
              <button type='button' onClick={() => void persistSource(save)}>{save.retains ? 'Retry retaining data' : 'Retry saving'}</button>
            </div>)}
            {inspector ? (
              <InspectorPanel key={`${inspector.provider}-${inspector.type}-${inspector.id}-${inspector.requestedData.join('-')}`} inspector={inspector} retrying={loading} saving={saving || commentsRetaining} savedProject={Boolean(opened)} onLoadMoreComments={() => void loadMoreComments()} onReloadSaved={() => void reloadOpenedItem()} onRetry={() => void retrySourceData()} onOpenComments={() => void refreshComments()} onRefresh={() => void refreshVideoData()} segments={filteredSegments} transcriptQuery={transcriptQuery} setTranscriptQuery={setTranscriptQuery} backLabel={backLabel} onClose={closeInspector} onSave={() => void saveInspector()} onMonitor={() => void addMonitor()} onOpenVideo={(id) => void openVideo(id, inspector.provider)} />
            ) : (
              hasSearched || loading || items.length ? <VideoSearchResults items={items} onInspect={(id, provider) => void openVideo(id, provider)} onStart={() => searchInput.current?.focus()} loading={loading} hasSearched={hasSearched} failed={Boolean(error)} />
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

function InspectorPanel({ inspector, onRetry, onOpenComments, onRefresh, retrying, saving, savedProject, onLoadMoreComments, onReloadSaved, segments, transcriptQuery, setTranscriptQuery, backLabel, onClose, onSave, onMonitor, onOpenVideo }: { inspector: Inspector; onRetry: () => void; onOpenComments: () => void; onRefresh: () => void; retrying: boolean; saving: boolean; savedProject: boolean; onLoadMoreComments: () => void; onReloadSaved: () => void; segments: Segment[]; transcriptQuery: string; setTranscriptQuery: (value:string)=>void; backLabel: string; onClose:()=>void; onSave:()=>void; onMonitor:()=>void; onOpenVideo:(id:string)=>void }) {
  const title = String(inspector.data.title ?? inspector.data.name ?? inspector.id);
  const videoChannel = inspector.data.channel as { id?: string; name?: string; url?: string } | undefined;
  const panelOptions = inspector.requestedData.filter((option) => option !== 'channel');
  const metadataLoading = Boolean(inspector.loadingData?.includes('metadata')) && !inspector.data.title;
  const refreshing = inspector.loadingData?.some(dataset => inspector.refreshData?.includes(dataset));
  const savedData = Boolean(inspector.savedText) || [inspector.data, inspector.transcript, inspector.comments].some(value => {
    const state = (value as { freshness?: { state?: string } } | undefined)?.freshness?.state;
    return state === 'stored' || state === 'stale';
  });
  const [activePanel, setActivePanel] = useState<SourceDataOption>(panelOptions[0] ?? 'channel');
  const commentPage = inspector.comments;
  const commentPagesLoaded = inspector.commentPagesLoaded ?? (commentPage ? 1 : 0);
  const commentsLoading = retrying || saving;

  if (inspector.type === 'playlist') return <PlaylistInspector inspector={inspector} saving={saving} onClose={onClose} onSave={onSave} onOpenVideo={onOpenVideo} />;
  if (inspector.type !== 'video') return <section className='inspector'><div className='inspector-head'><button className='back' onClick={onClose}>← Back to Sources</button></div><div className='entity-title'><div><span className={`type-pill ${inspector.type}`}>{inspector.type}</span><h2>{title}</h2><p>{String(inspector.data.description ?? '').slice(0,160)}</p></div></div><CatalogEntity inspector={inspector} /></section>;

  return <section className='source-inspector' aria-labelledby='source-detail-title'>
    <div className='source-inspector-toolbar'><button className='back' onClick={onClose}>{backLabel}</button><div><button onClick={onMonitor}><Icon name='monitor' size={15} />Monitor channel</button><button onClick={onSave} disabled={saving || retrying}><Icon name='plus' size={15} />Save to project</button></div></div>
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

    {inspector.savedMoment ? <p className='source-data-warning' role='note'>Saved moment at {formatTime(inspector.savedMoment.startMs)}{inspector.savedMoment.note ? ` · ${inspector.savedMoment.note}` : ''}</p> : null}

    {savedProject ? <div className='source-refresh-row'><span role='status'>Showing saved project data · no credits used</span><button type='button' onClick={onReloadSaved} disabled={retrying}>Reload saved data</button></div> : savedData || refreshing ? <div className='source-refresh-row'>
      <span role='status'>{refreshing ? 'Refreshing data from YouTube…' : 'Showing saved data · refreshing uses credits'}</span>
      <button type='button' onClick={onRefresh} disabled={retrying || commentsLoading}
        title='Fetch video details and the selected transcript and comments again from YouTube. This uses credits.'>
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
        {panelOptions.map((option) => <button key={option} type='button' role='tab' aria-selected={activePanel === option} className={activePanel === option ? 'active' : ''} onClick={() => setActivePanel(option)}>{SOURCE_DATA_OPTIONS[option].shortLabel}<span>{option === 'transcript' ? inspector.transcript?.segments.length ?? 0 : commentPage?.comments.length ?? 0}</span></button>)}
      </div>
      <section className='source-data-panel' role='tabpanel'>
        {activePanel === 'transcript' ? <TranscriptDataPanel inspector={inspector} segments={segments} transcriptQuery={transcriptQuery} setTranscriptQuery={setTranscriptQuery} /> : null}
        {/* Selecting a tab only shows saved data; fetching comments is a separate, credit-labeled action. */}
        {activePanel === 'comments' && inspector.loadingData?.includes('comments') && !commentPage ? <SourceSkeleton label='Loading comments' variant='panel' lines={6} /> : activePanel === 'comments' ? <CommentsDataPanel initialError={inspector.dataErrors.comments} page={commentPage} pagesLoaded={commentPagesLoaded} loading={commentsLoading || Boolean(inspector.loadingData?.includes('comments'))} error='' savedProject={savedProject} onLoadMore={onLoadMoreComments} onLoad={retrying || savedProject ? undefined : onOpenComments} /> : null}
      </section>
    </> : null}

    {!savedProject && !retrying && retryableSourceDatasets(inspector.dataErrors).length > 0 ? <div className='source-retry-actions'><button type='button' onClick={onRetry} disabled={saving}><ArrowClockwiseIcon size={16} aria-hidden='true' />Retry failed requests using credits</button></div> : null}
    {!savedProject && <SourceApiGuide inspector={inspector} channelId={videoChannel?.id} />}
  </section>;
}

function PlaylistInspector({ inspector, saving, onClose, onSave, onOpenVideo }: { inspector: Inspector; saving: boolean; onClose: () => void; onSave: () => void; onOpenVideo: (id: string) => void }) {
  const title = String(inspector.data.title ?? 'YouTube playlist');
  const channel = inspector.data.channel as { id?: string; name?: string; url?: string } | undefined;
  const videos = (inspector.data.videos ?? []) as SearchItem[];
  const thumbnail = bestThumbnail((inspector.data.thumbnails ?? videos[0]?.thumbnails ?? []) as Thumbnail[]);
  const playlistUrl = String(inspector.data.url ?? `https://youtube.com/playlist?list=${inspector.id}`);
  const returnedCount = videos.length;

  return <section className='source-inspector playlist-inspector' aria-labelledby='playlist-detail-title'>
    <div className='source-inspector-toolbar'><button className='back' onClick={onClose}>← Back to Sources</button><div><button onClick={onSave} disabled={saving}><Icon name='plus' size={15} />Save playlist</button></div></div>
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
  if (captionsUnavailable(inspector.dataErrors.transcript) && !inspector.transcript && !inspector.savedText) return <HistoryEmptyState title='No captions available' description='This video does not have captions available on YouTube, so there is no transcript to display.' />;
  if (inspector.dataErrors.transcript && !inspector.transcript && !inspector.savedText) return <p role='alert' className='source-data-unavailable'>{inspector.dataErrors.transcript}</p>;
  if (!inspector.transcript && inspector.savedText) return <>
    {/* Only the project's own saved text survives: no track, timing ranges or completeness are claimed. */}
    <header className='source-panel-head'><div><h3>Saved transcript text</h3><p>From this project’s saved copy. Caption track details were not retained.</p></div></header>
    <pre className='source-saved-text'>{inspector.savedText}</pre>
  </>;
  if (!inspector.transcript) return <p className='source-data-unavailable'>No caption track was returned.</p>;
  return <>
    {inspector.dataErrors.transcript ? <p role='alert' className='source-data-unavailable'>{inspector.dataErrors.transcript} Showing the previously loaded transcript.</p> : null}
    <header className='source-panel-head'><div><h3>{inspector.transcript.track.name}</h3><p>{inspector.transcript.meta.partial ? 'Partial transcript' : 'Complete transcript'} · {inspector.transcript.track.languageCode.toUpperCase()} · {inspector.transcript.track.kind} · {inspector.transcript.segments.length.toLocaleString()} moments</p></div><label><span className='sr-only'>Search transcript</span><input aria-label='Search transcript' value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} placeholder='Filter transcript…' /></label></header>
    {inspector.transcript.meta.warnings.length ? <p className='source-data-warning'>{inspector.transcript.meta.warnings.join(' ')}</p> : null}
    <ol className='source-transcript'>{segments.map((segment) => <li key={`${segment.startMs}-${segment.text}`}><a href={`https://youtube.com/watch?v=${inspector.id}&t=${Math.floor(segment.startMs / 1000)}s`} target='_blank' rel='noreferrer'>{formatTime(segment.startMs)}</a><p>{highlight(segment.text, transcriptQuery)}</p></li>)}</ol>
    {!segments.length ? <p className='source-data-unavailable'>No transcript moments match this filter.</p> : null}
  </>;
}

function CommentsDataPanel({ initialError, page, pagesLoaded, loading, error, savedProject, onLoadMore, onLoad }: { initialError?: string; page?: CommentPage; pagesLoaded: number; loading: boolean; error: string; savedProject: boolean; onLoadMore: () => void; onLoad?: () => void }) {
  if (initialError && !page) return <p role='alert' className='source-data-unavailable'>{initialError}</p>;
  const comments = page?.comments ?? [];
  if (!page && !loading && onLoad) return <div className='source-data-unavailable'><p>No comments are saved for this video.</p><button type='button' onClick={onLoad}>Load comments using credits</button></div>;
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
      <span>{savedProject ? 'All retained comment pages are shown.' : page?.continuation ? 'More comments are available.' : 'All available comment pages are loaded.'}</span>
      {!savedProject && page?.continuation ? <button type='button' disabled={loading} aria-busy={loading} onClick={onLoadMore}>Load next page using credits</button> : null}
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
