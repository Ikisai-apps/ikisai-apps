/* Bandejas (tanda 31, zona 3): las cuentas puras de «Por clasificar» (MUELA-057), del Reporte (MUELA-064 y 073) y de
   Etiquetas (MUELA-061). Sin DOM ni estado; probadas en tests/tasks/bandejas.test.ts.
   - urgencyOf(r, today): lo que urge de una petición: `tone` 'alert' (crítica o pasada su fecha), 'warn' (alta o para dentro
     de dos días como mucho) o null; `rank` (0, 1, 2) y los días que faltan (`days`, null sin fecha).
   - compareUrgency(a, b, today): primero lo que más urge, después la prioridad, la fecha y lo que llegó antes.
   - requestBands(requests, today): una banda por app que pide, ordenadas por su petición más urgente; dentro, cada tipo
     (ordenados igual) con sus peticiones. Cada banda dice cuántas trae y cuántas urgen.
   - reportStatus(request, task): 'pending', 'open', 'done', 'dismissed', 'deleted' o 'unknown'. Lo descartado y lo que está
     en la papelera nunca cuenta como resuelto (MUELA-073, «Estados del reporte»).
   - labelUsage(tasks): cuántas tareas abiertas lleva cada etiqueta (también como responsable); personUsage(tasks), lo mismo
     con las personas de Central (responsable y Personas). */
function urgencyOf(r,today){
  const prio=r.priority==='critical'?2:r.priority==='high'?1:0;
  const days=r.due?Math.round((Date.parse(r.due+'T12:00:00Z')-Date.parse(today+'T12:00:00Z'))/864e5):null;
  const tone=prio===2||(days!==null&&days<0)?'alert':prio===1||(days!==null&&days<=2)?'warn':null;
  return {tone,rank:tone==='alert'?0:tone==='warn'?1:2,prio,days}}
function compareUrgency(a,b,today){const x=urgencyOf(a,today),y=urgencyOf(b,today);
  return x.rank-y.rank||y.prio-x.prio||(x.days??1e9)-(y.days??1e9)||String(a.created_at||'').localeCompare(String(b.created_at||''))}
function requestBands(requests,today){const bySource=new Map();
  for(const r of [...requests].sort((a,b)=>compareUrgency(a,b,today))){
    const band=bySource.get(r.source)||{source:r.source,kinds:new Map(),items:[]};band.items.push(r);
    const kind=band.kinds.get(r.kind)||{kind:r.kind,label:null,items:[]};kind.items.push(r);kind.label=kind.label||r.kind_label||null;band.kinds.set(r.kind,kind);
    bySource.set(r.source,band)}
  return [...bySource.values()].map(b=>{const tones=b.items.map(r=>urgencyOf(r,today).tone);
    return {source:b.source,count:b.items.length,urgent:tones.filter(Boolean).length,tone:tones.includes('alert')?'alert':tones.includes('warn')?'warn':null,kinds:[...b.kinds.values()],items:b.kinds.size?[...b.kinds.values()].flatMap(k=>k.items):[]}})
    .sort((a,b)=>compareUrgency(a.items[0],b.items[0],today)||a.source.localeCompare(b.source))}
function reportStatus(request,task){
  if(request?.status==='dismissed')return 'dismissed';
  if(request?.status==='pending')return 'pending';
  if(task)return task.deleted_at||task.deleted?'deleted':task.done?'done':'open';
  if(request?.status==='routed')return 'open';
  return 'unknown'}
const REPORT_STAGES=[{key:'pending',label:'Recibido'},{key:'open',label:'En marcha'},{key:'done',label:'Resuelto'}];
const REPORT_TEXT={pending:'Recibido',open:'En marcha',done:'Resuelto',dismissed:'No lo vamos a hacer',deleted:'No lo vamos a hacer',unknown:'No lo encuentro'};
/* La etapa del recorrido: lo descartado y la papelera paran el recorrido (nunca «Resuelto»). */
function reportStage(status){return ['pending','open','done'].includes(status)?status:null}
function labelUsage(tasks){const out=new Map();
  for(const t of tasks){if(t.deleted||t.done)continue;for(const id of new Set([...(t.labels||[]),...(t.owner?[t.owner]:[])]))out.set(id,(out.get(id)||0)+1)}
  return out}
function personUsage(tasks){const out=new Map();
  for(const t of tasks){if(t.deleted||t.done)continue;for(const k of new Set([...(t.ownerPerson?[t.ownerPerson]:[]),...(t.people||[])]))out.set(k,(out.get(k)||0)+1)}
  return out}
