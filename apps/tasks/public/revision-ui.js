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
    ${owner?`<div class="field"><label for="tkrNote">Por qué se abre igualmente</label><textarea data-field-id="tasks.revision.abrir_nota" data-field-entity="tasks.reviews" data-field-prop="open_note" id="tkrNote" maxlength="2000" rows="3" data-feedback-id="tasks.revision.abrir_nota" data-feedback-label="Por qué se abre con pendientes"></textarea></div>
    <div class="actions"><button class="primary" id="tkrForce" type="button" data-feedback-id="tasks.revision.abrir_igualmente" data-feedback-label="Abrir con pendientes">Abrir con pendientes</button><button class="ghost" id="tkrCancel" type="button">Cancelar</button></div>`
    :'<p class="small muted">Para abrir con críticos pendientes hace falta una propietaria del área.</p><div class="actions"><button class="ghost" id="tkrCancel" type="button">Entendido</button></div>'}`);
  document.getElementById('tkrCancel').onclick=()=>closeSheet();
  const f=document.getElementById('tkrForce');if(f)f.onclick=async()=>{const note=document.getElementById('tkrNote').value.trim();if(!note)return toast('Escribe por qué se abre con pendientes.');
    if(await tkrCall('/reviews/open',{reviewId:rv.id,override:true,note},'Abierta con pendientes; queda anotado.'))closeSheet()}}

/* --- La comprobación en la ficha del ítem -------------------------------------------------------------------------- */
function tkrCheckHtml(i){const exp=tkrExpected(i),fix=i.corrective_task_id?taskLocation(i.corrective_task_id)?.t:null,again=i.recheck_task_id?taskLocation(i.recheck_task_id)?.t:null;
  const input=i.answer==='quantity'||i.answer==='reading'?`<div class="field"><label for="tkrValue">${i.answer==='quantity'?'Cuántos':'Lectura'}${exp?` <span class="small muted">(esperado: ${esc(exp)})</span>`:''}</label><input data-field-id="tasks.revision.item.valor" data-field-entity="tasks.review_items" data-field-prop="value" id="tkrValue" type="number" inputmode="decimal" step="any" value="${esc(String(i.value??''))}" data-feedback-id="tasks.revision.item.valor" data-feedback-label="Valor del ítem"></div>`
    :i.answer==='photo'?`<div class="field"><label for="tkrPhoto">Foto</label><input data-field-id="tasks.revision.item.foto" data-field-entity="tasks.review_items" data-field-prop="file_id" id="tkrPhoto" type="file" accept="image/*" capture="environment" data-feedback-id="tasks.revision.item.foto" data-feedback-label="Foto del ítem"></div>`:'';
  const note=`<div class="field"><label for="tkrText">${i.answer==='note'?'Observación':'Observación (opcional)'}</label><textarea data-field-id="tasks.revision.item.observacion" data-field-entity="tasks.review_items" data-field-prop="text" id="tkrText" rows="2" maxlength="2000" data-feedback-id="tasks.revision.item.observacion" data-feedback-label="Observación del ítem">${esc(i.text||'')}</textarea></div>`;
  const ff=i.first_failure?`<p class="small tkr-first">Primer fallo${i.first_failure.value!=null?`: ${esc(String(i.first_failure.value))}`:''}${i.first_failure.text?` · ${esc(i.first_failure.text)}`:''}</p>`:'';
  const links=[fix?`<button class="ghost small" type="button" data-tkr-task="${esc(fix.id)}">${fix.done?'✓ ':''}Arreglar</button>`:'',again?`<button class="ghost small" type="button" data-tkr-task="${esc(again.id)}">${again.done?'✓ ':''}Volver a comprobar</button>`:''].join('');
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
    <div class="field"><label for="tkrTpl">Plantilla</label><select data-field-id="tasks.revision.nueva.plantilla" data-field-entity="tasks.reviews" data-field-prop="template_id" id="tkrTpl" data-feedback-id="tasks.revision.nueva.plantilla" data-feedback-label="Plantilla de la revisión">${tpls.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}${t.tab_id?'':' · de la casa'}</option>`).join('')}</select></div>
    <div class="field"><label for="tkrTitle">Nombre</label><input data-field-id="tasks.revision.nueva.nombre" data-field-entity="tasks.reviews" data-field-prop="title" id="tkrTitle" maxlength="200" placeholder="Apertura · nombre del evento" data-feedback-id="tasks.revision.nueva.nombre" data-feedback-label="Nombre de la revisión"></div>
    <div class="field"><label for="tkrDue">Para cuándo</label><input data-field-id="tasks.revision.nueva.fecha" data-field-entity="tasks.projects" data-field-prop="due" id="tkrDue" type="date" data-feedback-id="tasks.revision.nueva.fecha" data-feedback-label="Fecha de la revisión"></div>
    <div class="field"><label for="tkrEvent">Evento (opcional)</label><input data-field-id="tasks.revision.nueva.evento" data-field-entity="tasks.reviews" data-field-prop="event_ref" id="tkrEvent" placeholder="booking:RES2026-80" data-feedback-id="tasks.revision.nueva.evento" data-feedback-label="Evento de la revisión"></div>
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


/* --- Plantillas de revisión (§46.1) -------------------------------------------------------------------------------- *
   «Plantillas» junto a «+ Revisión de apertura»: las de la casa (solo las cambia la administradora) y las del área (quien
   la edita entera). Cambiar una plantilla no toca las revisiones ya creadas: cada una guardó su copia. */
const TKR_ANSWER={check:'Funciona o no',quantity:'Cantidad',photo:'Foto',reading:'Lectura',note:'Observación'};
function tkrCanManage(t){return t.tab_id==null?isAdministrator():canEdit()&&!tab()?.restricted}
function tkrTplItems(id){return tkrRows('tasks.review_template_items').filter(i=>i.template_id===id).sort((a,b)=>Number(a.position)-Number(b.position))}
function tkrTemplatesSheet(){const tabId=tab()?.id,tpls=tkrRows('tasks.review_templates').filter(t=>t.tab_id==null||t.tab_id===tabId).sort((a,b)=>Number(a.position)-Number(b.position));
  const row=t=>`<button type="button" data-tkr-tpl="${esc(t.id)}" data-feedback-id="tasks.revision.plantillas.abrir" data-feedback-label="Abrir la plantilla">${esc(t.name)}<span class="small muted"> · ${t.tab_id?'de esta área':'de la casa'} · ${tkrTplItems(t.id).length} ítems${t.active===false?' · desactivada':''}</span></button>`;
  const canNew=canEdit()&&!tab()?.restricted;
  openSheet(`<h2 class="sheettitle">Plantillas de revisión</h2><p class="subtitle">Cambiar una plantilla no toca las revisiones ya creadas.</p>
    <div class="menulist">${tpls.map(row).join('')||'<p class="small muted">Aún no hay plantillas.</p>'}</div>
    <div class="actions">${canNew?'<button class="primary" id="tkrTplNew" type="button" data-feedback-id="tasks.revision.plantillas.nueva" data-feedback-label="Nueva plantilla">Nueva plantilla</button>':''}<button class="ghost" id="tkrTplClose" type="button">Cerrar</button></div>`);
  document.getElementById('tkrTplClose').onclick=()=>closeSheet();
  document.querySelectorAll('[data-tkr-tpl]').forEach(b=>b.onclick=()=>tkrTemplateSheet(b.dataset.tkrTpl));
  const n=document.getElementById('tkrTplNew');
  if(n)n.onclick=()=>{const id=crypto.randomUUID(),pos=Math.max(0,...tkrRows('tasks.review_templates').map(t=>Number(t.position)||0))+1024;
    if(purchaseCommit([{op:'insert',table:'tasks.review_templates',id,fields:{tab_id:tab().id,name:'Plantilla nueva',note:'',active:true,position:pos}}],'Plantilla creada.'))setTimeout(()=>tkrTemplateSheet(id),50)}}

function tkrTemplateSheet(id){const t=tkrRows('tasks.review_templates').find(x=>x.id===id);if(!t)return tkrTemplatesSheet();
  const can=tkrCanManage(t),items=tkrTplItems(id),zones=[...new Set(items.map(i=>i.zone))];
  const itemRow=i=>`<button type="button" data-tkr-item="${esc(i.id)}" ${can?'':'disabled'} data-feedback-id="tasks.revision.plantilla.item" data-feedback-label="Ítem de la plantilla">${esc(i.title)}<span class="small muted"> · ${esc(TKR_ANSWER[i.answer]||i.answer)}${tkrExpected(i)?' · '+esc(tkrExpected(i)):''}${i.critical?' · crítico':''}</span></button>`;
  const head=can?`<div class="field"><label for="tkrTplName">Nombre</label><input data-field-id="tasks.revision.plantilla.nombre" data-field-entity="tasks.review_templates" data-field-prop="name" id="tkrTplName" maxlength="120" value="${esc(t.name)}" data-feedback-id="tasks.revision.plantilla.nombre" data-feedback-label="Nombre de la plantilla"></div>
    <label class="row small"><input data-field-id="tasks.revision.plantilla.activa" data-field-entity="tasks.review_templates" data-field-prop="active" type="checkbox" id="tkrTplActive" ${t.active!==false?'checked':''} data-feedback-id="tasks.revision.plantilla.activa" data-feedback-label="Plantilla activa"> Se puede usar para crear revisiones</label>`:'';
  const body=zones.map(z=>`<h3 class="tkr-zone">${esc(TKR_ZONE[z]||z)}</h3><div class="menulist">${items.filter(i=>i.zone===z).map(itemRow).join('')}</div>`).join('')||'<p class="small muted">Sin ítems.</p>';
  const acts=can?'<button class="primary" id="tkrTplSave" type="button" data-feedback-id="tasks.revision.plantilla.guardar" data-feedback-label="Guardar la plantilla">Guardar</button><button class="ghost" id="tkrItemNew" type="button" data-feedback-id="tasks.revision.plantilla.nuevo_item" data-feedback-label="Añadir ítem">+ Ítem</button>':'';
  openSheet(`<h2 class="sheettitle">${esc(t.name)}</h2><p class="subtitle">${t.tab_id?'De esta área':'De la casa'}${can?'':' · solo lectura'}</p>${head}${body}
    <div class="actions">${acts}<button class="ghost" id="tkrTplBack" type="button">Volver</button></div>`);
  document.getElementById('tkrTplBack').onclick=()=>tkrTemplatesSheet();
  document.querySelectorAll('[data-tkr-item]').forEach(b=>b.onclick=()=>tkrItemSheet(id,b.dataset.tkrItem));
  const s=document.getElementById('tkrTplSave');
  if(s)s.onclick=()=>{const name=document.getElementById('tkrTplName').value.trim(),active=document.getElementById('tkrTplActive').checked;
    if(!name)return toast('Pon un nombre a la plantilla.');const fields={};if(name!==t.name)fields.name=name;if(active!==(t.active!==false))fields.active=active;
    if(!Object.keys(fields).length)return tkrTemplatesSheet();
    if(purchaseCommit([{op:'update',table:'tasks.review_templates',id:t.id,expectedRevision:t.revision,fields}],'Plantilla guardada.'))tkrTemplatesSheet()};
  const n=document.getElementById('tkrItemNew');if(n)n.onclick=()=>tkrItemSheet(id,null)}

function tkrItemSheet(tplId,itemId){const t=tkrRows('tasks.review_templates').find(x=>x.id===tplId);if(!t)return tkrTemplatesSheet();
  const i=itemId?tkrTplItems(tplId).find(x=>x.id===itemId):null,e=i?.expected||{},answer=i?.answer||'check';
  const opts=(map,cur)=>Object.entries(map).map(([k,v])=>`<option value="${k}" ${cur===k?'selected':''}>${esc(v)}</option>`).join('');
  openSheet(`<h2 class="sheettitle">${i?'Ítem':'Ítem nuevo'}</h2>
    <div class="field"><label for="tkrIZone">Zona</label><select data-field-id="tasks.revision.item_plantilla.zona" data-field-entity="tasks.review_template_items" data-field-prop="zone" id="tkrIZone" data-feedback-id="tasks.revision.item_plantilla.zona" data-feedback-label="Zona del ítem">${opts(TKR_ZONE,i?.zone||'habitaciones')}</select></div>
    <div class="field"><label for="tkrITitle">Qué se mira</label><input data-field-id="tasks.revision.item_plantilla.titulo" data-field-entity="tasks.review_template_items" data-field-prop="title" id="tkrITitle" maxlength="200" value="${esc(i?.title||'')}" data-feedback-id="tasks.revision.item_plantilla.titulo" data-feedback-label="Qué se mira"></div>
    <div class="field"><label for="tkrIInstr">Instrucciones</label><textarea data-field-id="tasks.revision.item_plantilla.instrucciones" data-field-entity="tasks.review_template_items" data-field-prop="instructions" id="tkrIInstr" rows="2" maxlength="2000" data-feedback-id="tasks.revision.item_plantilla.instrucciones" data-feedback-label="Instrucciones del ítem">${esc(i?.instructions||'')}</textarea></div>
    <div class="field"><label for="tkrIAnswer">Respuesta</label><select data-field-id="tasks.revision.item_plantilla.respuesta" data-field-entity="tasks.review_template_items" data-field-prop="answer" id="tkrIAnswer" data-feedback-id="tasks.revision.item_plantilla.respuesta" data-feedback-label="Tipo de respuesta">${opts(TKR_ANSWER,answer)}</select></div>
    <div class="row tkr-expected" id="tkrIExp">
      <div class="field" data-for="quantity"><label for="tkrICount">Cuántos se esperan</label><input data-field-id="tasks.revision.item_plantilla.esperado_cantidad" data-field-entity="tasks.review_template_items" data-field-prop="expected" id="tkrICount" type="number" min="0" step="1" value="${esc(String(e.count??''))}"></div>
      <div class="field" data-for="reading"><label for="tkrIUnit">Unidad</label><input data-field-id="tasks.revision.item_plantilla.esperado_unidad" data-field-entity="tasks.review_template_items" data-field-prop="expected" id="tkrIUnit" maxlength="20" value="${esc(e.unit||'')}" placeholder="°C"></div>
      <div class="field" data-for="reading"><label for="tkrIMin">Mínimo</label><input data-field-id="tasks.revision.item_plantilla.esperado_minimo" data-field-entity="tasks.review_template_items" data-field-prop="expected" id="tkrIMin" type="number" step="any" value="${esc(String(e.min??''))}"></div>
      <div class="field" data-for="reading"><label for="tkrIMax">Máximo</label><input data-field-id="tasks.revision.item_plantilla.esperado_maximo" data-field-entity="tasks.review_template_items" data-field-prop="expected" id="tkrIMax" type="number" step="any" value="${esc(String(e.max??''))}"></div>
    </div>
    <label class="row small"><input data-field-id="tasks.revision.item_plantilla.critico" data-field-entity="tasks.review_template_items" data-field-prop="critical" type="checkbox" id="tkrICrit" ${i?.critical?'checked':''} data-feedback-id="tasks.revision.item_plantilla.critico" data-feedback-label="Ítem crítico"> Crítico: sin él verificado no se abre</label>
    <div class="actions"><button class="primary" id="tkrISave" type="button" data-feedback-id="tasks.revision.item_plantilla.guardar" data-feedback-label="Guardar el ítem">Guardar</button>${i?'<button class="ghost danger-text" id="tkrIDel" type="button" data-feedback-id="tasks.revision.item_plantilla.quitar" data-feedback-label="Quitar el ítem">Quitar</button>':''}<button class="ghost" id="tkrIBack" type="button">Volver</button></div>`);
  const sel=document.getElementById('tkrIAnswer'),sync=()=>document.querySelectorAll('#tkrIExp [data-for]').forEach(f=>{f.hidden=f.dataset.for!==sel.value});sel.onchange=sync;sync();
  document.getElementById('tkrIBack').onclick=()=>tkrTemplateSheet(tplId);
  const del=document.getElementById('tkrIDel');
  if(del)del.onclick=()=>{if(purchaseCommit([{op:'delete',table:'tasks.review_template_items',id:i.id,expectedRevision:i.revision}],'Ítem quitado.'))tkrTemplateSheet(tplId)};
  document.getElementById('tkrISave').onclick=()=>{const v=id=>document.getElementById(id).value.trim(),num=id=>v(id)===''?undefined:Number(v(id)),a=sel.value;
    const title=v('tkrITitle');if(!title)return toast('Di qué se mira.');
    const expected={};
    if(a==='quantity'&&num('tkrICount')!==undefined)expected.count=num('tkrICount');
    if(a==='reading'){if(!v('tkrIUnit'))return toast('Una lectura necesita su unidad.');expected.unit=v('tkrIUnit');
      if(num('tkrIMin')!==undefined)expected.min=num('tkrIMin');if(num('tkrIMax')!==undefined)expected.max=num('tkrIMax');
      if(expected.min!==undefined&&expected.max!==undefined&&expected.min>expected.max)return toast('El mínimo no puede ser mayor que el máximo.')}
    if(expected.count!==undefined&&(!Number.isInteger(expected.count)||expected.count<0))return toast('Lo esperado es un número entero.');
    const fields={zone:document.getElementById('tkrIZone').value,title,instructions:v('tkrIInstr'),answer:a,expected,critical:document.getElementById('tkrICrit').checked};
    const pos=Math.max(0,...tkrTplItems(tplId).map(x=>Number(x.position)||0))+1024;
    const op=i?{op:'update',table:'tasks.review_template_items',id:i.id,expectedRevision:i.revision,fields}
      :{op:'insert',table:'tasks.review_template_items',id:crypto.randomUUID(),fields:{...fields,tab_id:t.tab_id,template_id:t.id,position:pos}};
    if(purchaseCommit([op],i?'Ítem guardado.':'Ítem añadido.'))tkrTemplateSheet(tplId)}}

const projectsViewBeforeTemplatesUi=projectsView;
projectsView=function(...a){const html=projectsViewBeforeTemplatesUi(...a);if(!canEdit()||tab()?.restricted||!html.includes('tkr-newrow'))return html;
  return html.replace('+ Revisión de apertura</button>','+ Revisión de apertura</button><button class="ghost" id="tkrTpls" type="button" data-feedback-id="tasks.revision.plantillas" data-feedback-label="Plantillas de revisión">Plantillas</button>')};
const bindBeforeTemplatesUi=bind;
bind=function(){bindBeforeTemplatesUi();const p=document.getElementById('tkrTpls');if(p)p.onclick=tkrTemplatesSheet};
