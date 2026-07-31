'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Mode = 'youtube' | 'inside' | 'ask';
type Section = 'discover' | 'projects' | 'monitors';
type EntityType = 'video' | 'channel' | 'playlist';
type Thumbnail = { url: string; width?: number; height?: number };
type SearchItem = {
  type: EntityType; id: string; title?: string; name?: string; description?: string;
  channel?: { id: string; name: string }; thumbnails: Thumbnail[]; durationText?: string;
  viewCountText?: string; publishedTimeText?: string; isLive?: boolean; videoCountText?: string;
};
type Segment = { text: string; startMs: number; endMs: number; durationMs: number };
type Transcript = { videoId: string; segments: Segment[]; text: string; track: { name: string; kind: string; languageCode: string } };
type Project = { id: string; name: string; description?: string; item_count?: number };
type Monitor = { id: string; kind: string; target: string; enabled: number; last_checked_at?: number };
type Citation = { index: number; text: string; entityId?: string; startMs?: number; score: number };
type Answer = { answer: string; citations: Citation[] };
type Inspector = { type: EntityType; id: string; data: Record<string, unknown>; transcript?: Transcript; comments?: Array<Record<string, unknown>> };

const DEMO_HEADERS = { 'x-demo-user': 'local-beta' };

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('x-demo-user', 'local-beta');
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(`/api/platform${path}`, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export default function WorkspacePage() {
  const [section, setSection] = useState<Section>('discover');
  const [mode, setMode] = useState<Mode>('youtube');
  const [query, setQuery] = useState('');
  const [entityFilter, setEntityFilter] = useState('all');
  const [duration, setDuration] = useState('');
  const [captionsOnly, setCaptionsOnly] = useState(false);
  const [items, setItems] = useState<SearchItem[]>([]);
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

  const refreshPrivateData = useCallback(async () => {
    const [projectData, monitorData] = await Promise.all([
      api<{ projects: Project[] }>('/v1/projects').catch(() => ({ projects: [] })),
      api<{ monitors: Monitor[] }>('/v1/monitors').catch(() => ({ monitors: [] })),
    ]);
    setProjects(projectData.projects);
    setMonitors(monitorData.monitors);
  }, []);

  useEffect(() => {
    void refreshPrivateData();
    api<{ results: SearchItem[] }>('/v1/browse')
      .then((data) => setItems(data.results.slice(0, 12)))
      .catch(() => {
        setItems(featuredFallback);
      });
  }, [refreshPrivateData]);

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setLoading(true); setError(''); setAnswer(null); setInspector(null); setSection('discover');
    try {
      const resolved = await api<{ kind: EntityType | 'search'; id?: string; query?: string }>('/v1/resolve', {
        method: 'POST', body: JSON.stringify({ input: query }), headers: DEMO_HEADERS,
      });
      if (resolved.kind !== 'search' && resolved.id) {
        await inspect(resolved.kind, resolved.id);
        return;
      }
      const params = new URLSearchParams({ q: resolved.query ?? query, mode });
      if (mode === 'youtube') {
        params.set('type', entityFilter);
        if (duration) params.set('duration', duration);
        if (captionsOnly) params.set('captions', 'true');
        const data = await api<{ results: SearchItem[] }>(`/v1/search?${params}`);
        setItems(data.results);
      } else if (mode === 'inside') {
        const data = await api<{ results: Citation[] }>(`/v1/search?${params}`);
        setItems(data.results.map((result) => evidenceToItem(result)));
      } else {
        const data = await api<Answer>(`/v1/search?${params}`);
        setAnswer(data);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Search failed.');
    } finally { setLoading(false); }
  };

  const inspect = async (type: EntityType, id: string) => {
    setLoading(true); setError(''); setAnswer(null);
    try {
      const plural = type === 'video' ? 'videos' : type === 'channel' ? 'channels' : 'playlists';
      const data = await api<Record<string, unknown>>(`/v1/${plural}/${encodeURIComponent(id)}`);
      const next: Inspector = { type, id, data };
      if (type === 'video') {
        const [transcript, comments] = await Promise.all([
          api<Transcript>(`/v1/videos/${id}/transcript`).catch(() => undefined),
          api<{ comments: Array<Record<string, unknown>> }>(`/v1/videos/${id}/comments?all=true`).catch(() => ({ comments: [] })),
        ]);
        next.transcript = transcript;
        next.comments = comments.comments;
      }
      setInspector(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open this source.'); }
    finally { setLoading(false); }
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
          entityType: inspector.type, entityId: inspector.id, title,
          content: inspector.transcript?.segments.map((segment) => `[${segment.startMs}] ${segment.text}`).join('\n'),
        }),
      });
      await api('/v1/imports', {
        method: 'POST', body: JSON.stringify({ kind: inspector.type, entityId: inspector.id, projectId: project.id }),
      }).catch(() => null);
      setNotice(`Saved to ${project.name}`); await refreshPrivateData();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save source.'); }
  };

  const addMonitor = async () => {
    if (!inspector) return;
    const target = inspector.type === 'channel' ? inspector.id : String(inspector.data.channel ? (inspector.data.channel as { id?: string }).id : inspector.id);
    try {
      await api('/v1/monitors', { method: 'POST', body: JSON.stringify({ kind: inspector.type === 'channel' ? 'channel' : 'topic', target }) });
      setNotice('Monitor enabled'); await refreshPrivateData();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create monitor.'); }
  };

  const askAboutSource = async (sourceQuestion?: string) => {
    if (!inspector) return;
    const prompt = sourceQuestion?.trim() || `Give me an evidence-first brief of ${String(inspector.data.title ?? inspector.data.name ?? 'this source')}.`;
    setLoading(true); setError('');
    try {
      const data = await api<Answer>('/v1/answers', {
        method: 'POST',
        body: JSON.stringify({ question: prompt, entityId: inspector.type === 'video' ? inspector.id : undefined }),
      });
      setAnswer(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a cited brief. Save and index the source first.'); }
    finally { setLoading(false); }
  };

  const filteredSegments = useMemo(() => {
    const segments = inspector?.transcript?.segments ?? [];
    const normalized = transcriptQuery.trim().toLowerCase();
    return normalized ? segments.filter((segment) => segment.text.toLowerCase().includes(normalized)) : segments;
  }, [inspector, transcriptQuery]);

  return (
    <main className='workspace-shell'>
      <Sidebar section={section} setSection={setSection} projects={projects} onNewProject={() => setShowNewProject(true)} />
      <div className='workspace-main'>
        <header className='topbar'>
          <div><p className='eyebrow'>PRIVATE RESEARCH WORKSPACE</p><h1>{section === 'discover' ? 'YouTube, with receipts.' : section === 'projects' ? 'Your research projects' : 'Signals worth watching'}</h1></div>
          <div className='topbar-actions'><button className='icon-button' aria-label='Notifications'>◌<span className='status-dot' /></button><button className='avatar' onClick={() => setShowSignIn(true)}>HG</button></div>
        </header>

        {section === 'discover' && (
          <>
            <section className='search-stage'>
              <form onSubmit={runSearch} className='universal-search'>
                <span className='search-glyph'>⌕</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder='Search, ask a question, or paste any YouTube URL…' aria-label='Search YouTube intelligence' />
                <kbd>⌘ K</kbd><button disabled={loading}>{loading ? 'Working…' : 'Explore'}</button>
              </form>
              <div className='search-controls'>
                <div className='mode-tabs'>{(['youtube','inside','ask'] as Mode[]).map((value) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{value === 'youtube' ? 'YouTube' : value === 'inside' ? 'Inside videos' : 'Ask YouTube'}</button>)}</div>
                {mode === 'youtube' && <div className='filter-row'><select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value)}><option value='all'>All types</option><option value='video'>Videos</option><option value='channel'>Channels</option><option value='playlist'>Playlists</option></select><select value={duration} onChange={(event) => setDuration(event.target.value)}><option value=''>Any duration</option><option value='short'>Under 4 min</option><option value='medium'>4–20 min</option><option value='long'>Over 20 min</option></select><label><input type='checkbox' checked={captionsOnly} onChange={(event) => setCaptionsOnly(event.target.checked)} /> Captions</label></div>}
              </div>
            </section>

            {error && <div className='alert error'>{error}</div>}
            {notice && <div className='alert success' onClick={() => setNotice('')}>{notice}<span>×</span></div>}
            {answer && <AnswerPanel answer={answer} />}
            {inspector ? (
              <InspectorPanel inspector={inspector} segments={filteredSegments} transcriptQuery={transcriptQuery} setTranscriptQuery={setTranscriptQuery} onClose={() => setInspector(null)} onSave={() => void saveInspector()} onMonitor={() => void addMonitor()} onAsk={(question) => void askAboutSource(question)} />
            ) : !answer && (
              <DiscoveryGrid items={items} onInspect={(type, id) => void inspect(type, id)} loading={loading} />
            )}
          </>
        )}
        {section === 'projects' && <ProjectsView projects={projects} onCreate={() => setShowNewProject(true)} />}
        {section === 'monitors' && <MonitorsView monitors={monitors} />}
      </div>
      {showSignIn && <SignInDialog onClose={() => setShowSignIn(false)} />}
      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} onCreate={(name) => void createProject(name)} />}
    </main>
  );
}

function Sidebar({ section, setSection, projects, onNewProject }: { section: Section; setSection: (value: Section) => void; projects: Project[]; onNewProject: () => void }) {
  return <aside className='sidebar'>
    <div className='brand'><span className='brand-mark'>YT</span><span>YouTube<br /><strong>Intelligence</strong></span></div>
    <nav><button className={section === 'discover' ? 'active' : ''} onClick={() => setSection('discover')}><span>⌕</span>Discover</button><button className={section === 'projects' ? 'active' : ''} onClick={() => setSection('projects')}><span>□</span>Projects <em>{projects.length}</em></button><button className={section === 'monitors' ? 'active' : ''} onClick={() => setSection('monitors')}><span>◉</span>Monitors</button></nav>
    <div className='sidebar-rule' />
    <div className='sidebar-label'><span>RECENT PROJECTS</span><button onClick={onNewProject}>＋</button></div>
    <div className='project-links'>{projects.slice(0,5).map((project, index) => <button key={project.id} onClick={() => setSection('projects')}><span className={`project-color c${index % 4}`} />{project.name}</button>)}{!projects.length && <p>Save a source to start.</p>}</div>
    <div className='plan-card'><div><span>PRO</span><strong>1,684 credits</strong></div><div className='meter'><i /></div><small>Renews Aug 18</small></div>
  </aside>;
}

function DiscoveryGrid({ items, onInspect, loading }: { items: SearchItem[]; onInspect: (type: EntityType, id: string) => void; loading: boolean }) {
  return <section className='content-section'>
    <div className='section-heading'><div><p className='eyebrow'>{items.length ? 'DISCOVER' : 'NO RESULTS'}</p><h2>{items.length ? 'Fresh evidence to explore' : 'Try a broader search'}</h2></div><span>{items.length} sources</span></div>
    <div className='source-grid'>{loading && !items.length ? Array.from({length:6}).map((_,i)=><div className='source-card skeleton' key={i}/>) : items.map((item) => <button className='source-card' key={`${item.type}-${item.id}`} onClick={() => onInspect(item.type,item.id)}>
      <div className='thumbnail'>{item.thumbnails?.[0]?.url ? <img src={item.thumbnails[0].url} alt='' /> : <div className='thumb-placeholder'>YT</div>}<span className={`type-pill ${item.type}`}>{item.type}</span>{item.durationText && <time>{item.durationText}</time>}</div>
      <div className='card-copy'><h3>{item.title ?? item.name}</h3><p>{item.channel?.name ?? item.description ?? `${item.videoCountText ?? ''}`}</p><div><span>{item.viewCountText ?? item.publishedTimeText ?? 'Source ready'}</span><b>Inspect ↗</b></div></div>
    </button>)}</div>
  </section>;
}

function InspectorPanel({ inspector, segments, transcriptQuery, setTranscriptQuery, onClose, onSave, onMonitor, onAsk }: { inspector: Inspector; segments: Segment[]; transcriptQuery: string; setTranscriptQuery: (value:string)=>void; onClose:()=>void; onSave:()=>void; onMonitor:()=>void; onAsk:(question?:string)=>void }) {
  const title = String(inspector.data.title ?? inspector.data.name ?? inspector.id);
  const channel = inspector.data.channel as { name?: string } | undefined;
  return <section className='inspector'>
    <div className='inspector-head'><button className='back' onClick={onClose}>← Back to discovery</button><div className='inspector-actions'><button onClick={onMonitor}>◉ Monitor</button><button onClick={onSave}>＋ Save to project</button><button className='primary' onClick={() => onAsk()}>✦ Cited brief</button></div></div>
    <div className='entity-title'><div><span className={`type-pill ${inspector.type}`}>{inspector.type}</span><h2>{title}</h2><p>{channel?.name ?? String(inspector.data.description ?? '').slice(0,160)}</p></div><div className='data-health'><i /> Fresh from YouTube<br /><small>Partial sections degrade safely</small></div></div>
    {inspector.type === 'video' ? <><SourceQuestion onAsk={onAsk} /><div className='video-workbench'>
      <div className='player-column'><div className='player'><iframe src={`https://www.youtube-nocookie.com/embed/${inspector.id}`} title={title} allowFullScreen /></div><div className='signal-strip'><span><b>{formatNumber(inspector.data.viewCount)}</b> views</span><span><b>{inspector.transcript?.segments.length ?? 0}</b> cited moments</span><span><b>{inspector.comments?.length ?? 0}</b> comments loaded</span></div><CommentSample comments={inspector.comments ?? []} /></div>
      <div className='transcript-panel'><div className='transcript-toolbar'><div><p className='eyebrow'>SYNCHRONIZED TRANSCRIPT</p><strong>{inspector.transcript?.track.name ?? 'No caption track'}</strong> <span>{inspector.transcript?.track.kind}</span></div><input value={transcriptQuery} onChange={(event)=>setTranscriptQuery(event.target.value)} placeholder='Search transcript…' /></div><div className='segments'>{segments.slice(0,300).map((segment) => <a key={`${segment.startMs}-${segment.text}`} href={`https://youtube.com/watch?v=${inspector.id}&t=${Math.floor(segment.startMs/1000)}s`} target='_blank' rel='noreferrer'><time>{formatTime(segment.startMs)}</time><p>{highlight(segment.text, transcriptQuery)}</p></a>)}{!segments.length && <div className='empty-state'>No matching caption moments.</div>}</div></div>
    </div></> : <CatalogEntity inspector={inspector} />}
  </section>;
}

function SourceQuestion({ onAsk }: { onAsk: (question: string) => void }) {
  const [question, setQuestion] = useState('');
  return <form className='source-question' onSubmit={(event) => { event.preventDefault(); if (question.trim()) onAsk(question); }}>
    <span>✦</span><input aria-label='Ask about this video' value={question} onChange={(event) => setQuestion(event.target.value)} placeholder='Ask anything about this video…' />
    <button disabled={!question.trim()}>Ask with citations</button>
  </form>;
}

function CatalogEntity({ inspector }: { inspector: Inspector }) {
  const videos = (inspector.data.videos ?? []) as SearchItem[];
  const playlists = (inspector.data.playlists ?? []) as SearchItem[];
  return <div className='catalog-layout'><div className='catalog-stats'><article><small>VIDEOS FOUND</small><strong>{videos.length}</strong></article><article><small>PLAYLISTS</small><strong>{playlists.length}</strong></article><article><small>INDEX STATE</small><strong>{inspector.data.continuation ? 'Partial' : 'Current'}</strong></article></div><div className='catalog-list'><h3>Catalog</h3>{[...videos,...playlists].slice(0,50).map((item)=><a key={item.id} href={item.type==='video'?`https://youtube.com/watch?v=${item.id}`:`https://youtube.com/playlist?list=${item.id}`} target='_blank' rel='noreferrer'><span>{item.type}</span><strong>{item.title}</strong><small>{item.viewCountText ?? item.videoCountText}</small></a>)}</div></div>;
}

function CommentSample({ comments }: { comments: Array<Record<string,unknown>> }) {
  return <div className='comments-card'><div className='section-heading compact'><div><p className='eyebrow'>AUDIENCE EVIDENCE</p><h3>Comment preview</h3></div><span>Showing {Math.min(3, comments.length)} of {comments.length}</span></div>{comments.slice(0,3).map((comment,index)=><blockquote key={String(comment.id ?? index)}><p>{String(comment.text ?? '')}</p><footer>{String((comment.author as {name?:string})?.name ?? 'Viewer')} · {String(comment.likeCountText ?? 'recent')}</footer></blockquote>)}{!comments.length&&<p className='muted'>No comments returned.</p>}</div>;
}

function AnswerPanel({ answer }: { answer: Answer }) {
  return <section className='answer-panel'><div className='answer-mark'>✦</div><div><p className='eyebrow'>CITED SYNTHESIS</p><h2>Answer grounded in source moments</h2><div className='answer-copy'>{answer.answer}</div><div className='citations'>{answer.citations.map((citation)=><a key={citation.index} href={citation.entityId ? `https://youtube.com/watch?v=${citation.entityId}${citation.startMs !== undefined ? `&t=${Math.floor(citation.startMs/1000)}s` : ''}` : '#'} target='_blank' rel='noreferrer'><b>[{citation.index}]</b><span>{citation.text.slice(0,140)}…</span><time>{citation.startMs !== undefined ? formatTime(citation.startMs) : 'source'}</time></a>)}</div></div></section>;
}

function ProjectsView({ projects, onCreate }: { projects: Project[]; onCreate:()=>void }) {
  return <section className='content-section standalone'><div className='section-heading'><div><p className='eyebrow'>PRIVATE BY DEFAULT</p><h2>Projects turn watching into research</h2></div><button className='button primary' onClick={onCreate}>＋ New project</button></div><div className='project-grid'>{projects.map((project,index)=><article key={project.id}><span className={`project-color c${index%4}`}/><h3>{project.name}</h3><p>{project.description || 'Videos, transcript moments, notes, and cited intelligence.'}</p><footer><b>{project.item_count ?? 0} sources</b><button>Open project →</button></footer></article>)}{!projects.length&&<div className='big-empty'><strong>No projects yet</strong><p>Create one, then save videos, channels, playlists, and exact transcript moments.</p></div>}</div></section>;
}

function MonitorsView({ monitors }: { monitors: Monitor[] }) {
  return <section className='content-section standalone'><div className='section-heading'><div><p className='eyebrow'>HOURLY SIGNAL SCAN</p><h2>Know what changed without refreshing</h2></div><span>{monitors.length} active</span></div><div className='monitor-list'>{monitors.map((monitor)=><article key={monitor.id}><span className='pulse'/><div><small>{monitor.kind.toUpperCase()}</small><h3>{monitor.target}</h3><p>New uploads, keyword mentions, view velocity, and audience-theme changes.</p></div><div><b>{monitor.enabled ? 'Active' : 'Paused'}</b><small>{monitor.last_checked_at ? `Checked ${new Date(monitor.last_checked_at).toLocaleString()}` : 'First scan queued'}</small></div></article>)}{!monitors.length&&<div className='big-empty'><strong>No monitors yet</strong><p>Open a channel or source and choose Monitor.</p></div>}</div></section>;
}

function SignInDialog({ onClose }: { onClose:()=>void }) {
  const [email,setEmail]=useState(''); const [message,setMessage]=useState('');
  const magic=async(event:FormEvent)=>{event.preventDefault();const response=await fetch('/api/platform/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,callbackURL:'/'})});setMessage(response.ok?'Check your inbox for a secure sign-in link.':'Could not send the link.');};
  const google=async()=>{const response=await fetch('/api/platform/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'google',callbackURL:'/'})});const data=await response.json() as {url?:string};if(data.url)window.location.href=data.url;};
  return <div className='dialog-backdrop' onMouseDown={onClose}><div className='dialog' onMouseDown={(event)=>event.stopPropagation()}><button className='dialog-close' onClick={onClose}>×</button><p className='eyebrow'>WELCOME BACK</p><h2>Sign in to your research</h2><p>Projects, notes, monitors, and YouTube sync stay private to you.</p><button className='google-button' onClick={()=>void google()}>G&nbsp;&nbsp; Continue with Google</button><div className='or'><span/>or<span/></div><form onSubmit={magic}><input type='email' required value={email} onChange={(event)=>setEmail(event.target.value)} placeholder='you@example.com'/><button>Send magic link</button></form>{message&&<small className='dialog-message'>{message}</small>}</div></div>;
}

function NewProjectDialog({ onClose,onCreate }: { onClose:()=>void;onCreate:(name:string)=>void }) { const [name,setName]=useState('');return <div className='dialog-backdrop' onMouseDown={onClose}><form className='dialog' onMouseDown={(event)=>event.stopPropagation()} onSubmit={(event)=>{event.preventDefault();if(name.trim())onCreate(name.trim());}}><button type='button' className='dialog-close' onClick={onClose}>×</button><p className='eyebrow'>NEW PROJECT</p><h2>Name this line of inquiry</h2><input autoFocus value={name} onChange={(event)=>setName(event.target.value)} placeholder='e.g. AI video research'/><button className='button primary' disabled={!name.trim()}>Create project</button></form></div>; }

function evidenceToItem(result: Citation): SearchItem { return { type:'video',id:result.entityId??result.index.toString(),title:result.text,description:`Match score ${Math.round(result.score*100)}% · ${result.startMs!==undefined?formatTime(result.startMs):'source'}`,thumbnails:[] }; }
function formatTime(ms:number){const total=Math.floor(ms/1000);return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;}
function formatNumber(value:unknown){const number=Number(value);return Number.isFinite(number)?Intl.NumberFormat('en',{notation:'compact'}).format(number):'—';}
function highlight(value:string,query:string){if(!query.trim())return value;const parts=value.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'ig'));return parts.map((part,index)=>part.toLowerCase()===query.toLowerCase()?<mark key={index}>{part}</mark>:part);}

const featuredFallback: SearchItem[] = [
  {type:'video',id:'dQw4w9WgXcQ',title:'Search live YouTube data to begin',description:'Paste a video, channel, or playlist URL above.',thumbnails:[]},
  {type:'channel',id:'@GoogleDevelopers',name:'Channel intelligence',description:'Catalogs, publishing cadence, outliers, and gaps.',thumbnails:[]},
  {type:'playlist',id:'PL590L5WQmH8fJ54FqQOZ2g',title:'Playlist research',description:'Combined transcript search and learning paths.',thumbnails:[]},
];
