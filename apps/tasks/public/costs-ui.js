/* R6 PR 4 · costes de tarea y proyecto (docs/tasks/API.md §37; decisión del usuario del 19-10-2026).
   - Coste de una tarea: lo gastado de sus materiales × el coste medio de cada artículo en Recursos, más los costes a mano
     (`resources.cost_entries`, «alquiler de andamio 120 €») y el campo «Coste (€)» de antes. El de un proyecto, la suma de
     sus tareas (y sus costes a mano) frente al presupuesto (la barra de siempre).
   - Los importes los ven la propietaria y el responsable de compras del área. Los demás ven las cantidades (materiales),
     sin importes: sin la barra, sin el chip de coste, sin «Coste (€)» ni «Presupuesto (€)».
   Los cálculos son del dominio (IkisaiTasks.costs) sobre el espejo de Recursos (Sync.core.inventory). */
const C=()=>IkisaiTasks.costs;
function costInventory(){return Sync.core?.inventory||{items:[],movements:[],movementCosts:[],costEntries:[]}}
function areaIdOf(p){if(typeof areaOfProject==='function'){const a=areaOfProject(p);if(a)return a.id||a}return p?.tab_id||tab()?.id}
/* La propietaria o el responsable de compras del área (el mismo que aprueba sus compras). */
function canSeeCosts(tabId){const a=Sync.actor;if(!a||Sync.secondary||a.kind==='agent')return false;if(a.role==='owner')return true;
  const approver=typeof purchaseApprover==='function'?purchaseApprover(tabId):null;return !!approver&&approver===a.id}
function taskTotal(taskId){try{return C().taskCost(purchasesData(),taskId,costInventory()).total}catch{return 0}}

/* Coste de un proyecto: el del dominio (incluye materiales y costes a mano); 0 para quien no ve importes. */
projectCost=function(p){if(!p||!canSeeCosts(areaIdOf(p)))return 0;try{return C().projectCostOf(purchasesData(),p.id,costInventory())}catch{return 0}};
const moneyBlockBeforeCosts=moneyBlock;
moneyBlock=function(p){return p&&canSeeCosts(areaIdOf(p))?moneyBlockBeforeCosts(p):''};
const projectCardBeforeCosts=projectCard;
projectCard=function(p){if(!p||canSeeCosts(areaIdOf(p)))return projectCardBeforeCosts(p);const budget=p.budget;p.budget=null;try{return projectCardBeforeCosts(p)}finally{p.budget=budget}};
const taskRowBeforeCosts=taskRow;
taskRow=function(t,p=project(),context=false){const html=taskRowBeforeCosts(t,p,context).replace(/<span class="cost">[^<]*<\/span>/,'');
  if(!canSeeCosts(areaIdOf(p)))return html;const total=taskTotal(t.id);
  return total?html.replace('</button><button class="taskmenu"',`<span class="cost">${money(total)}</span></button><button class="taskmenu"`):html};

function costSectionHtml(taskId){const c=C().taskCost(purchasesData(),taskId,costInventory()),editable=typeof canEditMaterials==='function'&&canEditMaterials();
  const item=id=>Sync.core?.inventory?.items.find(i=>i.id===id);
  const lines=[...c.materials.map(m=>{const it=item(m.material.item_id),q=`${Number(m.material.consumed).toLocaleString('es-ES',{maximumFractionDigits:3})}${it?.base_unit?' '+it.base_unit:''}`;
      return `<li class="costline"><span>${esc(it?.name||'Material')} · ${esc(q)}${m.unitCost!=null?` × ${esc(money(m.unitCost))}`:''}</span><strong>${m.amount!=null?esc(money(m.amount)):'sin coste conocido'}</strong></li>`}),
    ...c.manual.map(e=>`<li class="costline" data-cost-entry="${e.id}"><span>${esc(e.description)}</span><strong>${esc(money(Number(e.amount)))}</strong>${editable?`<button class="iconbtn small" type="button" data-cost-remove="${e.id}" aria-label="Quitar ${esc(e.description)}" data-feedback-id="tasks.tarea.coste.quitar" data-feedback-label="Quitar coste">×</button>`:''}</li>`),
    ...(c.legacy?[`<li class="costline"><span>Coste (€) de la tarea</span><strong>${esc(money(c.legacy))}</strong></li>`]:[])];
  return `<section class="taskcosts" id="taskCosts" data-task="${taskId}" aria-labelledby="taskCostsTitle"><h3 class="sectionlabel" id="taskCostsTitle">Coste</h3>
    ${lines.length?`<ul class="costlist">${lines.join('')}</ul>`:'<p class="small muted">Lo gastado en materiales y los costes a mano (alquileres, servicios…).</p>'}
    <p class="costtotal">Total: <strong id="taskCostTotal">${esc(money(c.total))}</strong>${c.uncosted?` <span class="small muted">· ${c.uncosted} ${c.uncosted===1?'material':'materiales'} sin coste conocido</span>`:''}</p>
    ${editable?`<div class="costadd"><input data-field-id="tasks.tarea.coste.que" id="costDesc" maxlength="200" placeholder="Qué (p. ej. alquiler de andamio)" aria-label="Qué" data-feedback-id="tasks.tarea.coste.que" data-feedback-label="Qué"><input data-field-id="tasks.tarea.coste.importe" id="costAmount" type="number" step="0.01" inputmode="decimal" placeholder="€" aria-label="Importe (€)" data-feedback-id="tasks.tarea.coste.importe" data-feedback-label="Importe"><button class="ghost small" type="button" id="costAdd" data-feedback-id="tasks.tarea.coste.anadir" data-feedback-label="Añadir coste">Añadir coste</button></div>`:''}</section>`}
function drawCosts(taskId){const box=document.getElementById('taskCosts'),loc=taskLocation(taskId);
  if(!loc||!canSeeCosts(areaIdOf(loc.p))){box?.remove();return}
  const html=costSectionHtml(taskId);
  if(box)box.outerHTML=html;else{const sheet=document.getElementById('sheet');if(!sheet)return;const anchor=sheet.querySelector('#taskComments')||sheet.querySelector('.actions');
    if(anchor)anchor.insertAdjacentHTML('beforebegin',html);else sheet.insertAdjacentHTML('beforeend',html)}
  bindCosts(taskId)}
function bindCosts(taskId){const r=Sync.core?.resources;
  const add=document.getElementById('costAdd');if(add)add.onclick=async()=>{const description=document.getElementById('costDesc').value.trim(),amount=Number(document.getElementById('costAmount').value);
    if(!description)return toast('Escribe qué es el coste.');if(!Number.isFinite(amount)||amount===0)return toast('Indica el importe.');if(!r)return toast('El inventario no está disponible ahora mismo.');
    let op;try{op=C().costEntryOperation({id:crypto.randomUUID(),kind:'task',targetId:taskId,amount,description})}catch(e){return toast(e.message)}
    add.disabled=true;try{await r.commit([op]);toast('Coste añadido.')}catch(e){toast(e.message||'No se pudo guardar.')}add.disabled=false};
  document.querySelectorAll('[data-cost-remove]').forEach(b=>b.onclick=async()=>{const e=costInventory().costEntries.find(x=>x.id===b.dataset.costRemove);if(!e||!r)return;
    try{await r.commit([{op:'delete',table:'resources.cost_entries',id:e.id,expectedRevision:e.revision}]);toast('Coste quitado.')}catch(err){toast(err.message||'No se pudo quitar.')}})}

/* Ficha de la tarea: «Coste (€)» solo para quien ve importes (se oculta, no se quita: el guardado sigue leyéndolo) y la
   sección de coste después de los materiales. */
const openTaskEditorBeforeCosts=openTaskEditor;
openTaskEditor=function(id,...rest){openTaskEditorBeforeCosts(id,...rest);document.getElementById('taskCosts')?.remove();const loc=id?taskLocation(id):null,area=loc?areaIdOf(loc.p):tab()?.id;
  const field=document.querySelector('#sheet .costfield');if(field)field.hidden=!canSeeCosts(area);if(loc)drawCosts(id)};
const openProjectEditorBeforeCosts=openProjectEditor;
openProjectEditor=function(id,...rest){openProjectEditorBeforeCosts(id,...rest);const p=id?tab()?.projects.find(x=>x.id===id):null;
  const field=document.querySelector('#sheet .budgetfield');if(field)field.hidden=!canSeeCosts(p?areaIdOf(p):tab()?.id)};
const refreshModelBeforeCosts=refreshModel;
refreshModel=function(){refreshModelBeforeCosts();const box=document.getElementById('taskCosts');if(!box||box.contains(document.activeElement))return;drawCosts(box.dataset.task)};
/* Los costes de Recursos no cambian el modelo de tareas: con la vista de un proyecto abierta, se repinta. */
let costListening=false;
function listenCosts(){if(costListening||!Sync.core)return;costListening=true;let last='';Sync.core.onChange(kind=>{if(kind!=='data'||document.getElementById('sheetBack')?.classList.contains('show'))return;
  const inv=costInventory(),sig=`${inv.costEntries.length}|${inv.movementCosts.length}|${inv.movements.length}`;if(sig===last)return;last=sig;if(['project','projects','home'].includes(state.view))render()})}
const bindBeforeCosts=bind;
bind=function(){bindBeforeCosts();listenCosts()};
