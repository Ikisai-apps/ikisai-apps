/* Entregables y unidades en Tasks («Proyectos y producción» 7.5; docs/tasks/API.md §55 y §57). Van por el modelo de siempre
   (`p.deliverables`, `t.deliverableId`, `t.unitCount`) y `save()`; marcar una unidad, por su acción (`tasks/unit-step`):
   - En el proyecto, la banda «Entregables»: cada uno con sus madres hechas («1 de 2»), su estado a mano (entregado,
     instalado) y «+ Entregable» para quien edita.
   - La hoja de un entregable: nombre, cantidad, estado, nota, quitar (deja sus tareas sin entregable) y sus tareas.
   - En la ficha de una madre, «Entregable» y «Unidades» (cuántas veces se hace: «4 marcos»).
   - En la ficha de una tarea con unidades, un botón por unidad («2 de 4»): marca o desmarca; con todas, queda hecha.
   Prefijo de clases: `tkdv-`. */
const TKDV_STATUS={todo:'Por hacer',delivered:'Entregado',installed:'Instalado'};
function tkdvList(p){return (p?.deliverables||[]).filter(d=>!d.deleted).sort((a,b)=>Number(a.order)-Number(b.order))}
function tkdvCanEdit(p){return !!p&&!p.system&&canEdit()&&Sync.actor?.role!=='outsider'}
function tkdvTasks(p,id){return (p.tasks||[]).filter(t=>!t.deleted&&!t.parentId&&t.deliverableId===id)}
function tkdvSave(p,message){touch(p);if(save()===false)return false;render();if(message)toast(message);return true}
function tkdvState(d,tasks){const done=tasks.length>0&&tasks.every(t=>t.done);return d.status!=='todo'?TKDV_STATUS[d.status]:done?'Hecho':`${tasks.filter(t=>t.done).length} de ${tasks.length}`}

/* --- La banda del proyecto ---------------------------------------------------------------------------------------- */
function tkdvBand(p){if(!p||p.system)return '';const list=tkdvList(p),can=tkdvCanEdit(p);if(!list.length&&!can)return '';
  const chip=d=>{const tasks=tkdvTasks(p,d.id);
    return `<button type="button" class="tkdv-chip ${esc(d.status)}" data-tkdv="${esc(d.id)}" data-feedback-id="tasks.entregables.entregable" data-feedback-label="Abrir el entregable">${esc(d.name)}<span class="small muted"> · ${esc(tkdvState(d,tasks))}</span></button>`};
  return `<section class="tkdv-band" id="tkdvBand" aria-label="Entregables"><b>Entregables</b><div class="tkdv-chips">${list.map(chip).join('')}${can?'<button type="button" class="softbtn" id="tkdvNew" data-feedback-id="tasks.entregables.nuevo" data-feedback-label="Nuevo entregable">+ Entregable</button>':''}</div></section>`}

/* --- La hoja de un entregable ------------------------------------------------------------------------------------- */
function tkdvSheet(id){const p=project();if(!p)return;const d=id?tkdvList(p).find(x=>x.id===id):null;if(id&&!d)return closeSheet();
  const can=tkdvCanEdit(p),dis=can?'':'disabled',tasks=d?tkdvTasks(p,d.id):[];
  openSheet(`<h2 class="sheettitle">${d?esc(d.name):'Entregable nuevo'}</h2><p class="subtitle">${esc(p.title)}</p>
    <div class="field"><label for="tkdvName">Qué se entrega</label><input id="tkdvName" maxlength="200" value="${esc(d?.name||'')}" placeholder="4 marcos acústicos" ${dis} data-feedback-id="tasks.entregables.nombre" data-feedback-label="Nombre del entregable"></div>
    <div class="row tkdv-row"><div class="field"><label for="tkdvQty">Cantidad</label><input id="tkdvQty" type="number" min="0" step="any" inputmode="decimal" value="${esc(String(d?.quantity??''))}" ${dis} data-feedback-id="tasks.entregables.cantidad" data-feedback-label="Cantidad del entregable"></div>
      ${d?`<div class="field"><label for="tkdvStatus">Estado</label><select id="tkdvStatus" ${dis} data-feedback-id="tasks.entregables.estado" data-feedback-label="Estado del entregable">${Object.entries(TKDV_STATUS).map(([k,v])=>`<option value="${k}" ${d.status===k?'selected':''}>${esc(v)}</option>`).join('')}</select></div>`:''}</div>
    <div class="field"><label for="tkdvNote">Nota</label><textarea id="tkdvNote" rows="2" maxlength="2000" ${dis} data-feedback-id="tasks.entregables.nota" data-feedback-label="Nota del entregable">${esc(d?.note||'')}</textarea></div>
    ${tasks.length?`<h3 class="tkdv-h">Tareas</h3><div class="menulist">${tasks.map(t=>`<button type="button" data-tkdv-task="${esc(t.id)}">${t.done?'✓ ':''}${esc(t.text)}</button>`).join('')}</div>`:d?'<p class="small muted">Aún no tiene tareas: se ponen desde la ficha de cada tarea, en «Entregable».</p>':''}
    <div class="actions">${can?`<button class="primary" id="tkdvSave" type="button" data-feedback-id="tasks.entregables.guardar" data-feedback-label="Guardar el entregable">${d?'Guardar':'Crear'}</button>`:''}
      ${can&&d?'<button class="ghost danger-text" id="tkdvDel" type="button" data-feedback-id="tasks.entregables.quitar" data-feedback-label="Quitar el entregable">Quitar</button>':''}
      <button class="ghost" id="tkdvClose" type="button">Cerrar</button></div>`);
  const $=x=>document.getElementById(x);
  $('tkdvClose').onclick=()=>closeSheet();
  document.querySelectorAll('[data-tkdv-task]').forEach(b=>b.onclick=()=>openTaskEditor(b.dataset.tkdvTask));
  if(!can)return;
  $('tkdvSave').onclick=()=>{const name=$('tkdvName').value.trim(),q=$('tkdvQty').value.trim(),note=$('tkdvNote').value.trim();
    if(!name)return toast('Di qué se entrega.');
    const quantity=q===''?null:Number(q);if(quantity!==null&&!(quantity>0))return toast('La cantidad es un número mayor que 0.');
    if(!d){p.deliverables||=[];p.deliverables.push({id:crypto.randomUUID(),name,quantity,status:'todo',spaceId:null,note,order:Math.max(0,...p.deliverables.map(x=>Number(x.order)||0))+1024,version:0});
      if(tkdvSave(p,'Entregable creado.'))closeSheet();return}
    Object.assign(d,{name,quantity,note,status:$('tkdvStatus').value});if(tkdvSave(p,'Entregable guardado.'))closeSheet()};
  $('tkdvDel').onclick=()=>{p.deliverables=(p.deliverables||[]).filter(x=>x.id!==d.id);
    for(const t of p.tasks||[])if(t.deliverableId===d.id){t.deliverableId=null;touch(t)}
    if(tkdvSave(p,tasks.length?`Entregable quitado: ${tasks.length===1?'su tarea queda':`sus ${tasks.length} tareas quedan`} sin entregable.`:'Entregable quitado.'))closeSheet()}}

/* --- En la ficha de la tarea: entregable, unidades y marcar unidades ---------------------------------------------- */
function tkdvUnitsOf(loc){if(!loc)return null;const mother=loc.t.parentId?loc.p.tasks.find(x=>x.id===loc.t.parentId):loc.t;const n=Number(mother?.unitCount)||0;
  const hasSteps=!loc.t.parentId&&loc.p.tasks.some(x=>x.parentId===loc.t.id&&!x.deleted);return n>1&&!hasSteps?n:null}
function tkdvFieldsHtml(id){const loc=taskLocation(id);if(!loc)return '';const can=tkdvCanEdit(loc.p),dis=can?'':'disabled',list=tkdvList(loc.p);let html='';
  if(!loc.t.parentId){
    if(list.length)html+=`<div class="field tkdv-field"><label for="tkdvTask">Entregable</label><select id="tkdvTask" ${dis} data-feedback-id="tasks.entregables.tarea" data-feedback-label="Entregable de la tarea"><option value="">Sin entregable</option>${list.map(d=>`<option value="${esc(d.id)}" ${loc.t.deliverableId===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>`;
    html+=`<div class="field tkdv-field"><label for="tkdvUnits">Unidades <span class="small muted">(cuántas veces se hace; vacío, una)</span></label><input id="tkdvUnits" type="number" min="1" max="100" step="1" inputmode="numeric" value="${esc(String(loc.t.unitCount??''))}" ${dis} data-feedback-id="tasks.unidades.cantidad" data-feedback-label="Unidades de la tarea"></div>`;
  }else{const d=list.find(x=>x.id===loc.t.deliverableId);if(d)html+=`<p class="small muted tkdv-field">Entregable: ${esc(d.name)} (el de su tarea madre)</p>`}
  const n=tkdvUnitsOf(loc);
  if(n){const done=Number(loc.t.unitsDone)||0;
    html+=`<div class="tkdv-field tkdv-units" id="tkdvUnitMarks" role="group" aria-label="Unidades"><span class="small">${done} de ${n}</span>${Array.from({length:n},(_,i)=>`<button type="button" class="tkdv-unit" data-tkdv-unit="${i+1}" ${can?'':'disabled'} aria-label="Unidad ${i+1}" data-feedback-id="tasks.unidades.marcar" data-feedback-label="Marcar una unidad">${i+1}</button>`).join('')}</div>`}
  return html}
async function tkdvMark(id,unit,button){if(!navigator.onLine)return toast('Sin conexión: las unidades se marcan con red.');
  const done=button.getAttribute('aria-pressed')!=='true';
  try{await syncNow();const out=await Sync.core.api('/tasks/unit-step',{method:'POST',json:{taskId:id,unit,done}});await syncNow();render();
    toast(out.taskDone?`Hecha: ${out.unitsDone} de ${out.units}.`:`${out.unitsDone} de ${out.units}.`);if(taskLocation(id))openTaskEditor(id)}
  catch(e){toast(e.message||'No se pudo marcar.')}}
const openTaskEditorBeforeDeliverables=openTaskEditor;
openTaskEditor=function(id,...rest){const out=openTaskEditorBeforeDeliverables(id,...rest);const s=document.getElementById('sheet');s?.querySelectorAll('.tkdv-field').forEach(n=>n.remove());
  if(!id||!s)return out;const html=tkdvFieldsHtml(id);if(!html)return out;
  const anchor=s.querySelector('.tkf-portada .tkf-tiles');if(!anchor)return out;anchor.insertAdjacentHTML('beforebegin',html);
  const loc=taskLocation(id),marks=new Set((Sync.core?.data?.['tasks.task_units']||[]).filter(u=>!u.deleted_at&&u.task_id===id).map(u=>Number(u.unit)));
  s.querySelectorAll('[data-tkdv-unit]').forEach(b=>{const u=Number(b.dataset.tkdvUnit);b.setAttribute('aria-pressed',marks.has(u)?'true':'false');b.onclick=()=>tkdvMark(id,u,b)});
  const sel=s.querySelector('#tkdvTask');
  if(sel)sel.onchange=()=>{const l=taskLocation(id);if(!l)return;l.t.deliverableId=sel.value||null;touch(l.t);record('edit',[id]);if(save()!==false){render();toast(sel.value?'Entregable puesto.':'Sin entregable.')}};
  const units=s.querySelector('#tkdvUnits');
  if(units)units.onchange=()=>{const l=taskLocation(id);if(!l)return;const v=units.value.trim(),n=v===''?null:Number(v);
    if(n!==null&&(!Number.isInteger(n)||n<1||n>100))return toast('Las unidades son un número entero de 1 a 100.');
    l.t.unitCount=n;touch(l.t);record('edit',[id]);if(save()!==false){render();toast(n&&n>1?`${n} unidades.`:'Sin unidades.')}};
  return out};

const projectViewBeforeDeliverables=projectView;
projectView=function(...a){const html=projectViewBeforeDeliverables(...a),p=project();if(!p)return html;const band=tkdvBand(p);
  return band?html.replace(/(<main[^>]*>)/,'$1'+band):html};
const bindBeforeDeliverables=bind;
bind=function(){bindBeforeDeliverables();document.querySelectorAll('[data-tkdv]').forEach(b=>b.onclick=()=>tkdvSheet(b.dataset.tkdv));
  const n=document.getElementById('tkdvNew');if(n)n.onclick=()=>tkdvSheet(null)};
