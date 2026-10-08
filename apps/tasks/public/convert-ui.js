/* Ikisai Tasks · «Convertir en proyecto de…» (docs/tasks/API.md §24.4; aprobado por el usuario el 8-10-2026).
   Acción de la propietaria con acceso completo, en «Editar área»: elige el área de destino y el nombre del proyecto, ve la
   vista previa (recuentos calculados con Sync.core.data y lo que Finance tiene asignado al área o a sus proyectos, que hay
   que reasignar a mano) y confirma. El servidor lo hace en un lote con historial (ruta tabs/:id/convert): mismas tareas
   con los mismos ids, etiquetas por nombre, compras, suministros y reglas al destino, y el área antigua a la papelera. */
const convertRows=table=>(Sync.core?.data?.[table]||[]);
const convertLive=table=>convertRows(table).filter(r=>!r.deleted_at);
const CONVERT_FINANCE_URL='https://finance.ikisai.com/#/facturas/';

/* Recuentos de lo que pasará al destino (lo mismo que mueve tasks.convert_tab_into_project). */
function convertPreview(sourceId,targetId){
  const tasks=convertLive('tasks.tasks').filter(t=>t.tab_id===sourceId),taskIds=new Set(tasks.map(t=>t.id));
  const projects=convertLive('tasks.projects').filter(p=>p.tab_id===sourceId);
  const families=new Map(convertRows('tasks.families').map(f=>[f.id,f])),labels=convertLive('tasks.labels');
  const used=new Set([...convertLive('tasks.task_labels').filter(l=>taskIds.has(l.task_id)).map(l=>l.label_id),...tasks.map(t=>t.owner_label_id).filter(Boolean),
    ...convertLive('tasks.request_routes').filter(r=>r.tab_id===sourceId).map(r=>r.owner_label_id).filter(Boolean)]);
  const sameFamily=(a,b)=>a&&b&&(a.system_key?a.system_key===b.system_key:!b.system_key&&a.name.toLowerCase()===b.name.toLowerCase());
  const newLabels=labels.filter(l=>l.tab_id===sourceId&&used.has(l.id)).filter(l=>!labels.some(d=>d.tab_id===targetId&&d.name.toLowerCase()===l.name.toLowerCase()&&sameFamily(families.get(l.family_id),families.get(d.family_id))));
  const attachments=convertLive('tasks.attachments').filter(a=>a.tab_id===sourceId&&(!a.task_id||taskIds.has(a.task_id)));
  const supplies=convertLive('tasks.supply_items').filter(s=>s.tab_id===sourceId);
  const renamed=supplies.filter(s=>convertLive('tasks.supply_items').some(d=>d.tab_id===targetId&&d.name.trim().toLowerCase()===s.name.trim().toLowerCase()));
  return {projects,tasks,open:tasks.filter(t=>!t.done).length,done:tasks.filter(t=>t.done).length,newLabels:[...new Set(newLabels.map(l=>l.name))],
    attachments:attachments.length,purchases:convertLive('tasks.purchase_requests').filter(r=>r.tab_id===sourceId).length,supplies:supplies.length,renamed:renamed.map(s=>s.name),
    routes:convertLive('tasks.request_routes').filter(r=>r.tab_id===sourceId).length};
}

/* Finance: lo asignado al área o a sus proyectos (hay que reasignarlo a mano) y lo asignado a sus tareas (se conserva).
   Devuelve null si no se pudo consultar (sin red o sin acceso a Finance, que devuelve vacío). */
async function convertFinance(sourceId,preview){
  if(!Sync.core||!navigator.onLine)return null;
  const ask=(targetKind,ids)=>ids.length?Sync.core.api('/read/invoices.allocations_by_target',{method:'POST',json:{targetApp:'tasks',targetKind,ids:ids.slice(0,500)}}).then(out=>out?.rows||[]):Promise.resolve([]);
  try{const [area,projects,tasks]=await Promise.all([ask('area',[sourceId]),ask('project',preview.projects.map(p=>p.id)),ask('task',preview.tasks.map(t=>t.id))]);
    return {manual:[...area.map(r=>({...r,target:'el área'})),...projects.map(r=>({...r,target:'el proyecto «'+(preview.projects.find(p=>p.id===r.target_id)?.title||'')+'»'}))],kept:tasks.length}}
  catch{return null}
}

function convertTabSheet(id){
  const t=state.tabs.find(x=>x.id===id&&!x.deleted);if(!t||!isAdministrator())return toast('Solo una propietaria con acceso completo puede convertir un área.');
  if(Sync.record.queue.length||Sync.busy)return toast('Sincroniza los cambios pendientes antes de convertir el área.');
  if(!navigator.onLine)return toast('Hace falta conexión para convertir un área.');
  const targets=state.tabs.filter(x=>!x.deleted&&x.id!==id);if(!targets.length)return toast('No hay otra área a la que pasarla.');
  const preferred=targets.find(x=>/mantenimiento/i.test(x.name))||targets[0];
  openSheet(`<h2 class="sheettitle">Convertir «${esc(t.name)}» en proyecto</h2>
    <p class="small muted">Sus tareas pasan, con su historial, fotos, notas, dependencias y enlaces de Finance, a un proyecto nuevo de otra área. El área antigua, vacía, va a la papelera y se puede restaurar.</p>
    <div class="field"><label for="convertTarget">Área de destino</label><select id="convertTarget" data-feedback-id="tasks.convertir_area.destino" data-feedback-label="Área de destino">${targets.map(x=>`<option value="${esc(x.id)}" ${x.id===preferred.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="convertTitle">Nombre del proyecto</label><input id="convertTitle" maxlength="300" value="${esc(t.name)}" data-feedback-id="tasks.convertir_area.nombre" data-feedback-label="Nombre del proyecto"></div>
    <div id="convertPreview" aria-live="polite"></div>
    <div class="actions"><button class="ghost" id="convertCancel" data-feedback-id="tasks.convertir_area.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="primary" id="convertConfirm" disabled data-feedback-id="tasks.convertir_area.confirmar" data-feedback-label="Convertir">Convertir</button></div>`);
  let finance=null,asked=false;
  const paint=()=>{const box=document.getElementById('convertPreview');if(!box)return;const target=document.getElementById('convertTarget').value,p=convertPreview(id,target),name=state.tabs.find(x=>x.id===target)?.name||'';
    const line=(n,text)=>`<li>${n} ${text}</li>`;
    box.innerHTML=`<h3 class="sectionlabel">Vista previa</h3><ul class="convertcounts small">
      <li>${p.projects.length} ${p.projects.length===1?'proyecto (su Entrada)':'proyectos (con su Entrada)'} → el proyecto «${esc(document.getElementById('convertTitle').value.trim()||t.name)}» de ${esc(name)}</li>
      ${line(p.tasks.length,`${p.tasks.length===1?'tarea':'tareas'} (pendientes: ${p.open}; hechas: ${p.done})`)}
      ${line(p.newLabels.length,p.newLabels.length?`etiquetas nuevas en ${esc(name)}: ${p.newLabels.map(esc).join(', ')}`:'etiquetas nuevas (todas existen ya en el destino)')}
      ${line(p.attachments,'fotos y adjuntos')}
      ${line(p.purchases,'solicitudes de compra')}${line(p.supplies,'suministros'+(p.renamed.length?` (se renombran por repetidos: ${p.renamed.map(esc).join(', ')})`:''))}
      ${line(p.routes,'reglas de entrada, que pasarán a apuntar al proyecto nuevo')}</ul>
      <div id="convertFinance">${!asked?'<p class="small muted">Consultando Finance…</p>':finance===null?'<p class="notice">No se pudo consultar Finance. Si hay facturas asignadas al área o a sus proyectos, habrá que reasignarlas a mano en Finance.</p>'
        :`<p class="small">${finance.kept} ${finance.kept===1?'asignación de Finance a una tarea se conserva':'asignaciones de Finance a tareas se conservan'}.</p>${finance.manual.length?`<div class="notice" id="convertFinanceManual"><strong>Hay que reasignar a mano en Finance ${finance.manual.length===1?'esta línea':'estas líneas'}</strong>, asignadas al área o a sus proyectos:<ul>${finance.manual.map(r=>`<li><a href="${CONVERT_FINANCE_URL}${encodeURIComponent(r.invoice_code||'')}" target="_blank" rel="noopener" data-feedback-id="tasks.convertir_area.finance.abrir" data-feedback-label="Abrir factura en Finance">${esc(r.invoice_code||'')}</a>${r.invoice_date?' · '+esc(shortDate(r.invoice_date)):''} · ${esc(String(r.allocated_amount??''))} € · ${esc(r.target)}</li>`).join('')}</ul></div>`:'<p class="small muted">Nada en Finance asignado al área ni a sus proyectos.</p>'}`}</div>`;
    document.getElementById('convertConfirm').disabled=!asked};
  convertFinance(id,convertPreview(id,preferred.id)).then(out=>{finance=out;asked=true;paint()});
  paint();
  document.getElementById('convertTarget').onchange=paint;document.getElementById('convertTitle').oninput=paint;
  document.getElementById('convertCancel').onclick=()=>manageTab(id);
  document.getElementById('convertConfirm').onclick=async()=>{const button=document.getElementById('convertConfirm'),targetTabId=document.getElementById('convertTarget').value,title=document.getElementById('convertTitle').value.trim();
    if(!title)return toast('Escribe el nombre del proyecto.');button.disabled=true;
    try{const out=await usage.run('tasks.convertir_area.confirmar',()=>Sync.core.api(`/tabs/${encodeURIComponent(id)}/convert`,{method:'POST',json:{targetTabId,title,requestId:uid('req-')}}));
      const arrived=()=>state.tabs.find(x=>x.id===targetTabId)?.projects.some(q=>q.id===out.projectId);
      for(let i=0;i<4&&!arrived();i++){await syncNow();if(!arrived())await new Promise(r=>setTimeout(r,250))}
      state.activeTab=targetTabId;state.view='project';state.currentProject=out.projectId;state.search='';state.filters={};save();closeSheet();render();toast(`«${t.name}» es ahora un proyecto. El área antigua está en la papelera.`)}
    catch(e){button.disabled=false;toast(e.message)}};
}

/* Botón en «Editar área», solo para la propietaria con acceso completo y si hay otra área viva. */
(()=>{const base=manageTab;manageTab=function(id=state.activeTab){base(id);
  if(!isAdministrator()||state.tabs.filter(x=>!x.deleted&&x.id!==id).length<1||!document.getElementById('editTabName'))return;
  const actions=document.getElementById('cancelArea')?.parentElement;if(!actions)return;
  const p=document.createElement('p');p.className='small';p.innerHTML='<button class="ghost" id="convertTab" type="button" data-feedback-id="tasks.editar_area.convertir" data-feedback-label="Convertir en proyecto de…">Convertir en proyecto de…</button>';
  actions.after(p);document.getElementById('convertTab').onclick=()=>convertTabSheet(id)}})();
