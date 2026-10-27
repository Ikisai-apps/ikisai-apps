/* «Revisión de apertura» en Tasks (encargo de VG por Core, 27-10-2026; docs/tasks/API.md §46). Las revisiones y sus
   resultados los escribe el servidor (rutas `reviews…`); aquí se pintan y se piden:
   - En el proyecto de una revisión, la banda «Revisión de apertura»: críticos verificados, fallos abiertos y «Abrir».
     Lista para abrir = todos los críticos verificados. Con críticos pendientes, solo una owner con el área entera y con
     nota (decisión de VG): queda quién, cuándo y lo que faltaba.
   - En la ficha de un ítem, «Comprobación»: lo que hay que mirar, lo esperado, el valor (cantidad o lectura), la foto o
     la observación, y «Está bien» / «Falla». Un fallo crea «Arreglar…» y «Volver a comprobar…»; arreglar no verifica.
   - En Proyectos, «Nueva revisión» desde una plantilla (de la casa o del área), con el evento si se sabe.
   Sin red, se avisa y no se marca nada: el resultado lo valida el servidor. */
const TKR_ZONE={habitaciones:'Habitaciones',camas:'Camas',aseos:'Aseos',duchas_acs:'Duchas y agua caliente',puertas:'Puertas',electricidad:'Electricidad',
  cocina:'Cocina',maquinaria:'Maquinaria',accesos:'Accesos',barandillas:'Barandillas',comunes:'Zonas comunes',limpieza:'Limpieza',extintores:'Extintores',agua:'Agua'};
const TKR_STATE={pending:'Sin mirar',ok:'Bien',failed:'Falla',verified:'Verificado'};
function tkrRows(t){return (Sync.core?.data?.[t]||[]).filter(r=>!r.deleted_at)}
function tkrReviewOf(projectId){return tkrRows('tasks.reviews').find(r=>r.project_id===projectId)||null}
function tkrItems(reviewId){return tkrRows('tasks.review_items').filter(i=>i.review_id===reviewId).sort((a,b)=>Number(a.position)-Number(b.position))}
function tkrItemOfTask(taskId){return tkrRows('tasks.review_items').find(i=>i.task_id===taskId)||null}
function tkrTotals(items){const crit=items.filter(i=>i.critical);return {crit:crit.length,critOk:crit.filter(i=>i.state==='ok'||i.state==='verified').length,
  failed:items.filter(i=>i.state==='failed').length,done:items.filter(i=>i.state==='ok'||i.state==='verified').length,all:items.length}}
function tkrExpected(i){const e=i.expected||{};if(i.answer==='reading'){const r=e.min!=null&&e.max!=null?`entre ${e.min} y ${e.max}`:e.min!=null?`${e.min} o más`:e.max!=null?`${e.max} o menos`:'';return r?`${r} ${e.unit||''}`.trim():(e.unit||'')}
  if(i.answer==='quantity')return e.count!=null?`${e.count}`:'';return ''}
async function tkrCall(path,body,okText){if(!navigator.onLine){toast('Sin conexión: la revisión se marca con red.');return null}
  await syncNow();try{const out=await Sync.core.api(path,{method:'POST',json:body});await syncNow();render();if(okText)toast(okText);return out}
  catch(e){toast(e.message||'No se pudo guardar.');return null}}

/* --- La banda del proyecto ---------------------------------------------------------------------------------------- */
function tkrBand(p){const rv=tkrReviewOf(p.id);if(!rv)return '';const items=tkrItems(rv.id),m=tkrTotals(items),ready=m.critOk===m.crit;
  const state=rv.status==='opened'?`Abierta${rv.open_override?' con pendientes':''}`:ready?'Lista para abrir':'Aún no se puede abrir';
  return `<section class="tkr-band ${rv.status==='opened'?'opened':ready?'ready':''}" id="tkrBand" aria-label="Revisión de apertura">
    <div><b>Revisión de apertura</b> · ${esc(state)}<div class="small muted">${m.critOk} de ${m.crit} críticos verificados · ${m.done} de ${m.all} ítems${m.failed?` · <b>${m.failed} ${m.failed===1?'falla':'fallan'}</b>`:''}</div>
    ${rv.status==='opened'&&rv.open_override?`<div class="small">Abierta con pendientes: ${esc(rv.open_note||'')}</div>`:''}</div>
    ${rv.status!=='opened'&&canEdit()?`<button class="${ready?'primary':'ghost'} small" id="tkrOpen" type="button" data-feedback-id="tasks.revision.abrir" data-feedback-label="Abrir el evento">Abrir</button>`:''}
  </section>`}
function tkrOpenSheet(rv){const items=tkrItems(rv.id),pending=items.filter(i=>i.critical&&i.state!=='ok'&&i.state!=='verified');
  if(!pending.length)return tkrCall('/reviews/open',{reviewId:rv.id},'Abierta: todos los críticos verificados.');
  const owner=Sync.actor?.role==='owner';
  openSheet(`<h2 class="sheettitle">Faltan críticos por verificar</h2><ul class="tkr-pending">${pending.map(i=>`<li>${esc(TKR_ZONE[i.zone]||i.zone)} · ${esc(i.title)} <span class="small muted">(${esc(TKR_STATE[i.state])})</span></li>`).join('')}</ul>
    ${owner?`<div class="field"><label for="tkrNote">Por qué se abre igualmente</label><textarea id="tkrNote" maxlength="2000" rows="3" data-feedback-id="tasks.revision.abrir_nota" data-feedback-label="Por qué se abre con pendientes"></textarea></div>
    <div class="actions"><button class="primary" id="tkrForce" type="button" data-feedback-id="tasks.revision.abrir_igualmente" data-feedback-label="Abrir con pendientes">Abrir con pendientes</button><button class="ghost" id="tkrCancel" type="button">Cancelar</button></div>`
    :'<p class="small muted">Para abrir con críticos pendientes hace falta una propietaria del área.</p><div class="actions"><button class="ghost" id="tkrCancel" type="button">Entendido</button></div>'}`);
  document.getElementById('tkrCancel').onclick=()=>closeSheet();
  const f=document.getElementById('tkrForce');if(f)f.onclick=async()=>{const note=document.getElementById('tkrNote').value.trim();if(!note)return toast('Escribe por qué se abre con pendientes.');
    if(await tkrCall('/reviews/open',{reviewId:rv.id,override:true,note},'Abierta con pendientes; queda anotado.'))closeSheet()}}

/* --- La comprobación en la ficha del ítem -------------------------------------------------------------------------- */
function tkrCheckHtml(i){const exp=tkrExpected(i),fix=i.corrective_task_id?taskLocation(i.corrective_task_id)?.t:null,again=i.recheck_task_id?taskLocation(i.recheck_task_id)?.t:null;
  const input=i.answer==='quantity'||i.answer==='reading'?`<div class="field"><label for="tkrValue">${i.answer==='quantity'?'Cuántos':'Lectura'}${exp?` <span class="small muted">(esperado: ${esc(exp)})</span>`:''}</label><input id="tkrValue" type="number" inputmode="decimal" step="any" value="${i.value??''}" data-feedback-id="tasks.revision.item.valor" data-feedback-label="Valor del ítem"></div>`
    :i.answer==='photo'?`<div class="field"><label for="tkrPhoto">Foto</label><input id="tkrPhoto" type="file" accept="image/*" capture="environment" data-feedback-id="tasks.revision.item.foto" data-feedback-label="Foto del ítem"></div>`:'';
  const note=`<div class="field"><label for="tkrText">${i.answer==='note'?'Observación':'Observación (opcional)'}</label><textarea id="tkrText" rows="2" maxlength="2000" data-feedback-id="tasks.revision.item.observacion" data-feedback-label="Observación del ítem">${esc(i.text||'')}</textarea></div>`;
  const ff=i.first_failure?`<p class="small tkr-first">Primer fallo${i.first_failure.value!=null?`: ${esc(String(i.first_failure.value))}`:''}${i.first_failure.text?` · ${esc(i.first_failure.text)}`:''}</p>`:'';
  const links=[fix?`<button class="ghost small" type="button" data-tkr-task="${fix.id}">${fix.done?'✓ ':''}Arreglar</button>`:'',again?`<button class="ghost small" type="button" data-tkr-task="${again.id}">${again.done?'✓ ':''}Volver a comprobar</button>`:''].join('');
  return `<section class="tkr-check ${i.state}" id="tkrCheck" aria-label="Comprobación"><h3>Comprobación ${i.critical?'<span class="tkr-crit">Crítico</span>':''} <span class="tkr-state">${esc(TKR_STATE[i.state])}</span></h3>
    ${i.instructions?`<p class="small">${esc(i.instructions)}</p>`:''}${ff}
    ${canEdit()?`${input}${note}<div class="row tkr-actions"><button class="primary" id="tkrOk" type="button" data-feedback-id="tasks.revision.item.resultado" data-feedback-label="Está bien">Está bien</button><button class="ghost danger-text" id="tkrFail" type="button" data-feedback-id="tasks.revision.item.falla" data-feedback-label="Falla">Falla</button></div>`:''}
    ${links?`<div class="row tkr-links">${links}</div>`:''}
  </section>`}
async function tkrMark(i,result){const v=document.getElementById('tkrValue'),t=document.getElementById('tkrText'),ph=document.getElementById('tkrPhoto');
  const body={itemId:i.id,result};if(v&&v.value!=='')body.value=Number(v.value);if(t&&t.value.trim())body.text=t.value.trim();
  if((i.answer==='quantity'||i.answer==='reading')&&body.value===undefined)return toast(i.answer==='quantity'?'Di cuántos hay.':'Apunta la lectura.');
  if(i.answer==='note'&&!body.text)return toast('Escribe la observación.');
  const file=ph?.files?.[0];
  if(file){if(!navigator.onLine)return toast('Sin conexión: la foto se sube con red.');try{const up=await Sync.core.uploadNow(file,{filename:file.name||'revision.jpg',mime:file.type||'image/jpeg'});body.fileId=up.fileId}catch(e){return toast(e.message||'No se pudo subir la foto.')}}
  else if(i.answer==='photo'&&result==='ok')return toast('Haz la foto para darlo por bueno.');
  const out=await tkrCall('/reviews/result',body);if(!out)return;
  toast(out.state==='failed'?'Anotado el fallo: se ha creado «Arreglar» y «Volver a comprobar».':out.state==='verified'?'Verificado.':'Anotado.');
  if(taskLocation(i.task_id))openTaskEditor(i.task_id)}
const openTaskEditorBeforeReview=openTaskEditor;
openTaskEditor=function(id,...rest){openTaskEditorBeforeReview(id,...rest);const i=id?tkrItemOfTask(id):null;document.getElementById('tkrCheck')?.remove();if(!i)return;
  const sheet=document.getElementById('sheet');if(!sheet)return;const title=sheet.querySelector('.sheettitle');
  if(title)title.insertAdjacentHTML('afterend',tkrCheckHtml(i));else sheet.insertAdjacentHTML('afterbegin',tkrCheckHtml(i));
  const ok=document.getElementById('tkrOk');if(ok)ok.onclick=()=>tkrMark(i,'ok');
  const fail=document.getElementById('tkrFail');if(fail)fail.onclick=()=>tkrMark(i,'fail');
  sheet.querySelectorAll('[data-tkr-task]').forEach(b=>b.onclick=()=>openTaskEditor(b.dataset.tkrTask))};

/* --- Nueva revisión ------------------------------------------------------------------------------------------------ */
function tkrTemplates(){const tabId=tab()?.id;return tkrRows('tasks.review_templates').filter(t=>t.active!==false&&(t.tab_id==null||t.tab_id===tabId)).sort((a,b)=>Number(a.position)-Number(b.position))}
function tkrNewSheet(){const tpls=tkrTemplates();if(!tpls.length)return toast('No hay plantillas de revisión.');
  openSheet(`<h2 class="sheettitle">Nueva revisión</h2><p class="subtitle">Se creará en ${esc(tab().name)}: un proyecto con una tarea por zona y una por ítem.</p>
    <div class="field"><label for="tkrTpl">Plantilla</label><select id="tkrTpl" data-feedback-id="tasks.revision.nueva.plantilla" data-feedback-label="Plantilla de la revisión">${tpls.map(t=>`<option value="${t.id}">${esc(t.name)}${t.tab_id?'':' · de la casa'}</option>`).join('')}</select></div>
    <div class="field"><label for="tkrTitle">Nombre</label><input id="tkrTitle" maxlength="200" placeholder="Apertura · nombre del evento" data-feedback-id="tasks.revision.nueva.nombre" data-feedback-label="Nombre de la revisión"></div>
    <div class="field"><label for="tkrDue">Para cuándo</label><input id="tkrDue" type="date" data-feedback-id="tasks.revision.nueva.fecha" data-feedback-label="Fecha de la revisión"></div>
    <div class="field"><label for="tkrEvent">Evento (opcional)</label><input id="tkrEvent" placeholder="booking:RES2026-80" data-feedback-id="tasks.revision.nueva.evento" data-feedback-label="Evento de la revisión"></div>
    <div class="actions"><button class="primary" id="tkrCreate" type="button" data-feedback-id="tasks.revision.nueva.crear" data-feedback-label="Crear la revisión">Crear</button><button class="ghost" id="tkrCancel" type="button">Cancelar</button></div>`);
  document.getElementById('tkrCancel').onclick=()=>closeSheet();
  document.getElementById('tkrCreate').onclick=async()=>{const ev=document.getElementById('tkrEvent').value.trim(),due=document.getElementById('tkrDue').value;
    if(ev&&!/^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9_.:/-]{1,150}$/.test(ev))return toast('El evento va como app:referencia, p. ej. booking:RES2026-80.');
    const body={templateId:document.getElementById('tkrTpl').value,tabId:tab().id,reviewId:crypto.randomUUID()};
    const title=document.getElementById('tkrTitle').value.trim();if(title)body.title=title;if(due)body.due=due;if(ev)body.eventRef=ev;
    const out=await tkrCall('/reviews',body,'Revisión creada.');if(!out)return;closeSheet();
    if(out.projectId){state.currentProject=out.projectId;state.view='project';render()}}}

const projectViewBeforeReview=projectView;
projectView=function(...a){const html=projectViewBeforeReview(...a),p=project();if(!p)return html;const band=tkrBand(p);
  return band?html.replace(/(<main[^>]*>)/,'$1'+band):html};
const projectsViewBeforeReview=projectsView;
projectsView=function(...a){const html=projectsViewBeforeReview(...a);if(!canEdit()||tab()?.restricted||!tkrTemplates().length)return html;
  return html.replace(/(<main[^>]*>)/,`$1<div class="row tkr-newrow"><button class="softbtn" id="tkrNew" type="button" data-feedback-id="tasks.revision.nueva" data-feedback-label="Nueva revisión">+ Revisión de apertura</button></div>`)};
const bindBeforeReview=bind;
bind=function(){bindBeforeReview();const n=document.getElementById('tkrNew');if(n)n.onclick=tkrNewSheet;
  const o=document.getElementById('tkrOpen');if(o){const rv=tkrReviewOf(project()?.id);if(rv)o.onclick=()=>tkrOpenSheet(rv)}};
