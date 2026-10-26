/* R6 PR 3 · materiales y equipos de la tarea, kit del oficio y «Confirmar consumo» (docs/tasks/API.md §36).
   - En la ficha de la tarea, «Materiales y equipos»: artículos del inventario de la casa (Recursos) con su cantidad prevista.
     Un equipo (artículo de tipo no consumible: herramientas, máquinas…) solo dice «hace falta», sin reservas.
   - Con oficios puestos, «Añadir lo del oficio»: el kit de `central.trade_kit_options` que aún no está en la tarea.
   - Al completar una tarea con materiales, la hoja «Confirmar consumo» con lo previsto, editable o «No se usó». Gasta en
     Recursos (`resources.consume`, una vez por material) y lo apunta en la tarea. Nada se descuenta sin confirmar; también
     se puede confirmar después desde la ficha.
   Las filas salen de Sync.core.data['tasks.task_materials'] y los cambios son operaciones del dominio
   (IkisaiTasks.materials) que se confirman por el mismo camino que las compras (purchaseRun). */
const M=()=>IkisaiTasks.materials;
const EQUIPMENT_DEFAULT=new Set(['menaje','textil','herramienta','maquina']);
function canEditMaterials(){return canEdit()&&Sync.actor?.role!=='outsider'&&Sync.actor?.kind!=='agent'}
function inventoryItem(id){return Sync.core?.inventory?.items.find(i=>i.id===id)||null}
/* Consumible según su tipo (los de la semilla de Recursos; uno nuevo, consumible salvo que se diga). El servidor lo decide
   con resources.item_kinds. */
function isConsumable(itemId){const kind=inventoryItem(itemId)?.kind;if(!kind)return true;const known=(IkisaiKit.DEFAULT_ITEM_KINDS||[]).find(k=>k.kind===kind);return known?known.consumable!==false:!EQUIPMENT_DEFAULT.has(kind)}
const materialQty=(n,item)=>n==null||n===''?'':`${Number(n).toLocaleString('es-ES',{maximumFractionDigits:3})}${item?.base_unit?' '+item.base_unit:''}`;
function kitTradeName(id){return (Sync.core?.trades||[]).find(t=>t.trade_id===id)?.name||"el oficio"}

function materialRows(taskId){return M().taskMaterials(purchasesData(),taskId)}
function materialRow(m,editable){const item=inventoryItem(m.item_id),name=item?.name||'Artículo del inventario',equip=!isConsumable(m.item_id),consumed=m.consumed!=null;
  const state=consumed?(Number(m.consumed)>0?`Gastado: ${materialQty(m.consumed,item)}`:'No se usó'):equip?'Hace falta':'';
  const qty=equip?'':editable&&!consumed?`<input class="materialqty" type="number" min="0" step="any" inputmode="decimal" value="${m.quantity??''}" placeholder="Cuánto" aria-label="Cantidad de ${esc(name)}" data-material-qty="${m.id}" data-feedback-id="tasks.tarea.materiales.cantidad" data-feedback-label="Cantidad"><span class="materialunit">${esc(item?.base_unit||'')}</span>`:`<span class="materialunit">${esc(materialQty(m.quantity,item))}</span>`;
  return `<li class="materialrow ${equip?'equipment':''}" data-material="${m.id}"><span class="materialname">${esc(name)}${equip?' <span class="pstate">Equipo</span>':''}</span>${qty}${state?`<span class="materialstate ${consumed?'ok':''}">${esc(state)}</span>`:''}
    ${editable&&!consumed&&!equip?`<button class="softbtn small materialspent" type="button" data-material-spent="${m.id}" aria-label="Gastado: ${esc(name)}" data-feedback-id="tasks.tarea.materiales.gastado" data-feedback-label="Gastado">Gastado</button>`:''}
    ${editable&&!(consumed&&Number(m.consumed)>0)?`<button class="iconbtn small" type="button" data-material-remove="${m.id}" aria-label="Quitar ${esc(name)}" data-feedback-id="tasks.tarea.materiales.quitar" data-feedback-label="Quitar material">×</button>`:''}</li>`}
function materialSectionHtml(taskId){const rows=materialRows(taskId),editable=canEditMaterials();
  if(!rows.length&&!editable)return '';
  const live=id=>{const it=inventoryItem(id);return !it||(!it.deleted_at&&it.active!==false)};
  const kit=editable&&Sync.core?.tradeKit?.length?M().kitSuggestions(purchasesData(),taskId,Sync.core.tradeKit,live):[];
  const trades=[...new Set(kit.flatMap(k=>k.tradeIds))].map(kitTradeName);
  const pending=M().pendingConsumption(purchasesData(),taskId,isConsumable);
  return `<section class="taskmaterials" id="taskMaterials" data-task="${taskId}" aria-labelledby="taskMaterialsTitle"><h3 class="sectionlabel" id="taskMaterialsTitle">Materiales y equipos${rows.length?` <span class="count">${rows.length}</span>`:''}</h3>
    ${rows.length?`<ul class="materiallist">${rows.map(m=>materialRow(m,editable)).join('')}</ul>`:'<p class="small muted">Lo que hace falta para esta tarea, del inventario de la casa.</p>'}
    ${kit.length?`<button class="softbtn small" type="button" id="materialKit" data-feedback-id="tasks.tarea.materiales.kit" data-feedback-label="Añadir lo del oficio">Añadir lo de ${esc(trades.join(', '))} (${kit.length})</button>`:''}
    ${editable?'<div class="ikisai-kit materialpicker" id="materialPicker"></div><button class="ghost small" type="button" id="materialAdd" data-feedback-id="tasks.tarea.materiales.anadir" data-feedback-label="Añadir material">Añadir</button>':''}
    ${editable&&pending.length?`<button class="primary small" type="button" id="materialConsume" data-feedback-id="tasks.tarea.materiales.confirmar" data-feedback-label="Confirmar consumo">Confirmar consumo (${pending.length})</button>`:''}</section>`}

let materialPicker=null;
function drawMaterials(taskId){const box=document.getElementById('taskMaterials');const html=materialSectionHtml(taskId);
  materialPicker?.destroy();materialPicker=null;
  if(!box){const sheet=document.getElementById('sheet');if(!sheet||!html)return;const anchor=sheet.querySelector('#taskComments')||sheet.querySelector('.actions');
    if(anchor)anchor.insertAdjacentHTML('beforebegin',html);else sheet.insertAdjacentHTML('beforeend',html)}
  else if(!html)box.remove();else box.outerHTML=html;
  bindMaterials(taskId)}
function bindMaterials(taskId){const run=(build,msg)=>{if(purchaseRun(build,msg))drawMaterials(taskId)};
  const host=document.getElementById('materialPicker'),src=typeof inventorySources==='function'?inventorySources():null;
  const add=document.getElementById('materialAdd');
  /* FB_2026_057: elegir no añade (falta la cantidad); el botón dice qué se va a añadir y, si se guarda la tarea con algo elegido
     sin añadir, se añade entonces (materialPendingAdd), en vez de perderse sin aviso. */
  const paintAdd=pick=>{if(!add)return;const it=pick?.itemId?inventoryItem(pick.itemId):null;add.textContent=it?`Añadir «${it.name}» a la tarea`:'Añadir';add.classList.toggle('primary',!!it);add.classList.toggle('ghost',!it)};
  if(host&&src){materialPicker=IkisaiKit.createItemPicker({label:'Añadir material o equipo',source:src.items,spaces:src.spaces,quantity:true,create:true,feedbackId:'tasks.tarea.materiales.elegir',onChange:paintAdd});host.append(materialPicker.element)}
  else if(host)host.innerHTML='<p class="small muted">El inventario no está disponible ahora mismo.</p>';
  if(add)add.onclick=()=>{if(!materialPendingAdd(taskId))toast('Elige un artículo del inventario.')};
  const kit=document.getElementById('materialKit');if(kit)kit.onclick=()=>{const live=id=>{const it=inventoryItem(id);return !it||(!it.deleted_at&&it.active!==false)};
    const list=M().kitSuggestions(purchasesData(),taskId,Sync.core.tradeKit,live);run(d=>M().addKitOps(d,taskId,list),list.length===1?'Añadido 1 material del oficio.':`Añadidos ${list.length} materiales del oficio.`)};
  document.querySelectorAll('[data-material-spent]').forEach(b=>b.onclick=()=>consumptionSheet([taskId],b.dataset.materialSpent));
  document.querySelectorAll('[data-material-remove]').forEach(b=>b.onclick=()=>run(d=>M().removeMaterialOps(d,b.dataset.materialRemove),'Quitado.'));
  document.querySelectorAll('[data-material-qty]').forEach(i=>i.onchange=()=>{const v=i.value.trim();run(d=>M().setMaterialQuantityOps(d,i.dataset.materialQty,v===''?null:Number(v)))});
  const consume=document.getElementById('materialConsume');if(consume)consume.onclick=()=>consumptionSheet([taskId])}
/* Añade a la tarea lo elegido en el selector, si lo hay. Devuelve si había algo que añadir. */
function materialPendingAdd(taskId){const pick=materialPicker?.get();if(!pick?.itemId)return false;
  const q=pick.baseQuantity??pick.quantity??null;
  if(purchaseRun(d=>M().addMaterialOps(d,{taskId,itemId:pick.itemId,quantity:q==null||q===''?null:Number(q)}),'Material añadido.')){if(document.getElementById('taskMaterials'))drawMaterials(taskId);else materialPicker?.set({itemId:null})}
  return true}
/* «Guardar» de la ficha con un material elegido y sin añadir: se añade antes de guardar (FB_2026_057). */
document.addEventListener('click',e=>{if(!e.target.closest('#saveTaskBtn'))return;const box=document.getElementById('taskMaterials');if(box?.dataset.task)materialPendingAdd(box.dataset.task)},true);

/* «Confirmar consumo»: lo previsto de cada material, editable, o «No se usó». Primero Recursos, después la tarea. Con
   `onlyId`, solo esa línea («Gastado» de la fila, FB_2026_058). */
function consumptionSheet(taskIds,onlyId=null){const pending=taskIds.flatMap(id=>M().pendingConsumption(purchasesData(),id,isConsumable)).filter(m=>!onlyId||m.id===onlyId);if(!pending.length)return;
  const line=m=>{const item=inventoryItem(m.item_id);return `<li class="consumeline" data-consume="${m.id}"><span class="materialname">${esc(item?.name||'Artículo del inventario')}</span>
    <input type="number" min="0" step="any" inputmode="decimal" value="${m.quantity??''}" placeholder="Cuánto" aria-label="Gastado de ${esc(item?.name||'')}" data-consume-qty="${m.id}" data-feedback-id="tasks.consumo.cantidad" data-feedback-label="Cantidad gastada"><span class="materialunit">${esc(item?.base_unit||'')}</span>
    <label class="checkline"><input type="checkbox" data-consume-none="${m.id}" data-feedback-id="tasks.consumo.no_se_uso" data-feedback-label="No se usó"> No se usó</label></li>`};
  openSheet(`<h2 class="sheettitle">Confirmar consumo</h2><p class="small">Lo que se gastó sale del inventario de la casa. Corrige lo que no cuadre; nada se descuenta sin confirmar.</p>
    <ul class="materiallist consumelist">${pending.map(line).join('')}</ul>
    <div class="actions"><button class="primary" id="consumeSave" type="button" data-feedback-id="tasks.consumo.confirmar" data-feedback-label="Confirmar consumo">Confirmar consumo</button><button class="ghost" id="consumeLater" type="button" data-feedback-id="tasks.consumo.ahora_no" data-feedback-label="Ahora no">Ahora no</button></div>`);
  document.querySelectorAll('[data-consume-none]').forEach(b=>b.onchange=()=>{const q=document.querySelector(`[data-consume-qty="${b.dataset.consumeNone}"]`);if(q)q.disabled=b.checked});
  document.getElementById('consumeLater').onclick=()=>closeSheet();
  const save=document.getElementById('consumeSave');save.onclick=async()=>{const lines=[];
    for(const m of pending){const none=document.querySelector(`[data-consume-none="${m.id}"]`)?.checked,raw=document.querySelector(`[data-consume-qty="${m.id}"]`)?.value.trim();
      if(none){lines.push({materialId:m.id,consumed:0});continue}
      const n=Number(raw);if(raw===''||!Number.isFinite(n)||n<0)return toast('Indica cuánto se gastó, o marca «No se usó».');lines.push({materialId:m.id,consumed:n})}
    save.disabled=true;
    try{await Sync.core.recordConsumption(lines)}catch(e){save.disabled=false;return toast(e.message||'No se pudo apuntar en el inventario.')}
    if(purchaseRun(d=>M().confirmConsumptionOps(d,lines),'Consumo apuntado.')){usage.track('tasks.consumo.confirmar');closeSheet()}else save.disabled=false}}

/* Completar una tarea (o un padre con sus hijas) con materiales pendientes: pregunta el consumo. La hoja sale cuando se va el
   aviso «Tarea completada · Deshacer», nunca antes; si se deshace, no sale (PERDIDAS §2: lo descontado no vuelve). Reabrir una
   tarea con el consumo ya apuntado avisa de que lo gastado no vuelve al inventario. */
function consumedAlready(ids){try{const data=purchasesData();return ids.some(t=>M().taskMaterials(data,t).some(m=>Number(m.consumed)>0))}catch{return false}}
const toggleTaskBeforeMaterials=toggleTask;
toggleTask=function(id){const before=taskLocation(id),wasDone=before?status(before.p,before.t)==='done':true,area=state.activeTab;toggleTaskBeforeMaterials(id);
  if(typeof batchMode!=='undefined'&&batchMode)return;const after=taskLocation(id);if(!after)return;
  const ids=[id,...children(after.p,id).map(c=>c.id)];
  if(wasDone){if(status(after.p,after.t)!=='done'&&consumedAlready(ids))toast('Lo gastado no vuelve al inventario.');return}
  if(!canEditMaterials()||status(after.p,after.t)!=='done')return;
  if(!ids.some(t=>M().pendingConsumption(purchasesData(),t,isConsumable).length))return;
  const ask=()=>withArea(area,()=>{const now=taskLocation(id);if(!now||now.t.deleted||status(now.p,now.t)!=='done')return;
    const live=[id,...children(now.p,id).map(c=>c.id)];if(live.some(t=>M().pendingConsumption(purchasesData(),t,isConsumable).length))consumptionSheet(live)});
  if(typeof afterUndoWindow==='function')afterUndoWindow('toggle:'+id,ask);else ask()};

/* La ficha de la tarea: la sección antes de los comentarios (o de los botones). */
const openTaskEditorBeforeMaterials=openTaskEditor;
openTaskEditor=function(id,...rest){openTaskEditorBeforeMaterials(id,...rest);document.getElementById('taskMaterials')?.remove();if(!id||!taskLocation(id))return;drawMaterials(id)};

/* Con datos nuevos (de este dispositivo o de otro), la sección abierta se repinta salvo que se esté escribiendo en ella. */
const refreshModelBeforeMaterials=refreshModel;
refreshModel=function(){refreshModelBeforeMaterials();const box=document.getElementById('taskMaterials');if(!box)return;
  if(box.contains(document.activeElement))return;drawMaterials(box.dataset.task)};
