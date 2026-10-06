/* Vista General (todas las áreas) y ámbito de «Todas las tareas». Capa gráfica; no toca el ejecutor de dominio. */
function withArea(id,fn){const previous=state.activeTab;if(previous===id)return fn();state.activeTab=id;try{return fn()}finally{state.activeTab=previous}}
function generalMode(){return state.taskScope==='all'&&['tasks','projects','labels','home'].includes(state.view)}
function activeAreas(){return state.tabs.filter(t=>!t.deleted)}
// Las áreas de trabajo de la vista General: todas menos «Plantillas».
function generalAreas(){const tpl=typeof templateArea==='function'?templateArea():null;return activeAreas().filter(t=>t!==tpl)}
function areasForTasks(){return generalMode()?generalAreas():[tab()]}
function areaMatchCount(){return filteredProjects().reduce((sum,p)=>sum+filteredTasks(p).length,0)}
function taskScopeSelector(){const all=state.taskScope==='all';return `<label class="scopefield">Área <select id="taskScope" aria-label="Área de las tareas">${activeAreas().map(t=>`<option value="${t.id}" ${!all&&t.id===state.activeTab?'selected':''}>${esc(t.name)}</option>`).join('')}<option value="*" ${all?'selected':''}>General · todas las áreas</option></select></label>`}
function areaBlock(area,inner,count,tools=true){return `<section class="areablock" data-area-block="${area.id}"><h2 class="sectionlabel areatitle"><span>${esc(area.name)}</span>${count==null?'':` <span class="count">${count}</span>`}${tools&&canEdit()&&!area.restricted?`<button class="ghost small addbtn" data-add-project="${area.id}">+ Proyecto</button>`:''}</h2>${inner}</section>`}
const SAVED_VIEWS_BUTTON='<button class="softbtn" id="savedViews">Vistas guardadas</button>';
const allTasksBeforeScope=allTasksView;
allTasksView=function(){
  if(state.taskScope!=='all')return allTasksBeforeScope().replace(SAVED_VIEWS_BUTTON,taskScopeSelector());
  const holder=document.createElement('template');
  const blocks=generalAreas().map(area=>withArea(area.id,()=>{holder.innerHTML=allTasksBeforeScope();const sections=[...holder.content.querySelectorAll('main > section')].map(s=>s.outerHTML).join('');return areaBlock(area,sections||'<p class="small muted areaempty">Sin coincidencias en esta área.</p>',areaMatchCount())}));
  return `<main class="screen"><h1 class="title">Tareas</h1><p class="subtitle">General · todas las áreas</p>${searchbar()}${groupToolbar().replace(SAVED_VIEWS_BUTTON,taskScopeSelector())}${blocks.join('')}</main>`;
};
// Botones «+» de Todas las tareas: proyecto nuevo por área y tarea nueva a continuación de la última de cada proyecto.
const allTasksBeforeAdders=allTasksView;
allTasksView=function(){
  const html=allTasksBeforeAdders();if((state.groupBy||'project')!=='project')return html;
  const holder=document.createElement('template');holder.innerHTML=html;
  holder.content.querySelectorAll('main > section:not(.areablock), .areablock > section').forEach(section=>{const pid=section.querySelector('.sectionlabel [data-open-project]')?.dataset.openProject,list=section.querySelector('.tasklist');if(pid&&list)list.insertAdjacentHTML('afterend',`<button class="quickadd addtask" data-add-task="${pid}" ${canEdit()?'':'disabled'}>+ Añadir tarea</button>`)});
  if(state.taskScope!=='all'&&canEdit()&&!tab().restricted)holder.content.querySelector('main')?.insertAdjacentHTML('beforeend',`<button class="ghost addbtn addproject" data-add-project="${state.activeTab}">+ Nuevo proyecto en ${esc(tab().name)}</button>`);
  return holder.innerHTML;
};
function generalProjectsView(){const areas=generalAreas(),quiet=!(state.search||'').trim()&&!activeFilterCount(),projects=areas.reduce((n,a)=>n+a.projects.filter(p=>!p.deleted&&p.status!=='archived').length,0),pendingTotal=areas.reduce((n,a)=>n+a.projects.filter(p=>!p.deleted&&p.status!=='archived').reduce((s,p)=>s+pending(p),0),0);
  const blocks=areas.map(area=>withArea(area.id,()=>{const ps=filteredProjects().filter(p=>!(p.system&&quiet&&!p.tasks.some(t=>!t.deleted)));return areaBlock(area,`<div class="project-grid">${ps.length?ps.map(projectCard).join(''):'<div class="empty">Sin proyectos que coincidan.</div>'}</div>`,ps.length)}));
  return `<main class="screen"><div class="screenhead"><div><h1 class="title">General</h1><p class="subtitle">${areas.length} áreas · ${projects} proyectos · ${pendingTotal} tareas pendientes</p></div></div>${searchbar()}${blocks.join('')}</main>`}
function generalLabelsView(){const blocks=generalAreas().map(area=>withArea(area.id,()=>areaBlock(area,`<div class="label-manager-area">${tab().families.map(familyCard).join('')}</div><div class="catalog-actions"><button class="primary" data-add-family="${area.id}" ${canManageCatalog()?'':'disabled'}>+ Nueva familia</button></div>`,null,false)));
  return `<main class="screen"><div class="screenhead"><div><h1 class="title">Etiquetas</h1><p class="subtitle">General · catálogo de cada área</p></div></div><div class="notice">Cada área tiene su propio catálogo. Pulsa una etiqueta para editarla.</div>${blocks.join('')}</main>`}
const mainBeforeScope=main;
main=function(){if(generalMode()&&state.view==='projects')return generalProjectsView();if(generalMode()&&state.view==='labels')return generalLabelsView();return mainBeforeScope()};
function enterGeneral(){state.taskScope='all';if(state.view==='project')state.view='projects';state.currentProject=null;state.search='';state.filters={};closeSheet();persistUI();render()}
function areaChooserSheet(){openSheet(`<h2 class="sheettitle">Nuevo proyecto</h2><p class="subtitle">Elige el área donde crearlo.</p><div class="menulist">${activeAreas().map(t=>`<button data-choose-area="${t.id}">${esc(t.name)}</button>`).join('')}</div>`);document.querySelectorAll('[data-choose-area]').forEach(b=>b.onclick=()=>{state.activeTab=b.dataset.chooseArea;openProjectEditor()})}
const uiBeforeScope=ui;
ui=function(){return {...uiBeforeScope(),taskScope:state.taskScope||'area'}};
const bindBeforeScope=bind;
bind=function(){bindBeforeScope();
  const selector=document.getElementById('taskScope');if(selector)selector.onchange=()=>{if(selector.value==='*')state.taskScope='all';else{state.taskScope='area';state.activeTab=selector.value}state.currentProject=null;persistUI();render()};
  const general=document.querySelector('[data-general-area]');if(general)general.onclick=enterGeneral;
  // Una acción dentro del bloque de otra área la convierte en área activa antes de ejecutarse.
  document.querySelectorAll('[data-area-block]').forEach(block=>{const id=block.dataset.areaBlock,enter=()=>{if(state.activeTab!==id)state.activeTab=id};block.addEventListener('pointerdown',enter,true);block.addEventListener('click',enter,true)});
  document.querySelectorAll('[data-tab]').forEach(b=>{const previous=b.onclick;b.onclick=e=>{state.taskScope='area';previous?.(e)}});
  document.querySelectorAll('[data-add-project]').forEach(b=>b.onclick=()=>{if(!canEdit())return;state.activeTab=b.dataset.addProject;openProjectEditor()});
  document.querySelectorAll('[data-add-family]').forEach(b=>b.onclick=()=>{state.activeTab=b.dataset.addFamily;openFamilyEditor()});
  document.querySelectorAll('[data-add-task]').forEach(b=>b.onclick=()=>{if(!canEdit())return;const pid=b.dataset.addTask,rows=b.previousElementSibling?.querySelectorAll('[data-row]')||[],last=rows[rows.length-1],parentId=last?taskLocation(last.dataset.row)?.t.parentId||null:null;state.currentProject=pid;openTaskEditor(null,null,parentId?{parentId}:null)});
  const fab=document.getElementById('fab');if(fab&&generalMode()&&state.view==='projects')fab.onclick=areaChooserSheet;
};
// En la vista General el panel de filtros ofrece también los proyectos y etiquetas de las demás áreas.
const filtersBeforeScope=openFilters;
openFilters=function(){filtersBeforeScope();if(!generalMode())return;
  const sheet=document.getElementById('sheet'),stateBlock=sheet.querySelector('[data-state-filter]')?.closest('.filterfamily'),projectBlock=sheet.querySelector('[data-project-filter]')?.closest('.filterfamily');
  if(stateBlock&&projectBlock)sheet.insertBefore(stateBlock,projectBlock);
  (projectBlock||sheet.querySelector('.filterfamily'))?.insertAdjacentHTML('beforebegin',`<h3 class="filterarea">${esc(tab().name)}</h3>`);
  const extra=document.createElement('div');extra.className='otherareas';
  extra.innerHTML=generalAreas().filter(t=>t.id!==state.activeTab).map(area=>withArea(area.id,()=>`<h3 class="filterarea">${esc(area.name)}</h3><div class="filterfamily"><h4>Proyecto</h4>${tab().projects.filter(p=>!p.deleted&&p.status!=='archived').map(p=>`<button class="filterchip ${(state.filters._project||[]).includes(p.id)?'on':''}" data-project-filter="${p.id}">${esc(p.title)}</button>`).join('')}</div>${tab().families.filter(f=>!f.archived).map(f=>{const ls=tab().labels.filter(l=>l.family===f.id&&!l.archived);if(!ls.length)return'';return `<div class="filterfamily"><h4><span class="dot" style="background:${esc(f.color)};display:inline-block;margin-right:7px"></span>${esc(f.name)}</h4>${ls.map(l=>`<button class="filterchip ${(state.filters[f.id]||[]).includes(l.id)?'on':''}" style="color:${esc(f.color)}" data-filter="${f.id}|${l.id}">${esc(l.text)}</button>`).join('')}</div>`}).join('')}`)).join('');
  sheet.querySelector('.actions').insertAdjacentElement('beforebegin',extra);
  extra.querySelectorAll('[data-project-filter]').forEach(b=>b.onclick=()=>{const ids=state.filters._project||[],id=b.dataset.projectFilter;state.filters._project=ids.includes(id)?ids.filter(x=>x!==id):[...ids,id];b.classList.toggle('on')});
  extra.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{const [fid,lid]=b.dataset.filter.split('|'),ids=state.filters[fid]||[];state.filters[fid]=ids.includes(lid)?ids.filter(x=>x!==lid):[...ids,lid];b.classList.toggle('on')});
};
