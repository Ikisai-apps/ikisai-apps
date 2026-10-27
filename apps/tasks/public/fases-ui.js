/* Fases del proyecto en Tasks («Proyectos y producción» 7.1; docs/tasks/API.md §51; migración 0356). Van por el modelo de
   siempre (`p.phases`, `t.phaseId`) y `save()`, como el resto de la ficha:
   - En el proyecto, la banda «Fases»: cada fase con sus madres hechas («2 de 5») y «+ Fase» para quien edita.
   - La hoja de una fase: nombre, estado, fechas, nota de cierre, subir o bajar, quitar y sus tareas. Cerrar con tareas
     abiertas pide nota (decisión de VG, vg-37). Quitar una fase deja sus tareas sin fase.
   - En la ficha de una tarea madre, «Fase». Un paso no la elige: lleva la de su madre.
   Prefijo de clases: `tkph-`. */
const TKPH_STATUS={pending:'Pendiente',active:'En curso',done:'Cerrada'};
function tkphList(p){return (p?.phases||[]).filter(f=>!f.deleted).sort((a,b)=>Number(a.order)-Number(b.order))}
function tkphCanEdit(p){return !!p&&!p.system&&canEdit()&&Sync.actor?.role!=='outsider'}
function tkphTasks(p,phaseId){return (p.tasks||[]).filter(t=>!t.deleted&&!t.parentId&&t.phaseId===phaseId)}
function tkphSave(p,message){touch(p);if(save()===false)return false;render();if(message)toast(message);return true}

/* --- La banda del proyecto ---------------------------------------------------------------------------------------- */
function tkphBand(p){if(!p||p.system)return '';const list=tkphList(p),can=tkphCanEdit(p);if(!list.length&&!can)return '';
  const chip=f=>{const tasks=tkphTasks(p,f.id),done=tasks.filter(t=>t.done).length;
    return `<button type="button" class="tkph-chip ${esc(f.status)}" data-tkph="${esc(f.id)}" data-feedback-id="tasks.fases.fase" data-feedback-label="Abrir la fase">${f.status==='done'?'✓ ':''}${esc(f.name)}<span class="small muted"> · ${tasks.length?`${done} de ${tasks.length}`:'sin tareas'}</span></button>`};
  return `<section class="tkph-band" id="tkphBand" aria-label="Fases"><b>Fases</b><div class="tkph-chips">${list.map(chip).join('')}${can?'<button type="button" class="softbtn" id="tkphNew" data-feedback-id="tasks.fases.nueva" data-feedback-label="Nueva fase">+ Fase</button>':''}</div></section>`}

/* --- La hoja de una fase ------------------------------------------------------------------------------------------ */
function tkphSheet(phaseId){const p=project();if(!p)return;const list=tkphList(p),f=phaseId?list.find(x=>x.id===phaseId):null;if(phaseId&&!f)return closeSheet();
  const can=tkphCanEdit(p),dis=can?'':'disabled',tasks=f?tkphTasks(p,f.id):[],open=tasks.filter(t=>!t.done).length,at=f?list.indexOf(f):-1;
  openSheet(`<h2 class="sheettitle">${f?esc(f.name):'Fase nueva'}</h2><p class="subtitle">${esc(p.title)}</p>
    <div class="field"><label for="tkphName">Nombre</label><input id="tkphName" maxlength="120" value="${esc(f?.name||'')}" placeholder="Cortar, Montar, Acabar…" ${dis} data-feedback-id="tasks.fases.nombre" data-feedback-label="Nombre de la fase"></div>
    ${f?`<div class="field"><label for="tkphStatus">Estado</label><select id="tkphStatus" ${dis} data-feedback-id="tasks.fases.estado" data-feedback-label="Estado de la fase">${Object.entries(TKPH_STATUS).map(([k,v])=>`<option value="${k}" ${f.status===k?'selected':''}>${esc(v)}</option>`).join('')}</select></div>`:''}
    <div class="row tkph-dates"><div class="field"><label for="tkphStart">Empieza</label><input id="tkphStart" type="date" value="${esc(f?.start||'')}" ${dis} data-feedback-id="tasks.fases.empieza" data-feedback-label="Cuándo empieza la fase"></div>
      <div class="field"><label for="tkphDue">Acaba</label><input id="tkphDue" type="date" value="${esc(f?.due||'')}" ${dis} data-feedback-id="tasks.fases.acaba" data-feedback-label="Cuándo acaba la fase"></div></div>
    ${f?`<div class="field" id="tkphNoteField"><label for="tkphNote">Nota de cierre${open?` <span class="small muted">(quedan ${open} sin hacer: para cerrarla hace falta)</span>`:''}</label><textarea id="tkphNote" rows="2" maxlength="2000" ${dis} data-feedback-id="tasks.fases.nota" data-feedback-label="Nota de cierre de la fase">${esc(f.closedNote||'')}</textarea></div>`:''}
    ${tasks.length?`<h3 class="tkph-h">Tareas</h3><div class="menulist">${tasks.map(t=>`<button type="button" data-tkph-task="${esc(t.id)}">${t.done?'✓ ':''}${esc(t.text)}</button>`).join('')}</div>`:f?'<p class="small muted">Aún no tiene tareas: se ponen desde la ficha de cada tarea, en «Fase».</p>':''}
    <div class="actions">${can?`<button class="primary" id="tkphSave" type="button" data-feedback-id="tasks.fases.guardar" data-feedback-label="Guardar la fase">${f?'Guardar':'Crear'}</button>`:''}
      ${can&&f&&at>0?'<button class="ghost" id="tkphUp" type="button" aria-label="Subir la fase" data-feedback-id="tasks.fases.subir" data-feedback-label="Subir la fase">↑</button>':''}
      ${can&&f&&at<list.length-1?'<button class="ghost" id="tkphDown" type="button" aria-label="Bajar la fase" data-feedback-id="tasks.fases.bajar" data-feedback-label="Bajar la fase">↓</button>':''}
      ${can&&f?'<button class="ghost danger-text" id="tkphDel" type="button" data-feedback-id="tasks.fases.quitar" data-feedback-label="Quitar la fase">Quitar</button>':''}
      <button class="ghost" id="tkphClose" type="button">Cerrar</button></div>`);
  const $=id=>document.getElementById(id);
  $('tkphClose').onclick=()=>closeSheet();
  document.querySelectorAll('[data-tkph-task]').forEach(b=>b.onclick=()=>openTaskEditor(b.dataset.tkphTask));
  if(!can)return;
  $('tkphSave').onclick=()=>{const name=$('tkphName').value.trim(),start=$('tkphStart').value,due=$('tkphDue').value;
    if(!name)return toast('Ponle nombre a la fase.');
    if(start&&due&&start>due)return toast('La fase no puede acabar antes de empezar.');
    if(!f){p.phases||=[];p.phases.push({id:crypto.randomUUID(),name,order:Math.max(0,...p.phases.map(x=>Number(x.order)||0))+1024,status:'pending',start,due,closedNote:'',version:0});
      if(tkphSave(p,'Fase creada.'))closeSheet();return}
    const status=$('tkphStatus').value,note=$('tkphNote').value.trim();
    if(status==='done'&&f.status!=='done'&&open&&!note)return toast(`Quedan ${open} sin hacer: para cerrarla, deja una nota.`);
    Object.assign(f,{name,status,start,due,closedNote:note});if(tkphSave(p,'Fase guardada.'))closeSheet()};
  const swap=d=>{const other=list[at+d];if(!other)return;const o=f.order;f.order=other.order;other.order=o;
    if(f.order===other.order)f.order=Number(other.order)+(d>0?1:-1);if(tkphSave(p))tkphSheet(f.id)};
  const up=$('tkphUp');if(up)up.onclick=()=>swap(-1);
  const down=$('tkphDown');if(down)down.onclick=()=>swap(1);
  const del=$('tkphDel');if(del)del.onclick=()=>{p.phases=(p.phases||[]).filter(x=>x.id!==f.id);
    for(const t of p.tasks||[])if(t.phaseId===f.id){t.phaseId=null;touch(t)}
    if(tkphSave(p,tasks.length?`Fase quitada: ${tasks.length===1?'su tarea queda':`sus ${tasks.length} tareas quedan`} sin fase.`:'Fase quitada.'))closeSheet()}}

/* --- «Fase» en la ficha de la tarea ------------------------------------------------------------------------------- */
function tkphFieldHtml(id){const loc=taskLocation(id);if(!loc)return '';const list=tkphList(loc.p);if(!list.length)return '';
  if(loc.t.parentId){const f=list.find(x=>x.id===loc.t.phaseId);return f?`<p class="small muted tkph-field">Fase: ${esc(f.name)} (la de su tarea madre)</p>`:''}
  return `<div class="field tkph-field"><label for="tkphTask">Fase</label><select id="tkphTask" ${tkphCanEdit(loc.p)?'':'disabled'} data-feedback-id="tasks.fases.tarea" data-feedback-label="Fase de la tarea"><option value="">Sin fase</option>${list.map(f=>`<option value="${esc(f.id)}" ${loc.t.phaseId===f.id?'selected':''}>${esc(f.name)}</option>`).join('')}</select></div>`}
const openTaskEditorBeforePhases=openTaskEditor;
openTaskEditor=function(id,...rest){const out=openTaskEditorBeforePhases(id,...rest);const s=document.getElementById('sheet');s?.querySelectorAll('.tkph-field').forEach(n=>n.remove());
  if(!id||!s)return out;const html=tkphFieldHtml(id);if(!html)return out;
  const anchor=s.querySelector('.tkf-portada .tkf-tiles');if(!anchor)return out;anchor.insertAdjacentHTML('beforebegin',html);
  const sel=s.querySelector('#tkphTask');
  if(sel)sel.onchange=()=>{const loc=taskLocation(id);if(!loc)return;loc.t.phaseId=sel.value||null;touch(loc.t);record('edit',[id]);
    if(save()!==false){render();toast(sel.value?`En la fase «${tkphList(loc.p).find(f=>f.id===sel.value)?.name||''}».`:'Sin fase.')}};
  return out};

const projectViewBeforePhases=projectView;
projectView=function(...a){const html=projectViewBeforePhases(...a),p=project();if(!p)return html;const band=tkphBand(p);
  return band?html.replace(/(<main[^>]*>)/,'$1'+band):html};
const bindBeforePhases=bind;
bind=function(){bindBeforePhases();document.querySelectorAll('[data-tkph]').forEach(b=>b.onclick=()=>tkphSheet(b.dataset.tkph));
  const n=document.getElementById('tkphNew');if(n)n.onclick=()=>tkphSheet(null)};
