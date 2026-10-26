/* Alias y «Mis tareas», deshacer rápido tras una acción, atajos de teclado, pendientes por área, y coste de tarea y presupuesto de proyecto. */
const ALIAS_KEY='ikisai-alias';
Object.assign(menuPaths,{user:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',undo:'M9 14L4 9l5-5 M4 9h11a6 6 0 0 1 0 12h-3',home:'M3 11l9-8 9 8 M5 10v10h5v-6h4v6h5V10',euro:'M18 6.5a7 7 0 1 0 0 11 M4 10.5h11 M4 13.5h11'});
const euro=new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0});
function money(n){return euro.format(Number(n)||0)}
// ---- Alias y Mis tareas -------------------------------------------------------------------------
function myAlias(){try{return (localStorage.getItem(ALIAS_KEY)||'').trim()}catch(e){return ''}}
function personFamilies(area){return area.families.filter(f=>!f.archived&&(f.system==='person'||f.id==='person'||f.name.trim().toLocaleLowerCase()==='persona'))}
function personNames(){const names=new Map();for(const area of generalAreas())for(const f of personFamilies(area))for(const l of area.labels.filter(l=>l.family===f.id&&!l.archived)){const key=l.text.trim().toLocaleLowerCase();if(!names.has(key))names.set(key,l.text.trim())}return [...names.values()].sort((a,b)=>a.localeCompare(b))}
function myTaskFilters(){const alias=myAlias().toLocaleLowerCase();if(!alias)return null;const filters={};for(const area of generalAreas())for(const f of personFamilies(area))for(const l of area.labels.filter(l=>l.family===f.id&&!l.archived&&l.text.trim().toLocaleLowerCase()===alias))(filters[f.id]||=[]).push(l.id);return Object.keys(filters).length?filters:null}
function isMyTasksView(){const f=myTaskFilters();return !!f&&state.view==='tasks'&&state.taskScope==='all'&&JSON.stringify(state.filters||{})===JSON.stringify(f)}
function aliasSheet(){const names=personNames(),current=myAlias();openSheet(`<h2 class="sheettitle">¿Quién eres?</h2><p class="subtitle">Elige tu nombre de la familia Persona. «Mis tareas» reunirá lo que lleve tu etiqueta en cualquier área. Se guarda en este dispositivo.</p><div class="chips aliaschips">${names.map(n=>`<button type="button" class="filterchip ${n.toLocaleLowerCase()===current.toLocaleLowerCase()?'on':''}" data-alias="${esc(n)}" data-feedback-ignore>${esc(n)}</button>`).join('')||'<span class="small muted">Aún no hay etiquetas de Persona. Créalas en Etiquetas.</span>'}</div><div class="field"><label for="aliasInput">O escribe tu alias</label><input id="aliasInput" maxlength="60" value="${esc(current)}" placeholder="Por ejemplo: Juan" data-feedback-ignore></div><div class="actions">${current?'<button class="ghost" id="aliasClear" data-feedback-id="tasks.alias.quitar" data-feedback-label="Quitar alias">Quitar</button>':''}<button class="primary" id="aliasSave" data-feedback-id="tasks.alias.guardar" data-feedback-label="Guardar alias">Guardar</button></div>`);
  document.querySelectorAll('[data-alias]').forEach(b=>b.onclick=()=>{document.getElementById('aliasInput').value=b.dataset.alias;document.querySelectorAll('[data-alias]').forEach(x=>x.classList.toggle('on',x===b))});
  document.getElementById('aliasSave').onclick=()=>{const v=document.getElementById('aliasInput').value.trim();try{if(v)localStorage.setItem(ALIAS_KEY,v);else localStorage.removeItem(ALIAS_KEY)}catch(e){}closeSheet();render();toast(v?'Hola, '+v:'Alias quitado')};
  document.getElementById('aliasClear')?.addEventListener('click',()=>{try{localStorage.removeItem(ALIAS_KEY)}catch(e){}closeSheet();render()})}
function showMyTasks(){const filters=myTaskFilters();if(!filters){if(myAlias())toast('No hay etiquetas de Persona llamadas «'+myAlias()+'».');return aliasSheet()}closeNavigation();closeSheet();state.taskScope='all';state.view='tasks';state.currentProject=null;state.search='';state.groupBy='project';state.filters=filters;persistUI();render()}
const groupsBeforeExtras=navigationGroups;
navigationGroups=function(){const groups=groupsBeforeExtras(),work=groups.find(g=>g.id==='work');if(work){const at=work.items.findIndex(i=>i[0]==='tasks');work.items.splice(at+1,0,['mine','Mis tareas','user','action'])}return groups};
const actionBeforeExtras=handleTopAction;
handleTopAction=function(action){if(action==='mine')return showMyTasks();if(action==='alias'){closeNavigation();return aliasSheet()}return actionBeforeExtras(action)};
// ---- Cabecera del menú, tira de vistas y pestañas con pendientes ---------------------------------
function areaPending(area){return area.projects.filter(p=>!p.deleted&&p.status!=='archived').reduce((n,p)=>n+pending(p),0)}
// ---- «Deshacer» con el aviso del kit (MUELA-073 «Tareas (Deshacer)»; PERDIDAS §2 y §4) -------------
/* Completar o reabrir, enviar a la papelera y enviar varias a la papelera se hacen al momento y ofrecen «Deshacer» local: la
   operación inversa sobre el modelo (lo hecho y lo no hecho de antes; restaurar por `deleteBatch`), que se guarda como
   cualquier cambio, también sin red. Mover y los demás lotes conservan el «Deshacer» del historial del servidor (offerUndo),
   con el mismo aviso del kit. Los avisos con acción se apilan: otro aviso no les quita el botón (kit 0.41). */
const UNDO_MS=6000;
/* Lo que espera a que se vaya un aviso con «Deshacer» (la hoja «Confirmar consumo», materials-ui.js): si se deshace, no sale. */
const undoWaits=new Map();
function offerLocalUndo(message,undo,key=null){
  const entry={done:false,after:[],timer:null};if(key)undoWaits.set(key,entry);
  const settle=()=>{entry.done=true;clearTimeout(entry.timer);if(key&&undoWaits.get(key)===entry)undoWaits.delete(key)};
  entry.timer=setTimeout(()=>{if(entry.done)return;settle();for(const fn of entry.after){try{fn()}catch(e){console.error(e)}}},UNDO_MS+50);
  // Un aviso cada vez (MUELA-095 §3): el «Deshacer» nuevo sustituye al anterior, que ya no haría lo que dice.
  IkisaiKit.hideToast();IkisaiKit.toastWithAction(message,{label:'Deshacer',onClick:()=>{if(entry.done)return;settle();undo()}},UNDO_MS);
  return entry}
function afterUndoWindow(key,fn){const entry=undoWaits.get(key);if(entry&&!entry.done)entry.after.push(fn);else fn()}
/* La operación inversa en su área, con un solo pintado al final (como un lote). */
function undoQuietly(area,fn){const renderReal=render;render=()=>{};try{withArea(area,fn)}finally{render=renderReal}render()}
function taskFamily(p,t){const out=[t];for(let i=0;i<out.length;i++)out.push(...children(p,out[i].id));return out}
/* Lo hecho de una tarea y de sus hijas antes del cambio, para volver justo a ese estado. */
function doneSnapshot(id){const loc=taskLocation(id);return loc?taskFamily(loc.p,loc.t).map(x=>[x.id,!!x.done]):[]}
function restoreDone(snapshot,wasDone){const loc=taskLocation(snapshot[0]?.[0]);if(!loc||loc.t.deleted)return toast('La tarea ya no está.');
  for(const [id,done] of snapshot){const x=loc.p.tasks.find(t=>t.id===id);if(x&&!x.deleted&&!!x.done!==done){x.done=done;touch(x)}}
  syncAll(loc.p);record(wasDone?'complete':'reopen',[loc.t.id]);save()}
/* Restaura cada tarea con las hijas que se fueron con ella. El lote se reconoce por `deleteBatch`, que tras sincronizar pasa a
   ser la hora del borrado (la misma para la madre y sus hijas): se compara con el de ahora y con el de entonces. */
function restoreTrashed(items){const touched=new Set();
  for(const it of items){const p=tab().projects.find(x=>x.id===it.pid),t=p?.tasks.find(x=>x.id===it.id);if(!p||!t)continue;
    const under=new Set([t.id]);for(let grew=true;grew;){grew=false;for(const x of p.tasks)if(x.parentId&&under.has(x.parentId)&&!under.has(x.id)){under.add(x.id);grew=true}}
    const same=x=>x===t||[t.deleteBatch,it.batch].some(b=>b&&x.deleteBatch===b)||!!t.deletedAt&&x.deletedAt===t.deletedAt;
    for(const x of p.tasks)if(under.has(x.id)&&x.deleted&&same(x)){x.deleted=false;delete x.deleteBatch;delete x.deletedAt;touch(x);touched.add(p)}
    record('restore',[it.id])}
  for(const p of touched)syncAll(p);if(touched.size)save()}
// Para la casilla «Hecha» del outsider (comments-ui.js), que sigue al estado de la tarea.
function syncOutsiderDone(){const box=document.getElementById('outsiderDone'),id=document.getElementById('taskComments')?.dataset.task,loc=id?taskLocation(id):null;if(box&&loc)box.checked=status(loc.p,loc.t)==='done'}
const toggleBeforeUndo=toggleTask;
toggleTask=function(id){const area=state.activeTab,loc=taskLocation(id),wasDone=loc?status(loc.p,loc.t)==='done':false,snapshot=doneSnapshot(id);toggleBeforeUndo(id);
  if(!loc||batchMode)return;const now=taskLocation(id);if(!now||(status(now.p,now.t)==='done')===wasDone)return;
  offerLocalUndo(wasDone?'Tarea reabierta':'Tarea completada',()=>{undoQuietly(area,()=>restoreDone(snapshot,wasDone));syncOutsiderDone()},'toggle:'+id)};
const deleteBeforeUndo=deleteTask;
deleteTask=function(id){const area=state.activeTab;deleteBeforeUndo(id);if(batchMode)return;const loc=taskLocation(id);if(!loc||!loc.t.deleted)return;
  const item={pid:loc.p.id,id,batch:loc.t.deleteBatch};offerLocalUndo('Enviada a la papelera',()=>undoQuietly(area,()=>restoreTrashed([item])))};
// ---- «Deshacer» del historial (mover y los lotes de prioridad, etiquetas, mover…): necesita red ---------------

function undoToast(label,cursor){IkisaiKit.hideToast();IkisaiKit.toastWithAction(label,{label:'Deshacer',onClick:()=>undoSheet(cursor)},7000)}
async function offerUndo(label){if(typeof undoSheet!=='function'||!Sync.record||!Sync.actor)return;
  const start=Date.now();while(Date.now()-start<6000){if(Sync.mode==='online'&&!Sync.busy&&Sync.record.queue.length===0)break;await new Promise(r=>setTimeout(r,200))}if(Sync.record.queue.length||Sync.mode!=='online')return;try{const data=await api('history'),mine=(data.events||[]).filter(e=>e.actor===Sync.actor.id&&!e.undoOf);if(!mine.length)return;const latest=mine.reduce((a,b)=>b.cursor>a.cursor?b:a);if(Date.now()-new Date(latest.at).getTime()>20000)return;undoToast(label,latest.cursor)}catch(e){}}
const moveBeforeUndo=moveTask;
moveTask=function(id,destId,parentId=null,beforeId=null){const ok=moveBeforeUndo(id,destId,parentId,beforeId);if(ok&&!batchMode)offerUndo('Tarea movida');return ok};
/* Lotes: el aviso sale una sola vez, al final. Completar, reabrir y papelera llevan su «Deshacer» local (batch-ui.js); los
   demás, el del historial con el mismo texto del lote. */
const batchBeforeUndo=batchRun;
batchRun=function(label,fn,options={}){const n=batchSelection.size,ok=batchBeforeUndo(label,fn,options);if(ok&&!options.undo)offerUndo(label.replace('%n',n));return ok};
// ---- Atajos de teclado --------------------------------------------------------------------------
document.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const t=e.target;if(t&&t.matches&&t.matches('input,textarea,select,[contenteditable]'))return;if(document.getElementById('sheetBack')?.classList.contains('show'))return;if(document.querySelector('[role="dialog"][aria-modal="true"]'))return;/* hojas y diálogos del kit (FB_2026_054) */
  if(e.key==='/'){const s=document.getElementById('searchInput');if(s){e.preventDefault();s.focus();s.select()}}
  else if(e.key==='n'||e.key==='N'){const add=document.querySelector('[data-add-task]:not([disabled])');if(add&&canEdit()){e.preventDefault();add.click()}}
  else if(e.key==='s'||e.key==='S'){const b=document.getElementById('batchToggle');if(b){e.preventDefault();b.click()}}
  else if(e.key==='i'||e.key==='I'){e.preventDefault();navigateView('home')}});
// ---- Coste de tarea y presupuesto de proyecto ----------------------------------------------------
let editorCost=null,editorBudget=null;
function projectCost(p){return p.tasks.filter(t=>!t.deleted).reduce((n,t)=>n+(Number(t.cost)||0),0)}
function moneyBlock(p){const cost=projectCost(p),budget=Number(p.budget)||0;if(!cost&&!budget)return'';const pct=budget?Math.min(100,Math.round(100*cost/budget)):0,over=budget&&cost>budget;return `<div class="money ${over?'over':''}" title="Coste de las tareas${budget?' frente al presupuesto':''}"><span class="moneytext">${menuIcon('euro')}<strong>${money(cost)}</strong>${budget?` de ${money(budget)}${over?' · excedido':''}`:''}</span>${budget?`<div class="moneybar"><span style="width:${pct}%"></span></div>`:''}</div>`}
const taskEditorBeforeCost=openTaskEditor;
openTaskEditor=function(id,selectedOverride=null,valsOverride=null){taskEditorBeforeCost(id,selectedOverride,valsOverride);const saveBtn=document.getElementById('saveTaskBtn');if(!saveBtn||!canEdit())return;const key='task:'+(id||'new'),loc=id?taskLocation(id):null,stored=Object.hasOwn(valsOverride||{},'cost')?valsOverride.cost:(editorCost&&editorCost.key===key?editorCost.value:(loc?.t.cost??''));
  document.getElementById('teDue')?.closest('.row')?.insertAdjacentHTML('afterend',`<div class="field costfield"><label for="teCost">Coste (€)</label><input id="teCost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Opcional" value="${esc(stored==null?'':stored)}" data-feedback-id="tasks.editor_tarea.coste" data-feedback-label="Coste de la tarea"></div>`);
  const input=document.getElementById('teCost');editorCost={key,value:stored};input.oninput=()=>{editorCost={key,value:input.value}};
  const previous=saveBtn.onclick;saveBtn.onclick=()=>{const raw=input.value.trim(),cost=Number(raw);if(raw!==''&&(!Number.isFinite(cost)||cost<0))return toast('El coste debe ser un número finito no negativo.');previous?.()}};
const projectEditorBeforeBudget=openProjectEditor;
openProjectEditor=function(id,selectedOverride=null,valsOverride=null){projectEditorBeforeBudget(id,selectedOverride,valsOverride);const saveBtn=document.getElementById('saveProjectBtn');if(!saveBtn||!canEdit())return;const key='project:'+(id||'new'),base=id?tab().projects.find(x=>x.id===id):null,stored=Object.hasOwn(valsOverride||{},'budget')?valsOverride.budget:(editorBudget&&editorBudget.key===key?editorBudget.value:(base?.budget??''));
  document.getElementById('peDue')?.closest('.field')?.insertAdjacentHTML('afterend',`<div class="field budgetfield"><label for="peBudget">Presupuesto (€)</label><input id="peBudget" type="number" min="0" step="1" inputmode="decimal" placeholder="Opcional" value="${esc(stored==null?'':stored)}" data-feedback-id="tasks.editor_proyecto.presupuesto" data-feedback-label="Presupuesto del proyecto">${base?`<p class="small muted">Coste actual de sus tareas: ${money(projectCost(base))}</p>`:''}</div>`);
  const input=document.getElementById('peBudget');editorBudget={key,value:stored};input.oninput=()=>{editorBudget={key,value:input.value}};
  const previous=saveBtn.onclick;saveBtn.onclick=()=>{const raw=input.value.trim(),budget=Number(raw);if(raw!==''&&(!Number.isFinite(budget)||budget<0))return toast('El presupuesto debe ser un número finito no negativo.');previous?.()}};
const closeSheetBeforeExtras=closeSheet;
closeSheet=function(e){closeSheetBeforeExtras(e);if(!document.getElementById('sheetBack').classList.contains('show')){editorCost=null;editorBudget=null}};
const projectViewBeforeMoney=projectView;
projectView=function(){const html=projectViewBeforeMoney(),p=project(),block=p?moneyBlock(p):'';return block?html.replace('<div class="progressline">',block+'<div class="progressline">'):html};
const rowsBeforeMoney=taskRow;
taskRow=function(t,p=project(),context=false){const html=rowsBeforeMoney(t,p,context);return t.cost?html.replace('</button><button class="taskmenu"',`<span class="cost">${money(t.cost)}</span></button><button class="taskmenu"`):html};
const bindBeforeExtras=bind;
bind=function(){bindBeforeExtras();document.querySelectorAll('#aliasBtn').forEach(b=>b.onclick=()=>{closeNavigation();aliasSheet()});const mine=document.querySelector('[data-quick-mine]');if(mine)mine.onclick=showMyTasks};
/* Fila de tarea con un solo botón, «Editar» (aceptación V1, 6): abre el editor, y dentro están mover, historial y la
   papelera, que antes estaban en un menú aparte. */
const editorBeforeActions=openTaskEditor;
openTaskEditor=function(id,...rest){editorBeforeActions(id,...rest);if(!id||!canEdit())return;const actions=document.querySelector('#sheet .actions');if(!actions||document.getElementById('taskMoreActions'))return;
  actions.insertAdjacentHTML('afterend',`<div class="menulist" id="taskMoreActions" style="margin-top:12px"><button id="menuMove" type="button" data-feedback-id="tasks.editor_tarea.mas_acciones.mover" data-feedback-label="Mover / cambiar nivel">Mover / cambiar nivel</button><button id="menuHistory" type="button" data-feedback-id="tasks.editor_tarea.mas_acciones.historial" data-feedback-label="Historial de esta tarea">Historial de esta tarea</button></div>`);
  document.getElementById('menuMove').onclick=()=>openMoveSheet(id);
  document.getElementById('menuHistory').onclick=()=>historySheet({kind:'task',id,tabId:tab().id})};
const bindBeforeTaskEdit=bind;
bind=function(){bindBeforeTaskEdit();document.querySelectorAll('[data-task-menu]').forEach(b=>{const name=b.getAttribute('aria-label')?.replace(/^Opciones de /,'')||'';b.setAttribute('aria-label','Editar '+name);b.title='Editar';b.classList.add('editbtn');b.onclick=()=>openTaskEditor(b.dataset.taskMenu)})};

/* Tarea pedida desde otra app (API.md §19): el editor dice de dónde viene. El nombre sale del catálogo de apps
   (GET /api/v1/apps); sin red, el id de la app con mayúscula. */
let appNames=null;
function requestOrigin(id){const ref=Sync.core?.data?.['tasks.tasks']?.find(t=>t.id===id)?.external_ref;if(!ref)return null;const source=ref.slice(0,ref.indexOf(':'));return {source,reference:ref.slice(source.length+1)}}
function appName(source){return appNames?.get(source)||source.charAt(0).toUpperCase()+source.slice(1)}
const taskEditorBeforeOrigin=openTaskEditor;
openTaskEditor=function(id,...rest){taskEditorBeforeOrigin(id,...rest);const origin=id?requestOrigin(id):null;if(!origin)return;
  const title=document.querySelector('#sheet .sheettitle');if(!title||document.getElementById('taskOrigin'))return;
  // §20: también el tipo (con el nombre que mandó quien pidió) y el enlace al elemento que la generó.
  const row=Sync.core.data['tasks.tasks'].find(t=>t.id===id),request=Sync.core.data['tasks.requests']?.find(r=>r.id===id);
  const kind=row?.external_kind?(typeof kindName==='function'?kindName(row.external_kind,request?.kind_label):row.external_kind):'';
  // §22: de un reporte de Feedback se dice quién informó (metadato), no la app.
  const behalf={guest:'Reporte de huésped',organizer:'Reporte de organizador',internal:'Reporte interno'}[row?.external_on_behalf];
  const text=()=>[behalf||'Pedida desde '+appName(origin.source),kind,origin.reference].filter(Boolean).join(' · ');
  title.insertAdjacentHTML('afterend',`<p class="notice" id="taskOrigin"><span id="taskOriginText">${esc(text())}</span>${row?.external_url?` · <a href="${esc(row.external_url)}" target="_blank" rel="noopener" data-feedback-id="tasks.editor_tarea.origen.abrir" data-feedback-label="Abrir origen de la petición">Abrir</a>`:''}</p>`);
  if(!appNames&&Sync.core&&navigator.onLine)Sync.core.api('/apps').then(out=>{appNames=new Map((out?.items||out?.apps||[]).map(a=>[a.id,a.name]));const el=document.getElementById('taskOriginText');if(el)el.textContent=text()}).catch(()=>{appNames=new Map()})};

/* Editor de una tarea principal (FB_2026_044 y 041): sus hijas en una lista sencilla (marcar, abrir) con «+ Nueva hija», y
   «Pasos en orden»: cada hija queda bloqueada por la de arriba mientras no esté hecha (se recalcula al reordenarlas). En una
   hija encadenada, su paso anterior y «Soltar de la cadena» (se mantiene al reordenar). */
function childrenSectionHtml(t,p){const kids=p.tasks.filter(c=>c.parentId===t.id&&!c.deleted).sort((a,b)=>(a.order||0)-(b.order||0)),index=dependencyIndex(),edit=canEdit();
  return `<section class="childsection" id="taskChildren"><h3 class="sectionlabel">Tareas hijas <span class="count">${kids.length}</span></h3>
    <label class="checkline"><input type="checkbox" id="stepsInOrder" ${t.stepsInOrder?'checked':''} ${edit?'':'disabled'} data-feedback-id="tasks.editor_tarea.hijas.pasos_en_orden" data-feedback-label="Pasos en orden"><span><strong>Pasos en orden</strong> <span class="small muted">· cada hija espera a que esté hecha la de arriba</span></span></label>
    <div class="childlist">${kids.map(c=>{const blocker=stepBefore(c,index);return `<div class="childrow ${c.done?'done':''}"><button class="childcheck" type="button" data-child-toggle="${c.id}" aria-pressed="${!!c.done}" aria-label="${c.done?'Marcar pendiente':'Marcar hecha'}: ${esc(c.text)}" ${edit?'':'disabled'} data-feedback-id="tasks.editor_tarea.hijas.marcar" data-feedback-label="Marcar hija">${c.done?'✓':''}</button><button class="childtext" type="button" data-child-open="${c.id}" data-feedback-id="tasks.editor_tarea.hijas.abrir" data-feedback-label="Abrir hija">${esc(c.text)}${c.stepFree&&t.stepsInOrder?' <span class="small muted">· fuera de la cadena</span>':blocker&&!c.done?' <span class="small muted">· espera al paso anterior</span>':''}</button></div>`}).join('')||'<p class="small muted">Sin hijas.</p>'}</div>
    ${edit?`<div class="row childadd"><input id="newChildText" maxlength="1000" placeholder="Nueva hija…" data-feedback-id="tasks.editor_tarea.hijas.nueva_texto" data-feedback-label="Texto de la nueva hija"><button class="ghost" id="newChildAdd" type="button" data-feedback-id="tasks.editor_tarea.hijas.nueva" data-feedback-label="Nueva hija">+ Nueva hija</button></div>`:''}</section>`}
function stepInfoHtml(t,p){const parent=p.tasks.find(x=>x.id===t.parentId);if(!parent?.stepsInOrder)return '';const before=stepBefore(t,dependencyIndex()),edit=canEdit();
  return `<div class="notice stepinfo" id="stepInfo">${t.stepFree?`Fuera de la cadena de «${esc(parent.text)}»: no espera a ningún paso.`:before?`Paso anterior: <strong>${esc(dependencyText(before))}</strong> (pasos en orden de «${esc(parent.text)}»).`:`Primer paso de «${esc(parent.text)}».`}
    ${edit?`<button class="ghost small" id="stepFreeToggle" type="button" data-feedback-id="tasks.editor_tarea.pasos.soltar" data-feedback-label="Soltar o volver a la cadena">${t.stepFree?'Volver a la cadena':'Soltar de la cadena'}</button>`:''}</div>`}
function refreshChildSection(id){const loc=taskLocation(id);const box=document.getElementById('taskChildren');if(!loc||!box)return;box.outerHTML=childrenSectionHtml(loc.t,loc.p);bindChildSection(id)}
function bindChildSection(id){
  const loc=()=>taskLocation(id);
  const steps=document.getElementById('stepsInOrder');if(steps)steps.onchange=()=>{const l=loc();if(!l)return;l.t.stepsInOrder=steps.checked;if(typeof touch==='function')touch(l.t);if(save()!==false){render();refreshChildSection(id);toast(steps.checked?'Pasos en orden: cada hija espera a la anterior.':'Las hijas ya no van en orden.')}};
  document.querySelectorAll('[data-child-toggle]').forEach(b=>b.onclick=()=>{toggleTask(b.dataset.childToggle);setTimeout(()=>refreshChildSection(id),0)});
  document.querySelectorAll('[data-child-open]').forEach(b=>b.onclick=()=>openTaskEditor(b.dataset.childOpen));
  const input=document.getElementById('newChildText'),add=document.getElementById('newChildAdd');
  const create=()=>{const text=input.value.trim();if(!text)return input.focus();const l=loc();if(!l||l.t.parentId)return;const {p,t}=l;
    const task={id:uid('t'),text,note:'',done:false,priority:'normal',due:'',owner:null,parentId:t.id,labels:[...(p.ownLabels||[])],attachments:[],dependsOn:[],order:Math.max(0,...p.tasks.map(x=>x.order||0))+1024,version:1};
    p.tasks.push(task);syncParent(p,t.id);syncAll(p);record('create',[task.id]);if(save()!==false){render();refreshChildSection(id);setTimeout(()=>document.getElementById('newChildText')?.focus(),0)}};
  if(add)add.onclick=create;if(input)input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();create()}};
}
const taskEditorBeforeChildren=openTaskEditor;
openTaskEditor=function(id,...rest){taskEditorBeforeChildren(id,...rest);if(!id)return;const loc=taskLocation(id);if(!loc)return;const actions=document.querySelector('#sheet .actions');if(!actions)return;
  if(!loc.t.parentId&&!document.getElementById('taskChildren')){actions.insertAdjacentHTML('beforebegin',childrenSectionHtml(loc.t,loc.p));bindChildSection(id)}
  if(loc.t.parentId&&!document.getElementById('stepInfo')){const html=stepInfoHtml(loc.t,loc.p);if(html){actions.insertAdjacentHTML('beforebegin',html);
    document.getElementById('stepFreeToggle')?.addEventListener('click',()=>{const l=taskLocation(id);if(!l)return;l.t.stepFree=!l.t.stepFree;if(typeof touch==='function')touch(l.t);if(save()!==false){render();openTaskEditor(id)}})}}};

