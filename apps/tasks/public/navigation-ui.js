/* Frontend improvements over R0. Domain writes still use the versioned outbox. */
const menuPaths={
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  allAreas:'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5 M3 17.5l9 5 9-5',
  tasks:'M9 5h12 M9 12h12 M9 19h12 M3 5l1 1 2-2 M3 12l1 1 2-2 M3 19l1 1 2-2',
  filter:'M3 5h18 M6 12h12 M10 19h4',
  view:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  archive:'M3 4h18v4H3z M5 8v12h14V8 M9 12h6',
  trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  tag:'M3 3h9l9 9-9 9-9-9z M7 7h.01',
  areas:'M3 7V4h7l2 3h9v13H3z',
  data:'M5 5h14v14H5z M5 10h14 M10 5v14',
  download:'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',
  upload:'M12 16V4 M7 9l5-5 5 5 M4 17v4h16v-4',
  copy:'M8 8h13v13H8z M16 8V3H3v13h5',
  file:'M5 3h9l5 5v13H5z M14 3v5h5 M8 12h8 M8 16h8',
  people:'M9 11a4 4 0 1 0 0-8 4 4 0 1 0 0 8 M2 21v-2a7 7 0 0 1 14 0v2 M18 4a4 4 0 0 1 0 7 M19 15a5 5 0 0 1 3 4v2',
  key:'M3 8a5 5 0 1 0 10 0 5 5 0 1 0-10 0 M12 12l9 9 M16 16l3-3 M18 18l3-3',
  agent:'M5 7h14v13H5z M12 3v4 M9 12h.01 M15 12h.01 M9 16h6',
  settings:'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2 M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
  sync:'M3 10a9 9 0 0 1 15-6l3 3 M21 3v4h-4 M21 14A9 9 0 0 1 6 20l-3-3 M3 21v-4h4',
  history:'M3 11a9 9 0 1 1 3 8 M3 4v7h7 M12 7v5l3 2',
  menu:'M4 6h16 M4 12h16 M4 18h16',
  close:'M5 5l14 14 M19 5L5 19'
};
function menuIcon(name){return `<svg class="menuicon" viewBox="0 0 24 24" aria-hidden="true"><path d="${menuPaths[name]||menuPaths.file}"/></svg>`}
const expandedMenuGroups=new Set(['work']);
function canManageCatalog(){const area=tab();return canEdit()&&!!area&&!area.restricted}
function canManageArea(scope=tab()){return Sync.actor?.role==='owner'&&!Sync.secondary&&!scope.restricted}
function navigationGroups(){return [
  {id:'work',name:'Trabajo',icon:'tasks',items:[
    ['projects','Proyectos','grid','view'],['tasks','Todas las tareas','tasks','view'],['filters','Filtros','filter'],['views','Vistas guardadas','view'],['archive','Archivados','archive'],['trash','Papelera','trash']]},
  {id:'organize',name:'Organización',icon:'areas',items:[['labels','Etiquetas y familias','tag','view'],['areas','Áreas de trabajo','areas']]},
  {id:'transfer',name:'Importar y exportar',icon:'data',items:[
    ['keep','Importar texto de Keep','upload','action',canEdit()],['csvImport','Importar CSV','upload','action',canManageCatalog()],['import','Importar JSON','upload','action',canManageCatalog()],['portableImport','Importar con adjuntos','upload','action',isAdministrator()],
    ['export','Exportar JSON','download'],['csvExport','Exportar CSV','download'],['readable','Exportar texto legible','file'],['portableExport','Exportar con adjuntos','copy'],['backup','Respaldo completo','download','action',isAdministrator()]]},
  {id:'people',name:'Personas y agentes',icon:'people',items:[
    ['users','Cuentas de personas','people','action',isAdministrator()],['accesses','Accesos y permisos','key','action',isAdministrator()],['proposals','Propuestas de agentes','agent'],['sessions','Mi cuenta y sesiones','key','action',!!Sync.actor?.session]]},
  {id:'system',name:'Sistema',icon:'settings',items:[['sync','Sincronización','sync'],['history','Historial de cambios','history'],['accessLog','Registro de accesos','key','action',isAdministrator()]]}
]}
function closeNavigation(){document.getElementById('kebab')?.classList.remove('show');document.getElementById('menuBackdrop')?.classList.remove('show');document.getElementById('moreBtn')?.setAttribute('aria-expanded','false')}
function navigateView(view){closeNavigation();closeSheet();state.view=view;state.currentProject=null;state.search='';state.filters={};persistUI();render()}
const actionBeforeNavigation=handleTopAction;
handleTopAction=function(action){closeNavigation();if(action==='areas')return areasSheet();if(action==='filters')return openFilters();if(action==='newtab')return newAreaSheet();if(action==='managetab')return manageTab();return actionBeforeNavigation(action)};
const bindBeforeNavigation=bind;
bind=function(){bindBeforeNavigation();
  const more=document.getElementById('moreBtn');if(more)more.onclick=()=>{const open=document.getElementById('kebab').classList.toggle('show');document.getElementById('menuBackdrop').classList.toggle('show',open);more.setAttribute('aria-expanded',String(open));if(open)document.getElementById('closeMenu')?.focus()};
  // La cáscara se conserva entre pintados: onclick (no addEventListener) para no acumular manejadores.
  const closeMenu=document.getElementById('closeMenu');if(closeMenu)closeMenu.onclick=()=>{closeNavigation();more?.focus()};const backdrop=document.getElementById('menuBackdrop');if(backdrop)backdrop.onclick=closeNavigation;
  document.querySelectorAll('[data-menu-group]').forEach(d=>d.ontoggle=()=>{if(!d.isConnected)return;d.open?expandedMenuGroups.add(d.dataset.menuGroup):expandedMenuGroups.delete(d.dataset.menuGroup)});
  document.querySelectorAll('[data-menu-view]').forEach(b=>b.onclick=()=>navigateView(b.dataset.menuView));
  document.querySelectorAll('[data-edit-label]').forEach(b=>{b.disabled=!canManageCatalog();b.onclick=()=>openLabelEditor(label(b.dataset.editLabel).family,b.dataset.editLabel)});
};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(document.getElementById('sheetBack').classList.contains('show'))closeSheet();else {closeNavigation();document.getElementById('moreBtn')?.focus()}}});

/* Lo archivado no se mezcla con lo vivo (aceptación V1, 8): familias y etiquetas archivadas se ocultan y se ven con
   «Ver archivadas», al final del catálogo, donde se pueden restaurar. */
let showArchivedCatalog=false;
function archivedCatalogCount(scope=tab()){const families=new Set(scope.families.filter(f=>f.archived).map(f=>f.id));return families.size+scope.labels.filter(l=>l.archived&&!families.has(l.family)).length}
function archivedCatalogButton(scope=tab()){const n=archivedCatalogCount(scope);if(!n&&!showArchivedCatalog)return'';return `<button class="ghost" id="toggleArchivedCatalog" type="button" aria-pressed="${showArchivedCatalog}" data-feedback-id="tasks.etiquetas.catalogo.ver_archivadas" data-feedback-label="Ver archivadas">${menuIcon('archive')}${showArchivedCatalog?'Ocultar archivadas':`Ver archivadas (${n})`}</button>`}
document.addEventListener('click',e=>{if(!e.target.closest?.('#toggleArchivedCatalog'))return;showArchivedCatalog=!showArchivedCatalog;render()});
function catalogOrder(ls){const ids=new Set(ls.map(l=>l.id)),roots=ls.filter(l=>!l.parent||!ids.has(l.parent));return roots.flatMap(r=>[r,...ls.filter(c=>c.parent===r.id)])}
familyCard=function(f){if(f.archived&&!showArchivedCatalog)return'';const ls=catalogOrder(tab().labels.filter(l=>l.family===f.id&&(showArchivedCatalog||!l.archived)));return `<section class="family-card"><div class="family-card-head"><span class="dot" style="background:${esc(f.color)}"></span><strong>${esc(f.name)}${f.archived?' · archivada':''}</strong><div class="spacer"></div><button class="ghost" data-edit-family="${f.id}" data-feedback-id="tasks.etiquetas.familia.editar" data-feedback-label="Editar familia">Editar familia</button><button class="ghost" data-toggle-family="${f.id}" aria-label="${f.archived?'Restaurar':'Archivar'} familia" data-feedback-id="tasks.etiquetas.familia.archivar" data-feedback-label="Archivar o restaurar familia">${menuIcon(f.archived?'sync':'archive')}</button></div><div class="chips">${ls.map(l=>`<button class="chip label-edit ${l.archived?'archivedchip':''}" style="background:${esc(f.color)}" data-edit-label="${l.id}" title="Editar etiqueta" data-feedback-id="tasks.etiquetas.familia.etiqueta" data-feedback-label="Editar etiqueta">${l.parent&&ls.some(x=>x.id===l.parent)?'↳ ':''}${esc(l.text)}${l.archived?' · archivada':''}</button>`).join('')||'<span class="small muted">Sin etiquetas.</span>'}</div>${!f.archived?`<button class="ghost" data-new-label="${f.id}" style="margin-top:10px" data-feedback-id="tasks.etiquetas.familia.nueva_etiqueta" data-feedback-label="Nueva etiqueta">+ Nueva etiqueta</button>`:''}</section>`};
labelsView=function(){return `<main class="screen label-manager"><div class="screenhead"><div><h1 class="title">Etiquetas</h1><p class="subtitle">Catálogo del área ${esc(tab().name)}. Pulsa una etiqueta para editarla.</p></div></div><div class="notice">Las familias agrupan etiquetas por color. Archivar una etiqueta conserva sus referencias en tareas e historial.${!canManageCatalog()?' Tu acceso permite consultar este catálogo.':''}</div>${tab().families.map(familyCard).join('')}<div class="catalog-actions"><button class="primary" id="newFamily" ${canManageCatalog()?'':'disabled'} data-feedback-id="tasks.etiquetas.catalogo.nueva_familia" data-feedback-label="Nueva familia">+ Nueva familia</button>${archivedCatalogButton()}</div></main>`};
openNewLabel=function(fid){openLabelEditor(fid)};
function openLabelEditor(fid,id=null,returnTo=null){
  if(!canManageCatalog())return toast('Necesitas permiso para editar el catálogo del área.');
  const f=family(fid),item=id?label(id):null,scopeId=tab().id;if(!f||id&&!item)return;
  const draft=structuredClone(item||{text:'',family:fid,parent:null,archived:!!f.archived});
  const hasChildren=!!id&&tab().labels.some(l=>l.parent===id&&!l.archived);
  const candidates=hasChildren?[]:tab().labels.filter(l=>l.id!==id&&!l.parent&&(l.family===fid&&!l.archived||l.id===draft.parent));
  // Exclude descendants as parents; selecting one would make a cycle.
  const descendant=l=>{let node=l,seen=new Set();while(node?.parent&&!seen.has(node.id)){seen.add(node.id);if(node.parent===id)return true;node=label(node.parent)}return false};
  openSheet(`<h2 class="sheettitle">${id?'Editar':'Nueva'} etiqueta</h2><p class="subtitle">Familia: ${esc(f.name)}</p><div class="field"><label for="nlText">Nombre</label><input id="nlText" maxlength="100" value="${esc(draft.text)}" placeholder="Nombre de la etiqueta" data-feedback-id="tasks.editor_etiqueta.nombre" data-feedback-label="Nombre"></div><div class="field"><label for="labelParent">Etiqueta superior (opcional)</label><p class="small muted">Dos niveles: una etiqueta principal y sus hijas, que se ven como «Principal: Hija».</p><select id="labelParent" ${hasChildren?'disabled':''} data-feedback-id="tasks.editor_etiqueta.superior" data-feedback-label="Etiqueta superior"><option value="">${hasChildren?'Ninguna (tiene etiquetas hijas)':'Ninguna: es una etiqueta principal'}</option>${candidates.filter(l=>!descendant(l)||l.id===draft.parent).map(l=>`<option value="${l.id}">${esc(l.text)}</option>`).join('')}</select></div><div class="actions"><button class="ghost" id="cancelLabel" data-feedback-id="tasks.editor_etiqueta.volver" data-feedback-label="Volver">Volver</button>${id?`<button class="danger" id="archiveLabel" ${f.archived?'disabled':''} data-feedback-id="tasks.editor_etiqueta.archivar" data-feedback-label="Archivar o restaurar">${item.archived?'Restaurar':'Archivar'}</button>`:''}<button class="primary" id="saveNewLabel" data-feedback-id="tasks.editor_etiqueta.guardar" data-feedback-label="Guardar">${id?'Guardar':'Crear'}</button></div>`);
  document.getElementById('labelParent').value=draft.parent||'';
  const back=result=>returnTo?returnTo(result):(closeSheet(),render());
  document.getElementById('cancelLabel').onclick=()=>back();
  document.getElementById('closeDialog').onclick=()=>back();
  document.getElementById('saveNewLabel').onclick=()=>{if(!canManageCatalog())return;const text=document.getElementById('nlText').value.trim();if(!text)return toast('Escribe un nombre.');if(tab().labels.some(l=>l.id!==id&&l.family===fid&&l.text.toLocaleLowerCase()===text.toLocaleLowerCase()))return toast('Ya existe una etiqueta con ese nombre en esta familia.');const parent=document.getElementById('labelParent').value||null;const scope=state.tabs.find(t=>t.id===scopeId&&!t.deleted);if(!scope||state.activeTab!==scopeId)return toast('El área ya no está disponible.');let result=id?scope.labels.find(l=>l.id===id):null;if(id){if(!result)return;const edits=editorFields(result,draft,{text,parent});if(!edits)return;Object.assign(result,edits)}else {result={id:uid('label-'),text,family:fid,parent,archived:!!f.archived,version:1};tab().labels.push(result)}save();render();back(result);toast('Etiqueta guardada')};
  const archive=document.getElementById('archiveLabel');if(archive)archive.onclick=()=>{if(!canManageCatalog()||family(fid)?.archived)return;const current=label(id);if(!current)return;current.archived=!current.archived;save();render();back(current);toast(current.archived?'Etiqueta archivada':'Etiqueta restaurada')};
}
/* Elegir etiquetas (FB_2026_021): las madres como chips. Una madre con hijas se despliega para elegir hijas concretas o
   «Todos» (la madre sola); «Todos» y una hija suelta no van juntas. Al guardar, el núcleo añade la madre de cada hija. */
let pickerOpenMothers=new Set();
openLabelPicker=function(selected,cb){
  selected=[...new Set(selected)];
  const used=new Set((project()?.tasks||[]).flatMap(t=>t.labels||[]));
  const mothersOf=f=>tab().labels.filter(l=>l.family===f.id&&!l.archived&&!labelMotherOf(l)).sort((a,b)=>Number(used.has(b.id))-Number(used.has(a.id)));
  const kidsOn=m=>labelChildren(m).filter(c=>selected.includes(c.id));
  const motherChip=(m,f)=>{const kids=labelChildren(m);
    if(!kids.length)return `<button class="filterchip ${selected.includes(m.id)?'on':''}" style="color:${esc(f.color)}" data-pick-label="${m.id}" data-feedback-id="tasks.elegir_etiquetas.etiqueta" data-feedback-label="Etiqueta">${esc(m.text)}</button>`;
    const on=kidsOn(m),all=selected.includes(m.id)&&!on.length,open=pickerOpenMothers.has(m.id),summary=all?'Todos':on.map(c=>c.text).join(', ');
    return `<span class="mothergroup ${open?'open':''}"><button class="filterchip motherchip ${all||on.length?'on':''}" style="color:${esc(f.color)}" data-pick-mother="${m.id}" aria-expanded="${open}" data-feedback-id="tasks.elegir_etiquetas.madre" data-feedback-label="Etiqueta madre">${esc(m.text)}${summary?`<span class="mothersummary">: ${esc(summary)}</span>`:''}<span class="motherarrow" aria-hidden="true"></span></button>${open?`<span class="motherkids"><button class="filterchip ${all?'on':''}" style="color:${esc(f.color)}" data-pick-all="${m.id}" data-feedback-id="tasks.elegir_etiquetas.todos" data-feedback-label="Todas las hijas">Todos</button>${kids.map(c=>`<button class="filterchip ${selected.includes(c.id)?'on':''}" style="color:${esc(f.color)}" data-pick-kid="${c.id}" data-feedback-id="tasks.elegir_etiquetas.hija" data-feedback-label="Etiqueta hija">${esc(c.text)}</button>`).join('')}</span>`:''}</span>`};
  const scroll=document.getElementById('sheet')?.scrollTop||0;
  openSheet(`<h2 class="sheettitle">Elegir etiquetas</h2><p class="subtitle">Catálogo de ${esc(tab().name)}. Puedes crear una etiqueta sin perder lo escrito.</p>${tab().families.filter(f=>!f.archived).map(f=>`<section class="family"><div class="familyhead"><span class="dot" style="background:${esc(f.color)}"></span><span class="familyname">${esc(f.name)}</span></div>${mothersOf(f).map(m=>motherChip(m,f)).join('')}${canManageCatalog()?`<button class="ghost" data-picker-new-label="${f.id}" data-feedback-id="tasks.elegir_etiquetas.nueva_etiqueta" data-feedback-label="Nueva etiqueta">+ Nueva etiqueta</button>`:''}</section>`).join('')}<div class="actions"><button class="primary" id="labelsDone" data-feedback-id="tasks.elegir_etiquetas.aplicar" data-feedback-label="Aplicar">Aplicar</button></div>`);
  const sheet=document.getElementById('sheet');if(sheet)sheet.scrollTop=scroll;
  const again=()=>openLabelPicker(selected,cb);
  document.querySelectorAll('[data-pick-label]').forEach(b=>b.onclick=()=>{const id=b.dataset.pickLabel;selected=selected.includes(id)?selected.filter(x=>x!==id):[...selected,id];b.classList.toggle('on')});
  document.querySelectorAll('[data-pick-mother]').forEach(b=>b.onclick=()=>{const id=b.dataset.pickMother;if(pickerOpenMothers.has(id))pickerOpenMothers.delete(id);else pickerOpenMothers.add(id);again()});
  document.querySelectorAll('[data-pick-all]').forEach(b=>b.onclick=()=>{const m=label(b.dataset.pickAll),kids=labelChildren(m).map(c=>c.id),all=selected.includes(m.id)&&!kids.some(k=>selected.includes(k));
    selected=selected.filter(x=>x!==m.id&&!kids.includes(x));if(!all)selected.push(m.id);again()});
  document.querySelectorAll('[data-pick-kid]').forEach(b=>b.onclick=()=>{const c=label(b.dataset.pickKid),m=labelMotherOf(c);
    // Una hija concreta quita «Todos»: la madre la vuelve a poner el núcleo al guardar.
    selected=selected.includes(c.id)?selected.filter(x=>x!==c.id):[...selected.filter(x=>x!==m?.id),c.id];again()});
  document.querySelectorAll('[data-picker-new-label]').forEach(b=>b.onclick=()=>openLabelEditor(b.dataset.pickerNewLabel,null,l=>{if(l&&!selected.includes(l.id))selected.push(l.id);openLabelPicker(selected,cb)}));
  document.getElementById('labelsDone').onclick=()=>{pickerOpenMothers=new Set();cb(selected)};
};

/* «Áreas de trabajo» (FB_2026_018): una fila compacta por área. A la izquierda, el asa para ordenar (arrastrar con el ratón
   o el dedo, o con las flechas del teclado), el color y el nombre con sus proyectos debajo (tocarlo abre el área); a la
   derecha, editar. */
function areasSheet(focusId=null){
  const current=state.activeTab,active=state.tabs.filter(t=>!t.deleted),removed=state.tabs.filter(t=>t.deleted),sortable=isAdministrator()&&active.length>1;
  openSheet(`<h2 class="sheettitle">Áreas de trabajo</h2><p>Ikisai, Personal o Detailorg son áreas independientes. Cada una contiene sus proyectos, etiquetas y vistas.</p>${isAdministrator()?'<button class="primary" id="newArea" data-feedback-id="tasks.areas.nueva" data-feedback-label="Nueva área">+ Nueva área</button>':''}<div class="area-list arearows">${active.map(t=>{const n=t.projects.filter(p=>!p.deleted&&!p.system).length;
    return `<div class="area-row ${t.id===current?'current':''}" data-area-row="${t.id}">${sortable?`<button class="draghandle" type="button" data-area-drag="${t.id}" aria-label="Mover ${esc(t.name)}: arrastra, o usa las flechas arriba y abajo" data-feedback-id="tasks.areas.lista.ordenar" data-feedback-label="Ordenar área">⠿</button>`:''}<span class="dot areadot" style="background:${esc(t.color||'var(--line)')}"></span><button class="area-open" type="button" data-area-open="${t.id}" data-feedback-id="tasks.areas.lista.abrir" data-feedback-label="Abrir área"><strong>${esc(t.name)}${t.id===current?' · actual':''}</strong><span class="small muted">${n} ${n===1?'proyecto':'proyectos'}${t.restricted?' compartidos':''}</span></button>${canManageArea(t)?`<button class="iconbtn arearow-edit" type="button" data-edit-area="${t.id}" aria-label="Editar ${esc(t.name)}" data-feedback-id="tasks.areas.lista.editar" data-feedback-label="Editar o eliminar área"></button>`:''}</div>`}).join('')}</div>${removed.some(canManageArea)?'<h3>Áreas en papelera</h3>'+removed.filter(canManageArea).map(t=>`<div class="suggestion"><span>${esc(t.name)}</span><button data-restore-area="${t.id}" data-feedback-id="tasks.areas.papelera.restaurar" data-feedback-label="Restaurar área">Restaurar</button></div>`).join(''):''}`);
  document.getElementById('newArea')?.addEventListener('click',newAreaSheet);
  document.querySelectorAll('[data-area-open]').forEach(b=>b.onclick=()=>{state.activeTab=b.dataset.areaOpen;state.groupBy='project';navigateView('projects')});
  document.querySelectorAll('[data-edit-area]').forEach(b=>b.onclick=()=>manageTab(b.dataset.editArea));
  document.querySelectorAll('[data-area-drag]').forEach(bindAreaDrag);
  document.querySelectorAll('[data-restore-area]').forEach(b=>b.onclick=()=>{const t=state.tabs.find(t=>t.id===b.dataset.restoreArea);if(!canManageArea(t))return;t.deleted=false;save();render();areasSheet()});
  if(focusId)document.querySelector(`[data-area-drag="${focusId}"]`)?.focus();
}
/* Asa de una fila: flechas del teclado (una posición) y arrastre con puntero (ratón o dedo), con la fila siguiendo al dedo. */
function bindAreaDrag(handle){
  const id=handle.dataset.areaDrag;
  handle.onkeydown=e=>{if(e.key!=='ArrowUp'&&e.key!=='ArrowDown')return;e.preventDefault();const order=state.tabs.filter(t=>!t.deleted).map(t=>t.id);
    if(moveAreaTo(id,order.indexOf(id)+(e.key==='ArrowUp'?-1:1)))setTimeout(()=>areasSheet(id),0)};
  // Mover la fila en el DOM le quita la captura del puntero al asa: el movimiento y el final se escuchan en la ventana.
  handle.onpointerdown=e=>{if(e.button>0)return;e.preventDefault();const row=handle.closest('.area-row'),list=row.parentElement,pid=e.pointerId;row.classList.add('dragging');
    const move=ev=>{if(ev.pointerId!==pid)return;ev.preventDefault();const rows=[...list.querySelectorAll('.area-row')].filter(r=>r!==row);const after=rows.find(r=>{const b=r.getBoundingClientRect();return ev.clientY<b.top+b.height/2});if(row.nextElementSibling!==(after||null))list.insertBefore(row,after||null)};
    const end=ev=>{if(ev.pointerId!==pid)return;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);row.classList.remove('dragging');
      const to=[...list.querySelectorAll('.area-row')].indexOf(row);if(moveAreaTo(id,to))setTimeout(()=>areasSheet(),0)};
    window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end)};
}
/* Orden de las áreas (FB_2026_018): lleva un área a otra posición de la lista y renumera las de todas, en un lote.
   La posición de un área solo la escribe el puente al crearla, así que el orden se guarda con operaciones directas. */
function moveArea(id,step){const order=state.tabs.filter(t=>!t.deleted).map(t=>t.id);return moveAreaTo(id,order.indexOf(id)+step)}
function moveAreaTo(id,to){
  if(!isAdministrator())return false;const order=state.tabs.filter(t=>!t.deleted).map(t=>t.id),at=order.indexOf(id);
  if(at<0||to<0||to>=order.length||to===at)return false;order.splice(to,0,order.splice(at,1)[0]);
  const rows=new Map((Sync.core?.data?.['tasks.tabs']||[]).map(r=>[r.id,r]));
  const ops=order.map((tid,i)=>({row:rows.get(tid),position:(i+1)*1024})).filter(x=>x.row&&x.row.position!==x.position)
    .map(x=>({op:'update',table:'tasks.tabs',id:x.row.id,expectedRevision:x.row.revision,fields:{position:x.position}}));
  if(!ops.length)return false;
  // El modelo local sigue el nuevo orden ya, sin esperar a la sincronización.
  const live=state.tabs.filter(t=>!t.deleted).sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id)),gone=state.tabs.filter(t=>t.deleted);state.tabs.splice(0,state.tabs.length,...live,...gone);
  return purchaseCommit(ops,'Orden de las áreas guardado.')}
function newAreaSheet(){
  if(!isAdministrator())return toast('Crear áreas requiere acceso de propietario global.');
  openSheet('<h2 class="sheettitle">Nueva área</h2><div class="field"><label for="tabName">Nombre</label><input id="tabName" maxlength="100" placeholder="Por ejemplo: Jardín" data-feedback-id="tasks.nueva_area.nombre" data-feedback-label="Nombre"></div><p class="small muted">Empezará con Entrada y un catálogo vacío de etiquetas.</p><div class="actions"><button class="ghost" id="cancelArea" data-feedback-id="tasks.nueva_area.volver" data-feedback-label="Volver">Volver</button><button class="primary" id="createTab" data-feedback-id="tasks.nueva_area.crear" data-feedback-label="Crear">Crear</button></div>');
  document.getElementById('cancelArea').onclick=areasSheet;
  document.getElementById('createTab').onclick=()=>{if(!isAdministrator())return;const name=document.getElementById('tabName').value.trim();if(!name)return toast('Escribe un nombre.');const id=uid('tab-');state.tabs.push({id,name,families:structuredClone(FAMILY_DEFAULTS),labels:[],projects:[]});state.activeTab=id;state.view='projects';state.currentProject=null;state.search='';state.filters={};state.groupBy='project';normalize();save();closeSheet();render();toast('Área creada')};
}
manageTab=function(id=state.activeTab){
  let t=state.tabs.find(t=>t.id===id&&!t.deleted);if(!t||!canManageArea(t))return toast('Solo el propietario administra esta área.');const baseline=structuredClone(t);
  openSheet(`<h2 class="sheettitle">Editar área</h2><div class="field"><label for="editTabName">Nombre</label><input id="editTabName" maxlength="100" value="${esc(t.name)}" data-feedback-id="tasks.editar_area.nombre" data-feedback-label="Nombre"></div><div class="actions"><button class="ghost" id="cancelArea" data-feedback-id="tasks.editar_area.volver" data-feedback-label="Volver">Volver</button>${state.tabs.filter(t=>!t.deleted).length>1?'<button class="danger" id="deleteTab" data-feedback-id="tasks.editar_area.eliminar" data-feedback-label="Eliminar área">Eliminar área</button>':''}<button class="primary" id="saveTabName" data-feedback-id="tasks.editar_area.guardar" data-feedback-label="Guardar">Guardar</button></div><p class="small muted">Eliminar envía el área a la papelera con sus proyectos y tareas. Podrás restaurarla.</p>`);
  document.getElementById('cancelArea').onclick=areasSheet;
  document.getElementById('saveTabName').onclick=()=>{t=state.tabs.find(x=>x.id===id&&!x.deleted);if(!t||!canManageArea(t))return;const name=document.getElementById('editTabName').value.trim();if(!name)return toast('Escribe un nombre.');const edits=editorFields(t,baseline,{name});if(!edits)return;Object.assign(t,edits);save();closeSheet();render();toast('Área actualizada')};
  document.getElementById('deleteTab')?.addEventListener('click',()=>{const count=t.projects.flatMap(p=>p.tasks).filter(t=>!t.deleted).length;openSheet(`<h2 class="sheettitle">Eliminar ${esc(t.name)}</h2><p>Se enviará a la papelera el área con ${count} tareas. Sus datos se conservarán para poder restaurarlos.</p><div class="actions"><button class="ghost" id="cancelDeleteArea" data-feedback-id="tasks.eliminar_area.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="danger" id="confirmDeleteArea" data-feedback-id="tasks.eliminar_area.confirmar" data-feedback-label="Enviar a papelera">Enviar a papelera</button></div>`);document.getElementById('cancelDeleteArea').onclick=()=>manageTab(id);document.getElementById('confirmDeleteArea').onclick=()=>{t=state.tabs.find(x=>x.id===id&&!x.deleted);if(!t||!canManageArea(t)||state.tabs.filter(t=>!t.deleted).length<2)return;t.deleted=true;if(state.activeTab===id){state.activeTab=state.tabs.find(x=>!x.deleted).id;state.view='projects';state.currentProject=null;state.search='';state.filters={};state.groupBy='project'}save();closeSheet();render();toast('Área enviada a papelera')}});
};
/* «Familia de responsables» (aceptación V1, 7): la familia que da los responsables de tareas y proyectos se elige en su
   editor. Hay una por área; mover la marca quita los responsables de la familia anterior en el mismo guardado, porque
   el núcleo solo admite responsables de la familia marcada (migración 0304). Las familias con otra clave de sistema
   (Oficio, Fase, Edificio, Espacio) no pueden serlo. */
function ownersFrom(familyId){const ids=new Set(tab().labels.filter(l=>l.family===familyId).map(l=>l.id)),out=[];for(const p of tab().projects){if(p.owner&&ids.has(p.owner))out.push(p);for(const t of p.tasks)if(t.owner&&ids.has(t.owner))out.push(t)}return out}
const familyEditorBeforeOwners=openFamilyEditor;
openFamilyEditor=function(id){familyEditorBeforeOwners(id);if(!id||!canManageCatalog())return;const f=family(id),actions=document.querySelector('#sheet .actions');if(!f||!actions)return;
  const current=tab().families.find(x=>x.system==='person'&&!x.deleted),locked=!!f.system&&f.system!=='person';
  actions.insertAdjacentHTML('beforebegin',`<div class="field"><label class="checkrow" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="feOwners" ${f.system==='person'?'checked':''} ${locked?'disabled':''} data-feedback-id="tasks.editor_familia.responsables" data-feedback-label="Familia de responsables"> Familia de responsables</label><p class="small muted" id="feOwnersHint"></p></div>`);
  const box=document.getElementById('feOwners'),hint=document.getElementById('feOwnersHint');
  const explain=()=>{if(locked){hint.textContent='Es una familia de sistema y no puede dar responsables.';return}
    if(box.checked&&f.system!=='person'){const n=current?ownersFrom(current.id).length:0;hint.textContent=`Sus etiquetas serán los responsables que se pueden elegir en tareas y proyectos.${current?` Deja de serlo «${current.name}»`+(n?` y ${n} ${n===1?'elemento se queda':'elementos se quedan'} sin responsable.`:'.'):''}`}
    else if(!box.checked&&f.system==='person'){const n=ownersFrom(f.id).length;hint.textContent=`El área se quedará sin familia de responsables${n?` y ${n} ${n===1?'elemento se queda':'elementos se quedan'} sin responsable`:''}.`}
    else hint.textContent=f.system==='person'?'Sus etiquetas son los responsables de tareas y proyectos de esta área.':'Márcala para que sus etiquetas sean los responsables de tareas y proyectos.'};
  box.onchange=explain;explain();
  const saveButton=document.getElementById('saveFamily'),saveBefore=saveButton.onclick;
  saveButton.onclick=()=>{const wants=box.checked&&!locked;
    if(wants!==(f.system==='person')){const from=wants?current:f;
      if(from){for(const x of ownersFrom(from.id)){x.owner=null;touch(x)}if(from!==f)from.system=null}
      f.system=wants?'person':null}
    saveBefore()};
};
/* Etiquetas en dos niveles (aceptación V1, 9): al guardar, cada hija elegida añade su padre, así filtrar por el padre
   incluye sus hijas. Se pueden elegir varias hijas, también de padres distintos. */
function withParentLabels(ids){const out=[...(ids||[])];for(const id of ids||[]){const l=label(id),p=l?.parent?label(l.parent):null;if(p&&p.family===l.family&&!p.archived&&!out.includes(p.id))out.push(p.id)}return out}
function addParentLabels(){for(const scope of state.tabs||[])withArea(scope.id,()=>{for(const p of scope.projects||[]){const own=withParentLabels(p.ownLabels);if(own.length!==(p.ownLabels||[]).length){p.ownLabels=own;touch(p)}for(const t of p.tasks||[]){const ls=withParentLabels(t.labels);if(ls.length!==(t.labels||[]).length){t.labels=ls;touch(t)}}}})}
const saveBeforeParents=save;
save=function(){try{addParentLabels()}catch(e){console.error(e)}return saveBeforeParents()};
/* Color de la familia con el campo del kit (aceptación V1, 14); el campo nativo queda oculto y es el que lee el guardado. */
const familyEditorBeforeColor=openFamilyEditor;
openFamilyEditor=function(id){familyEditorBeforeColor(id);const input=document.getElementById('feColor');if(!input||input.type==='hidden')return;input.type='hidden';input.removeAttribute('style');input.after(kitColorField(input.value,color=>{if(color)input.value=color},{allowNone:false}))};
