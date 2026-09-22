'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { useRouter } from 'next/navigation';
import { platformRequest as api,isAbortError } from '../../lib/platform-request';
import {useDashboardDraft} from './DashboardDataProvider';
import {Icon} from './DashboardSidebar';
import pageStyles from './DashboardPages.module.css';
import type {TrendReport,AiTrendPlan} from './research-types';
const YOUTUBE_API='/v1/providers/youtube';
const TREND_SAMPLE_SIZE=10;
export default function TrendLab() {
 const router=useRouter();
 const onInspect=(id:string)=>router.push(`/dashboard/sources?type=video&id=${encodeURIComponent(id)}`);
  const [topic, setTopic] = useDashboardDraft('trend-topic', '');
  const [report, setReport] = useDashboardDraft<TrendReport | null>('trend-report', null);
  const [aiPlan, setAiPlan] = useDashboardDraft<AiTrendPlan | null>('trend-ai-plan', null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestController = useRef<AbortController | null>(null);
  const planController = useRef<AbortController | null>(null);
  const topicInputRef = useRef<HTMLInputElement>(null);

  const runTopic = useCallback(async (value: string) => {
    const nextTopic = value.trim();
    if (!nextTopic) return;
    requestController.current?.abort();
    planController.current?.abort(); setAiLoading(false);
    const controller = new AbortController(); requestController.current = controller;
    setTopic(nextTopic); setLoading(true); setError(''); setAiPlan(null); setAiError('');
    try {
      setReport(await api<TrendReport>(`${YOUTUBE_API}/trends?q=${encodeURIComponent(nextTopic)}&limit=${TREND_SAMPLE_SIZE}&insights=deterministic`, { signal: controller.signal }));
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not research this topic.');
    } finally {
      if (requestController.current === controller) { requestController.current = null; setLoading(false); }
    }
  }, []);

  useEffect(() => () => { requestController.current?.abort(); planController.current?.abort(); }, []);

  const cancelTrend = () => {
    requestController.current?.abort(); requestController.current = null; setLoading(false);
  };

  const generatePlan = async () => {
    if (!report) return;
    planController.current?.abort();
    const controller = new AbortController(); planController.current = controller;
    setAiLoading(true); setAiError('');
    const planSignals = {
      provider: report.provider,
      query: report.query,
      sampleSize: report.sampleSize,
      summary: report.summary,
      videos: report.videos.map((video) => ({
        id: video.id, title: video.title, channel: video.channel.name,
        viewsPerHour: video.viewsPerHour, observedViewsPerHour: video.observedViewsPerHour,
        viewCount: video.viewCount, ageHours: video.ageHours,
        durationSeconds: video.durationSeconds, trendBand: video.trendBand,
      })),
      hashtags: report.hashtags,
      titlePatterns: report.titlePatterns,
      durationMix: report.durationMix,
    };
    try {
      setAiPlan(await api<AiTrendPlan>('/v1/trends/plan', { method: 'POST', body: JSON.stringify({ report: planSignals }), signal: controller.signal }));
    } catch (cause) {
      if (!isAbortError(cause)) setAiError(cause instanceof Error ? cause.message : 'Could not generate the AI plan.');
    } finally { if (planController.current === controller) setAiLoading(false); }
  };

  const maxVelocity = Math.max(...(report?.videos.map((video) => video.effectiveViewsPerHour) ?? [1]), 1);
  const measuredCount = report?.videos.filter((video) => video.signalSource === 'observed').length ?? 0;
  const maxDurationCount = Math.max(...(report?.durationMix.map((bucket) => bucket.videos) ?? [1]), 1);

  return <section className='trend-lab' data-report={Boolean(report)}>
    <header className='trend-command'>
      <div className={pageStyles.intro}><h2>Explore a topic</h2><p>Compare video performance and find patterns in a fresh sample.</p></div>
      <form className='trend-search' onSubmit={(event) => { event.preventDefault(); void runTopic(topic); }}>
        <label htmlFor='trend-topic'>Topic or niche</label><div><input id='trend-topic' ref={topicInputRef} value={topic} onChange={(event) => setTopic(event.target.value)} placeholder='e.g. AI coding agents' /><button disabled={loading || !topic.trim()}>{loading ? 'Scanning…' : 'Research topic'} <span aria-hidden='true'>→</span></button></div>
      </form>
    </header>
    <div className='trend-presets'><span>Try a topic</span>{['AI agents','Claude Code','faceless YouTube','personal finance'].map((preset) => <button key={preset} type='button' onClick={() => { setTopic(preset); topicInputRef.current?.focus(); }}>{preset}</button>)}</div>

    {error && <div className='trend-alert' role='alert'><span>{error}</span><button onClick={() => void runTopic(topic)}>Retry scan</button></div>}
    {loading && !report && <TrendLoading onCancel={cancelTrend} />}
    {!loading && !report && !error && <div className={pageStyles.emptyState}><span className={pageStyles.rowIcon}><Icon name='trend' size={21} /></span><div><h3>Your research starts here</h3><p>Choose a topic above to see its latest video signals.</p></div></div>}
    {report && <>
      {loading && <div className='trend-refresh-status' role='status' aria-live='polite'><span className='status-spinner' aria-hidden='true' /><div><strong>Refreshing the topic sample…</strong><small>The previous report remains visible.</small></div><button onClick={cancelTrend}>Cancel</button></div>}
      <div className='trend-report-head'><div><p className='panel-label'>Live sample · {report.sampleSize} videos</p><h3>{report.query}</h3></div><span>Updated {new Date(report.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div className='trend-kpis'>
        <article><span>Median views/hour</span><strong>{formatNumber(report.summary.medianViewsPerHour)}</strong><small>{measuredCount ? `${measuredCount} of ${report.sampleSize} measured` : 'all estimated from lifetime views'}</small></article>
        <article><span>Published this week</span><strong>{report.summary.publishedLast7Days}/{report.sampleSize}</strong><small>sampled videos</small></article>
        <article><span>Breakout signals</span><strong>{report.summary.breakoutCount}</strong><small>measured, relative to sample</small></article>
        <article><span>Recent vs established</span><strong>{report.summary.recentVelocityLift ? `${report.summary.recentVelocityLift.toFixed(2)}×` : '—'}</strong><small>{report.summary.recentVelocityLift ? `last ${report.window.days} days vs whole sample` : `nothing from the last ${report.window.days} days ranked`}</small></article>
      </div>

      <div className='trend-dashboard-grid'>
        <article className='trend-card velocity-card'>
          <div className='trend-card-head'><div><h4>Views/hour used for ranking</h4></div><span>{measuredCount ? `${measuredCount} measured, ${report.sampleSize - measuredCount} estimated` : 'all estimated'}</span></div>
          <div className='velocity-chart'>{report.videos.slice(0,6).map((video) => <button key={video.id} onClick={() => onInspect(video.id)} title={`${video.title} · ${video.signalSource === 'observed' ? 'measured between scans' : 'lifetime average'}`}><span>{video.title}</span><i><b style={{width:`${Math.max(4,(video.effectiveViewsPerHour/maxVelocity)*100)}%`}} /></i><strong>{formatNumber(video.effectiveViewsPerHour)}/h{video.signalSource === 'estimated' ? ' est.' : ''}</strong></button>)}</div>
        </article>

        <article className='trend-card scatter-card'>
          <div className='trend-card-head'><div><h4>Freshness × relative momentum</h4></div><span>Select a point to inspect</span></div>
          <div className='scatter-plot'><span className='axis-y'>More momentum</span><span className='axis-x'>Fresher →</span>{report.videos.map((video) => {
            const freshness = video.ageHours === undefined ? 10 : Math.max(5, 96 - Math.log10(video.ageHours + 1) * 29);
            const size = Math.max(12, Math.min(28, 12 + Math.log10(video.viewCount + 1) * 2.2));
            return <button key={video.id} aria-label={`${video.title}: ${formatNumber(video.effectiveViewsPerHour)} views per hour ${video.signalSource === 'observed' ? 'measured' : 'estimated'}, ${video.trendBand}`} className={`trend-dot ${video.trendBand.toLowerCase()}`} style={{left:`${freshness}%`,bottom:`${Math.max(8,video.trendScore * .78)}%`,width:size,height:size}} title={`${video.title} · ${formatNumber(video.effectiveViewsPerHour)} views/hour ${video.signalSource === 'observed' ? 'measured' : 'estimated'}`} onClick={() => onInspect(video.id)}><span>{video.title}</span></button>;
          })}</div>
          <div className='scatter-legend'><span><i className='breakout' />Breakout</span><span><i className='rising' />Rising</span><span><i className='steady' />Steady</span></div>
        </article>

        <article className='trend-card pattern-card'>
          <div className='trend-card-head'><div><h4>Video lengths</h4></div><span>{report.sampleSize} videos</span></div>
          <div className='duration-chart'>{report.durationMix.map((bucket) => <div key={bucket.label}><span>{bucket.label}</span><i><b style={{height:`${Math.max(4,(bucket.videos/maxDurationCount)*100)}%`}} /></i><strong>{bucket.videos}</strong><small>{formatNumber(bucket.averageViewsPerHour)}/h avg</small></div>)}</div>
        </article>

        <article className='trend-card hashtag-card'>
          <div className='trend-card-head'><div><h4>Observed hashtags & title terms</h4></div><span>Correlation, not causation</span></div>
          {report.hashtags.length ? <div className='hashtag-list'>{report.hashtags.slice(0,6).map((item) => <div key={item.tag}><strong>{item.tag}</strong><span>{item.videos} video{item.videos === 1 ? '' : 's'}</span><b>{item.lift ? `${item.lift.toFixed(1)}×` : '—'} velocity</b></div>)}</div> : <p className='no-hashtags'>No repeated hashtags in this sample.</p>}
          <div className='term-cloud'>{report.titlePatterns.slice(0,7).map((item, index) => <span key={item.term} style={{fontSize:`${11 + Math.max(0,4-index)}px`}}>{item.term}<small>{item.videos}</small></span>)}</div>
        </article>
      </div>

      <div className='trend-bottom-grid'>
        <article className='trend-leaders'>
          <div className='trend-card-head'><div><h4>Top videos in this sample</h4></div><span>Open any source</span></div>
          <div className='leader-list'>{report.videos.slice(0,5).map((video, index) => <button key={video.id} onClick={() => onInspect(video.id)}><span className='leader-rank'>{String(index+1).padStart(2,'0')}</span><div className='leader-thumb'>{video.thumbnails[0]?.url ? <img src={video.thumbnails[0].url} alt='' /> : <span>YT</span>}</div><div><strong>{video.title}</strong><small>{video.channel.name} · {video.publishedTimeText ?? video.publishDate ?? 'Published recently'}</small></div><span className={`signal-pill ${video.trendBand.toLowerCase()}`}>{video.trendBand}</span><div className='leader-metric'><strong>{formatNumber(video.effectiveViewsPerHour)}/h</strong><small>{video.signalSource === 'observed' ? 'measured' : 'lifetime avg'}</small></div></button>)}</div>
        </article>

        <aside className={`video-plan ${aiPlan ? 'ai-ready' : ''}`}>
          <div className='plan-head'><h3>Video brief</h3>{aiPlan && <span>AI generated</span>}</div>
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
            <p className='plan-explainer'>Generate an audience, hook, outline, and title ideas using this sample.</p>
            <button className='plan-generate' disabled={aiLoading} onClick={() => void generatePlan()}><span>✦</span>{aiLoading ? 'Building your plan…' : 'Generate brief'}</button>
            <div className='plan-detail'><span>SIGNAL-BASED LENGTH</span><strong>{report.plan.recommendedDurationSeconds ? formatDuration(report.plan.recommendedDurationSeconds) : 'Test 8–12 min'}</strong></div>
            <div className='plan-tags'><span>OBSERVED REPEATED HASHTAGS</span><div>{report.plan.observedHashtags.length ? report.plan.observedHashtags.map((tag) => <b key={tag}>{tag}</b>) : <small>No repeated hashtag signal</small>}</div></div>
          </>}
          {aiError && <p className='plan-error'>{aiError}</p>}
        </aside>
      </div>
      <details className={pageStyles.disclosure}><summary>Methodology</summary><p>{report.methodology}</p></details>
    </>}
  </section>;
}

function TrendLoading({ onCancel }: { onCancel: () => void }) {
  return <div className='trend-loading' role='status' aria-live='polite'><div className='loading-dots' aria-hidden='true'><i /><i /><i /></div><p><strong>Building a fresh topic sample…</strong><span>Comparing public video signals.</span></p><button onClick={onCancel}>Cancel scan</button></div>;
}

function formatNumber(value:unknown){const number=Number(value);return Number.isFinite(number)?Intl.NumberFormat('en',{notation:'compact'}).format(number):'—';}
function formatDuration(seconds:number){const minutes=Math.round(seconds/60);return minutes >= 60 ? `${Math.floor(minutes/60)}h ${minutes%60}m` : `${minutes} minutes`;}
