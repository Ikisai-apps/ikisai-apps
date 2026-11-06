/* Fases del proyecto en Tasks («Proyectos y producción» 7.1; docs/tasks/API.md §51; migración 0356). Van por el modelo de
   siempre (`p.phases`, `t.phaseId`) y `save()`, como el resto de la ficha:
   - En el proyecto, la banda «Fases»: cada fase con sus madres hechas («2 de 5») y «+ Fase» para quien edita.
   - La hoja de una fase: nombre, estado, fechas, nota de cierre, subir o bajar, quitar y sus tareas. Cerrar con tareas
     abiertas pide nota (decisión de VG, vg-37). Quitar una fase deja sus tareas sin fase.
   - En la ficha de una tarea madre, «Fase». Un paso no la elige: lleva la de su madre.
   «Etapa» como fase (encargo de VG del 06-11, migración 0367, §61): una de las fases es la «actual» (se marca en su hoja) y es
   la de las tareas nuevas. Una madre de un proyecto con fases lleva siempre una, sin «Sin fase»: en la ficha se elige con un
   segmento ordenado; al quitar una fase, sus tareas pasan a la actual; la primera fase de un proyecto se la llevan todas.
   Prefijo de clases: `tkph-`. */
const TKPH_STATUS={pending:'Pendiente',active:'En curso',done:'Cerrada'};
function tkphList(p){return (p?.phases||[]).filter(f=>!f.deleted).sort((a,b)=>Number(a.order)-Number(b.order))}
function tkphCanEdit(p){return !!p&&!p.system&&canEdit()&&Sync.actor?.role!=='outsider'}
function tkphTasks(p,phaseId){return (p.tasks||[]).filter(t=>!t.deleted&&!t.parentId&&t.phaseId===phaseId)}
/* La fase por defecto: la actual; si no hay, la primera sin cerrar; si no, la primera (como tasks.default_phase). */
function tkphDefault(p,list=tkphList(p)){return list.find(f=>f.current)||list.find(f=>f.status!=='done')||list[0]||null}
/* Cada madre viva sin fase de su proyecto (nueva, movida de otro o de antes de tener fases) recibe la de por defecto. */
function tkphSettle(p){const list=tkphList(p);if(!list.length)return;const ids=new Set(list.map(f=>f.id)),def=tkphDefault(p,list);
  for(const t of p.tasks||[])if(!t.deleted&&!t.parentId&&!ids.has(t.phaseId)){t.phaseId=def.id;touch(t)}}
function tkphSave(p,message){touch(p);if(save()===false)return false;render();if(message)toast(message);return true}

/* --- La banda del proyecto ---------------------------------------------------------------------------------------- */
function tkphBand(p){if(!p||p.system)return '';const list=tkphList(p),can=tkphCanEdit(p);if(!list.length&&!can)return '';
  const chip=f=>{const tasks=tkphTasks(p,f.id),done=tasks.filter(t=>t.done).length;
    return `<button type="button" class="tkph-chip ${esc(f.status)}" data-tkph="${esc(f.id)}" data-feedback-id="tasks.fases.fase" data-feedback-label="Abrir la fase">${f.status==='done'?'✓ ':''}${esc(f.name)}${f.current?' <span class="tkph-now">actual</span>':''}<span class="small muted"> · ${tasks.length?`${done} de ${tasks.length}`:'sin tareas'}</span></button>`};
  return `<section class="tkph-band" id="tkphBand" aria-label="Fases"><b>Fases</b><div class="tkph-chips">${list.map(chip).join('')}${can?'<button type="button" class="softbtn" id="tkphNew" data-feedback-id="tasks.fases.nueva" data-feedback-label="Nueva fase">+ Fase</button>':''}</div></section>`}

/* --- La hoja de una fase ------------------------------------------------------------------------------------------ */
function tkphSheet(phaseId){const p=project();if(!p)return;const list=tkphList(p),f=phaseId?list.find(x=>x.id===phaseId):null;if(phaseId&&!f)return closeSheet();
  const can=tkphCanEdit(p),dis=can?'':'disabled',tasks=f?tkphTasks(p,f.id):[],open=tasks.filter(t=>!t.done).length,at=f?list.indexOf(f):-1;
  openSheet(`<h2 class="sheettitle">${f?esc(f.name):'Fase nueva'}</h2><p class="subtitle">${esc(p.title)}</p>
    <div class="field"><label for="tkphName">Nombre</label><input data-field-id="tasks.fases.nombre" data-field-entity="tasks.project_phases" data-field-prop="name" id="tkphName" maxlength="120" value="${esc(f?.name||'')}" placeholder="Cortar, Montar, Acabar…" ${dis} data-feedback-id="tasks.fases.nombre" data-feedback-label="Nombre de la fase"></div>
    ${f?`<div class="field"><label for="tkphStatus">Estado</label><select data-field-id="tasks.fases.estado" data-field-entity="tasks.project_phases" data-field-prop="status" id="tkphStatus" ${dis} data-feedback-id="tasks.fases.estado" data-feedback-label="Estado de la fase">${Object.entries(TKPH_STATUS).map(([k,v])=>`<option value="${k}" ${f.status===k?'selected':''}>${esc(v)}</option>`).join('')}</select></div>`:''}
    <div class="row tkph-dates"><div class="field"><label for="tkphStart">Empieza</label><input data-field-id="tasks.fases.empieza" data-field-entity="tasks.project_phases" data-field-prop="start" id="tkphStart" type="date" value="${esc(f?.start||'')}" ${dis} data-feedback-id="tasks.fases.empieza" data-feedback-label="Cuándo empieza la fase"></div>
      <div class="field"><label for="tkphDue">Acaba</label><input data-field-id="tasks.fases.acaba" data-field-entity="tasks.project_phases" data-field-prop="due" id="tkphDue" type="date" value="${esc(f?.due||'')}" ${dis} data-feedback-id="tasks.fases.acaba" data-feedback-label="Cuándo acaba la fase"></div></div>
    <label class="tkph-current"><input type="checkbox" id="tkphCurrent" data-field-id="tasks.fases.actual" data-field-entity="tasks.project_phases" data-field-prop="is_current" ${(f?f.current:!list.length)?'checked':''} ${dis} data-feedback-id="tasks.fases.actual" data-feedback-label="Fase actual"> Actual: la de las tareas nuevas</label>
    ${f?`<div class="field" id="tkphNoteField"><label for="tkphNote">Nota de cierre${open?` <span class="small muted">(quedan ${open} sin hacer: para cerrarla hace falta)</span>`:''}</label><textarea data-field-id="tasks.fases.nota" data-field-entity="tasks.project_phases" data-field-prop="closed_note" id="tkphNote" rows="2" maxlength="2000" ${dis} data-feedback-id="tasks.fases.nota" data-feedback-label="Nota de cierre de la fase">${esc(f.closedNote||'')}</textarea></div>`:''}
    ${tasks.length?`<h3 class="tkph-h">Tareas</h3><div class="menulist">${tasks.map(t=>`<button type="button" data-tkph-task="${esc(t.id)}">${t.done?'✓ ':''}${esc(t.text)}</button>`).join('')}</div>`:f?'<p class="small muted">Aún no tiene tareas: se cambian desde la ficha de cada tarea, en «Fase».</p>':''}
    <div class="actions">${can?`<button class="primary" id="tkphSave" type="button" data-feedback-id="tasks.fases.guardar" data-feedback-label="Guardar la fase">${f?'Guardar':'Crear'}</button>`:''}
      ${can&&f&&at>0?'<button class="ghost" id="tkphUp" type="button" aria-label="Subir la fase" data-feedback-id="tasks.fases.subir" data-feedback-label="Subir la fase">↑</button>':''}
      ${can&&f&&at<list.length-1?'<button class="ghost" id="tkphDown" type="button" aria-label="Bajar la fase" data-feedback-id="tasks.fases.bajar" data-feedback-label="Bajar la fase">↓</button>':''}
      ${can&&f?'<button class="ghost danger-text" id="tkphDel" type="button" data-feedback-id="tasks.fases.quitar" data-feedback-label="Quitar la fase">Quitar</button>':''}
      <button class="ghost" id="tkphClose" type="button">Cerrar</button></div>`);
  const $=id=>document.getElementById(id);
  $('tkphClose').onclick=()=>closeSheet();
  document.querySelectorAll('[data-tkph-task]').forEach(b=>b.onclick=()=>openTaskEditor(b.dataset.tkphTask));
  if(!can)return;
  const markCurrent=(id,on)=>{for(const x of p.phases||[])if(x.id===id)x.current=!!on;else if(on&&x.current)x.current=false};
  $('tkphSave').onclick=()=>{const name=$('tkphName').value.trim(),start=$('tkphStart').value,due=$('tkphDue').value,current=$('tkphCurrent').checked;
    if(!name)return toast('Ponle nombre a la fase.');
    if(start&&due&&start>due)return toast('La fase no puede acabar antes de empezar.');
    if(!f){p.phases||=[];const id=crypto.randomUUID(),first=!list.length;
      p.phases.push({id,name,order:Math.max(0,...p.phases.map(x=>Number(x.order)||0))+1024,status:'pending',start,due,closedNote:'',version:0});
      if(current||first)markCurrent(id,true);tkphSettle(p);
      if(tkphSave(p,first?'Fase creada: las tareas del proyecto quedan en ella.':'Fase creada.'))closeSheet();return}
    const status=$('tkphStatus').value,note=$('tkphNote').value.trim();
    if(status==='done'&&f.status!=='done'&&open&&!note)return toast(`Quedan ${open} sin hacer: para cerrarla, deja una nota.`);
    Object.assign(f,{name,status,start,due,closedNote:note});markCurrent(f.id,current);if(tkphSave(p,'Fase guardada.'))closeSheet()};
  const swap=d=>{const other=list[at+d];if(!other)return;const o=f.order;f.order=other.order;other.order=o;
    if(f.order===other.order)f.order=Number(other.order)+(d>0?1:-1);if(tkphSave(p))tkphSheet(f.id)};
  const up=$('tkphUp');if(up)up.onclick=()=>swap(-1);
  const down=$('tkphDown');if(down)down.onclick=()=>swap(1);
  const del=$('tkphDel');if(del)del.onclick=()=>{p.phases=(p.phases||[]).filter(x=>x.id!==f.id);const def=tkphDefault(p);
    for(const t of p.tasks||[])if(t.phaseId===f.id){t.phaseId=def?.id||null;touch(t)}
    if(tkphSave(p,tasks.length&&def?`Fase quitada: ${tasks.length===1?'su tarea pasa':`sus ${tasks.length} tareas pasan`} a «${def.name}».`:'Fase quitada.'))closeSheet()}}

/* --- «Fase» en la ficha de la tarea ------------------------------------------------------------------------------- */
function tkphFieldHtml(id){const loc=taskLocation(id);if(!loc)return '';const list=tkphList(loc.p);if(!list.length)return '';
  if(loc.t.parentId){const f=list.find(x=>x.id===loc.t.phaseId);return f?`<p class="small muted tkph-field">Fase: ${esc(f.name)} (la de su tarea madre)</p>`:''}
  const on=list.find(f=>f.id===loc.t.phaseId)||tkphDefault(loc.p,list),dis=tkphCanEdit(loc.p)?'':'disabled';
  return `<div class="field tkph-field"><span class="tkph-label" id="tkphTaskLabel">Fase</span><div class="tkph-seg" role="radiogroup" aria-labelledby="tkphTaskLabel" id="tkphTask" data-field-id="tasks.fases.tarea" data-field-entity="tasks.tasks" data-field-prop="phase_id" data-feedback-id="tasks.fases.tarea" data-feedback-label="Fase de la tarea">${list.map((f,i)=>{const past=i<list.indexOf(tkphDefault(loc.p,list));return `<button type="button" role="radio" aria-checked="${f===on}" class="${f===on?'on':''} ${esc(f.status)}${past?' past':''}" data-tkph-pick="${esc(f.id)}" ${past?'title="Anterior a la actual"':''} ${dis}>${f.status==='done'?'✓ ':''}${esc(f.name)}${f.current?'<span class="tkph-nowtag">actual</span>':''}</button>`}).join('')}</div></div>`}
const openTaskEditorBeforePhases=openTaskEditor;
openTaskEditor=function(id,...rest){const out=openTaskEditorBeforePhases(id,...rest);const s=document.getElementById('sheet');s?.querySelectorAll('.tkph-field').forEach(n=>n.remove());
  if(!id||!s)return out;const html=tkphFieldHtml(id);if(!html)return out;
  const anchor=s.querySelector('.tkf-portada .tkf-tiles');if(!anchor)return out;anchor.insertAdjacentHTML('beforebegin',html);
  s.querySelectorAll('[data-tkph-pick]').forEach(b=>b.onclick=()=>{const loc=taskLocation(id);if(!loc||loc.t.phaseId===b.dataset.tkphPick)return;
    loc.t.phaseId=b.dataset.tkphPick;touch(loc.t);record('edit',[id]);
    s.querySelectorAll('[data-tkph-pick]').forEach(x=>{const on=x===b;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on))});
    if(save()!==false){render();toast(`En la fase «${tkphList(loc.p).find(f=>f.id===b.dataset.tkphPick)?.name||''}».`)}});
  return out};

const projectViewBeforePhases=projectView;
projectView=function(...a){const html=projectViewBeforePhases(...a),p=project();if(!p)return html;const band=tkphBand(p);
  return band?html.replace(/(<main[^>]*>)/,'$1'+band):html};
const bindBeforePhases=bind;
bind=function(){bindBeforePhases();document.querySelectorAll('[data-tkph]').forEach(b=>b.onclick=()=>tkphSheet(b.dataset.tkph));
  const n=document.getElementById('tkphNew');if(n)n.onclick=()=>tkphSheet(null)};

/* Antes de guardar, cada madre de un proyecto con fases queda con una (la tarea nueva, la actual). */
const saveBeforePhaseDefault=save;
save=function(...args){try{for(const a of state.tabs||[])for(const p of a.projects||[])if(!p.deleted&&!p.system)tkphSettle(p)}catch(e){console.error(e)}
  return saveBeforePhaseDefault(...args)};
