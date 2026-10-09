/* Ikisai Tasks · catálogo General de etiquetas (FB_2026_023; aprobado por el usuario el 9-10-2026).
   Lo General (tab_id nulo) vale en todas las áreas. Aquí, la acción de la propietaria con acceso completo para fusionar en
   General las etiquetas repetidas entre áreas: vista previa con los grupos (misma familia y mismo nombre en dos o más
   áreas), casillas para elegir cuáles, y la fusión en un lote con historial (ruta labels/general/merge). Los parecidos que
   no son iguales («Jardín» y «jardin.») se enseñan aparte, para decidir a mano. */
const generalNorm=s=>String(s||'').trim().toLowerCase();
const generalLoose=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/gi,'').toLowerCase();
function generalMergeGroups(){
  const data=Sync.core?.data||{},fams=new Map((data['tasks.families']||[]).map(f=>[f.id,f])),tabs=new Map((data['tasks.tabs']||[]).filter(t=>!t.deleted_at).map(t=>[t.id,t]));
  const all=(data['tasks.labels']||[]).filter(l=>!l.deleted_at),byId=new Map(all.map(l=>[l.id,l]));
  const famKey=f=>f?.system_key||('name:'+generalNorm(f?.name));
  const keyOf=l=>famKey(fams.get(l.family_id))+'|'+generalNorm(l.name);
  const groups=new Map();
  for(const l of all.filter(l=>!l.archived&&l.tab_id&&tabs.has(l.tab_id))){const k=keyOf(l);const g=groups.get(k)||{key:k,labels:[]};if(!g.labels.some(x=>x.tab_id===l.tab_id))g.labels.push(l);groups.set(k,g)}
  const out=[...groups.values()].filter(g=>g.labels.length>=2).map(g=>{
    // El nombre que más se repite (y, a igualdad, el del área actual) va primero: es el que toma la General.
    const count=new Map();for(const l of g.labels)count.set(l.name.trim(),(count.get(l.name.trim())||0)+1);
    const name=[...count.entries()].sort((a,b)=>b[1]-a[1]||(g.labels.find(l=>l.name.trim()===b[0])?.tab_id===tab()?.id)-(g.labels.find(l=>l.name.trim()===a[0])?.tab_id===tab()?.id))[0][0];
    const labels=[...g.labels].sort((a,b)=>(b.name.trim()===name)-(a.name.trim()===name));
    const parents=labels.map(l=>l.parent_id?byId.get(l.parent_id):null);
    const mother=parents.every(p=>!p)?null:parents.every(p=>p&&p.tab_id)?keyOf(parents[0]):parents.every(p=>p&&!p.tab_id)&&new Set(parents.map(p=>p.id)).size===1?'general':'mixed';
    return {key:g.key,name,family:fams.get(labels[0].family_id),labels,areas:labels.map(l=>tabs.get(l.tab_id)?.name||''),mother}});
  // Una hija solo se puede fusionar si su madre también (o ya es General); las madres van delante.
  for(const g of out)g.mergeable=g.mother===null||g.mother==='general'||out.some(m=>m.key===g.mother&&m.labels.length===g.labels.length);
  return out.sort((a,b)=>(a.mother?1:0)-(b.mother?1:0)||a.name.localeCompare(b.name,'es'));
}
function generalLookalikes(groups){
  const data=Sync.core?.data||{},fams=new Map((data['tasks.families']||[]).map(f=>[f.id,f])),tabs=new Set((data['tasks.tabs']||[]).filter(t=>!t.deleted_at).map(t=>t.id));
  const loose=new Map();
  for(const l of (data['tasks.labels']||[]).filter(l=>!l.deleted_at&&!l.archived&&(!l.tab_id||tabs.has(l.tab_id)))){const f=fams.get(l.family_id);const k=(f?.system_key||generalNorm(f?.name))+'|'+generalLoose(l.name);const set=loose.get(k)||new Set();set.add(l.name.trim());loose.set(k,set)}
  return [...loose.values()].filter(s=>new Set([...s].map(generalNorm)).size>1).map(s=>[...s])}

function generalMergeSheet(){
  if(!isAdministrator())return toast('Solo una propietaria con acceso completo fusiona etiquetas en General.');
  if(Sync.record.queue.length||Sync.busy)return toast('Sincroniza los cambios pendientes antes de fusionar.');
  if(!navigator.onLine)return toast('Hace falta conexión para fusionar etiquetas.');
  const groups=generalMergeGroups(),lookalikes=generalLookalikes(groups),chosen=new Set(groups.filter(g=>g.mergeable).map(g=>g.key));
  const paint=()=>{
    openSheet(`<h2 class="sheettitle">Repetidas → General</h2><p class="small muted">Cada etiqueta marcada pasa a ser una sola, General, válida en todas las áreas. Las tareas, los responsables, las reglas y las vistas pasan a usarla; las copias de cada área quedan archivadas.</p>
      ${groups.length?`<div class="generalgroups">${groups.map(g=>`<label class="checkline generalgroup ${g.mother?'child':''}"><input type="checkbox" data-general-group="${esc(g.key)}" ${chosen.has(g.key)?'checked':''} ${g.mergeable?'':'disabled'} data-feedback-id="tasks.etiquetas.general.grupo" data-feedback-label="Fusionar este grupo"><span><strong>${g.mother?'↳ ':''}${esc(g.name)}</strong> <span class="small muted">· ${esc(g.family?.name||'')} · en ${g.labels.length} áreas: ${esc(g.areas.join(', '))}${g.mergeable?'':' · su madre no se repite igual: se queda como está'}</span></span></label>`).join('')}</div>`:'<p>No hay etiquetas repetidas entre áreas.</p>'}
      ${lookalikes.length?`<div class="notice"><strong>Parecidas, pero no iguales</strong> (decide a mano si son la misma; renómbralas y vuelve aquí):<ul>${lookalikes.map(l=>`<li>${l.map(esc).join(' · ')}</li>`).join('')}</ul></div>`:''}
      <div class="actions"><button class="ghost" id="generalCancel" data-feedback-id="tasks.etiquetas.general.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="primary" id="generalMerge" ${chosen.size?'':'disabled'} data-feedback-id="tasks.etiquetas.general.fusionar" data-feedback-label="Fusionar en General">Fusionar ${chosen.size}</button></div>`);
    document.querySelectorAll('[data-general-group]').forEach(b=>b.onchange=()=>{const k=b.dataset.generalGroup;if(b.checked)chosen.add(k);else{chosen.delete(k);for(const g of groups)if(g.mother===k)chosen.delete(g.key)}
      for(const g of groups)if(g.mother&&g.mother!=='general'&&!chosen.has(g.mother))chosen.delete(g.key);paint()});
    document.getElementById('generalCancel').onclick=closeSheet;
    document.getElementById('generalMerge').onclick=async()=>{const button=document.getElementById('generalMerge');button.disabled=true;
      const picked=groups.filter(g=>chosen.has(g.key)).map(g=>g.labels.map(l=>l.id));
      try{const out=await usage.run('tasks.etiquetas.general.fusionar',()=>Sync.core.api('/labels/general/merge',{method:'POST',json:{groups:picked,requestId:uid('req-')}}));
        await syncNow();closeSheet();render();toast(`Fusionadas en General: ${out.counts?.groups??picked.length} etiquetas.`)}
      catch(e){button.disabled=false;toast(e.message)}};
  };
  paint();
}

/* «Etiquetas» (FB_2026_023): primero General, con sus familias (y, marcadas, las etiquetas de esa familia que solo son de
   esta área); debajo, «Solo de <área>», con las familias que no tienen General equivalente. Lo General lo edita quien
   tiene acceso a toda la app; una familia General no se archiva desde aquí (sus etiquetas, una a una). */
function generalFamilyCard(f){
  const scope=tab(),ids=catalogFamilyIds(f),admin=isAdministrator();
  const ls=catalogOrder(scope.labels.filter(l=>ids.includes(l.family)&&(showArchivedCatalog||!l.archived)).sort((a,b)=>Number(b.general||0)-Number(a.general||0)));
  return `<section class="family-card generalfamily"><div class="family-card-head"><span class="dot" style="background:${esc(f.color)}"></span><strong>${esc(f.name)}${f.archived?' · archivada':''}</strong><div class="spacer"></div>${admin?`<button class="ghost" data-edit-family="${f.id}" data-feedback-id="tasks.etiquetas.familia.editar" data-feedback-label="Editar familia">Editar familia</button>`:''}</div><div class="chips">${ls.map(l=>`<button class="chip label-edit ${l.archived?'archivedchip':''} ${l.general?'':'arealabel'}" style="background:${esc(f.color)}" data-edit-label="${l.id}" title="${l.general?'General: en todas las áreas':`Solo de ${esc(scope.name)}`}" data-feedback-id="tasks.etiquetas.familia.etiqueta" data-feedback-label="Editar etiqueta">${l.parent&&ls.some(x=>x.id===l.parent)?'↳ ':''}${esc(l.text)}${l.general?'':`<span class="scopemark"> · solo de ${esc(scope.name)}</span>`}${l.archived?' · archivada':''}</button>`).join('')||'<span class="small muted">Sin etiquetas.</span>'}</div>${!f.archived?`<div class="row generalnew">${admin?`<button class="ghost" data-new-general-label="${f.id}" data-feedback-id="tasks.etiquetas.general.nueva" data-feedback-label="Nueva etiqueta General">+ General</button>`:''}${canManageCatalog()?`<button class="ghost" data-new-label="${f.id}" data-feedback-id="tasks.etiquetas.familia.nueva_etiqueta" data-feedback-label="Nueva etiqueta">+ Solo de ${esc(scope.name)}</button>`:''}</div>`:''}</section>`}
labelsView=function(){const scope=tab(),generals=catalogFamilies().filter(f=>f.general&&(showArchivedCatalog||!f.archived)),own=catalogFamilies().filter(f=>!f.general);
  return `<main class="screen label-manager"><div class="screenhead"><div><h1 class="title">Etiquetas</h1><p class="subtitle">General, en todas las áreas, y lo propio de ${esc(scope.name)}. Pulsa una etiqueta para editarla.</p></div></div><div class="notice">Las familias agrupan etiquetas por color. Archivar una etiqueta conserva sus referencias en tareas e historial.${!canManageCatalog()?' Tu acceso permite consultar este catálogo.':''}</div>
    <h2 class="sectionlabel catalogsection" id="catalogGeneral">General <span class="small muted">· en todas las áreas</span></h2>${generals.map(generalFamilyCard).join('')||'<p class="small muted">Aún no hay etiquetas General. Las repetidas entre áreas se pueden fusionar aquí.</p>'}
    <h2 class="sectionlabel catalogsection" id="catalogOwn">Solo de ${esc(scope.name)}</h2>${own.map(familyCard).join('')||'<p class="small muted">Todo lo de esta área está en General.</p>'}
    <div class="catalog-actions"><button class="primary" id="newFamily" ${canManageCatalog()?'':'disabled'} data-feedback-id="tasks.etiquetas.catalogo.nueva_familia" data-feedback-label="Nueva familia">+ Nueva familia</button>${archivedCatalogButton()}</div></main>`};
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-new-general-label]');if(!b)return;labelEditorScope='general';openLabelEditor(b.dataset.newGeneralLabel)});

/* En «Etiquetas», para la propietaria con acceso completo, si hay repetidas. */
const labelsViewBeforeGeneral=labelsView;
labelsView=function(){const html=labelsViewBeforeGeneral();if(!isAdministrator()||!Sync.core)return html;const n=generalMergeGroups().filter(g=>g.mergeable).length;if(!n)return html;
  return html.replace('<div class="catalog-actions">',`<div class="catalog-actions"><button class="ghost" id="generalMergeOpen" type="button" data-feedback-id="tasks.etiquetas.general.abrir" data-feedback-label="Repetidas a General">Repetidas → General (${n})</button>`)};
document.addEventListener('click',e=>{if(e.target.closest?.('#generalMergeOpen'))generalMergeSheet()});
