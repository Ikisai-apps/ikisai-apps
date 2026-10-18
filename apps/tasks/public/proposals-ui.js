/* Ikisai Tasks · O1, pasos 3 y 4 (docs/tasks/API.md §31): propuestas del outsider, su interfaz y «Abrir a…».
   - Propuestas (sugerencias del núcleo, contrato §3.10; necesitan red):
     · el outsider no crea: el «+» (FAB, «+ Añadir tarea», «Con detalles…») abre «Proponer tarea» (título, nota, proyecto
       entre los abiertos y una foto opcional); en la ficha de una tarea, «Proponer un cambio» (un paso nuevo o una línea en
       la nota). Lo sigue en «Mis propuestas» (createProposalList del kit, modo `mine`): estado, comentario y «Retirar».
     · decide staff o dirección (editor u owner humano) en «Por clasificar», arriba, «Propuestas (n)» (modo `review`):
       aprobar con el proyecto de destino editable (tarea nueva) o descartar con un comentario. Al aprobar se sincroniza.
     · el lote lo construye el dominio (IkisaiTasks/Sync.core.suggestionOps) y el servidor lo comprueba al proponer
       (tasks.suggestion_check: solo en lo abierto) y al aprobar (commit de quien aprueba).
   - Interfaz del outsider: menú reducido (Inicio, Proyectos, Todas las tareas, Mis propuestas y su cuenta), sin la pestaña
     «Etiquetas» de abajo, y ninguna otra vista ni acción se abre (ni por el menú, ni por URL o hash, ni por la paleta).
   - «Abrir a…» en el editor del proyecto (propietaria con acceso a todo): una casilla por outsider de Tasks; al guardar se
     abre o se cierra el proyecto en sus ámbitos con la acción `tasks.outsider_scopes` (el rol no se toca). La misma acción
     guarda las áreas y proyectos de un outsider en «Cuentas de personas» (cloud-auth.js). */
Object.assign(menuPaths,{proposal:'M4 4h16v12H8l-4 4z M8 9h8 M8 12h5'});

function outsiderMode(){return !!Sync.actor?.outsider&&!Sync.secondary}
function canDecideProposals(){const a=Sync.actor;return !!a&&!Sync.secondary&&a.kind!=='agent'&&['editor','owner'].includes(a.role)}
const PROPOSAL_KINDS={tarea:{label:'Tarea nueva'},anadido:{label:'Añadido a una tarea'}};
const PROPOSAL_NETWORK='Sin conexión: las propuestas necesitan red.';
const PROPOSAL_PHOTO_LIMIT=25*1024*1024;
function proposalClient(){return Sync.core?.client}
function proposalError(e){return IkisaiKit.suggestionErrorMessage(e)}
/* Todas son de Tasks: sin «· tasks» en cada tarjeta. */
function withoutApp(item){return {...item,app:null}}
/* Un editor por proyecto solo ve aquí las propuestas de lo suyo (el núcleo se las da todas: ver riesgos en API.md §31). */
function decidable(s){const scopes=Sync.actor?.scopes;if(scopes==='*'||scopes==null)return true;const pid=s.detail?.projectId;return !!pid&&(Sync.core?.data?.['tasks.projects']||[]).some(p=>p.id===pid&&!p.deleted_at)}

/* --- Proyectos abiertos (los que ve el outsider; los de sistema, como la Entrada, no) ----------------------------- */
function proposableProjects(){return state.tabs.filter(t=>!t.deleted).flatMap(t=>t.projects.filter(p=>!p.deleted&&p.status!=='archived'&&!p.system).map(p=>({tab:t,p})))}
function projectOptionsHtml(selected,list=proposableProjects()){const byTab=new Map();for(const x of list){if(!byTab.has(x.tab.id))byTab.set(x.tab.id,{tab:x.tab,items:[]});byTab.get(x.tab.id).items.push(x.p)}
  const option=p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.title)}</option>`;
  return [...byTab.values()].map(g=>byTab.size>1?`<optgroup label="${esc(g.tab.name)}">${g.items.map(option).join('')}</optgroup>`:g.items.map(option).join('')).join('')}

/* --- Foto: la misma recompresión que los adjuntos (1600 px en WebP); se sube al enviar --------------------------- */
async function proposalPhotoFrom(file){
  if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw Error('Solo fotos: JPEG, PNG o WebP.');
  let image;try{image=await createImageBitmap(file)}catch{throw Error('No se pudo leer esta imagen.')}
  let blob;try{const scale=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.7))}finally{image.close()}
  if(!blob)throw Error('No se pudo comprimir la foto.');
  if(blob.size>PROPOSAL_PHOTO_LIMIT)throw Error('Máximo 25 MB por foto.');
  return {blob,name:file.name.replace(/\.[^.]+$/,'')+'.webp',mime:blob.type||'image/webp',url:URL.createObjectURL(blob)}}

/* --- Enviar ---------------------------------------------------------------------------------------------------- */
async function sendSuggestion(kind,summary,detail,operations){
  const client=proposalClient();if(!client)throw Error('Inicia sesión primero.');
  if(!navigator.onLine)throw Error(PROPOSAL_NETWORK);
  const s=await client.suggest({kind,summary:summary.slice(0,300),detail,operations});
  mineProposals?.refresh();return s}

/* «Proponer tarea»: título obligatorio, nota, proyecto entre los abiertos y una foto opcional. */
let proposeDraft=null;
function proposeTaskSheet(projectId=null){
  if(!outsiderMode())return;const list=proposableProjects();
  if(!list.length)return toast('Todavía no tienes ningún proyecto abierto en el que proponer.');
  const current=projectId&&list.some(x=>x.p.id===projectId)?projectId:(project()&&list.some(x=>x.p.id===project().id)?project().id:list[0].p.id);
  proposeDraft={photo:null};
  openSheet(`<h2 class="sheettitle">Proponer tarea</h2><p class="small muted">Staff o dirección la verán y decidirán. La sigues en «Mis propuestas».</p>
    <div class="ikisai-kit proposeform" data-feedback-id="tasks.proponer_tarea" data-feedback-label="Proponer tarea">
      <label class="field"><span>Título</span><input id="proposeTitle" maxlength="1000" required autocomplete="off" data-feedback-id="tasks.proponer_tarea.titulo" data-feedback-label="Título"></label>
      <label class="field"><span>Nota (opcional)</span><textarea id="proposeNote" rows="3" maxlength="20000" data-feedback-id="tasks.proponer_tarea.nota" data-feedback-label="Nota"></textarea></label>
      <label class="field"><span>Proyecto</span><select id="proposeProject" data-feedback-id="tasks.proponer_tarea.proyecto" data-feedback-label="Proyecto">${projectOptionsHtml(current,list)}</select></label>
      <div class="field"><span>Foto (opcional)</span><div class="proposephoto"><label class="softbtn small" data-feedback-id="tasks.proponer_tarea.foto" data-feedback-label="Añadir foto"><input type="file" id="proposePhoto" accept="image/jpeg,image/png,image/webp" hidden>📷 Foto</label><span id="proposePhotoPreview"></span></div></div>
    </div>
    <div class="actions"><button class="ghost" type="button" id="proposeCancel" data-feedback-id="tasks.proponer_tarea.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="primary" type="button" id="proposeSend" data-feedback-id="tasks.proponer_tarea.enviar" data-feedback-label="Proponer">Proponer</button></div>`);
  const title=document.getElementById('proposeTitle'),send=document.getElementById('proposeSend'),picker=document.getElementById('proposePhoto'),preview=document.getElementById('proposePhotoPreview');
  title.focus();
  const drawPhoto=()=>{const p=proposeDraft?.photo;preview.innerHTML=p?`<img src="${esc(p.url)}" alt="Foto elegida"><button type="button" class="commentaction" id="proposePhotoRemove" aria-label="Quitar la foto">×</button>`:'';const r=document.getElementById('proposePhotoRemove');if(r)r.onclick=()=>{proposeDraft.photo=null;drawPhoto()}};
  picker.onchange=async()=>{const file=picker.files?.[0];picker.value='';if(!file)return;send.disabled=true;try{proposeDraft.photo=await proposalPhotoFrom(file);drawPhoto()}catch(e){toast(e.message||'No se pudo usar la foto.')}finally{send.disabled=false}};
  document.getElementById('proposeCancel').onclick=()=>closeSheet();
  send.onclick=async()=>{const text=title.value.trim(),note=document.getElementById('proposeNote').value.trim(),pid=document.getElementById('proposeProject').value;
    if(!text){title.focus();return toast('Escribe un título.')}
    const target=list.find(x=>x.p.id===pid);if(!target)return toast('Elige un proyecto.');
    send.disabled=true;send.textContent='Enviando…';
    try{
      if(!navigator.onLine)throw Error(PROPOSAL_NETWORK);
      const photo=proposeDraft?.photo?await Sync.core.uploadNow(proposeDraft.photo.blob,{filename:proposeDraft.photo.name,mime:proposeDraft.photo.mime}):null;
      const operations=Sync.core.suggestionOps('tarea',{projectId:pid,title:text,note,photo});
      await sendSuggestion('tarea',text,{kind:'tarea',title:text,note,projectId:pid,tabId:target.tab.id,projectTitle:target.p.title,photo:photo?{name:photo.name}:null},operations);
      proposeDraft=null;closeSheet();toast('Propuesta enviada. La verás en «Mis propuestas».')}
    catch(e){send.disabled=false;send.textContent='Proponer';toast(proposalError(e))}}}

/* «Proponer un cambio» en la ficha de una tarea: un paso nuevo o una línea en la nota. */
function proposeChangeSheet(taskId){
  if(!outsiderMode())return;const loc=taskLocation(taskId);if(!loc)return;
  openSheet(`<h2 class="sheettitle">Proponer un cambio</h2><p class="small muted" data-feedback-ignore>En «${esc(loc.t.text)}». Staff o dirección lo verán y decidirán.</p>
    <div class="ikisai-kit proposeform" data-feedback-id="tasks.proponer_cambio" data-feedback-label="Proponer un cambio">
      <div class="segmented" role="group" aria-label="Qué propones"><button type="button" class="on" aria-pressed="true" data-change-mode="step" data-feedback-id="tasks.proponer_cambio.paso" data-feedback-label="Un paso nuevo">Un paso nuevo</button><button type="button" aria-pressed="false" data-change-mode="note" data-feedback-id="tasks.proponer_cambio.nota" data-feedback-label="Una línea en la nota">Una línea en la nota</button></div>
      <label class="field"><span id="proposeChangeLabel">Paso</span><input id="proposeChangeText" maxlength="1000" autocomplete="off" data-feedback-id="tasks.proponer_cambio.texto" data-feedback-label="Texto"></label>
    </div>
    <div class="actions"><button class="ghost" type="button" id="proposeChangeCancel" data-feedback-id="tasks.proponer_cambio.cancelar" data-feedback-label="Volver a la tarea">Volver</button><button class="primary" type="button" id="proposeChangeSend" data-feedback-id="tasks.proponer_cambio.enviar" data-feedback-label="Proponer">Proponer</button></div>`);
  let mode='step';const text=document.getElementById('proposeChangeText'),send=document.getElementById('proposeChangeSend');text.focus();
  document.querySelectorAll('[data-change-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.changeMode;document.querySelectorAll('[data-change-mode]').forEach(x=>{const on=x===b;x.classList.toggle('on',on);x.setAttribute('aria-pressed',String(on))});document.getElementById('proposeChangeLabel').textContent=mode==='step'?'Paso':'Línea para la nota';text.focus()});
  document.getElementById('proposeChangeCancel').onclick=()=>openTaskEditor(taskId);
  send.onclick=async()=>{const value=text.value.trim();if(!value){text.focus();return toast(mode==='step'?'Escribe el paso.':'Escribe la línea que quieres añadir.')}
    const now=taskLocation(taskId);if(!now)return toast('Esa tarea ya no está disponible.');
    send.disabled=true;send.textContent='Enviando…';
    try{const operations=Sync.core.suggestionOps(mode,{taskId,title:value,line:value});
      const summary=mode==='step'?`Paso en «${now.t.text}»: ${value}`:`Nota de «${now.t.text}»: ${value}`;
      await sendSuggestion('anadido',summary,{kind:'anadido',mode,taskId,taskTitle:now.t.text,projectId:now.p.id,tabId:tab().id,text:value},operations);
      closeSheet();toast('Propuesta enviada. La verás en «Mis propuestas».')}
    catch(e){send.disabled=false;send.textContent='Proponer';toast(proposalError(e))}}}

/* --- «Mis propuestas» (outsider) -------------------------------------------------------------------------------- */
let mineProposals=null;
function mineProposalList(){if(mineProposals||!proposalClient())return mineProposals;const K=IkisaiKit,kitSource=K.createSuggestionSource(proposalClient(),{scope:'mine'}),source={...kitSource,list:async()=>(await kitSource.list()).map(withoutApp)};
  mineProposals=K.createProposalList({mode:'mine',source,kinds:PROPOSAL_KINDS,onWithdraw:kitSource.withdraw,onCreate:()=>proposeTaskSheet(),feedbackId:'tasks.mis_propuestas',emptyText:'Aún no has propuesto nada. Con el «+» propones una tarea; en la ficha de una tarea, un cambio.'});
  return mineProposals}
function myProposalsView(){return `<main class="screen myproposals"><div class="screenhead"><div><h1 class="title">Mis propuestas</h1><p class="subtitle">Lo que has propuesto y cómo va. Staff o dirección deciden.</p></div></div>${navigator.onLine?'':`<div class="notice">${PROPOSAL_NETWORK}</div>`}<div class="ikisai-kit" id="myProposalsMount"></div></main>`}

/* --- Decidir en «Por clasificar» (editor u owner humano) --------------------------------------------------------- */
let reviewProposals=null,reviewItems=new Map(),reviewTarget=new Map(),proposalPending=0;
function reviewSource(){const client=proposalClient(),K=IkisaiKit;let pending=null;
  return {async list(){try{const res=await client.suggestions({scope:'all',limit:100});pending=res.pendingCount;setProposalPending(res.pendingCount??0);reviewItems=new Map(res.items.map(s=>[s.id,s]));return res.items.filter(decidable).map(x=>withoutApp(K.proposalFromSuggestion(x)))}catch(e){throw Error(proposalError(e))}},
    pendingCount:()=>pending}}
async function approveProposal(item,comment){const s=reviewItems.get(item.id),client=proposalClient();
  if(!navigator.onLine)throw Error(PROPOSAL_NETWORK);
  let operations=null;try{operations=Sync.core.approvalOps(s?.detail,s?.operations||[],{projectId:reviewTarget.get(item.id)||null})}catch(e){throw Error(e.message||'No se pudo preparar el lote.')}
  try{await client.decideSuggestion(item.id,'approve',{...(comment?{comment}:{}),...(operations?{operations}:{})})}catch(e){throw Error(proposalError(e))}
  reviewTarget.delete(item.id);
  // La tarea aparece en cuanto llega el cambio (también al outsider, en su próximo ciclo).
  Sync.core.sync().catch(()=>{});setProposalPending(Math.max(0,proposalPending-1))}
async function rejectProposal(item,comment){if(!navigator.onLine)throw Error(PROPOSAL_NETWORK);try{await proposalClient().decideSuggestion(item.id,'reject',comment?{comment}:{})}catch(e){throw Error(proposalError(e))}setProposalPending(Math.max(0,proposalPending-1))}

/* Detalle: qué se propone y, en una tarea nueva pendiente, el proyecto de destino (editable). */
function proposalDetail(item){const K=IkisaiKit,d=item.detail||{},rows=Sync.core?.data||{};
  const projectRow=id=>(rows['tasks.projects']||[]).find(p=>p.id===id&&!p.deleted_at),taskRow=id=>(rows['tasks.tasks']||[]).find(t=>t.id===id&&!t.deleted_at);
  const box=K.el('div',{class:'proposaldetail'});
  if(d.kind==='tarea'){
    box.append(K.el('p',null,K.el('strong',null,'Título: '),d.title||item.summary));
    if(d.note)box.append(K.el('p',{class:'proposalnote'},K.el('strong',null,'Nota: '),d.note));
    if(item.status==='pending'&&canDecideProposals()){
      const options=(rows['tasks.projects']||[]).filter(p=>!p.deleted_at&&p.status!=='archived'&&!p.system).map(p=>({p,t:(rows['tasks.tabs']||[]).find(t=>t.id===p.tab_id&&!t.deleted_at)})).filter(x=>x.t);
      const select=K.el('select',{'data-proposal-target':item.id,'data-feedback-id':'tasks.por_clasificar.propuestas.destino','data-feedback-label':'Proyecto de destino',onchange:e=>{const v=e.target.value;if(v===d.projectId)reviewTarget.delete(item.id);else reviewTarget.set(item.id,v)}},
        ...options.map(({p,t})=>K.el('option',{value:p.id,selected:(reviewTarget.get(item.id)||d.projectId)===p.id?'':null},`${t.name} · ${p.title}`)));
      if(!options.some(x=>x.p.id===d.projectId))select.prepend(K.el('option',{value:d.projectId,selected:''},`${d.projectTitle||'Proyecto'} (no disponible)`));
      box.append(K.el('label',{class:'field'},K.el('span',null,'Proyecto de destino'),select));
    }else box.append(K.el('p',null,K.el('strong',null,'Proyecto: '),projectRow(d.projectId)?.title||d.projectTitle||'—'));
    if(d.photo){const s=reviewItems.get(item.id),file=(s?.operations||[]).find(o=>o.table==='tasks.attachments')?.fields?.file_id;
      const img=K.el('img',{class:'proposalphoto',alt:'Foto de la propuesta',onerror:()=>img.classList.add('missing')});box.append(img);
      if(file)proposalClient().fileUrl(file).then(url=>{img.src=url}).catch(()=>{img.alt='No se pudo cargar la foto';img.classList.add('missing')})}
  }else if(d.kind==='anadido'){
    const task=taskRow(d.taskId);
    box.append(K.el('p',null,K.el('strong',null,'Tarea: '),task?.title||d.taskTitle||'—'));
    box.append(K.el('p',null,K.el('strong',null,d.mode==='step'?'Paso nuevo: ':'Línea para la nota: '),d.text||''));
    if(d.mode==='note'&&task?.note)box.append(K.el('p',{class:'small muted proposalnote'},'Nota de ahora: '+task.note));
  }else box.append(K.el('p',{class:'hint'},item.summary));
  return box}

function reviewProposalList(){if(reviewProposals||!proposalClient()||!canDecideProposals())return reviewProposals;
  reviewProposals=IkisaiKit.createProposalList({mode:'review',source:reviewSource(),kinds:PROPOSAL_KINDS,canDecide:true,onApprove:approveProposal,onReject:rejectProposal,renderDetail:proposalDetail,feedbackId:'tasks.por_clasificar.propuestas',label:'Propuestas',emptyText:'No hay propuestas pendientes.'});
  return reviewProposals}
function setProposalPending(n){n=Number(n)||0;if(n===proposalPending)return;proposalPending=n;const title=document.getElementById('proposalReviewTitle');if(title)title.textContent=`Propuestas (${n})`;if(Sync.actor&&state.tabs.length)render()}
let proposalCountAt=0;
async function refreshProposalCount(force=false){if(!canDecideProposals()||!proposalClient()||!navigator.onLine)return;if(!force&&Date.now()-proposalCountAt<30000)return;proposalCountAt=Date.now();
  try{const res=await proposalClient().suggestions({scope:'pending',limit:1});setProposalPending(res.pendingCount??res.items.length)}catch{}}
/* Ámbitos que cambian en el servidor («Abrir a…», Cuentas de personas): se comprueban al volver a la app y cada minuto. */
function refreshMembershipSoon(){if(!Sync.core?.refreshMembership||Sync.secondary||!Sync.actor||!navigator.onLine)return;Sync.core.refreshMembership().catch(()=>{})}
window.addEventListener('focus',()=>{refreshProposalCount();refreshMembershipSoon()});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshMembershipSoon()});
setInterval(()=>{refreshProposalCount();refreshMembershipSoon()},60000);

/* --- Menú ------------------------------------------------------------------------------------------------------- */
const OUTSIDER_VIEWS=new Set(['home','projects','project','tasks','myproposals']);
const OUTSIDER_ACTIONS=new Set(['sessions','filters','proposeTask']);
const navigationGroupsBeforeProposals=navigationGroups;
navigationGroups=function(){
  if(outsiderMode())return [
    {id:'work',name:'Trabajo',icon:'tasks',items:[['home','Inicio','home','view'],['projects','Proyectos','grid','view'],['tasks','Todas las tareas','tasks','view'],['myproposals','Mis propuestas','proposal','view']]},
    {id:'people',name:'Tu cuenta',icon:'people',items:[['sessions','Mi cuenta','key','action',!!Sync.actor]]}];
  const groups=navigationGroupsBeforeProposals();
  if(!canDecideProposals()||!proposalPending)return groups;
  // Con propuestas pendientes, «Por clasificar» sale también para quien decide y suma las dos cosas.
  const work=groups.find(g=>g.id==='work');if(!work)return groups;
  const at=work.items.findIndex(i=>i[0]==='triage'),requests=typeof pendingCount==='function'?pendingCount():0,n=requests+proposalPending;
  const item=['triage',`Por clasificar · ${n}`,'triage','view'];
  if(at>=0)work.items[at]=item;else work.items.unshift(item);
  return groups};
const topActionBeforeProposals=handleTopAction;
handleTopAction=function(action){if(outsiderMode()&&!OUTSIDER_ACTIONS.has(action)){closeNavigation?.();return toast('Eso no está disponible con tu acceso.')}if(action==='proposeTask')return proposeTaskSheet();return topActionBeforeProposals(action)};

/* --- Vistas: el outsider solo abre las suyas (también por URL, hash o vista recordada) ----------------------------- */
const mainBeforeProposals=main;
main=function(){
  if(outsiderMode()&&!OUTSIDER_VIEWS.has(state.view)){state.view='projects';state.currentProject=null;persistUI()}
  if(state.view==='myproposals')return outsiderMode()?myProposalsView():(state.view='projects',mainBeforeProposals());
  return mainBeforeProposals()};
const fabBeforeProposals=fab;
fab=function(){return outsiderMode()&&state.view==='myproposals'?'':fabBeforeProposals()};

/* Después de cada pintado: montar las listas del kit y, para el outsider, el «+» que propone. */
const renderBeforeProposals=render;
render=function(...args){const result=renderBeforeProposals(...args);
  if(!Sync.actor||!state.tabs.length)return result;
  if(state.view==='myproposals'){const mount=document.getElementById('myProposalsMount'),list=mineProposalList();if(mount&&list){mount.replaceChildren(list.element);if(proposalViewChanged('myproposals'))list.refresh()}}
  else if(state.view==='triage'&&canDecideProposals())mountReview();
  else proposalViewChanged(state.view);
  if(outsiderMode())outsiderShell();
  return result};
let proposalLastView='';
function proposalViewChanged(view){const changed=view!==proposalLastView;proposalLastView=view;return changed}
function mountReview(){const list=reviewProposalList();if(!list)return;const main=document.querySelector('#view main.screen');if(!main)return;
  const section=document.createElement('section');section.className='inboxgroup proposalreview';section.id='proposalReview';section.dataset.feedbackId='tasks.por_clasificar.propuestas';section.dataset.feedbackLabel='Propuestas';
  section.innerHTML=`<h2 class="sectionlabel" id="proposalReviewTitle">Propuestas (${proposalPending})</h2><div class="ikisai-kit" id="proposalReviewMount"></div>`;
  const head=main.querySelector(':scope > .screenhead')||main.querySelector(':scope > h1');if(head)head.after(section);else main.prepend(section);
  section.querySelector('#proposalReviewMount').append(list.element);
  if(proposalViewChanged('triage'))list.refresh()}

function outsiderShell(){
  // Abajo, sin «Etiquetas» (no es para él).
  document.querySelectorAll('[data-nav="labels"]').forEach(b=>{b.hidden=true});
  // El «+» propone: FAB, «+ Añadir tarea» y «Con detalles…».
  const fabBtn=document.getElementById('fab');if(fabBtn){fabBtn.disabled=false;fabBtn.setAttribute('aria-label','Proponer tarea');fabBtn.onclick=()=>proposeTaskSheet(state.view==='project'?project()?.id:null)}
  document.querySelectorAll('[data-add-task]').forEach(b=>{b.disabled=false;b.textContent='+ Proponer tarea';b.onclick=()=>proposeTaskSheet(b.dataset.addTask)});
  const quick=document.getElementById('quickAdd');if(quick){quick.disabled=false;quick.hidden=true}}

/* Ninguna vía abre el editor de crear para el outsider: el de tarea nueva propone, el de proyecto no se abre. */
const taskEditorBeforeProposals=openTaskEditor;
openTaskEditor=function(id,...rest){
  if(outsiderMode()&&!id)return proposeTaskSheet(project()?.id||null);
  taskEditorBeforeProposals(id,...rest);
  if(!outsiderMode()||!id||!taskLocation(id))return;
  const actions=document.querySelector('#sheet .actions');if(!actions||document.getElementById('proposeChange'))return;
  actions.insertAdjacentHTML('afterbegin','<button type="button" class="softbtn" id="proposeChange" data-feedback-id="tasks.editor_tarea.proponer_cambio" data-feedback-label="Proponer un cambio">Proponer un cambio</button>');
  document.getElementById('proposeChange').onclick=()=>proposeChangeSheet(id)};
const projectEditorBeforeProposals=openProjectEditor;
openProjectEditor=function(id,...rest){if(outsiderMode()&&!id)return proposeTaskSheet();projectEditorBeforeProposals(id,...rest);mountOpenTo(id)};

/* Al llegar datos nuevos: «Mis propuestas» se vuelve a leer (una decisión trae su tarea), como mucho cada 3 s. */
let proposalDataAt=0,proposalListening=false;
function listenProposals(){if(proposalListening||!Sync.core)return;proposalListening=true;
  Sync.core.onChange(kind=>{if(kind!=='data')return;if(state.view==='myproposals'&&mineProposals&&Date.now()-proposalDataAt>3000){proposalDataAt=Date.now();mineProposals.refresh()}});
  refreshProposalCount(true)}
const enterSessionBeforeProposals=enterSession;
enterSession=async function(...args){const result=await enterSessionBeforeProposals(...args);
  // Otra cuenta: las listas se rehacen con su cliente y sus permisos.
  mineProposals?.destroy();mineProposals=null;reviewProposals?.destroy();reviewProposals=null;proposalPending=0;proposalCountAt=0;proposalLastView='';
  listenProposals();refreshProposalCount(true);return result};

/* --- «Abrir a…» en el editor del proyecto (propietaria con acceso a todo) ----------------------------------------- */
function outsiderMembers(){return (Sync.members||[]).filter(m=>m.role==='outsider').sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','es'))}
function outsiderScopesOf(m){const s=m.scopes;if(s==null||s==='*')return {tabs:[],projects:{}};if(Array.isArray(s))return {tabs:s,projects:{}};return {tabs:s.tabs||[],projects:s.projects||{}}}
function outsiderSees(m,tabId,projectId){const s=outsiderScopesOf(m);return s.tabs.includes(tabId)?'tab':(s.projects[tabId]||[]).includes(projectId)?'project':null}
let openToDraft=null;
function mountOpenTo(id){
  if(!id||typeof isAdministrator!=='function'||!isAdministrator())return;
  const p=tab()?.projects.find(x=>x.id===id);if(!p||p.system)return;
  if(!Sync.members){Sync.core.api('/members').then(items=>{Sync.members=items;if(document.getElementById('saveProjectBtn')&&!document.getElementById('openToField'))mountOpenTo(id)}).catch(()=>{});return}
  const people=outsiderMembers();if(!people.length)return;
  if(openToDraft?.projectId!==id)openToDraft={projectId:id,tabId:tab().id,want:new Map()};
  const actions=document.querySelector('#sheet .actions');if(!actions||document.getElementById('openToField'))return;
  const row=m=>{const sees=outsiderSees(m,openToDraft.tabId,id),checked=openToDraft.want.has(m.userId)?openToDraft.want.get(m.userId):!!sees;
    return `<label class="checkline"><input type="checkbox" data-open-to="${m.userId}" ${checked?'checked':''} ${sees==='tab'?'disabled':''} data-feedback-id="tasks.editor_proyecto.abrir_a.persona" data-feedback-label="Abrir a esta persona"><span data-feedback-ignore>${esc(m.displayName||'Sin nombre')}${sees==='tab'?' <span class="small muted">· tiene toda el área</span>':''}</span></label>`};
  actions.insertAdjacentHTML('beforebegin',`<section class="field opento" id="openToField" data-feedback-id="tasks.editor_proyecto.abrir_a" data-feedback-label="Abrir a…"><label>Abrir a…</label><p class="small muted">Personas de fuera (outsiders) que verán este proyecto: sus tareas, pasos y comentarios. Pueden marcar hechas, comentar y proponer.</p>${people.map(row).join('')}</section>`);
  document.querySelectorAll('[data-open-to]').forEach(b=>b.onchange=()=>openToDraft.want.set(b.dataset.openTo,b.checked));
  const save=document.getElementById('saveProjectBtn');
  if(save)save.addEventListener('click',()=>{const draft=openToDraft;openToDraft=null;if(draft)setTimeout(()=>applyOpenTo(draft),0)},true)}
async function applyOpenTo(draft){
  const changes=[...draft.want].map(([userId,open])=>({userId,open,m:outsiderMembers().find(m=>m.userId===userId)})).filter(x=>x.m&&outsiderSees(x.m,draft.tabId,draft.projectId)!=='tab'&&!!outsiderSees(x.m,draft.tabId,draft.projectId)!==x.open);
  if(!changes.length)return;
  if(!navigator.onLine)return toast('Sin conexión: «Abrir a…» necesita red. Vuelve a intentarlo con conexión.');
  const done=[];
  for(const c of changes){try{const res=await Sync.core.api('/invoke/tasks.outsider_scopes',{method:'POST',json:{userId:c.userId,projectId:draft.projectId,open:c.open}});c.m.scopes=res.scopes;done.push(c)}catch(e){toast(`${c.m.displayName||'Esa persona'}: ${e.message||'no se pudo guardar.'}`)}}
  if(done.length)toast(done.map(c=>`${c.open?'Abierto a':'Cerrado para'} ${c.m.displayName||'una persona'}`).join(' · '))}
const closeSheetBeforeOpenTo=closeSheet;
closeSheet=function(...args){const result=closeSheetBeforeOpenTo(...args);if(!document.getElementById('sheetBack')?.classList.contains('show'))setTimeout(()=>{if(!document.getElementById('openToField'))openToDraft=null},0);return result};

/* --- «Cuentas de personas» para un outsider: áreas completas y proyectos sueltos, nunca toda la app ---------------- */
function outsiderAccessEditor(user){
  const s=outsiderScopesOf(user);
  openSheet(`<h2 class="sheettitle" data-feedback-ignore>Permisos de ${esc(user.displayName||'la cuenta')}</h2><p class="small muted">Persona de fuera (outsider): el rol lo da su nivel de casa en Central. Aquí eliges qué ve: áreas completas o proyectos sueltos. Sin nada marcado no ve nada.</p>${state.tabs.filter(t=>!t.deleted).map(t=>`<section class="filterfamily"><label><input type="checkbox" data-outsider-tab="${t.id}" ${s.tabs.includes(t.id)?'checked':''} data-feedback-id="tasks.editor_cuenta.outsider.area" data-feedback-label="Abrir toda el área"> Todo ${esc(t.name)}</label>${t.projects.filter(p=>!p.deleted&&!p.system).map(p=>`<label style="display:block;padding:6px 12px"><input type="checkbox" data-outsider-project="${t.id}|${p.id}" ${(s.projects[t.id]||[]).includes(p.id)?'checked':''} data-feedback-id="tasks.editor_cuenta.outsider.proyecto" data-feedback-label="Abrir el proyecto"> ${esc(p.title)}</label>`).join('')}</section>`).join('')}<button class="danger" id="outsiderNone" data-feedback-id="tasks.editor_cuenta.outsider.quitar" data-feedback-label="No abrirle nada">No abrirle nada</button><button class="primary" id="outsiderSave" data-feedback-id="tasks.editor_cuenta.outsider.guardar" data-feedback-label="Guardar permisos">Guardar permisos</button>`);
  const sync=()=>document.querySelectorAll('[data-outsider-project]').forEach(b=>{const whole=document.querySelector(`[data-outsider-tab="${b.dataset.outsiderProject.split('|')[0]}"]`)?.checked;b.disabled=!!whole;if(whole)b.checked=true});
  document.querySelectorAll('[data-outsider-tab]').forEach(b=>b.onchange=sync);sync();
  const send=async(scopes,button)=>{if(!navigator.onLine)return toast('Sin conexión: los permisos necesitan red.');button.disabled=true;
    try{const res=await Sync.core.api('/invoke/tasks.outsider_scopes',{method:'POST',json:{userId:user.userId,scopes}});user.scopes=res.scopes;const m=(Sync.members||[]).find(x=>x.userId===user.userId);if(m)m.scopes=res.scopes;await usersSheet();toast('Permisos guardados.')}
    catch(e){button.disabled=false;toast(e.message||'No se pudo guardar.')}};
  document.getElementById('outsiderSave').onclick=e=>{const tabs=[...document.querySelectorAll('[data-outsider-tab]:checked')].map(b=>b.dataset.outsiderTab),projects={};
    document.querySelectorAll('[data-outsider-project]:checked').forEach(b=>{const [t,p]=b.dataset.outsiderProject.split('|');if(!tabs.includes(t))(projects[t]||=[]).push(p)});send({tabs,projects},e.currentTarget)};
  document.getElementById('outsiderNone').onclick=e=>send({tabs:[],projects:{}},e.currentTarget)}
const userEditorBeforeOutsider=userEditor;
userEditor=function(user=null,...rest){if(user?.role==='outsider')return outsiderAccessEditor(user);return userEditorBeforeOutsider(user,...rest)};
