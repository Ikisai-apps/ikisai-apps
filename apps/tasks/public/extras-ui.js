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
function aliasSheet(){const names=personNames(),current=myAlias();openSheet(`<h2 class="sheettitle">¿Quién eres?</h2><p class="subtitle">Elige tu nombre de la familia Persona. «Mis tareas» reunirá lo que lleve tu etiqueta en cualquier área. Se guarda en este dispositivo.</p><div class="chips aliaschips">${names.map(n=>`<button type="button" class="filterchip ${n.toLocaleLowerCase()===current.toLocaleLowerCase()?'on':''}" data-alias="${esc(n)}">${esc(n)}</button>`).join('')||'<span class="small muted">Aún no hay etiquetas de Persona. Créalas en Etiquetas.</span>'}</div><div class="field"><label for="aliasInput">O escribe tu alias</label><input id="aliasInput" maxlength="60" value="${esc(current)}" placeholder="Por ejemplo: Juan"></div><div class="actions">${current?'<button class="ghost" id="aliasClear">Quitar</button>':''}<button class="primary" id="aliasSave">Guardar</button></div>`);
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
// ---- Deshacer rápido ---------------------------------------------------------------------------
let undoTimer=null;
function undoToast(label,cursor){let el=document.getElementById('undoToast');if(!el){el=document.createElement('div');el.id='undoToast';el.className='undotoast';document.body.appendChild(el)}el.innerHTML=`<span>${esc(label)}</span><button type="button" id="undoNow">${menuIcon('undo')}Deshacer</button>`;el.classList.add('show');document.getElementById('undoNow').onclick=()=>{el.classList.remove('show');undoSheet(cursor)};clearTimeout(undoTimer);undoTimer=setTimeout(()=>el.classList.remove('show'),7000)}
async function offerUndo(label){if(typeof undoSheet!=='function'||!Sync.record||!Sync.actor)return;const start=Date.now();while(Date.now()-start<6000){if(Sync.mode==='online'&&!Sync.busy&&Sync.record.queue.length===0)break;await new Promise(r=>setTimeout(r,200))}if(Sync.record.queue.length||Sync.mode!=='online')return;try{const data=await api('history'),mine=(data.events||[]).filter(e=>e.actor===Sync.actor.id&&!e.undoOf);if(!mine.length)return;const latest=mine.reduce((a,b)=>b.cursor>a.cursor?b:a);if(Date.now()-new Date(latest.at).getTime()>20000)return;undoToast(label,latest.cursor)}catch(e){}}
const toggleBeforeUndo=toggleTask;
toggleTask=function(id){const loc=taskLocation(id),wasDone=loc?status(loc.p,loc.t)==='done':false;toggleBeforeUndo(id);if(loc&&!batchMode)offerUndo(wasDone?'Tarea reabierta':'Tarea completada')};
const deleteBeforeUndo=deleteTask;
deleteTask=function(id){deleteBeforeUndo(id);if(!batchMode)offerUndo('Enviada a papelera')};
const moveBeforeUndo=moveTask;
moveTask=function(id,destId,parentId=null,beforeId=null){const ok=moveBeforeUndo(id,destId,parentId,beforeId);if(ok&&!batchMode)offerUndo('Tarea movida');return ok};
const batchBeforeUndo=batchRun;
batchRun=function(label,fn){batchBeforeUndo(label,fn);offerUndo('Lote aplicado')};
// ---- Atajos de teclado --------------------------------------------------------------------------
document.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const t=e.target;if(t&&t.matches&&t.matches('input,textarea,select,[contenteditable]'))return;if(document.getElementById('sheetBack')?.classList.contains('show'))return;
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
  document.getElementById('teDue')?.closest('.row')?.insertAdjacentHTML('afterend',`<div class="field costfield"><label for="teCost">Coste (€)</label><input id="teCost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Opcional" value="${esc(stored==null?'':stored)}"></div>`);
  const input=document.getElementById('teCost');editorCost={key,value:stored};input.oninput=()=>{editorCost={key,value:input.value}};
  const previous=saveBtn.onclick;saveBtn.onclick=()=>{const raw=input.value.trim(),cost=Number(raw);if(raw!==''&&(!Number.isFinite(cost)||cost<0))return toast('El coste debe ser un número finito no negativo.');previous?.()}};
const projectEditorBeforeBudget=openProjectEditor;
openProjectEditor=function(id,selectedOverride=null,valsOverride=null){projectEditorBeforeBudget(id,selectedOverride,valsOverride);const saveBtn=document.getElementById('saveProjectBtn');if(!saveBtn||!canEdit())return;const key='project:'+(id||'new'),base=id?tab().projects.find(x=>x.id===id):null,stored=Object.hasOwn(valsOverride||{},'budget')?valsOverride.budget:(editorBudget&&editorBudget.key===key?editorBudget.value:(base?.budget??''));
  document.getElementById('peDue')?.closest('.field')?.insertAdjacentHTML('afterend',`<div class="field budgetfield"><label for="peBudget">Presupuesto (€)</label><input id="peBudget" type="number" min="0" step="1" inputmode="decimal" placeholder="Opcional" value="${esc(stored==null?'':stored)}">${base?`<p class="small muted">Coste actual de sus tareas: ${money(projectCost(base))}</p>`:''}</div>`);
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
