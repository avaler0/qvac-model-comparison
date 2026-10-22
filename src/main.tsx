import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './style.css';

type Status = 'checking' | 'available' | 'download' | 'partial' | 'downloading' | 'verifying' | 'local' | 'unknown';
type Model = { id: string; name: string; kind: 'registry' | 'local'; status: Status; size?: number; quantization?: string; assets?: {name:string;size:number;ready:boolean}[] };
type Metrics = { loadMs?: number; inferenceMs?: number; firstOutputMs?: number|null; inputTokens?: number; outputTokens?: number; sdkTokensPerSecond?: number;
  peakRss?: number; peakWorkerTreeRss?: number|null; totalMs?: number; sdkVersion?: string; backend?: string; device?: string; settings?: Record<string,number>; contextSize?: number; partial?: boolean };
type Panel = { state: string; text: string; metrics: Metrics; message?: string };
type Event = { type: string; runId?: string; panel?: 'A'|'B'; state?: string; text?: string; metrics?: Metrics; totalMs?: number; models?: Model[]; id?: string;
  status?: Status; downloaded?: number; total?: number; peakWorkerTreeRss?: number|null; message?: string };
type Bridge = { listModels():Promise<Model[]>; chooseLocal():Promise<Model|null>; download(id:string):Promise<boolean>; pauseDownload():Promise<void>;
  compare(request:{prompt:string;models:[string,string]}):Promise<string>; stop():Promise<void>; subscribe(callback:(event:Event)=>void):()=>void };
declare global { interface Window { qvac: Bridge } }
const emptyPanel = ():Panel => ({ state: 'ready', text: '', metrics: {} });
const statusText:Record<Status,string> = { checking:'Checking disk', available:'Available on disk', download:'Download required', partial:'Partial download',
  downloading:'Downloading', verifying:'Verifying', local:'Local file', unknown:'Availability unknown' };
const duration = (n?:number|null) => n == null || !Number.isFinite(n) ? 'Unavailable' : `${(n/1000).toFixed(2)} s`;
const count = (n?:number) => n == null ? 'Unavailable' : n.toLocaleString();
const bytes = (n?:number) => n == null ? 'Size unavailable' : `${(n/1e9).toFixed(2)} GB`;

function ModelPicker({ letter, models, selected, disabled, onSelect, onLocal, onDownload }:{letter:'A'|'B';models:Model[];selected:string;disabled:boolean;
  onSelect:(id:string)=>void;onLocal:()=>void;onDownload:(id:string)=>void}) {
  const [query,setQuery]=useState('');
  const [open,setOpen]=useState(false);
  const current=models.find(m=>m.id===selected);
  return <div className="picker">
    <label htmlFor={`search-${letter}`}>Model {letter}</label>
    <div className="picker-head">
      <button type="button" className="select-button" disabled={disabled} aria-expanded={open} aria-controls={`list-${letter}`} onClick={()=>setOpen(!open)}>
        <span>{current?.name ?? 'Choose a model'}</span><span aria-hidden="true">⌄</span>
      </button>
    </div>
    {current && <div className="model-meta">{current.quantization || 'GGUF'} · {bytes(current.size)} · <span className={`status ${current.status}`}>{statusText[current.status]}</span></div>}
    {open && <div className="picker-popover" id={`list-${letter}`}>
      <input id={`search-${letter}`} type="search" autoFocus placeholder="Search models" value={query} onChange={e=>setQuery(e.target.value)} aria-label={`Search models for panel ${letter}`}/>
      <div className="picker-list" role="listbox" aria-label={`Models for panel ${letter}`}>
        {models.filter(m=>m.name.toLowerCase().includes(query.toLowerCase())).map(m=><button type="button" role="option" aria-selected={selected===m.id} key={m.id}
          onClick={()=>{setOpen(false); if(m.status==='download'||m.status==='partial'||m.status==='unknown') onDownload(m.id); else onSelect(m.id)}}>
          <strong>{m.name}</strong><small>{m.quantization || 'GGUF'} · {bytes(m.size)} · {statusText[m.status]}</small>
        </button>)}
      </div>
      <button type="button" className="local-choice" onClick={()=>{setOpen(false);onLocal()}}>Choose local model file…</button>
    </div>}
  </div>;
}

function Output({ panel, letter }:{panel:Panel;letter:'A'|'B'}) {
  const box=useRef<HTMLDivElement>(null);
  const nearBottom=useRef(true);
  useEffect(()=>{if(nearBottom.current && box.current) box.current.scrollTop=box.current.scrollHeight},[panel.text]);
  const m=panel.metrics;
  return <>
    <div className="output-title"><span>Output</span><span className={`run-status ${panel.state}`} role="status">{panel.state === 'queued' ? 'Waiting for Model A to finish' : panel.state}</span></div>
    <div className="output" ref={box} tabIndex={0} aria-label={`Model ${letter} output`} onScroll={e=>{const el=e.currentTarget;nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<48}}>
      {panel.text ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({children})=><span>{children}</span>,img:()=>null}}>{panel.text}</ReactMarkdown>
        : <p className="placeholder">{panel.message || (panel.state==='queued'?'Waiting for Model A to finish': panel.state==='loading'?'Loading model…':panel.state==='generating'?'Generating…':'Output will appear here.')}</p>}
    </div>
    {panel.message && panel.text && <p className="error-text">{panel.message}</p>}
    <div className="metrics" aria-label={`Model ${letter} metrics`}>
      <div><small>First output</small><strong>{duration(m.firstOutputMs)}</strong></div>
      <div><small>SDK tokens/s</small><strong>{m.sdkTokensPerSecond == null || m.partial ? 'Unavailable' : m.sdkTokensPerSecond.toFixed(1)}</strong></div>
      <div><small>Inference</small><strong>{duration(m.inferenceMs)}</strong></div>
      <div><small>Output tokens</small><strong>{count(m.outputTokens)}</strong></div>
    </div>
    <details className="details"><summary>Run details</summary>
      <dl><dt>Load time</dt><dd>{duration(m.loadMs)}</dd><dt>Total model run</dt><dd>{duration(m.totalMs)}</dd>
        <dt>Input tokens</dt><dd>{count(m.inputTokens)}</dd><dt>Peak worker tree RSS</dt><dd>{m.peakWorkerTreeRss == null ? 'Unavailable' : `${(m.peakWorkerTreeRss/1e9).toFixed(2)} GB`}</dd>
        <dt>Backend</dt><dd>{m.backend||'Unavailable'}</dd><dt>Device</dt><dd>{m.device||'Unavailable'}</dd>
        <dt>SDK</dt><dd>{m.sdkVersion||'Unavailable'}</dd><dt>Context size</dt><dd>{count(m.contextSize)}</dd>
        <dt>Settings</dt><dd>{m.settings ? JSON.stringify(m.settings) : 'Unavailable'}</dd></dl>
      <p>First output measures visible text after submission. SDK tokens/s and token counts come from QVAC, including generated tokens that may not appear as text. Streamed chunks are never counted as tokens. Peak memory sums sampled process RSS for the worker and its native descendants every 250 ms on macOS; shared pages may be counted more than once.</p>
    </details>
  </>;
}

function App(){
  const [models,setModels]=useState<Model[]>([]);
  const [selected,setSelected]=useState<[string,string]>(['','']);
  const [prompt,setPrompt]=useState('');
  const [panels,setPanels]=useState<[Panel,Panel]>([emptyPanel(),emptyPanel()]);
  const [state,setState]=useState('idle');
  const [notice,setNotice]=useState('');
  const [transfer,setTransfer]=useState<{id:string;downloaded:number;total:number;status:Status}|null>(null);
  const runId=useRef<string|null>(null);
  const busy=['preflight','runningA','releasingA','runningB','releasingB','cancelling'].includes(state);
  const updatePanel=(letter:'A'|'B',change:(p:Panel)=>Panel)=>setPanels(previous=>{
    const next:[Panel,Panel]=[...previous]; const i=letter==='A'?0:1; next[i]=change(next[i]); return next;
  });
  useEffect(()=>{
    window.qvac.listModels().then(setModels).catch(e=>setNotice(String(e)));
    return window.qvac.subscribe(event=>{
      if(event.type==='catalog' && event.models) setModels(event.models);
      if(event.type==='notice') setNotice(event.message||'QVAC is unavailable.');
      if(event.type==='download' && event.id) {
        setTransfer(event.status==='available'||event.status==='partial'?null:{id:event.id,downloaded:event.downloaded||0,total:event.total||0,status:event.status||'downloading'});
        if(event.status) setModels(previous=>previous.map(model=>model.id===event.id?{...model,status:event.status!}:model));
        if(event.message) setNotice(event.message);
      }
      if(event.type==='comparison' && event.runId) {
        if(event.state==='preflight') runId.current=event.runId;
        if(runId.current!==event.runId) return;
        setState(event.state||'idle');
        if(event.message) setNotice(event.message);
        if(event.state==='runningA') updatePanel('A',p=>({...p,state:'loading'}));
        if(event.state==='runningB') updatePanel('B',p=>({...p,state:'loading'}));
        if(event.state==='cancelled') setPanels(ps=>ps.map(p=>['queued','loading','generating','unloading'].includes(p.state)?{...p,state:'cancelled',metrics:{...p.metrics,partial:true}}:p) as [Panel,Panel]);
        if(event.state==='failed') setPanels(ps=>ps.map(p=>p.state==='queued'?{...p,state:'error',message:'Comparison stopped during preflight.'}:p) as [Panel,Panel]);
      }
      if(!event.runId || event.runId!==runId.current || !event.panel) return;
      if(event.type==='panel') updatePanel(event.panel,p=>({...p,state:event.state||p.state,message:event.message||p.message}));
      if(event.type==='delta') updatePanel(event.panel,p=>({...p,text:p.text+(event.text||'')}));
      if(event.type==='metrics') updatePanel(event.panel,p=>({...p,metrics:{...p.metrics,...event.metrics}}));
      if(event.type==='total') updatePanel(event.panel,p=>({...p,metrics:{...p.metrics,totalMs:event.totalMs,peakWorkerTreeRss:event.peakWorkerTreeRss}}));
    });
  },[]);
  const choose=(letter:'A'|'B',id:string)=>setSelected(s=>letter==='A'?[id,s[1]]:[s[0],id]);
  const local=async(letter:'A'|'B')=>{try{const m=await window.qvac.chooseLocal();if(m)choose(letter,m.id)}catch(e){setNotice(String(e))}};
  const download=async(letter:'A'|'B',id:string)=>{try{const ok=await window.qvac.download(id);if(ok)choose(letter,id)}catch(e){setNotice(String(e))}};
  const compare=()=>{
    if(busy||transfer||!prompt.trim()||selected.some(id=>!['available','local'].includes(models.find(model=>model.id===id)?.status||'')))return;
    runId.current=null;setNotice('');setPanels([{...emptyPanel(),state:'queued'},{...emptyPanel(),state:'queued'}]);setState('preflight');
    window.qvac.compare({prompt,models:selected}).catch(e=>{setState('failed');setNotice(String(e))});
  };
  const clear=()=>{setPrompt('');setPanels([emptyPanel(),emptyPanel()]);setNotice('');setState('idle');runId.current=null};
  return <main>
    <header><div className="brand"><div><span className="eyebrow">QVAC / WORKSPACE</span><h1>Model Compare</h1></div></div><span className="phase">LLM · Phase 1</span></header>
    <section className="prompt-section"><div className="section-heading"><label htmlFor="prompt">Shared prompt</label><span>One prompt, two local models</span></div>
      <textarea id="prompt" value={prompt} onChange={e=>setPrompt(e.target.value)} disabled={busy||!!transfer} placeholder="Ask both models the same question…"
        onKeyDown={e=>{if(e.metaKey&&e.key==='Enter'){e.preventDefault();compare()}}}/>
      <div className="action-row"><p>Models run one at a time to avoid competing for memory and compute.</p><div className="actions">
        {busy ? <button className="stop" onClick={()=>window.qvac.stop()}>Stop</button> : <button className="clear" onClick={clear}>Clear</button>}
        <button className="primary" disabled={busy||!!transfer||!prompt.trim()||selected.some(id=>!['available','local'].includes(models.find(model=>model.id===id)?.status||''))} onClick={compare}>Compare <span className="shortcut">⌘↵</span></button>
      </div></div>
    </section>
    {notice&&<div className="notice" role="alert">{notice}</div>}
    {transfer&&<div className="transfer" role="status">{statusText[transfer.status]} · {bytes(transfer.downloaded)} / {bytes(transfer.total)}
      {transfer.status==='downloading'&&<button onClick={()=>window.qvac.pauseDownload()}>Pause</button>}</div>}
    <div className="comparison-grid">{(['A','B'] as const).map((letter,i)=><section className="model-card" key={letter}>
      <div className="card-top"><div className="panel-index">{letter}</div><ModelPicker letter={letter} models={models} selected={selected[i]} disabled={busy||!!transfer}
        onSelect={id=>choose(letter,id)} onLocal={()=>local(letter)} onDownload={id=>download(letter,id)}/></div>
      <Output letter={letter} panel={panels[i]}/>
    </section>)}</div>
    <footer>Sequential execution · Order A → B · Results stay in this window only</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
