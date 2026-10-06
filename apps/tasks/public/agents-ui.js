/* Agentes de IA (docs/tasks/AGENTES.md): claves de agente, propuestas con aprobación humana y registro de accesos sobre
   las rutas del núcleo `agents`, `proposals` y `access-log`. Sustituye a las hojas de la app antigua de access-ui.js y
   accounts-ui.js (otra API), que cloud-auth.js dejaba ocultas. Lo administra la propietaria con acceso completo. */
for(const feature of ['accesses','proposals','accessLog'])PENDING_FEATURES.delete(feature);
const navigationBeforeAgents=navigationGroups;
navigationGroups=function(){return navigationBeforeAgents().map(group=>({...group,items:group.items.map(item=>
  item[0]==='accesses'?['accesses','Agentes de IA','agent','action',isAdministrator()]
  :item[0]==='proposals'?['proposals','Propuestas de agentes','agent','action',isAdministrator()]
  :item)}))};

const AGENT_ROLES={reader:'Solo lectura',editor:'Editar'};
const PROPOSAL_STATES={pending:'Pendiente',approved:'Aprobada',rejected:'Rechazada',consumed:'Aplicada',expired:'Caducada',revoked:'Revocada'};
const ACCESS_EVENTS={key_issued:'Clave de agente creada',key_revoked:'Clave de agente revocada',member_invited:'Persona invitada',member_changed:'Permisos cambiados',proposal_prepared:'Propuesta preparada',proposal_approved:'Propuesta aprobada',proposal_rejected:'Propuesta rechazada',proposal_consumed:'Propuesta aplicada',proposal_revoked:'Propuesta revocada'};
const CHANGE_KINDS={'tasks.tabs':'Área','tasks.families':'Familia','tasks.labels':'Etiqueta','tasks.projects':'Proyecto','tasks.tasks':'Tarea','tasks.project_labels':'Etiqueta de proyecto','tasks.task_labels':'Etiqueta de tarea','tasks.task_dependencies':'Dependencia','tasks.saved_views':'Vista','tasks.attachments':'Adjunto'};
const CHANGE_FIELDS={title:'Nombre',name:'Nombre',note:'Nota',done:'Completada',status:'Estado',priority:'Prioridad',due:'Fecha objetivo',owner_label_id:'Responsable',parent_id:'Tarea padre',project_id:'Proyecto',position:'Posición',archived:'Archivada',color:'Color',budget:'Presupuesto',cost:'Coste',label_id:'Etiqueta',depends_on_id:'Depende de',filters:'Filtros',family_id:'Familia'};
const CHANGE_IGNORED=new Set(['id','revision','created_at','updated_at','updated_by','deleted_at','tab_id','archived_before_family','system_key','system']);
const when=value=>value?new Date(value).toLocaleString('es-ES',{dateStyle:'medium',timeStyle:'short'}):'—';

/* Nombres para lo que el servidor devuelve con ids: lo busca en el modelo local (lo que esta persona ve). */
function changeName(table,id){const tabs=state.tabs||[];
  if(table==='tasks.tabs')return tabs.find(t=>t.id===id)?.name;
  for(const t of tabs){
    if(table==='tasks.projects'){const p=t.projects.find(p=>p.id===id);if(p)return p.title}
    if(table==='tasks.tasks'){for(const p of t.projects){const x=p.tasks.find(x=>x.id===id);if(x)return x.text}}
    if(table==='tasks.labels'){const l=t.labels.find(l=>l.id===id);if(l)return l.text}
    if(table==='tasks.families'){const f=t.families.find(f=>f.id===id);if(f)return f.name}
  }
  return null}
function changeValue(field,value){
  if(value==null||value==='')return '—';
  if(typeof value==='boolean')return value?'Sí':'No';
  if(field==='status')return {active:'Activo',paused:'Pausado',archived:'Archivado'}[value]||String(value);
  if(field==='priority')return {normal:'Normal',high:'Alta',critical:'Crítica'}[value]||String(value);
  if(field==='owner_label_id'||field==='label_id')return changeName('tasks.labels',value)||'otra etiqueta';
  if(field==='parent_id'||field==='depends_on_id')return changeName('tasks.tasks',value)||'otra tarea';
  if(field==='project_id')return changeName('tasks.projects',value)||'otro proyecto';
  if(field==='family_id')return changeName('tasks.families',value)||'otra familia';
  if(typeof value==='object')return JSON.stringify(value);
  return String(value)}
/* Una línea legible por cambio del ensayo: «Borrar · Tarea · Pintar» y, al editar, los campos que cambian. */
function describeChange(change){
  const row=change.after||change.before||{},kind=CHANGE_KINDS[change.table]||change.table;
  if(change.op==='call')return {title:'Procedimiento · '+change.table,fields:[]};
  const name=row.title||row.name||changeName(change.table,change.id)||
    (row.task_id?changeName('tasks.tasks',row.task_id):null)||(row.project_id?changeName('tasks.projects',row.project_id):null)||'';
  const archiving=change.op==='update'&&(change.after?.status==='archived'&&change.before?.status!=='archived'||change.after?.archived===true&&change.before?.archived!==true);
  const action=archiving?'Archivar':{insert:'Crear',update:'Editar',delete:'Borrar',restore:'Restaurar'}[change.op]||change.op;
  const fields=[];
  if(change.op==='update'||change.op==='restore'){
    for(const key of Object.keys(change.after||{})){if(CHANGE_IGNORED.has(key))continue;const a=change.before?.[key],b=change.after[key];if(JSON.stringify(a)!==JSON.stringify(b))fields.push({label:CHANGE_FIELDS[key]||key,from:changeValue(key,a),to:changeValue(key,b)})}
  }
  return {title:`${action} · ${kind}${name?' · '+name:''}`,fields}}
function riskText(risk){if(!risk)return '';const parts=[];
  if(risk.destructive)parts.push('Incluye borrados');
  if((risk.reasons||[]).some(r=>r.startsWith('archive:')))parts.push('Archiva');
  parts.push(`${risk.affected} ${risk.affected===1?'elemento afectado':'elementos afectados'}${risk.bulk?` (umbral ${risk.bulkThreshold})`:''}`);
  return parts.join(' · ')}

/* Ámbitos: el mismo selector que «Cuentas de personas». */
function scopePickerHtml(){return `<label><input type="checkbox" id="scopeAll"> Todas las áreas, también las futuras</label>${state.tabs.filter(t=>!t.deleted).map(t=>`<section class="filterfamily"><label><input type="checkbox" data-scope-tab="${t.id}"> Todo ${esc(t.name)}</label>${t.projects.filter(p=>!p.deleted&&!p.system).map(p=>`<label style="display:block;padding:6px 12px"><input type="checkbox" data-scope-project="${t.id}|${p.id}"> ${esc(p.title)}</label>`).join('')}</section>`).join('')}`}
function pickedScopes(){if(document.getElementById('scopeAll').checked)return '*';const tabs=[...document.querySelectorAll('[data-scope-tab]:checked')].map(b=>b.dataset.scopeTab),projects={};document.querySelectorAll('[data-scope-project]:checked').forEach(b=>{const [t,p]=b.dataset.scopeProject.split('|');if(!tabs.includes(t))(projects[t]||=[]).push(p)});return {tabs,projects}}

accessesSheet=async function(){
  if(!isAdministrator())return;
  openSheet('<h2 class="sheettitle">Agentes de IA</h2><p>Cargando…</p>');
  try{const {items}=await Sync.core.api('/agents');Sync.agents=items;
    openSheet(`<h2 class="sheettitle">Agentes de IA</h2><p class="small muted">Cada agente entra con su propia clave y trabaja con el permiso y las áreas que le des. Lo que borra, archiva o toca 10 elementos o más espera tu aprobación en «Propuestas de agentes».</p><button class="primary" id="newAgent">Crear agente</button>${items.length?'':'<div class="empty">Todavía no hay agentes.</div>'}${items.map(a=>`<section class="agentrow" data-agent="${a.keyId}" style="padding:12px 0;border-bottom:1px solid var(--line)"><strong>${esc(a.name)}</strong> <span class="small muted">· clave …${esc(a.hint)}</span><p class="small">${esc(AGENT_ROLES[a.role]||a.role)} · ${esc(accessScopeText(a.scopes==null?'*':a.scopes))}<br>${a.revokedAt?'Revocada el '+esc(when(a.revokedAt)):a.lastUsedAt?'Último uso: '+esc(when(a.lastUsedAt)):'Sin usar todavía'}${a.expiresAt&&!a.revokedAt?' · caduca el '+esc(when(a.expiresAt)):''}</p>${a.revokedAt?'':`<button class="danger" data-revoke-agent="${a.keyId}">Revocar clave</button>`}</section>`).join('')}`);
    document.getElementById('newAgent').onclick=createAccessSheet;
    document.querySelectorAll('[data-revoke-agent]').forEach(b=>b.onclick=()=>revokeAgentSheet(items.find(a=>a.keyId===b.dataset.revokeAgent)));
  }catch(e){toast(e.message||'No se pudieron cargar los agentes.')}
};
createAccessSheet=function(){
  if(!isAdministrator())return;
  openSheet(`<h2 class="sheettitle">Crear agente</h2><div class="field"><label for="agentName">Nombre</label><input id="agentName" maxlength="100" placeholder="Por ejemplo: Asistente de obra"></div><div class="field"><label for="agentRole">Permiso</label><select id="agentRole"><option value="editor">Editar</option><option value="reader">Solo lectura</option></select></div>${scopePickerHtml()}<button class="primary" id="saveAgent">Crear y mostrar la clave</button>`);
  document.getElementById('scopeAll').checked=true;
  document.getElementById('saveAgent').onclick=async()=>{
    const name=document.getElementById('agentName').value.trim(),role=document.getElementById('agentRole').value,scopes=pickedScopes(),button=document.getElementById('saveAgent');
    if(!name)return toast('Pon un nombre al agente.');
    if(scopes!=='*'&&!memberHasAccess({scopes}))return toast('Elige al menos un área o un proyecto.');
    button.disabled=true;
    try{const issued=await Sync.core.api('/agents',{method:'POST',json:{name,role,scopes}});
      openSheet(`<h2 class="sheettitle">Clave de ${esc(issued.name)}</h2><p>Copia la clave y configúrala en el agente. <strong>Solo se muestra ahora</strong>: si la pierdes, revócala y crea otra.</p><div class="field"><label for="issuedAgentKey">Clave</label><input id="issuedAgentKey" readonly value="${esc(issued.token)}"></div><button class="softbtn" id="copyAgentKey">Copiar</button> <button class="primary" id="agentDone">Hecho</button>`);
      document.getElementById('copyAgentKey').onclick=async()=>{try{await navigator.clipboard.writeText(issued.token);toast('Clave copiada.')}catch{document.getElementById('issuedAgentKey').select();toast('Selecciónala y cópiala.')}};
      document.getElementById('agentDone').onclick=accessesSheet;
    }catch(e){button.disabled=false;toast(e.message||'No se pudo crear el agente.')}
  };
};
function revokeAgentSheet(agent){
  if(!agent)return;
  openSheet(`<h2 class="sheettitle">Revocar la clave de ${esc(agent.name)}</h2><p>El agente dejará de poder entrar en todas las apps de Ikisai al momento, y sus propuestas pendientes o aprobadas quedarán revocadas. No se puede deshacer: para volver a darle acceso, crea otra clave.</p><button class="danger" id="confirmRevokeAgent">Revocar</button>`);
  document.getElementById('confirmRevokeAgent').onclick=async()=>{const button=document.getElementById('confirmRevokeAgent');button.disabled=true;
    try{const out=await Sync.core.api('/agents/'+encodeURIComponent(agent.keyId),{method:'DELETE'});await accessesSheet();toast(out.proposalsRevoked?`Clave revocada y ${out.proposalsRevoked} ${out.proposalsRevoked===1?'propuesta revocada':'propuestas revocadas'}.`:'Clave revocada.')}catch(e){button.disabled=false;toast(e.message)}};
}

async function agentNames(){
  if(!Sync.agents){try{Sync.agents=(await Sync.core.api('/agents')).items}catch{Sync.agents=[]}}
  if(!Sync.members){try{Sync.members=await Sync.core.api('/members')}catch{Sync.members=[]}}
  const names=new Map();for(const m of Sync.members||[])names.set(m.userId,m.displayName||'Sin nombre');for(const a of Sync.agents||[])names.set(a.userId,a.name);
  return names}
proposalsSheet=async function(){
  if(!isAdministrator())return;
  openSheet('<h2 class="sheettitle">Propuestas de agentes</h2><p>Cargando…</p>');
  try{const [{items},names]=await Promise.all([Sync.core.api('/proposals'),agentNames()]);
    Sync.proposals=items;
    openSheet(`<h2 class="sheettitle">Propuestas de agentes</h2><p class="small muted">Aprobar autoriza ese lote exacto durante 24 horas desde que se preparó; no lo ejecuta. El agente lo envía después. Si los datos han cambiado y ya no encaja, se rechaza y el agente tiene que prepararlo de nuevo.</p>${items.length?'':'<div class="empty">No hay propuestas.</div>'}${items.map(x=>`<button class="ghost" data-review-proposal="${x.id}" style="display:block;width:100%;text-align:left;margin:8px 0"><strong>${esc(names.get(x.userId)||'Agente')}</strong> · ${esc(PROPOSAL_STATES[x.status]||x.status)}<br><span class="small muted">${esc(when(x.createdAt))} · ${esc(riskText(x.risk))}</span></button>`).join('')}`);
    document.querySelectorAll('[data-review-proposal]').forEach(b=>b.onclick=()=>reviewProposalSheet(items.find(x=>x.id===b.dataset.reviewProposal),names));
  }catch(e){toast(e.message||'No se pudieron cargar las propuestas.')}
};
reviewProposalSheet=function(proposal,names=new Map()){
  if(!proposal)return;
  const canApprove=isAdministrator()&&proposal.status==='pending',canReject=isAdministrator()&&['pending','approved'].includes(proposal.status);
  const changes=(proposal.summary||[]).map(describeChange);
  openSheet(`<h2 class="sheettitle">Revisar propuesta</h2><p>${esc(names.get(proposal.userId)||'Agente')} · <strong>${esc(PROPOSAL_STATES[proposal.status]||proposal.status)}</strong><br><span class="small">Preparada: ${esc(when(proposal.createdAt))} · caduca: ${esc(when(proposal.expiresAt))}</span></p><p class="small">${esc(riskText(proposal.risk))}</p>${proposal.reason?`<p class="small muted">${esc(proposal.reason)}</p>`:''}<ol class="proposalchanges" style="padding-left:20px">${changes.map(c=>`<li style="margin:8px 0"><strong>${esc(c.title)}</strong>${c.fields.length?`<ul class="small" style="padding-left:16px">${c.fields.map(f=>`<li>${esc(f.label)}: ${esc(f.from)} → ${esc(f.to)}</li>`).join('')}</ul>`:''}</li>`).join('')}</ol><p class="small muted">El resumen es el de cuando se preparó; si algo ha cambiado desde entonces, aprobar lo comprueba de nuevo.</p>${canApprove?'<button class="primary" id="approveProposal">Aprobar</button> ':''}${canReject?'<button class="danger" id="rejectProposal">Rechazar</button>':''}`);
  const decide=async(kind,button)=>{button.disabled=true;
    try{await Sync.core.api(`/proposals/${encodeURIComponent(proposal.id)}/${kind}`,{method:'POST',json:{}});await proposalsSheet();toast(kind==='approve'?'Propuesta aprobada. El agente ya puede aplicarla.':'Propuesta rechazada.')}
    catch(e){if(e.code==='PROPOSAL_UNAVAILABLE'){await proposalsSheet();toast('Los datos han cambiado y el lote ya no encaja: queda rechazada y el agente debe prepararla de nuevo.');return}button.disabled=false;toast(e.message)}};
  const approve=document.getElementById('approveProposal'),reject=document.getElementById('rejectProposal');
  if(approve)approve.onclick=()=>decide('approve',approve);
  if(reject)reject.onclick=()=>decide('reject',reject);
};
accessLogSheet=async function(before=null){
  if(!isAdministrator())return;
  try{const [page,names]=await Promise.all([Sync.core.api('/access-log'+(before?'?before='+encodeURIComponent(before):'')),agentNames()]);
    const previous=before?(Sync.accessLog||[]):[];Sync.accessLog=[...previous,...page.items];
    openSheet(`<h2 class="sheettitle">Registro de accesos</h2>${Sync.accessLog.length?'':'<div class="empty">Sin actividad registrada.</div>'}${Sync.accessLog.map(x=>`<p class="small accessevent" style="overflow-wrap:anywhere;margin:8px 0">${esc(when(x.at))} · <strong>${esc(ACCESS_EVENTS[x.event]||x.event)}</strong>${x.actorId?' · '+esc(names.get(x.actorId)||'otra cuenta'):''}${x.meta?.name?' · '+esc(x.meta.name):''}</p>`).join('')}${page.hasMore?'<button class="softbtn" id="olderAccessLog">Ver anteriores</button>':''}`);
    const older=document.getElementById('olderAccessLog');if(older)older.onclick=()=>accessLogSheet(page.nextBefore);
  }catch(e){toast(e.message||'No se pudo cargar el registro.')}
};
