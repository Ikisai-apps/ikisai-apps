/* Agentes de IA (docs/tasks/AGENTES.md): claves de agente, propuestas con aprobación humana y registro de accesos sobre
   las rutas del núcleo `agents`, `proposals` y `access-log`, pintados con las piezas comunes del kit (0.11.0). Las piezas
   van dentro de la hoja heredada en un envoltorio `.ikisai-kit` (el CSS del kit está acotado a esa clase); la revisión
   pasará a `openProposalReview` cuando la hoja de la app sea la del kit. Solo para la propietaria con acceso completo. */
for(const feature of ['accesses','proposals','accessLog'])PENDING_FEATURES.delete(feature);
const navigationBeforeAgents=navigationGroups;
navigationGroups=function(){return navigationBeforeAgents().map(group=>({...group,items:group.items.map(item=>
  item[0]==='accesses'?['accesses','Agentes de IA','agent','action',isAdministrator()]
  :item[0]==='proposals'?['proposals','Propuestas de agentes','agent','action',isAdministrator()]
  :item)}))};

const AGENT_ROLES={reader:'Solo lectura',editor:'Editar'};
const ACCESS_EVENTS={key_issued:['Clave de agente creada','ok'],key_revoked:['Clave de agente revocada','alert'],member_invited:['Persona invitada','ok'],member_changed:['Permisos cambiados',undefined],proposal_prepared:['Propuesta preparada',undefined],proposal_approved:['Propuesta aprobada','ok'],proposal_rejected:['Propuesta rechazada','alert'],proposal_consumed:['Propuesta aplicada','ok'],proposal_revoked:['Propuesta revocada','alert']};
const CHANGE_TABLES={'tasks.tabs':['área','áreas'],'tasks.families':['familia','familias'],'tasks.labels':['etiqueta','etiquetas'],'tasks.projects':['proyecto','proyectos'],'tasks.tasks':['tarea','tareas'],'tasks.project_labels':['etiqueta de proyecto','etiquetas de proyecto'],'tasks.task_labels':['etiqueta de tarea','etiquetas de tarea'],'tasks.task_dependencies':['dependencia','dependencias'],'tasks.saved_views':['vista','vistas'],'tasks.attachments':['adjunto','adjuntos']};
const CHANGE_FIELDS={title:'Nombre',name:'Nombre',note:'Nota',done:'Completada',status:'Estado',priority:'Prioridad',due:'Fecha objetivo',owner_label_id:'Responsable',parent_id:'Tarea padre',project_id:'Proyecto',position:'Posición',archived:'Archivada',color:'Color',budget:'Presupuesto',cost:'Coste',label_id:'Etiqueta',depends_on_id:'Depende de',filters:'Filtros',family_id:'Familia'};
const CHANGE_IGNORED=new Set(['id','revision','created_at','updated_at','updated_by','deleted_at','tab_id','archived_before_family','system_key','system']);
const when=value=>value?new Date(value).toLocaleString('es-ES',{dateStyle:'medium',timeStyle:'short'}):'—';

/* Hoja heredada con un cuerpo pintado por el kit: devuelve el contenedor `.ikisai-kit` donde montar las piezas. */
function kitSheet(title,intro=''){openSheet(`<h2 class="sheettitle">${esc(title)}</h2>${intro}<div class="ikisai-kit agentsheet" id="agentSheetBody"></div>`);return document.getElementById('agentSheetBody')}
function kitFoot(host,...buttons){const foot=IkisaiKit.el('div',{class:'btnrow agentsfoot',style:'position:sticky;bottom:0;padding:12px 0 4px;background:var(--paper);justify-content:flex-end'},...buttons);host.append(foot);return foot}

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
  if(value==null||value==='')return '';
  if(typeof value==='boolean')return value?'Sí':'No';
  if(field==='status')return {active:'Activo',paused:'Pausado',archived:'Archivado'}[value]||String(value);
  if(field==='priority')return {normal:'Normal',high:'Alta',critical:'Crítica'}[value]||String(value);
  if(field==='owner_label_id'||field==='label_id')return changeName('tasks.labels',value)||'otra etiqueta';
  if(field==='parent_id'||field==='depends_on_id')return changeName('tasks.tasks',value)||'otra tarea';
  if(field==='project_id')return changeName('tasks.projects',value)||'otro proyecto';
  if(field==='family_id')return changeName('tasks.families',value)||'otra familia';
  if(typeof value==='object')return JSON.stringify(value);
  return String(value)}
/* Un cambio del ensayo (`summary`) como fila de `renderChangeList`: operación, tabla traducida, título y campos. */
function describeChange(change){
  const row=change.after||change.before||{},[one,many]=CHANGE_TABLES[change.table]||[change.table,change.table];
  if(change.op==='call')return {op:'call',table:'procedimiento',tablePlural:'procedimientos',title:change.table||'Procedimiento',id:change.id};
  const title=row.title||row.name||changeName(change.table,change.id)||(row.task_id?changeName('tasks.tasks',row.task_id):null)||(row.project_id?changeName('tasks.projects',row.project_id):null)||'Sin nombre';
  const archiving=change.op==='update'&&(change.after?.status==='archived'&&change.before?.status!=='archived'||change.after?.archived===true&&change.before?.archived!==true);
  const fields=[];
  if(change.op==='update'||change.op==='restore'){
    for(const key of Object.keys(change.after||{})){if(CHANGE_IGNORED.has(key))continue;const a=change.before?.[key],b=change.after[key];if(JSON.stringify(a)!==JSON.stringify(b))fields.push({label:CHANGE_FIELDS[key]||key,before:changeValue(key,a),after:changeValue(key,b)})}
  }
  return {op:archiving?'archive':change.op,table:one,tablePlural:many,title,fields,id:change.id}}
const CHANGE_OPS={archive:'Archivar',call:'Ejecutar'};
/* Códigos de `risk.reasons` (núcleo y riesgo de Tasks) traducidos; el de lote masivo ya lo muestra el contador. */
function riskReasons(risk){const out=[],seen=new Set(),add=(label,tone)=>{if(!seen.has(label)){seen.add(label);out.push({label,tone})}};
  for(const code of risk?.reasons||[]){const [kind,what,id]=code.split(':');
    if(kind==='delete'&&what==='tab')add(`Borra el área «${changeName('tasks.tabs',id)||'otra área'}»`,'alert');
    else if(kind==='delete'&&what==='project')add(`Borra el proyecto «${changeName('tasks.projects',id)||'otro proyecto'}»`,'alert');
    else if(kind==='delete')add('Incluye borrados','alert');
    else if(kind==='call')add('Ejecuta un procedimiento','alert');
    else if(kind==='archive'&&what==='project')add(`Archiva el proyecto «${changeName('tasks.projects',id)||'otro proyecto'}»`,'warn');
    else if(kind==='archive'&&what==='family')add(`Archiva la familia «${changeName('tasks.families',id)||'otra familia'}»`,'warn');
    else if(kind==='archive'&&what==='label')add(`Archiva la etiqueta «${changeName('tasks.labels',id)||'otra etiqueta'}»`,'warn');
    else if(kind!=='bulk')add(code,'info');
  }
  return out}
function proposalSummary(x,names){return {id:x.id,agent:names.get(x.userId)||'Agente',status:x.status,createdAt:x.createdAt,expiresAt:x.expiresAt,affected:x.risk?.affected,reasons:riskReasons(x.risk)}}
function scopeAreas(){return state.tabs.filter(t=>!t.deleted).map(t=>({id:t.id,name:t.name,projects:t.projects.filter(p=>!p.deleted&&!p.system).map(p=>({id:p.id,name:p.title}))}))}

accessesSheet=async function(){
  if(!isAdministrator())return;
  const K=IkisaiKit;let host=kitSheet('Agentes de IA','<p>Cargando…</p>');
  try{const {items}=await Sync.core.api('/agents');Sync.agents=items;
    host=kitSheet('Agentes de IA','<p class="small muted">Cada agente entra con su propia clave y trabaja con el permiso y las áreas que le des. Lo que borra, archiva o toca 10 elementos o más espera tu aprobación en «Propuestas de agentes».</p>');
    host.append(K.el('button',{class:'primary',type:'button',id:'newAgent','data-feedback-id':'tasks.agentes.lista.crear','data-feedback-label':'Crear agente',onclick:createAccessSheet},K.icon('bot',18),K.el('span',null,'Crear agente')));
    if(!items.length)host.append(K.el('p',{class:'empty'},'Todavía no hay agentes.'));
    for(const a of items){
      const status=a.revokedAt?`Revocada el ${when(a.revokedAt)}`:a.lastUsedAt?`Último uso: ${when(a.lastUsedAt)}`:'Sin usar todavía';
      host.append(K.el('section',{class:'agentrow card',dataset:{agent:a.keyId}},
        K.el('div',{class:'pr-top'},K.el('strong',null,a.name),K.el('span',{class:`chip small${a.revokedAt?' trash':''}`,'data-feedback-ignore':true},K.el('span',null,`clave …${a.hint}`))),
        K.el('p',{class:'row-meta'},`${AGENT_ROLES[a.role]||a.role} · ${accessScopeText(a.scopes==null?'*':a.scopes)}`),
        K.el('p',{class:'row-meta'},status+(a.expiresAt&&!a.revokedAt?` · caduca el ${when(a.expiresAt)}`:'')),
        a.revokedAt?null:K.el('button',{class:'ghost danger-text',type:'button','data-feedback-id':'tasks.agentes.lista.revocar','data-feedback-label':'Revocar clave',dataset:{revokeAgent:a.keyId},onclick:()=>revokeAgentSheet(a)},'Revocar clave')));
    }
  }catch(e){toast(e.message||'No se pudieron cargar los agentes.')}
};
createAccessSheet=function(){
  if(!isAdministrator())return;
  const K=IkisaiKit,host=kitSheet('Crear agente');
  const name=K.el('input',{id:'agentName','data-feedback-id':'tasks.agentes.nuevo.nombre','data-feedback-label':'Nombre',maxlength:'100',placeholder:'Por ejemplo: Asistente de obra'});
  const role=K.el('select',{id:'agentRole','data-feedback-id':'tasks.agentes.nuevo.permiso','data-feedback-label':'Permiso'},K.el('option',{value:'editor'},'Editar'),K.el('option',{value:'reader'},'Solo lectura'));
  const scopes=K.createScopePicker({areas:scopeAreas(),value:'*',label:'Áreas y proyectos'});
  const save=K.el('button',{class:'primary',type:'button',id:'saveAgent','data-feedback-id':'tasks.agentes.nuevo.crear','data-feedback-label':'Crear y mostrar la clave'},'Crear y mostrar la clave');
  host.append(K.el('label',{class:'field'},K.el('span',null,'Nombre'),name),K.el('label',{class:'field'},K.el('span',null,'Permiso'),role),scopes.element);
  kitFoot(host,save);
  save.onclick=async()=>{
    const agentName=name.value.trim();
    if(!agentName)return toast('Pon un nombre al agente.');
    if(scopes.isEmpty())return toast('Elige al menos un área o un proyecto.');
    save.disabled=true;
    try{const issued=await Sync.core.api('/agents',{method:'POST',json:{name:agentName,role:role.value,scopes:scopes.get()}});
      const shown=kitSheet(`Clave de ${issued.name}`,'<p>Configúrala en el agente. Con ella entra en Ikisai con el permiso y las áreas que le has dado.</p>');
      shown.append(K.renderSecretOnce({value:issued.token,label:'Clave del agente',onDone:accessesSheet,valueAttrs:{id:'issuedAgentKey','data-feedback-ignore':true},copyAttrs:{id:'copyAgentKey','data-feedback-id':'tasks.agentes.clave.copiar','data-feedback-label':'Copiar clave'},doneAttrs:{id:'agentDone','data-feedback-id':'tasks.agentes.clave.hecho','data-feedback-label':'Hecho'}}));
    }catch(e){save.disabled=false;toast(e.message||'No se pudo crear el agente.')}
  };
};
function revokeAgentSheet(agent){
  if(!agent)return;
  const K=IkisaiKit,host=kitSheet(`Revocar la clave de ${agent.name}`,'<p>El agente dejará de poder entrar en todas las apps de Ikisai al momento, y sus propuestas pendientes o aprobadas quedarán revocadas. No se puede deshacer: para volver a darle acceso, crea otra clave.</p>');
  const confirm=K.el('button',{class:'danger',type:'button',id:'confirmRevokeAgent','data-feedback-id':'tasks.agentes.revocar.confirmar','data-feedback-label':'Revocar'},'Revocar');
  kitFoot(host,K.el('button',{class:'ghost',type:'button','data-feedback-id':'tasks.agentes.revocar.cancelar','data-feedback-label':'Cancelar',onclick:accessesSheet},'Cancelar'),confirm);
  confirm.onclick=async()=>{confirm.disabled=true;
    try{const out=await Sync.core.api('/agents/'+encodeURIComponent(agent.keyId),{method:'DELETE'});await accessesSheet();toast(out.proposalsRevoked?`Clave revocada y ${out.proposalsRevoked} ${out.proposalsRevoked===1?'propuesta revocada':'propuestas revocadas'}.`:'Clave revocada.')}catch(e){confirm.disabled=false;toast(e.message)}};
}

async function agentNames(){
  if(!Sync.agents){try{Sync.agents=(await Sync.core.api('/agents')).items}catch{Sync.agents=[]}}
  if(!Sync.members){try{Sync.members=await Sync.core.api('/members')}catch{Sync.members=[]}}
  const names=new Map(),kinds=new Map();
  for(const m of Sync.members||[]){names.set(m.userId,m.displayName||'Sin nombre');kinds.set(m.userId,m.kind==='agent'?'agent':'person')}
  for(const a of Sync.agents||[]){names.set(a.userId,a.name);kinds.set(a.userId,'agent')}
  return {names,kinds}}
proposalsSheet=async function(){
  if(!isAdministrator())return;
  const K=IkisaiKit;let host=kitSheet('Propuestas de agentes','<p>Cargando…</p>');
  try{const [{items},{names}]=await Promise.all([Sync.core.api('/proposals'),agentNames()]);
    host=kitSheet('Propuestas de agentes','<p class="small muted">Aprobar autoriza ese lote exacto durante 24 horas desde que se preparó; no lo ejecuta. El agente lo envía después. Si los datos han cambiado y ya no encaja, se rechaza y el agente tiene que prepararlo de nuevo.</p>');
    if(!items.length)host.append(K.el('p',{class:'empty'},'No hay propuestas.'));
    for(const x of items)host.append(K.renderProposalRow({...proposalSummary(x,names),attrs:{'data-review-proposal':x.id,'data-feedback-id':'tasks.agentes.propuestas.revisar','data-feedback-label':'Revisar propuesta'},onOpen:()=>reviewProposalSheet(x,names)}));
  }catch(e){toast(e.message||'No se pudieron cargar las propuestas.')}
};
reviewProposalSheet=function(proposal,names=new Map()){
  if(!proposal)return;
  const K=IkisaiKit,summary=proposalSummary(proposal,names),changes=(proposal.summary||[]).map(describeChange);
  const canApprove=isAdministrator()&&proposal.status==='pending',canReject=isAdministrator()&&['pending','approved'].includes(proposal.status);
  const host=kitSheet('Revisar propuesta');
  const expiry=['pending','approved'].includes(proposal.status)&&proposal.expiresAt?` · caduca ${K.relativeTime(proposal.expiresAt)}`:'';
  host.append(...[
    K.el('div',{class:'pr-top'},K.el('strong',{class:'pr-agent'},summary.agent),K.proposalStatusChip(proposal.status)),
    K.el('p',{class:'pr-meta'},`Preparada ${when(proposal.createdAt)}${expiry}`),
    K.renderRiskSummary({affected:summary.affected??changes.length,threshold:proposal.risk?.bulkThreshold,reasons:summary.reasons}),
    proposal.reason?K.el('p',{class:'hint'},proposal.reason):null,
    K.renderChangeList({changes,opLabels:CHANGE_OPS}),
    K.el('p',{class:'hint'},'El resumen es el de cuando se preparó; si algo ha cambiado desde entonces, aprobar lo comprueba de nuevo.')].filter(Boolean));
  const decide=async(kind,button)=>{host.querySelectorAll('.agentsfoot button').forEach(b=>b.disabled=true);
    try{await Sync.core.api(`/proposals/${encodeURIComponent(proposal.id)}/${kind}`,{method:'POST',json:{}});await proposalsSheet();toast(kind==='approve'?'Propuesta aprobada. El agente ya puede aplicarla.':'Propuesta rechazada.')}
    catch(e){if(e.code==='PROPOSAL_UNAVAILABLE'){await proposalsSheet();toast('Los datos han cambiado y el lote ya no encaja: queda rechazada y el agente debe prepararla de nuevo.');return}host.querySelectorAll('.agentsfoot button').forEach(b=>b.disabled=false);toast(e.message)}};
  const buttons=[];
  if(canReject)buttons.push(K.el('button',{class:'ghost danger-text',type:'button',id:'rejectProposal','data-feedback-id':'tasks.agentes.propuesta.rechazar','data-feedback-label':'Rechazar',onclick:e=>decide('reject',e.currentTarget)},'Rechazar'));
  if(canApprove)buttons.push(K.el('button',{class:'primary',type:'button',id:'approveProposal','data-feedback-id':'tasks.agentes.propuesta.aprobar','data-feedback-label':'Aprobar',onclick:e=>decide('approve',e.currentTarget)},changes.length===1?'Aprobar el cambio':`Aprobar ${changes.length} cambios`));
  if(buttons.length)kitFoot(host,...buttons);
};
accessLogSheet=async function(before=null){
  if(!isAdministrator())return;
  const K=IkisaiKit;
  try{const [page,{names,kinds}]=await Promise.all([Sync.core.api('/access-log'+(before?'?before='+encodeURIComponent(before):'')),agentNames()]);
    const previous=before?(Sync.accessLog||[]):[];Sync.accessLog=[...previous,...page.items];
    const host=kitSheet('Registro de accesos');
    host.append(K.renderAccessLog({emptyText:'Sin actividad registrada.',entries:Sync.accessLog.map(x=>{const [label,tone]=ACCESS_EVENTS[x.event]||[x.event];return {at:x.at,label,tone,actor:x.actorId?(names.get(x.actorId)||'otra cuenta'):undefined,actorKind:x.actorId?kinds.get(x.actorId):undefined,target:x.meta?.name}})}));
    if(page.hasMore)host.append(K.el('button',{class:'ghost',type:'button',id:'olderAccessLog','data-feedback-id':'tasks.agentes.registro.ver_anteriores','data-feedback-label':'Ver anteriores',onclick:()=>accessLogSheet(page.nextBefore)},'Ver anteriores'));
  }catch(e){toast(e.message||'No se pudo cargar el registro.')}
};
