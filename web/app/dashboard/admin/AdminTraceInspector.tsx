'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  fetchAdminTrace,adminTraceListSchema,adminTraceRunSchema,adminTraceDetailSchema,
  type AdminTraceList,type AdminTraceRun,type AdminTraceDetail,
} from '../../../lib/admin-tool-traces';
import styles from './AdminTraceInspector.module.css';
import { platformFetch, platformResponseError } from '../../../lib/platform-request';

export default function AdminTraceInspector() {
  const [query,setQuery]=useState('');
  const [search,setSearch]=useState('');
  const [status,setStatus]=useState('');
  const [offset,setOffset]=useState(0);
  const [revision,setRevision]=useState(0);
  const [page,setPage]=useState<AdminTraceList>();
  const [runId,setRunId]=useState('');
  const [run,setRun]=useState<AdminTraceRun>();
  const [traceId,setTraceId]=useState('');
  const [detail,setDetail]=useState<AdminTraceDetail>();
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const [copied,setCopied]=useState(false);
  const [exporting,setExporting]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError('');setDetail(undefined);setCopied(false);
    const request=runId
      ? Promise.all([
          fetchAdminTrace(`/${runId}`,adminTraceRunSchema,controller.signal).then(value=>{if (!controller.signal.aborted) setRun(value);}),
          ...(traceId ? [fetchAdminTrace(`/${runId}/calls/${traceId}`,adminTraceDetailSchema,controller.signal).then(value=>{if (!controller.signal.aborted) setDetail(value);})] : []),
        ])
      : fetchAdminTrace(`?${new URLSearchParams({q:search,status,offset:String(offset)})}`,adminTraceListSchema,controller.signal).then(value=>{if (!controller.signal.aborted) setPage(value);});
    void request.catch(cause=>{if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load diagnostic traces.');})
      .finally(()=>{if (!controller.signal.aborted) setLoading(false);});
    return ()=>controller.abort();
  },[runId,traceId,search,status,offset,revision]);
  function submit(event:FormEvent) {event.preventDefault();setSearch(query.trim());setOffset(0);setRevision(value=>value+1);}
  function openRun(id:string) {setRun(undefined);setDetail(undefined);setTraceId('');setRunId(id);}
  async function downloadTrace() {
    setExporting(true);setError('');
    try {
      const response=await platformFetch(`/v1/admin/agent-traces/${runId}/export`,{cache:'no-store'});
      if (!response.ok) throw await platformResponseError(response,'Could not export this trace. Please try again.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;link.download=`agent-trace-${runId}.jsonl`;
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(cause) {setError(cause instanceof Error ? cause.message : 'Could not export this trace.');}
    finally {setExporting(false);}
  }
  return <section className={styles.inspector} aria-label='Agent tool traces'>
    <header className={styles.header}><div><h2>Agent tool traces</h2><p>Inspect tool arguments, results and failed attempts across agent runs.</p></div>
      <button onClick={()=>setRevision(value=>value+1)} disabled={loading}>Refresh traces</button></header>
    {error && <p role='alert' className='alert error'>{error}</p>}
    {!runId ? <>
      <form className={styles.filters} onSubmit={submit}>
        <label>Run, session or user ID<input value={query} onChange={event=>setQuery(event.target.value)} maxLength={200} placeholder='Paste an ID to find its traces' /></label>
        <label>Run status<select value={status} onChange={event=>{setStatus(event.target.value);setOffset(0);}}>
          <option value=''>All statuses</option>{['running','completed','failed','cancelled'].map(value=><option key={value} value={value}>{value}</option>)}
        </select></label><button type='submit' disabled={loading}>Search traces</button>
      </form>
      <div className={styles.runs} aria-busy={loading}>{page?.runs.map(item=><button key={item.runId} className={styles.run} onClick={()=>openRun(item.runId)}>
        <span><strong>{item.runId}</strong><small>User {item.userId}</small></span>
        <span>{item.status}<small>{item.callCount} attempts, {item.failedCalls} failed{item.captureFailures>0 ? `, ${item.captureFailures} storage failures` : ''}</small></span>
        <time>{new Date(item.startedAt).toLocaleString()}</time>
      </button>)}</div>
      {!loading && page?.runs.length===0 && <p>No traces found. Diagnostic capture starts with new runs after deployment.</p>}
      <nav className={styles.actions} aria-label='Trace pages'><button disabled={loading || offset===0} onClick={()=>setOffset(Math.max(0,offset-30))}>Previous</button>
        <button disabled={loading || page?.nextOffset==null} onClick={()=>setOffset(page!.nextOffset!)}>Next</button></nav>
    </> : <>
      <div className={styles.actions}><button onClick={()=>{setRunId('');setRun(undefined);setTraceId('');}}>All trace runs</button>
        <button onClick={downloadTrace} disabled={exporting}>{exporting ? 'Downloading…' : 'Download timeline JSONL'}</button></div>
      <h3 className={styles.identifier}>Run {runId}</h3>
      {run && <p className={styles.metadata}>User {run.userId} · Session {run.sessionId} · {run.status}</p>}
      <div className={styles.layout}>
        <ol className={styles.calls} aria-label='Tool call timeline'>{run?.calls.map(call=><li key={call.traceId}>
          <button className={traceId===call.traceId ? styles.selected : ''} onClick={()=>{setDetail(undefined);setTraceId(call.traceId);}}>
            <strong>{call.callSequence}. {call.name}</strong><span>{call.status} · attempt {call.attempt} · {call.source}</span>
            {call.finishedAt!==undefined && <small>{((call.finishedAt-call.startedAt)/1000).toFixed(2)} seconds</small>}
          </button></li>)}</ol>
        <div className={styles.payload}>
          {!traceId && <p>Select a tool call to inspect its saved payload.</p>}
          {detail && <>
            <div className={styles.header}><h3>{detail.name}</h3><button onClick={async()=>{
              try {await navigator.clipboard.writeText(JSON.stringify(detail,null,2));setCopied(true);}
              catch {setError('Could not copy the trace.');}
            }}>{copied ? 'Copied trace JSON' : 'Copy trace JSON'}</button></div>
            <p className={styles.metadata}>Call {detail.toolCallId} · {detail.status}</p>
            {detail.payloadState==='deleted' ? <p>Trace payloads were removed when session evidence or the account was deleted.</p> : <>
              {detail.payloadState==='unavailable' && <p role='alert'>Some payloads could not be saved or loaded. {detail.captureError}</p>}
              <h4>Input</h4><pre>{JSON.stringify(detail.input,null,2)}</pre>
              {detail.output!==undefined && <><h4>Output</h4><pre>{JSON.stringify(detail.output,null,2)}</pre></>}
              {detail.error && <><h4>Error</h4><pre>{JSON.stringify(detail.error,null,2)}</pre></>}
              {detail.status==='running' && <p>Awaiting a result. Refresh to load the latest state.</p>}
            </>}
          </>}
        </div>
      </div>
    </>}
    {loading && <p role='status'>Loading diagnostic traces…</p>}
  </section>;
}
