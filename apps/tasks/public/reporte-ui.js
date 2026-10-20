/* Reporte de Feedback como resguardo (MUELA-064, con el 073; tanda 31, zona 3): `#/feedback/<código>` enseña una tarjeta con
   el título, el estado en palabras y el recorrido del kit (renderStages, en lugar de la barra tocable de 064):
   Recibido · En marcha · Resuelto. Lo descartado y lo que está en la papelera paran el recorrido con «No lo vamos a hacer» y
   nunca salen como «Resuelto» (bandejas.js, reportStatus y reportStage).
   - Quien puede (la app entera para lo de la petición; editar, para la tarea) toca una etapa y el estado cambia con «Deshacer»:
     Recibido → En marcha abre «Mover a…»; En marcha ⇄ Resuelto marca o reabre la tarea (toggleTask, con su «Deshacer» y el
     «Confirmar consumo» de siempre); En marcha → Recibido y «No lo vamos a hacer» quitan la tarea con
     unrouteRequestOps(…, 'pending' | 'dismissed'); «Recuperar» vuelve a Recibido. Lo imposible se explica.
   - Datos: quién avisa (sin nombre), llegó, va a, lo lleva (medallón), para y el sitio. Tocar la tarjeta abre la tarea, o
     «Mover a…» si está por clasificar. El lápiz edita ahí mismo «Para» y «Va a» (con «Deshacer»); «Lo lleva», en la ficha.
   - El icono de enlace copia el enlace; el código no se ve (PERDIDAS §1). Se conserva «En la papelera» (§3).
   - El lector no recibe las peticiones: si no hay tarea, «No lo encuentro», nunca «No hay ninguna tarea tuya enlazada».
   - «Ver la tarea» de las propuestas (`#/tarea/<id>`) se abre aquí también.
   Prefijo de clases: `tkr-`. */
const TKR_BEHALF={guest:'Un huésped',organizer:'Una organizadora',internal:'Alguien de la casa'};
let tkrEditing=false;
function tkrFind(code){const data=Sync.core?.data||{},ref='feedback:'+code;
  const request=(data['tasks.requests']||[]).find(r=>!r.deleted_at&&(r.external_ref===ref||r.on_behalf_of?.report_code===code))||null;
  const tasks=(data['tasks.tasks']||[]).filter(t=>t.external_ref===ref||(request&&t.id===request.id));
  return {request,task:tasks.find(t=>!t.deleted_at)||tasks[0]||null}}
function tkrRow(table,id){return id?(Sync.core?.data?.[table]||[]).find(r=>r.id===id&&!r.deleted_at)||null:null}
function tkrWhere(task){if(!task)return null;const t=tkrRow('tasks.tabs',task.tab_id),p=tkrRow('tasks.projects',task.project_id);return `${t?.name||''} › ${p?.system==='inbox'?'Entrada':p?.title||''}`}
function tkrOwner(task){if(!task)return null;
  if(task.owner_person_id&&typeof fichaPersonName==='function'&&fichaPersonName(task.owner_person_id))return {key:task.owner_person_id,name:fichaPersonName(task.owner_person_id)};
  const l=tkrRow('tasks.labels',task.owner_label_id);if(l)return {key:l.id,name:l.name};
  if(task.owner_house_level)return {key:null,name:{direccion:'Dirección',staff:'Staff',outsider:'Gente de fuera'}[task.owner_house_level]||task.owner_house_level};
  return null}
function tkrSpace(request,task){const ids=[request?.space_id,...((Sync.core?.data?.['tasks.task_spaces']||[]).filter(s=>task&&s.task_id===task.id&&!s.deleted_at).map(s=>s.space_id))].filter(Boolean);
  const id=ids.find(x=>typeof spaceById==='function'&&spaceById(x));return id?spaceShort(id):null}
function tkrCanRequest(){return typeof canTriage==='function'&&canTriage()}
function tkrCanTask(task){return !!task&&!task.deleted_at&&canEdit()}
function tkrDate(iso){try{return new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(iso))}catch{return iso}}

feedbackView=function(){const code=state.feedbackCode||'',{request,task}=tkrFind(code),status=reportStatus(request,task),K=IkisaiKit;
  const offline=navigator.onLine?'':'<div class="notice tkr-offline">Sin conexión: es la última copia que hay en este dispositivo.</div>';
  const copy=`<button class="iconbtn tkr-copy" type="button" data-tkr-copy aria-label="Copiar el enlace del reporte" data-feedback-id="tasks.reporte.copiar_enlace" data-feedback-label="Copiar el enlace del reporte"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg></button>`;
  if(status==='unknown')return `<main class="screen tkr-screen"><div class="screenhead"><div><h1 class="title">Reporte</h1><p class="subtitle">${REPORT_TEXT.unknown}</p></div>${copy}</div>${offline}
    <div class="notice tkr-unknown">No lo encuentro en este dispositivo. ${tkrCanRequest()?'Puede que aún no haya llegado: prueba a sincronizar.':'Puede que aún esté por clasificar: eso lo ve quien clasifica las peticiones.'}</div></main>`;
  const canReq=tkrCanRequest(),canTask=tkrCanTask(task),pickable=(canReq&&!!request)||canTask,stage=reportStage(status);
  const stages=K.renderStages({label:'Seguimiento del reporte',stages:REPORT_STAGES,current:stage,stopText:'No lo vamos a hacer.',caption:stage==='done'?'Resuelto.':null,...(pickable?{onPick:()=>{}}:{}),feedbackId:'tasks.reporte.recorrido'});
  const owner=tkrOwner(task),where=tkrWhere(task),space=tkrSpace(request,task),due=task?.due||request?.due||null,behalf=TKR_BEHALF[request?.on_behalf_of?.kind||task?.external_on_behalf]||null;
  const arrived=request?.created_at||task?.created_at||null,kind=request?(kindName(request.kind,request.kind_label)):task?.external_kind?kindName(task.external_kind,null):null;
  const face=owner?.key&&typeof fichaFace==='function'?fichaFace(owner.key,null):null;
  const facts=[
    ['Quién avisa',behalf?esc(behalf):'—'],['Llegó',arrived?esc(tkrDate(arrived)):'—'],['Tipo',kind?esc(kind):'—'],
    ['Va a',where?esc(where):'Por clasificar'],['Lo lleva',owner?`${face?`<span class="ikisai-kit tkr-face">${tkcHtml(K.renderMedal({...face,size:28}))}</span>`:''}<span>${esc(owner.name)}</span>`:'Sin responsable'],
    ['Para',due?esc(fmtDate(due)):'Sin fecha'],...(space?[['Sitio',esc(space)]]:[])];
  const title=request?.title||task?.title||'Reporte',note=request?.note||task?.note||'';
  const tone=status==='done'?'approved':status==='pending'?'pending':status==='open'?'':'trash';
  const actions=[];
  if(canReq&&request&&status==='pending')actions.push(`<button class="ghost danger-text" type="button" data-tkr-action="dismiss" data-feedback-id="tasks.reporte.descartar" data-feedback-label="No lo vamos a hacer">No lo vamos a hacer</button>`);
  if(canReq&&request&&status==='open'&&task&&!task.parent_id)actions.push(`<button class="ghost danger-text" type="button" data-tkr-action="dismiss" data-feedback-id="tasks.reporte.descartar" data-feedback-label="No lo vamos a hacer">No lo vamos a hacer</button>`);
  if(canReq&&request&&status==='dismissed')actions.push(`<button class="softbtn" type="button" data-tkr-action="recover" data-feedback-id="tasks.reporte.recuperar" data-feedback-label="Recuperar el reporte">Recuperar</button>`);
  const edit=canTask?`<button class="iconbtn tkr-edit" type="button" data-tkr-edit aria-pressed="${tkrEditing}" aria-label="${tkrEditing?'Terminar de editar':'Editar «Va a» y «Para»'}" data-feedback-id="tasks.reporte.editar" data-feedback-label="Editar el reporte">✎</button>`:'';
  const projects=canTask?inboxRows('tasks.projects').filter(p=>p.tab_id===task.tab_id&&p.status!=='archived').sort((a,b)=>(a.system==='inbox'?-1:b.system==='inbox'?1:(a.position||0)-(b.position||0))):[];
  const editor=canTask&&tkrEditing?`<div class="tkr-editor" id="tkrEditor">
      <label class="field"><span>Va a</span><select id="tkrProject" data-feedback-id="tasks.reporte.editar.va_a" data-feedback-label="Va a (proyecto)">${projects.map(p=>`<option value="${p.id}" ${p.id===task.project_id?'selected':''}>${esc(p.system==='inbox'?'Entrada del área':p.title)}</option>`).join('')}</select></label>
      <label class="field"><span>Para</span><input type="date" id="tkrDue" value="${esc(task.due||'')}" data-feedback-id="tasks.reporte.editar.para" data-feedback-label="Para (fecha)"></label>
      <button class="softbtn small" type="button" data-tkr-owner data-feedback-id="tasks.reporte.editar.lo_lleva" data-feedback-label="Cambiar quién lo lleva">Cambiar quién lo lleva…</button></div>`:'';
  return `<main class="screen tkr-screen"><div class="screenhead"><div><p class="eyebrow tkr-eyebrow">Reporte${behalf?' · '+esc(behalf.toLowerCase()):''}</p><h1 class="title">${esc(title)}</h1></div><div class="tkr-tools">${edit}${copy}</div></div>${offline}
    <article class="tkr-card" data-tkr-status="${status}">
      <p class="tkr-state"><span class="pstate ${tone}" id="tkrState">${REPORT_TEXT[status]}</span>${task?.deleted_at?'<span class="pstate trash">En la papelera</span>':''}</p>
      <div class="tkr-stages ikisai-kit">${tkcHtml(stages)}</div>
      ${!pickable?'<p class="small muted tkr-readonly">Puedes ver cómo va. Lo cambian quienes clasifican o llevan la tarea.</p>':''}
      <button type="button" class="tkr-open" data-tkr-open data-feedback-id="tasks.reporte.abrir_tarea" data-feedback-label="Abrir la tarea del reporte">${note?`<span class="tkr-note">${esc(note)}</span>`:''}<span class="tkr-openlabel">${task&&!task.deleted_at?'Abrir la tarea':status==='pending'&&canReq?'Elegir adónde va…':task?'Ver la tarea':''}</span></button>
      <dl class="tkr-facts">${facts.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      ${editor}
      ${actions.length?`<div class="actions tkr-actions">${actions.join('')}</div>`:''}
    </article>
    <section class="tkr-gap" aria-label="Lo que contó quien informó"><h2 class="sectionlabel">Lo que contó quien informó</h2><p class="small muted">Aquí se verá lo que escribió quien avisó (con sus fotos) cuando Feedback lo comparta con Tasks.</p></section></main>`};

/* --- Cambiar el estado desde el reporte -------------------------------------------------------------------------- */
function tkrToggle(task){if(!tkrCanTask(task))return toast('Tu acceso es de solo lectura.');withArea(task.tab_id,()=>toggleTask(task.id))}
function tkrClassifyBack(id,prev){return purchaseRun(data=>R().classifyRequestOps(data,id,prev),null)}
function tkrUnroute(request,task,to){if(!tkrCanRequest())return toast('Eso lo hace quien clasifica las peticiones.');
  if(task.parent_id)return toast('Esa tarea ya es parte de otra: quítala desde allí.');
  const prev={project_id:task.project_id,owner_label_id:task.owner_label_id??null,owner_person_id:task.owner_person_id??null,owner_house_level:task.owner_house_level??null};
  if(!purchaseRun(data=>R().unrouteRequestOps(data,request.id,to),null))return;usage.track(to==='pending'?'tasks.reporte.a_recibido':'tasks.reporte.descartar');
  IkisaiKit.toastWithAction(to==='pending'?'Vuelve a «Recibido»: espera en «Por clasificar».':'No lo vamos a hacer. La app que lo pidió lo verá.',{label:'Deshacer',onClick:()=>{
    if(to==='dismissed'&&!purchaseRun(data=>R().reopenRequestOps(data,request.id),null))return;tkrClassifyBack(request.id,prev)}},UNDO_MS)}
function tkrDismissPending(request){if(!purchaseRun(data=>R().dismissRequestOps(data,request.id),null))return;usage.track('tasks.reporte.descartar');
  IkisaiKit.toastWithAction('No lo vamos a hacer. La app que lo pidió lo verá.',{label:'Deshacer',onClick:()=>purchaseRun(data=>R().reopenRequestOps(data,request.id),null)},UNDO_MS)}
function tkrRecover(request){if(!purchaseRun(data=>R().reopenRequestOps(data,request.id),null))return;usage.track('tasks.reporte.recuperar');
  IkisaiKit.toastWithAction('Recuperado: vuelve a «Recibido».',{label:'Deshacer',onClick:()=>purchaseRun(data=>R().dismissRequestOps(data,request.id),null)},UNDO_MS)}
const TKR_WHY={
  'pending>done':'Primero tiene que pasar a «En marcha»: toca «En marcha» para elegir adónde va.',
  'done>pending':'Para devolverlo a «Recibido», primero ponlo otra vez «En marcha».',
  'dismissed':'Está descartado: para retomarlo, toca «Recuperar».',
  'deleted':'Su tarea está en la papelera: restáurala desde la Papelera para retomarlo.',
};
function tkrPick(key){const {request,task}=tkrFind(state.feedbackCode||''),status=reportStatus(request,task);if(key===reportStage(status))return;
  if(status==='dismissed'||status==='deleted')return toast(TKR_WHY[status]);
  if(status==='pending'){if(key==='open'){if(!tkrCanRequest()||!request)return toast('Eso lo hace quien clasifica las peticiones.');return moveRequestSheet(request.id)}return toast(TKR_WHY['pending>done'])}
  if(status==='open'){if(key==='done')return tkrToggle(task);if(key==='pending'){if(!request||!task)return toast('Eso lo hace quien clasifica las peticiones.');return tkrUnroute(request,task,'pending')}}
  if(status==='done'){if(key==='open')return tkrToggle(task);return toast(TKR_WHY['done>pending'])}}
function tkrCopy(){const url=`${location.origin}/#/feedback/${state.feedbackCode||''}`;
  const done=()=>toast('Enlace copiado.'),fail=()=>toast('No se ha podido copiar el enlace.');
  try{navigator.clipboard?navigator.clipboard.writeText(url).then(done,fail):fail()}catch{fail()}}
function tkrSetDue(task,value){const before=task.due||'';if((value||'')===before)return;
  withArea(task.tab_id,()=>{const loc=taskLocation(task.id);if(!loc)return;loc.t.due=value||'';touch(loc.t);save()});render();
  IkisaiKit.toastWithAction(value?`Para el ${fmtDate(value)}`:'Sin fecha',{label:'Deshacer',onClick:()=>{withArea(task.tab_id,()=>{const loc=taskLocation(task.id);if(!loc)return;loc.t.due=before;touch(loc.t);save()});render()}},UNDO_MS)}
const bindBeforeReporte=bind;
bind=function(){bindBeforeReporte();if(state.view!=='feedback')return;const {request,task}=tkrFind(state.feedbackCode||'');
  document.querySelectorAll('.tkr-stages button.stage-step').forEach(b=>b.onclick=()=>tkrPick(b.closest('[data-stage]')?.dataset.stage));
  const copy=document.querySelector('[data-tkr-copy]');if(copy)copy.onclick=tkrCopy;
  const open=document.querySelector('[data-tkr-open]');if(open)open.onclick=()=>{if(task&&!task.deleted_at)return tkrOpenTask(task.id);if(request?.status==='pending'&&tkrCanRequest())return moveRequestSheet(request.id);if(task?.deleted_at)return toast(TKR_WHY.deleted)};
  const edit=document.querySelector('[data-tkr-edit]');if(edit)edit.onclick=()=>{tkrEditing=!tkrEditing;render();document.querySelector(tkrEditing?'#tkrProject':'[data-tkr-edit]')?.focus()};
  const due=document.getElementById('tkrDue');if(due&&task)due.onchange=()=>tkrSetDue(task,due.value);
  const project=document.getElementById('tkrProject');if(project&&task)project.onchange=()=>{withArea(task.tab_id,()=>moveTask(task.id,project.value));render()};
  const owner=document.querySelector('[data-tkr-owner]');if(owner&&task)owner.onclick=()=>tkrOpenTask(task.id);
  document.querySelectorAll('[data-tkr-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.tkrAction;if(!request)return;
    if(a==='recover')return tkrRecover(request);if(request.status==='pending')return tkrDismissPending(request);if(task)return tkrUnroute(request,task,'dismissed')})};
const mainBeforeReporte=main;
main=function(){if(state.view!=='feedback')tkrEditing=false;else tkrListen();return mainBeforeReporte()};
/* Lo que llega del núcleo (también las peticiones, que no pasan por el modelo de tareas) repinta el reporte abierto. */
let tkrListening=false;
function tkrListen(){if(tkrListening||!Sync.core)return;tkrListening=true;
  Sync.core.onChange(kind=>{if(kind==='data'&&state.view==='feedback'&&!document.getElementById('sheetBack')?.classList.contains('show'))render()})}

/* «Ver la tarea» (propuestas) y enlaces `#/tarea/<id>`: se abre la ficha en su área en cuanto hay modelo. */
function tkrOpenTask(id){const row=(Sync.core?.data?.['tasks.tasks']||[]).find(t=>t.id===id&&!t.deleted_at);
  if(!row)return toast('Esa tarea aún no ha llegado a este dispositivo. Prueba en un momento.');
  if(state.tabs.some(t=>t.id===row.tab_id)&&state.activeTab!==row.tab_id){state.activeTab=row.tab_id;persistUI();render()}
  openTaskEditor(id)}
const openHashViewBeforeTarea=openHashView;
openHashView=function(){const m=location.hash.match(/^#\/?tarea\/([0-9a-f-]{36})$/i);if(!m)return openHashViewBeforeTarea();
  hashPending=false;history.replaceState(null,'',location.pathname+location.search);tkrOpenTask(m[1])};
