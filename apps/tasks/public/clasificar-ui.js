/* «Por clasificar» por origen (MUELA-057, con el 073 y el 083; tanda 31, zona 3). Sustituye a la lista por tipo de
   inbox-ui.js (inboxView), que sigue siendo la base de todo lo demás: «Mover a…», las reglas y «Gestionar entradas».
   - Una banda por app que pide (renderGroups del kit, con su medallón), ordenadas por su petición más urgente, con cuántas
     trae y cuántas urgen (bandejas.js, requestBands y urgencyOf). Arriba, la banda «De fuera · Propuestas» (proposals-ui.js).
   - Dentro, cada tipo con su regla a la vista («Sin regla»), «Siempre a …» para la propietaria (abre la regla con el destino
     propuesto) y «✓ Clasificar las N».
   - Cada petición: título, de parte de quién (sin nombre de huésped), cuándo llegó, para cuándo, el espacio del que se avisa
     (space_id, hallazgo 8) y adónde va. ✓ la clasifica al momento en ese destino con «Deshacer» del kit
     (toastWithAction): la operación inversa es unrouteRequestOps(…, 'pending'), que la devuelve aquí y manda su tarea a la
     papelera; volver a clasificarla la trae de allí. «Mover a…» y «Descartar» (con «Deshacer») siguen.
   - Sin la referencia «R…» a la vista (PERDIDAS §1): sigue en la ficha de la tarea y en «Abrir en …».
   - Se conservan: «Gestionar entradas», la regla nueva, «Quitar regla», «Mover también las que esperaban», el aviso de los
     retiros, «Abrir en <app>», el responsable de Central en «Mover a…» y solo para quien tiene la app entera.
   Prefijo de clases: `tkc-`. */
const TKC_BEHALF={guest:'De parte de un huésped',organizer:'De parte de una organizadora',internal:'De parte de alguien de la casa'};
function tkcToday(){return typeof isoDay==='function'?isoDay(0):new Date().toISOString().slice(0,10)}
function tkcHtml(node){const box=document.createElement('div');box.append(node);return box.innerHTML}
/* Adónde va al tocar ✓: lo que propone quien pide (si sigue vivo), lo que propone la estructura acordada (suggestedDestination)
   o la Entrada del área actual. */
function tkcDestination(r){const projects=inboxRows('tasks.projects'),tabs=inboxRows('tasks.tabs');
  const live=p=>p&&p.status!=='archived'&&tabs.some(t=>t.id===p.tab_id);
  const inboxOf=tabId=>projects.find(p=>p.tab_id===tabId&&p.system==='inbox');
  let p=r.suggested_project_id?projects.find(x=>x.id===r.suggested_project_id):null;
  if(!live(p)&&r.suggested_tab_id)p=inboxOf(r.suggested_tab_id);
  if(!live(p)){const s=suggestedDestination(r.kind);p=s?(s.project_id?projects.find(x=>x.id===s.project_id):inboxOf(s.tab_id)):null}
  if(!live(p))p=inboxOf(tab()?.id);
  if(!live(p))return null;
  const t=tabs.find(x=>x.id===p.tab_id);return {project_id:p.id,name:`${t?.name||''} › ${p.system==='inbox'?'Entrada':p.title}`}}
function tkcBehalf(r){if(r.on_behalf_of?.kind)return TKC_BEHALF[r.on_behalf_of.kind]||null;
  const m=r.requested_by?(Sync.members||[]).find(x=>x.userId===r.requested_by&&(x.kind||'human')==='human'):null;return m?.displayName?`De parte de ${m.displayName}`:null}
function tkcSpace(r){if(!r.space_id||typeof spaceById!=='function'||!spaceById(r.space_id))return null;return spaceShort(r.space_id)}
function tkcWhen(r){const today=tkcToday(),u=urgencyOf(r,today);if(!r.due)return null;const d=fmtDate(r.due);
  return u.days<0?`Para el ${d} · pasó su fecha`:u.days===0?'Para hoy':u.days===1?'Para mañana':`Para el ${d}`}
function tkcRow(r,head){const dest=tkcDestination(r),u=urgencyOf(r,tkcToday()),arrived=r.created_at?IkisaiKit.relativeTime(r.created_at,new Date()):'';
  const meta=[tkcBehalf(r),arrived?`llegó ${arrived}`:'',tkcWhen(r)].filter(Boolean),space=tkcSpace(r);
  const li=document.createElement('li');li.className='tkc-item';
  li.innerHTML=`<div class="ikisai-legacy">${head||''}<div class="pcard tkc-row" data-request-row="${r.id}" data-tkc-tone="${u.tone||'none'}">
    <span class="phead"><strong>${esc(r.title)}</strong>${r.priority!=='normal'?priorityStar(r.priority):''}${u.tone==='alert'?'<span class="pstate alert">Urge</span>':u.tone==='warn'?'<span class="pstate pending">Pronto</span>':''}</span>
    ${meta.length?`<span class="pmeta">${meta.map(esc).join(' · ')}</span>`:''}
    ${space?`<span class="pmeta tkc-space" data-request-space="${esc(r.space_id)}">Sitio: ${esc(space)}</span>`:''}
    <span class="pmeta tkc-dest">${dest?`Va a <strong>${esc(dest.name)}</strong>`:'Sin destino propuesto: elige con «Mover a…»'}${r.external_url?` · <a href="${esc(r.external_url)}" target="_blank" rel="noopener" data-feedback-id="tasks.por_clasificar.lista.abrir_origen" data-feedback-label="Abrir en la app de origen">Abrir en ${esc(appName(r.source))}</a>`:''}</span>
    <div class="pactions tkc-actions">${dest?`<button class="primary small tkc-classify" data-request-classify="${r.id}" type="button" aria-label="Clasificar «${esc(r.title)}» en ${esc(dest.name)}" data-feedback-id="tasks.por_clasificar.lista.clasificar" data-feedback-label="Clasificar en el destino propuesto">✓ Clasificar</button>`:''}<button class="softbtn small" data-request-move="${r.id}" type="button" data-feedback-id="tasks.por_clasificar.lista.mover" data-feedback-label="Mover petición a…">Mover a…</button><button class="ghost small" data-request-dismiss="${r.id}" type="button" aria-label="Descartar «${esc(r.title)}»" data-feedback-id="tasks.por_clasificar.lista.descartar" data-feedback-label="Descartar petición">✕ Descartar</button></div></div></div>`;
  return li}
/* Cabecera de cada tipo dentro de su banda: la regla a la vista, «Siempre a …» y «✓ Clasificar las N». */
function tkcKindHead(kind){const data=Sync.core.data,route=R().routeFor(data,kind.kind),items=kind.items,dests=items.map(tkcDestination),same=dests.every(d=>d&&d.name===dests[0]?.name);
  const suggestion=suggestedDestination(kind.kind),sugName=suggestion?(()=>{const t=inboxRows('tasks.tabs').find(x=>x.id===suggestion.tab_id),p=suggestion.project_id?inboxRows('tasks.projects').find(x=>x.id===suggestion.project_id):null;return `${t?.name||''}${p?' › '+p.title:''}`})():null;
  return `<div class="inboxgroup tkc-kind" data-tkc-kind="${esc(kind.kind)}"><h2 class="sectionlabel">${esc(kindName(kind.kind,kind.label))} <span class="count">${items.length}</span> <span class="pstate ${route?'':'pending'}">${route?'Con regla, sin aplicar':'Sin regla'}</span></h2>
    <div class="tkc-kindactions">${canManageRoutes()?`<button class="linkbtn small" data-route-new="${esc(kind.kind)}" type="button" data-feedback-id="tasks.por_clasificar.grupo.crear_regla" data-feedback-label="Siempre a… (crear regla para este tipo)">${route?'Ver la regla':sugName?`Siempre a ${esc(sugName)}…`:'Siempre a…'}</button>`:''}${items.length>1&&dests.every(Boolean)?`<button class="softbtn small" data-classify-kind="${esc(kind.kind)}" type="button" data-feedback-id="tasks.por_clasificar.grupo.clasificar_todas" data-feedback-label="Clasificar todas las de este tipo">✓ Clasificar las ${items.length}${same?` en ${esc(dests[0].name)}`:''}</button>`:''}</div></div>`}
function tkcBands(){const today=tkcToday(),bands=requestBands(R().pendingRequests(Sync.core.data),today),K=IkisaiKit;
  if(!bands.length)return '';
  const heads=new Map();for(const b of bands)for(const k of b.kinds)heads.set(k.items[0].id,k);
  const view=K.renderGroups({label:'Peticiones por app',feedbackId:'tasks.por_clasificar.bandas',
    groups:bands.map(b=>({key:b.source,title:appName(b.source),medal:{name:appName(b.source)},items:b.items,open:true,feedbackId:'tasks.por_clasificar.banda',
      summary:`${b.count===1?'1 petición':`${b.count} peticiones`} · ${b.urgent?(b.urgent===1?'1 urge':`${b.urgent} urgen`):'nada urgente'}`})),
    toneOf:r=>urgencyOf(r,today).tone,row:r=>tkcRow(r,heads.has(r.id)?tkcKindHead(heads.get(r.id)):'')});
  view.element.classList.add('tkc-bands');return `<div class="ikisai-kit tkc-wrap">${tkcHtml(view.element)}</div>`}
inboxView=function(){listenInbox();
  if(!canTriage())return `<main class="screen"><h1 class="title">Por clasificar</h1><div class="notice">Las peticiones de otras apps las clasifica quien tiene acceso a toda la app.</div></main>`;
  const bands=tkcBands();
  return `<main class="screen inbox tkc-screen"><div class="screenhead"><div><h1 class="title">Por clasificar</h1><p class="subtitle">Lo que piden otras apps, por app y lo más urgente primero</p></div>${canManageRoutes()?'<button class="softbtn" id="manageRoutes" type="button" data-feedback-id="tasks.por_clasificar.gestionar_entradas" data-feedback-label="Gestionar entradas">Gestionar entradas</button>':''}</div>
    ${canManageRoutes()&&!R().routeFor(Sync.core.data,'booking.retreat_project')?'<div class="notice" id="retreatRouteMissing" data-feedback-id="tasks.por_clasificar.aviso_retiros" data-feedback-label="Falta el área de los retiros">Falta elegir el área de los proyectos de retiro: hasta entonces, Booking no puede crearlos. <button class="linkbtn" type="button" data-route-new="booking.retreat_project">Elegir el área</button></div>':''}
    ${bands||'<div class="empty">Nada por clasificar. Lo que pidan otras apps sin regla de entrada aparecerá aquí.</div>'}</main>`};

/* ✓: crea la tarea en su destino al momento; «Deshacer» la devuelve a «Por clasificar» (y la tarea, a la papelera). */
function tkcClassify(ids){const plan=[];
  for(const id of ids){const r=inboxRows('tasks.requests').find(x=>x.id===id&&x.status==='pending'),d=r&&tkcDestination(r);if(d)plan.push({id,d})}
  if(!plan.length)return ids.length===1?moveRequestSheet(ids[0]):toast('Elige el destino con «Mover a…».');
  const ok=purchaseRun(data=>{let working=data;const ops=[];
    for(const {id,d} of plan){const batch=R().classifyRequestOps(working,id,{project_id:d.project_id});ops.push(...batch);
      // Las posiciones siguientes cuentan con las tareas que ya entran en este lote (como routeWaitingOps).
      const ins=batch.find(o=>o.table==='tasks.tasks'&&o.op==='insert');if(ins)working={...working,'tasks.tasks':[...working['tasks.tasks'],{id:ins.id,...ins.fields,deleted_at:null,revision:0}]}}
    return ops},null);
  if(!ok)return;usage.track(plan.length===1?'tasks.por_clasificar.clasificar':'tasks.por_clasificar.clasificar_todas');
  const names=[...new Set(plan.map(x=>x.d.name))];
  IkisaiKit.toastWithAction(plan.length===1?`Tarea creada en ${names[0]}`:`${plan.length} tareas creadas${names.length===1?` en ${names[0]}`:''}`,{label:'Deshacer',onClick:()=>{
    purchaseRun(data=>plan.flatMap(({id})=>{try{return R().unrouteRequestOps(data,id,'pending')}catch{return []}}),plan.length===1?'Vuelve a «Por clasificar».':'Vuelven a «Por clasificar».')}},UNDO_MS)}
function tkcDismiss(id){const r=inboxRows('tasks.requests').find(x=>x.id===id);
  if(!purchaseRun(data=>R().dismissRequestOps(data,id),null))return;usage.track('tasks.por_clasificar.descartar');
  IkisaiKit.toastWithAction(`Descartada${r?`: «${r.title}»`:''}. La app que la pidió lo verá.`,{label:'Deshacer',onClick:()=>purchaseRun(data=>R().reopenRequestOps(data,id),'Vuelve a «Por clasificar».')},UNDO_MS)}
const bindBeforeClasificar=bind;
bind=function(){bindBeforeClasificar();if(state.view!=='triage')return;
  document.querySelectorAll('[data-request-classify]').forEach(b=>b.onclick=()=>tkcClassify([b.dataset.requestClassify]));
  document.querySelectorAll('[data-classify-kind]').forEach(b=>b.onclick=()=>tkcClassify(R().pendingRequests(Sync.core.data,b.dataset.classifyKind).map(r=>r.id)));
  document.querySelectorAll('[data-request-dismiss]').forEach(b=>b.onclick=()=>tkcDismiss(b.dataset.requestDismiss))};
