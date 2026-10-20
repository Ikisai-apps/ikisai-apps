/* Proyectos · la cuenta única (MUELA-041, hallazgo 8; tanda 31): la misma regla para las portadas de Proyectos, la ficha de
   un proyecto («Foco») y el tablero. Funciones puras (sin DOM ni estado), probadas en tests/tasks/project-stats.test.ts.
   - whenOf(p, t, today): en qué punto está una tarea: 'hecha', 'vencida', 'hoy', 'manana', 'semana' (7 días o menos), 'luego'
     o 'sinfecha'. Una hija sin fecha toma la de su madre; una madre sin fecha, la más cercana de sus hijas pendientes. Así,
     una madre vencida es vencida aunque sus hijas no tengan fecha.
   - projectStats(p, today): pendientes (las hojas por hacer, como siempre), vencidas (las tareas RAÍZ vencidas: cada una
     cuenta una vez), % hecho, días hasta la fecha del proyecto, pausado, Entrada y la cola de raíces por hacer, de más a
     menos urgente (vencidas, hoy, mañana, semana, luego, sin fecha; a igual punto, la fecha y su orden).
   - healthOf(s): 'entrada', 'pausa', 'atencion' (con vencidas o pasada su fecha), 'semana' (vence en 7 días o menos),
     'hecho' o 'marcha'.
   - attentionOrder(list, pinnedId): la Entrada, después el fijado y el resto por atención y fecha; a igualdad, el orden de
     siempre (el que se cambia arrastrando u ordenando). `list`: [{ stats, order }]. */
const PS_WHEN_RANK={vencida:0,hoy:1,manana:2,semana:3,luego:4,sinfecha:5,hecha:9};
const PS_HEALTH_RANK={entrada:-2,atencion:0,semana:1,marcha:2,hecho:3,pausa:4};
/* Días enteros de `a` a `b` (AAAA-MM-DD), en el calendario; null si alguna no es una fecha. */
function psDaysBetween(a,b){const pa=String(a||'').slice(0,10).split('-').map(Number),pb=String(b||'').slice(0,10).split('-').map(Number);
  if(pa.length!==3||pb.length!==3||pa.some(n=>!Number.isFinite(n))||pb.some(n=>!Number.isFinite(n)))return null;
  return Math.round((Date.UTC(pb[0],pb[1]-1,pb[2])-Date.UTC(pa[0],pa[1]-1,pa[2]))/86400000)}
function psLive(p){return (p?.tasks||[]).filter(t=>!t.deleted)}
function psKids(p,id){return psLive(p).filter(t=>t.parentId===id)}
function psDone(p,t){const kids=psKids(p,t.id);return kids.length?kids.every(k=>!!k.done):!!t.done}
/* La fecha que cuenta: la suya; si no tiene, la de su madre (hija) o la más cercana de sus hijas pendientes (madre). */
function psDueOf(p,t){if(t.due)return t.due;const kids=psKids(p,t.id);
  if(kids.length)return kids.filter(k=>!k.done&&k.due).map(k=>k.due).sort()[0]||'';
  const mother=t.parentId?psLive(p).find(x=>x.id===t.parentId):null;return mother?.due||''}
function whenOf(p,t,today){if(psDone(p,t))return 'hecha';const due=psDueOf(p,t);if(!due)return 'sinfecha';const d=psDaysBetween(today,due);
  if(d==null)return 'sinfecha';if(d<0)return 'vencida';if(d===0)return 'hoy';if(d===1)return 'manana';return d<=7?'semana':'luego'}
function projectStats(p,today){const live=psLive(p),ids=new Set(live.map(t=>t.id));
  const leaves=live.filter(t=>!live.some(c=>c.parentId===t.id)),open=leaves.filter(t=>!t.done).length,total=leaves.length;
  const roots=live.filter(t=>!t.parentId||!ids.has(t.parentId)).map(t=>({t,when:whenOf(p,t,today)}));
  const queue=roots.filter(r=>r.when!=='hecha').sort((a,b)=>PS_WHEN_RANK[a.when]-PS_WHEN_RANK[b.when]||String(psDueOf(p,a.t)||'9999').localeCompare(String(psDueOf(p,b.t)||'9999'))||(a.t.order||0)-(b.t.order||0));
  return {id:p.id,total,open,done:total-open,pct:total?Math.round(100*(total-open)/total):0,late:roots.filter(r=>r.when==='vencida').length,
    due:p.due||'',dueIn:p.due?psDaysBetween(today,p.due):null,paused:p.status==='paused',inbox:p.system==='inbox',
    queue:queue.map(r=>r.t),whenOf:Object.fromEntries(roots.map(r=>[r.t.id,r.when]))}}
function healthOf(s){if(s.inbox)return 'entrada';if(s.paused)return 'pausa';
  if(s.open&&(s.late||(s.dueIn!=null&&s.dueIn<0)))return 'atencion';
  if(s.open&&s.dueIn!=null&&s.dueIn<=7)return 'semana';
  if(!s.open&&s.total)return 'hecho';return 'marcha'}
function attentionOrder(list,pinnedId){const key=x=>x.stats.inbox?-3:x.stats.id===pinnedId?-2:PS_HEALTH_RANK[healthOf(x.stats)];
  return [...list].sort((a,b)=>key(a)-key(b)||(a.stats.dueIn??9999)-(b.stats.dueIn??9999)||(a.order||0)-(b.order||0))}
