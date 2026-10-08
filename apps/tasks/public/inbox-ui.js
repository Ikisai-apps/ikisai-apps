/* Entradas de otras apps (docs/tasks/API.md §20): «Por clasificar» con las peticiones que no tienen regla, agrupadas por
   origen y tipo, y «Gestionar entradas» con las reglas del usuario (tipo → área, proyecto y responsable). Las filas salen
   del núcleo (Sync.core.data) y los cambios son operaciones del dominio (IkisaiTasks.requests), confirmadas como en
   compras (purchaseCommit). Solo con acceso a toda la app: las peticiones pendientes no tienen área. */
Object.assign(menuPaths,{triage:'M3 13h4l2 3h6l2-3h4 M5 5h14l2 8v6H3v-6z'});
const R=()=>IkisaiTasks.requests;
/* Al cerrar una hoja tras un cambio se repinta: el aviso de datos del núcleo puede llegar con la hoja aún abierta. */
function inboxDone(){closeSheet();render()}
const inboxRows=table=>(Sync.core?.data?.[table]||[]).filter(r=>!r.deleted_at);
function canTriage(){const a=Sync.actor;return !!a&&!Sync.secondary&&a.kind!=='agent'&&['editor','owner'].includes(a.role)&&(a.scopes==='*'||a.scopes==null)}
function canManageRoutes(){return canTriage()&&Sync.actor.role==='owner'}
function pendingCount(){return Sync.core&&canTriage()?R().pendingRequests(Sync.core.data).length:0}
/* Tipos que pueden llegar desde otras apps (§20, §22.2): «Gestionar entradas» los enseña aunque aún no haya llegado ninguno,
   para preparar la regla antes. `suggest` propone el destino de la estructura acordada con el usuario (8-10-2026): primero
   un proyecto cuyo nombre case y, si no hay, un área; sin ids fijos, solo por nombre. */
const SPACE_KINDS={damage:'Avería',cleaning:'Limpieza',missing:'Falta algo',utilities:'Suministros',safety:'Seguridad',other:'Otros'};
const EVENT_KINDS={setup:'Montaje',accommodation:'Alojamiento',cleaning:'Limpieza',food:'Cocina',technical:'Técnico',operation:'Horarios y operación',other:'Otros'};
const KNOWN_KINDS=[
  {kind:'booking.retreat_project',label:'Retiro · Proyecto',areaOnly:true,suggest:{area:/retiro/i}},
  {kind:'booking.organizer_dates',label:'Organizador · Fechas posibles',suggest:{project:/comercial/i,area:/comercial|gesti/i}},
  {kind:'booking.organizer_confirm',label:'Organizador · Quiere confirmar',suggest:{project:/comercial/i,area:/comercial|gesti/i}},
  {kind:'booking.proposal_comment',label:'Organizador · Comentario a la propuesta',suggest:{project:/comercial/i,area:/comercial|gesti/i}},
  {kind:'booking.ses_deadline',label:'SES · Plazo legal',suggest:{project:/administraci|fiscal/i,area:/gesti/i}},
  {kind:'central.compliance_due',label:'Central · Vencimientos',suggest:{project:/cumplimiento/i,area:/gesti/i}},
  {kind:'core.user_task',label:'Core · Tarea para ti',suggest:{project:/tareas de core/i,area:/aplicaciones/i}},
  ...Object.entries(SPACE_KINDS).map(([k,v])=>({kind:'feedback.space.'+k,label:'Espacio · '+v,suggest:{project:/reparaci/i,area:/mantenimiento/i}})),
  // Lo del retiro va al proyecto de su reserva cuando el reporte la trae (§22.2); la regla es para lo que no.
  ...Object.entries(EVENT_KINDS).map(([k,v])=>({kind:'feedback.event.'+k,label:'Retiro · '+v,suggest:{area:/retiro/i}})),
];
/* Destino propuesto para una regla nueva: un proyecto vivo y no archivado cuyo nombre case; si no, un área. */
function suggestedDestination(kind){const want=KNOWN_KINDS.find(k=>k.kind===kind)?.suggest;if(!want)return null;
  const tabs=inboxRows('tasks.tabs');
  if(want.project){const project=inboxRows('tasks.projects').find(p=>p.status!=='archived'&&!p.system&&want.project.test(p.title)&&tabs.some(t=>t.id===p.tab_id));if(project)return {tab_id:project.tab_id,project_id:project.id}}
  const tab=want.area?tabs.find(t=>want.area.test(t.name)):null;return tab?{tab_id:tab.id}:null}
function kindName(kind,label){return label||kind.slice(kind.indexOf('.')+1).replace(/[_.-]+/g,' ')}
function originChip(source){return `<span class="pstate">${esc(appName(source))}</span>`}

/* Menú: «Por clasificar · N» en Trabajo, solo si hay algo esperando. */
const navigationBeforeInbox=navigationGroups;
navigationGroups=function(){const groups=navigationBeforeInbox(),n=pendingCount(),work=groups.find(g=>g.id==='work');
  // Con algo pendiente, para quien clasifica; a cero, sigue para el owner, que entra por aquí a «Gestionar entradas».
  if(work&&(n||canManageRoutes()))work.items.unshift(['triage',n?`Por clasificar · ${n}`:'Por clasificar','triage','view']);
  return groups};

let inboxListening=false;
function listenInbox(){if(inboxListening||!Sync.core)return;inboxListening=true;Sync.core.onChange(kind=>{if(kind==='data'&&state.view==='triage'&&!document.getElementById('sheetBack')?.classList.contains('show'))render()})}

function inboxView(){listenInbox();
  if(!canTriage())return `<main class="screen"><h1 class="title">Por clasificar</h1><div class="notice">Las peticiones de otras apps las clasifica quien tiene acceso a toda la app.</div></main>`;
  const groups=R().requestGroups(Sync.core.data);
  const row=r=>`<div class="pcard" data-request-row="${r.id}"><span class="phead">${originChip(r.source)}<strong>${esc(r.title)}</strong>${r.priority!=='normal'?priorityStar(r.priority):''}</span>
    <span class="pmeta">${[r.due?'para el '+new Date(r.due+'T00:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'short'}):'',r.external_ref.slice(r.external_ref.indexOf(':')+1)].filter(Boolean).map(esc).join(' · ')}${r.external_url?` · <a href="${esc(r.external_url)}" target="_blank" rel="noopener" data-feedback-id="tasks.por_clasificar.lista.abrir_origen" data-feedback-label="Abrir en la app de origen">Abrir en ${esc(appName(r.source))}</a>`:''}</span>
    <div class="pactions"><span class="pgrow"></span><button class="softbtn small" data-request-move="${r.id}" type="button" data-feedback-id="tasks.por_clasificar.lista.mover" data-feedback-label="Mover petición a…">Mover a…</button><button class="ghost small" data-request-dismiss="${r.id}" type="button" data-feedback-id="tasks.por_clasificar.lista.descartar" data-feedback-label="Descartar petición">Descartar</button></div></div>`;
  return `<main class="screen inbox"><div class="screenhead"><div><h1 class="title">Por clasificar</h1><p class="subtitle">Peticiones de otras apps sin regla de entrada</p></div>${canManageRoutes()?'<button class="softbtn" id="manageRoutes" type="button" data-feedback-id="tasks.por_clasificar.gestionar_entradas" data-feedback-label="Gestionar entradas">Gestionar entradas</button>':''}</div>
    ${canManageRoutes()&&!R().routeFor(Sync.core.data,'booking.retreat_project')?'<div class="notice" id="retreatRouteMissing" data-feedback-id="tasks.por_clasificar.aviso_retiros" data-feedback-label="Falta el área de los retiros">Falta elegir el área de los proyectos de retiro: hasta entonces, Booking no puede crearlos. <button class="linkbtn" type="button" data-route-new="booking.retreat_project">Elegir el área</button></div>':''}
    ${groups.length?groups.map(g=>`<section class="inboxgroup"><h2 class="sectionlabel">${esc(appName(g.source))} · ${esc(kindName(g.kind,g.label))} <span class="count">${g.items.length}</span>${canManageRoutes()?` <button class="linkbtn small" data-route-new="${esc(g.kind)}" type="button" data-feedback-id="tasks.por_clasificar.grupo.crear_regla" data-feedback-label="Crear regla para este tipo">Crear regla para este tipo</button>`:''}</h2>${g.items.map(row).join('')}</section>`).join(''):'<div class="empty">Nada por clasificar. Lo que pidan otras apps sin regla de entrada aparecerá aquí.</div>'}</main>`}

const mainBeforeInbox=main;
main=function(){return state.view==='triage'?inboxView():mainBeforeInbox()};

/* Destino: área (con acceso completo), proyecto (si no, su Entrada) y responsable (familia Persona de esa área). */
function destinationFields(current={}){const data=Sync.core.data,tabs=inboxRows('tasks.tabs').sort((a,b)=>(a.position||0)-(b.position||0));
  const tabId=current.tab_id&&tabs.some(t=>t.id===current.tab_id)?current.tab_id:(tab()?.id||tabs[0]?.id);
  const projects=inboxRows('tasks.projects').filter(p=>p.tab_id===tabId&&p.status!=='archived').sort((a,b)=>(a.system==='inbox'?-1:b.system==='inbox'?1:(a.position||0)-(b.position||0)));
  const people=new Set(inboxRows('tasks.families').filter(f=>f.tab_id===tabId&&f.system_key==='person').map(f=>f.id));
  const owners=inboxRows('tasks.labels').filter(l=>l.tab_id===tabId&&people.has(l.family_id)&&!l.archived);
  /* Responsables (FB_2026_015): primero las personas del equipo (cuentas de Ikisai con acceso a Tasks, las mismas que
     Central enlaza a cada persona) y después las demás etiquetas Persona del área. Si una persona del equipo aún no tiene
     etiqueta en el área, se crea al guardar. */
  const team=teamPeople(),byName=new Map(owners.map(l=>[l.name.trim().toLowerCase(),l]));
  const teamOptions=team.map(m=>{const l=m.names.map(n=>byName.get(n)).find(Boolean);return {value:l?l.id:m.key,name:m.name,label:l}});
  const others=owners.filter(l=>!team.some(m=>m.names.includes(l.name.trim().toLowerCase())));
  const option=(value,name)=>`<option value="${esc(value)}" ${value===current.owner_label_id||value===current.owner_member?'selected':''}>${esc(name)}</option>`;
  return `<div class="field"><label for="destTab">Área</label><select id="destTab" data-feedback-id="tasks.destino.area" data-feedback-label="Área de destino">${tabs.map(t=>`<option value="${t.id}" ${t.id===tabId?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="destProject">Proyecto</label><select id="destProject" data-feedback-id="tasks.destino.proyecto" data-feedback-label="Proyecto de destino">${projects.map(p=>`<option value="${p.system==='inbox'?'':p.id}" ${(p.system==='inbox'?!current.project_id:p.id===current.project_id)?'selected':''}>${esc(p.system==='inbox'?'Entrada del área':p.title)}</option>`).join('')}</select></div>
    <div class="field"><label for="destOwner">Responsable</label><select id="destOwner" data-feedback-id="tasks.destino.responsable" data-feedback-label="Responsable"><option value="">Sin responsable</option>${teamOptions.length?`<optgroup label="Equipo">${teamOptions.map(o=>option(o.value,o.name)).join('')}</optgroup>`:''}${others.length?`<optgroup label="${teamOptions.length?'Otras etiquetas Persona del área':'Etiquetas Persona del área'}">${others.map(l=>option(l.id,l.name)).join('')}</optgroup>`:''}</select></div>`}
/* Personas del equipo con cuenta (sin agentes ni servicios). La lista la da el núcleo a la propietaria; se pide una vez. */
/* El equipo: las personas activas de Central (`central.people_options`, con su nombre de ficha, que manda) y las cuentas
   de Ikisai con acceso a Tasks; una sola vez quien tiene cuenta y ficha. Sin la lectura de Central (Central #394; sin red o
   sin acceso), solo las cuentas. `names`: los nombres con los que se reconoce su etiqueta Persona del área. */
function teamPeople(){
  const members=(Sync.members||[]).filter(m=>(m.kind||'human')==='human'&&m.displayName?.trim()),out=[],byUser=new Map(members.map(m=>[m.userId,m]));
  for(const p of centralPeople||[]){if(p.active===false||!p.name?.trim())continue;const m=p.user_id?byUser.get(p.user_id):null;if(m)byUser.delete(m.userId);
    out.push({key:m?'member:'+m.userId:'person:'+p.person_id,name:p.name.trim(),names:[...new Set([p.name.trim().toLowerCase(),...(m?[m.displayName.trim().toLowerCase()]:[])])]})}
  for(const m of byUser.values())out.push({key:'member:'+m.userId,name:m.displayName.trim(),names:[m.displayName.trim().toLowerCase()]});
  return out.sort((a,b)=>a.name.localeCompare(b.name,'es'))}
let teamAsked=false,centralPeople=null;
function loadTeam(reopen){if((Sync.members&&centralPeople)||teamAsked||!Sync.core||!navigator.onLine||Sync.actor?.role!=='owner')return;teamAsked=true;
  const people=Sync.core.api('/read/central.people_options',{method:'POST',json:{limit:2000}}).then(out=>{const rows=Array.isArray(out)?out:out?.rows||out?.items||[];centralPeople=rows}).catch(()=>{centralPeople=[]});
  const members=Sync.members?Promise.resolve():Sync.core.api('/members').then(items=>{Sync.members=items}).catch(()=>{});
  Promise.all([people,members]).then(()=>{if(document.getElementById('destOwner'))reopen()})}
/* La etiqueta Persona de una persona del equipo que aún no la tiene en el área: la operación que la crea y su id. */
function personLabelOps(tabId,key){const m=teamPeople().find(x=>x.key===key);
  const family=inboxRows('tasks.families').find(f=>f.tab_id===tabId&&f.system_key==='person');if(!m||!family)return null;
  const id=uid(),position=(Math.max(0,...inboxRows('tasks.labels').filter(l=>l.family_id===family.id).map(l=>l.position||0))+1024);
  return {id,ops:[{op:'insert',table:'tasks.labels',id,fields:{tab_id:tabId,family_id:family.id,name:m.name,position}}]}}
function destinationValue(){const tab_id=document.getElementById('destTab').value,project=document.getElementById('destProject').value||null;
  const inbox=inboxRows('tasks.projects').find(p=>p.tab_id===tab_id&&p.system==='inbox');
  let owner=document.getElementById('destOwner').value||null,labelOps=[];
  if(owner?.startsWith('member:')||owner?.startsWith('person:')){const made=personLabelOps(tab_id,owner);owner=made?.id||null;labelOps=made?.ops||[]}
  return {tab_id,project_id:project,target_project:project||inbox?.id||null,owner_label_id:owner,labelOps}}
function bindDestination(reopen){const t=document.getElementById('destTab');if(t)t.onchange=()=>reopen({tab_id:t.value});
  loadTeam(()=>{const o=document.getElementById('destOwner')?.value||null;reopen({tab_id:document.getElementById('destTab')?.value,project_id:document.getElementById('destProject')?.value||null,owner_label_id:o,owner_member:o})})}

function moveRequestSheet(id,current={}){const r=inboxRows('tasks.requests').find(x=>x.id===id);if(!r)return;
  openSheet(`<h2 class="sheettitle">Mover a…</h2><p>${originChip(r.source)} ${esc(r.title)}</p>${destinationFields(current)}<div class="actions"><button class="primary" id="moveRequest" type="button" data-feedback-id="tasks.mover_peticion.crear_tarea" data-feedback-label="Crear la tarea aquí">Crear la tarea aquí</button></div>`);
  bindDestination(c=>moveRequestSheet(id,c));
  document.getElementById('moveRequest').onclick=()=>{const d=destinationValue();if(!d.target_project)return toast('Elige un proyecto.');
    if(purchaseRun(data=>[...d.labelOps,...R().classifyRequestOps(data,id,{project_id:d.target_project,owner_label_id:d.owner_label_id})],'Tarea creada.')){usage.track('tasks.por_clasificar.mover');inboxDone()}}}

function routesSheet(){if(!canManageRoutes())return;const data=Sync.core.data,routes=inboxRows('tasks.request_routes');
  const kinds=new Map(KNOWN_KINDS.map(k=>[k.kind,{kind:k.kind,source:k.kind.slice(0,k.kind.indexOf('.')),label:k.label}]));for(const r of inboxRows('tasks.requests'))kinds.set(r.kind,{kind:r.kind,source:r.source,label:r.kind_label||kinds.get(r.kind)?.label||null});
  for(const r of routes)kinds.set(r.kind,{kind:r.kind,source:r.kind.slice(0,r.kind.indexOf('.')),label:r.kind_label||kinds.get(r.kind)?.label||null});
  const where=route=>{if(!route)return '<span class="pstate pending">Por clasificar</span>';const project=R().routeTarget(data,route);if(!project)return '<span class="pstate alert">El destino ya no existe</span>';
    const tabName=inboxRows('tasks.tabs').find(t=>t.id===route.tab_id)?.name||'',p=inboxRows('tasks.projects').find(x=>x.id===project);return esc(tabName+' › '+(p?.system==='inbox'?'Entrada':p?.title||''))};
  const list=[...kinds.values()].sort((a,b)=>a.kind.localeCompare(b.kind));
  openSheet(`<h2 class="sheettitle">Gestionar entradas</h2><p class="small muted">Qué hace Tasks con cada tipo de petición de otras apps. Sin regla, espera en «Por clasificar».</p>
    ${list.length?list.map(k=>`<button type="button" class="pcard" data-route-edit="${esc(k.kind)}" data-feedback-id="tasks.entradas.lista.regla" data-feedback-label="Editar regla de entrada"><span class="phead">${originChip(k.source)}<strong>${esc(kindName(k.kind,k.label))}</strong></span><span class="pmeta">${where(routes.find(r=>r.kind===k.kind))}</span></button>`).join(''):'<div class="empty">Todavía no ha llegado ninguna petición de otras apps.</div>'}
    <div class="actions"><button class="softbtn" id="routeNew" type="button" data-feedback-id="tasks.entradas.nueva_regla" data-feedback-label="Regla para otro tipo">Regla para otro tipo</button></div>`);
  document.querySelectorAll('[data-route-edit]').forEach(b=>b.onclick=()=>routeSheet(b.dataset.routeEdit));
  document.getElementById('routeNew').onclick=()=>routeSheet('')}

function routeSheet(kind,current=null,isNew=!kind){if(!canManageRoutes())return;const existing=kind?R().routeFor(Sync.core.data,kind):null;
  const label=current?.kind_label??existing?.kind_label??inboxRows('tasks.requests').find(r=>r.kind===kind&&r.kind_label)?.kind_label??KNOWN_KINDS.find(k=>k.kind===kind)?.label??'';
  // Regla nueva: se propone el destino de la estructura acordada (proyecto por nombre y, si no, área), sin ids fijos.
  const dest=current||existing||suggestedDestination(kind)||{};
  openSheet(`<h2 class="sheettitle">${existing?'Regla de entrada':'Regla nueva'}</h2>
    <div class="field"><label for="routeKind">Tipo</label><input id="routeKind" value="${esc(kind)}" placeholder="central.compliance_due" ${isNew?'':'disabled'} data-feedback-id="tasks.regla_entrada.tipo" data-feedback-label="Tipo de petición"></div>
    <div class="field"><label for="routeLabel">Nombre</label><input id="routeLabel" maxlength="100" value="${esc(label)}" placeholder="Vencimientos" data-feedback-id="tasks.regla_entrada.nombre" data-feedback-label="Nombre del tipo"></div>
    ${destinationFields(dest)}
    ${KNOWN_KINDS.find(k=>k.kind===kind)?.areaOnly?'<p class="small muted" id="routeAreaOnly">Cada retiro confirmado crea aquí su propio proyecto (AAAAMMDD-título): de esta regla solo cuenta el área.</p>':''}
    <div class="actions"><button class="primary" id="routeSave" type="button" data-feedback-id="tasks.regla_entrada.guardar" data-feedback-label="Guardar regla">Guardar</button>${existing?'<button class="ghost danger-text" id="routeDelete" type="button" data-feedback-id="tasks.regla_entrada.quitar" data-feedback-label="Quitar regla">Quitar regla</button>':''}</div>`);
  bindDestination(c=>routeSheet(document.getElementById('routeKind').value.trim(),{...c,kind_label:document.getElementById('routeLabel').value.trim()},isNew));
  document.getElementById('routeSave').onclick=()=>{const k=document.getElementById('routeKind').value.trim(),d=destinationValue();
    if(!/^[a-z][a-z0-9_-]{1,30}\.[a-z0-9][a-z0-9_.-]{0,60}$/.test(k))return toast('El tipo va como app.nombre, en minúsculas.');
    if(!purchaseRun(data=>[...d.labelOps,...R().saveRouteOps(data,{kind:k,kind_label:document.getElementById('routeLabel').value.trim()||null,tab_id:d.tab_id,project_id:d.project_id,owner_label_id:d.owner_label_id})],'Regla guardada.'))return;
    const waiting=R().pendingRequests(Sync.core.data,k).length;
    if(!waiting)return inboxDone();
    openSheet(`<h2 class="sheettitle">Regla guardada</h2><p>Hay ${waiting} ${waiting===1?'petición':'peticiones'} de este tipo esperando en «Por clasificar». ¿Las mueves también?</p><div class="actions"><button class="primary" id="routeWaiting" type="button" data-feedback-id="tasks.regla_guardada.mover_esperando" data-feedback-label="Mover también las que esperaban">Mover también ${waiting===1?'la que esperaba':`las ${waiting} que esperaban`}</button><button class="ghost" id="routeLater" type="button" data-feedback-id="tasks.regla_guardada.ahora_no" data-feedback-label="Ahora no">Ahora no</button></div>`);
    document.getElementById('routeWaiting').onclick=()=>{if(purchaseRun(data=>R().routeWaitingOps(data,k),'Movidas.'))inboxDone()};
    document.getElementById('routeLater').onclick=()=>inboxDone()};
  const del=document.getElementById('routeDelete');if(del)del.onclick=()=>{if(purchaseRun(data=>R().deleteRouteOps(data,kind),'Regla quitada: lo nuevo de este tipo esperará en «Por clasificar».'))inboxDone()}}

const bindBeforeInbox=bind;
bind=function(){bindBeforeInbox();
  const m=document.getElementById('manageRoutes');if(m)m.onclick=routesSheet;
  document.querySelectorAll('[data-request-move]').forEach(b=>b.onclick=()=>moveRequestSheet(b.dataset.requestMove));
  document.querySelectorAll('[data-request-dismiss]').forEach(b=>b.onclick=()=>purchaseRun(data=>R().dismissRequestOps(data,b.dataset.requestDismiss),'Descartada: la app que la pidió lo verá.'));
  document.querySelectorAll('[data-route-new]').forEach(b=>b.onclick=()=>routeSheet(b.dataset.routeNew))};

/* Enlaces directos `https://tasks.ikisai.com/#/<vista>` (los usa el panel de Dirección de Central, API.md §21): se abre
   la vista en cuanto hay modelo y se limpia el hash, para que recargar no vuelva a saltar. */
const HASH_VIEWS=['home','projects','tasks','triage','purchases','supplies','plans'];
let hashPending=true;
function openHashView(){const view=location.hash.replace(/^#\/?/,'');hashPending=false;
  const report=view.match(/^feedback\/([A-Za-z0-9_-]{1,40})$/);
  if(report){history.replaceState(null,'',location.pathname+location.search);state.feedbackCode=report[1];navigateView('feedback');return}
  if(!HASH_VIEWS.includes(view))return;history.replaceState(null,'',location.pathname+location.search);navigateView(view)}

/* Reporte de Feedback (§22.4): `#/feedback/<código>` es el `external_url` de las tareas que nacen de un reporte. El detalle lo
   pintará el componente del kit con la API de Core cuando existan; por ahora, el código y la tarea que lo trabaja. */
function feedbackView(){const code=state.feedbackCode||'';const task=(Sync.core?.data?.['tasks.tasks']||[]).find(t=>t.external_ref==='feedback:'+code);
  return `<main class="screen"><h1 class="title">Reporte ${esc(code)}</h1><div class="notice">El detalle del reporte se verá aquí cuando esté disponible.</div>
    ${task?`<button class="pcard" type="button" data-feedback-task="${task.id}" data-feedback-id="tasks.reporte.abrir_tarea" data-feedback-label="Abrir la tarea del reporte"><span class="phead"><strong>${esc(task.title)}</strong>${task.deleted_at?'<span class="pstate trash">En la papelera</span>':''}</span><span class="pmeta">Abrir la tarea</span></button>`:'<p class="small muted">No hay ninguna tarea tuya enlazada a este reporte.</p>'}</main>`}
const mainBeforeFeedback=main;
main=function(){return state.view==='feedback'?feedbackView():mainBeforeFeedback()};
const bindBeforeFeedback=bind;
bind=function(){bindBeforeFeedback();document.querySelectorAll('[data-feedback-task]').forEach(b=>b.onclick=()=>openTaskEditor(b.dataset.feedbackTask))};
const renderBeforeHash=render;
render=function(...args){renderBeforeHash(...args);if(hashPending&&state.tabs.length&&Sync.ready)openHashView()};
window.addEventListener('hashchange',()=>{if(state.tabs.length)openHashView()});
