/* Filtros disponibles: cada chip indica cuántas tareas daría y se bloquea atenuado si daría cero. El panel muestra el total vigente. */
/* En la vista de proyectos los filtros eligen proyectos: los que tienen alguna tarea que los cumple (aceptación V1, 12).
   Allí se cuentan proyectos y no se ofrece la faceta «Proyecto». */
function projectsMode(){return state.view==='projects'}
function filterNoun(n){return projectsMode()?(n===1?'proyecto':'proyectos'):(n===1?'tarea':'tareas')}
function projectMatchesFilters(p){const keys=Object.keys(state.filters||{}).filter(k=>k!=='_project'&&(state.filters[k]||[]).length);if(!keys.length)return true;const search=state.search;state.search='';try{return filteredTasks(p).length>0}finally{state.search=search}}
function filterCount(filters){const previous=state.filters;state.filters=filters;try{if(projectsMode())return areasForTasks().reduce((sum,area)=>sum+withArea(area.id,()=>filteredProjects().length),0);if(state.view==='project'&&project())return filteredTasks(project()).length;return areasForTasks().reduce((sum,area)=>sum+withArea(area.id,areaMatchCount),0)}finally{state.filters=previous}}
function chipFilters(chip){const probe=structuredClone(state.filters||{});if(chip.dataset.stateFilter){probe._state=[chip.dataset.stateFilter];return probe}if(chip.dataset.availability){probe._availability=[chip.dataset.availability];return probe}if(chip.dataset.projectFilter){probe._project=[chip.dataset.projectFilter];return probe}if(chip.dataset.filter){const [fid,lid]=chip.dataset.filter.split('|');probe[fid]=[lid];return probe}return null}
function filterScopeName(){if(state.view==='project'&&project())return 'en '+project().title;if(generalMode())return 'en todas las áreas';return 'en '+tab().name}
function refreshFilterSheet(){const sheet=document.getElementById('sheet');if(!sheet)return;
  const total=filterCount(state.filters||{}),all=filterCount({}),counter=sheet.querySelector('#filterCount');
  if(counter)counter.innerHTML=`<strong>${total}</strong> ${filterNoun(total)} ${esc(filterScopeName())}${total!==all?` <span class="muted">de ${all}</span>`:''}`;
  sheet.querySelectorAll('.filterchip').forEach(chip=>{const probe=chipFilters(chip);if(!probe)return;const n=filterCount(probe),blocked=!chip.classList.contains('on')&&n===0;chip.querySelector('.chipcount')?.remove();chip.insertAdjacentHTML('beforeend',`<span class="chipcount">${n}</span>`);chip.classList.toggle('unavailable',blocked);chip.disabled=blocked;chip.title=blocked?`Sin ${filterNoun(0)} con los filtros actuales`:''});
}
/* Barra de facetas siempre visible bajo el buscador, con desplegable por dimensión en escritorio, fila de filtros activos
   quitables y atajos a las vistas guardadas bajo las áreas. En móvil cada faceta abre el panel completo. */
let openFacet=null;
const FACET_FIXED=[{id:'_state',name:'Estado',options:[['pending','Pendientes'],['done','Completadas']]},{id:'_availability',name:'Disponibilidad',options:[['ready','Disponibles ahora'],['blocked','Bloqueadas']]}];
/* Cada opción es [ids, nombre]: en la vista General, las etiquetas o proyectos con el mismo nombre en varias áreas se funden en una sola opción. */
function mergeOptions(entries,merge=true){const byName=new Map();for(const [id,name] of entries){const key=merge?name.trim().toLocaleLowerCase():id;if(!byName.has(key))byName.set(key,{ids:[],name});byName.get(key).ids.push(id)}return [...byName.values()].map(o=>[o.ids,o.name])}
function facetDefinitions(){const areas=areasForTasks(),defs=FACET_FIXED.map(d=>({...d,options:d.options.map(([v,name])=>[[v],name])}));
  if(state.view!=='project'&&!projectsMode())defs.push({id:'_project',name:'Proyecto',options:mergeOptions(areas.flatMap(area=>withArea(area.id,()=>tab().projects.filter(p=>!p.deleted&&p.status!=='archived').map(p=>[p.id,p.title]))),areas.length>1)});
  const families=new Map();for(const area of areas)withArea(area.id,()=>{for(const f of tab().families.filter(f=>!f.archived)){const entry=families.get(familyKey(f))||{id:f.id,name:f.name,color:f.color,raw:[]};for(const l of tab().labels.filter(l=>l.family===f.id&&!l.archived))entry.raw.push([l.id,labelName(l)]);families.set(familyKey(f),entry)}});
  return defs.concat([...families.values()].filter(f=>f.raw.length).map(f=>({id:f.id,name:f.name,color:f.color,options:mergeOptions(f.raw,areas.length>1)})))}
function optionOn(key,ids){const list=state.filters[key]||[];return ids.every(id=>list.includes(id))}
function activeFilterCount(){return Object.values(state.filters||{}).flat().length}
function activeFilterChips(){const defs=facetDefinitions(),out=[];for(const [key,values] of Object.entries(state.filters||{})){const def=defs.find(d=>d.id===key),left=new Set(values||[]);for(const [ids,name] of def?.options||[]){if(!ids.every(id=>left.has(id)))continue;ids.forEach(id=>left.delete(id));out.push(activeChip(key,ids,name,def))}for(const v of left)out.push(activeChip(key,[v],v,def))}return out.join('')}
function activeChip(key,ids,name,def){const color=def?.color||(key==='_project'?'#777063':'#6f746d');return `<button class="chip activechip" style="background:${esc(color)}" data-facet-toggle="${esc(key)}" data-facet-value="${esc(ids.join(','))}" aria-label="Quitar filtro ${esc(name)}">${esc(name)}<span class="x">×</span></button>`}
function facetPanel(d){const current=state.filters[d.id]||[];return `<div class="facetpanel" role="group" aria-label="${esc(d.name)}">${d.options.map(([ids,name])=>{const probe=structuredClone(state.filters||{});probe[d.id]=ids;const n=filterCount(probe),on=optionOn(d.id,ids),blocked=!on&&n===0;return `<button class="filterchip ${on?'on':''} ${blocked?'unavailable':''}" data-facet-toggle="${d.id}" data-facet-value="${esc(ids.join(','))}" ${blocked?`disabled title="Sin ${filterNoun(0)} con los filtros actuales"`:''} ${d.color?`style="color:${esc(d.color)}"`:''}>${esc(name)}<span class="chipcount">${n}</span></button>`}).join('')}<div class="facetfoot"><span class="small muted">Se aplica al instante · Esc cierra</span>${current.length?`<button class="ghost small" data-facet-clear="${d.id}">Quitar ${esc(d.name)}</button>`:''}</div></div>`}
function facetBar(){if(!['projects','tasks','project'].includes(state.view)||!tab())return'';const defs=facetDefinitions(),total=filterCount(state.filters||{}),all=filterCount({}),active=activeFilterCount();
  const facets=defs.map(d=>{const sel=d.options.filter(([ids])=>optionOn(d.id,ids)),open=openFacet===d.id;return `<div class="facet ${open?'open':''}"><button class="facetbtn ${sel.length?'active':''}" data-facet="${d.id}" aria-expanded="${open}">${d.color?`<span class="dot" style="background:${esc(d.color)}"></span>`:''}<span>${esc(d.name)}</span>${sel.length?`<span class="facetcount">${sel.length}</span>`:''}<span class="facetchev" aria-hidden="true"></span></button>${open?facetPanel(d):''}</div>`}).join('');
  return `<div class="facetbar"><div class="facets">${facets}</div><div class="facettotal"><span class="facetnumber"><strong>${total}</strong> ${filterNoun(total)}${total!==all?` <span class="muted">de ${all}</span>`:''}</span></div></div>${active?`<div class="activefilters"><span class="activelabel">Activos</span>${activeFilterChips()}<button class="ghost small" id="clearAllFilters">Limpiar</button></div>`:''}`}
function toggleFacetValue(key,value){const ids=String(value).split(',').filter(Boolean),list=state.filters[key]||[];state.filters[key]=ids.every(id=>list.includes(id))?list.filter(x=>!ids.includes(x)):[...new Set([...list,...ids])];if(!state.filters[key].length)delete state.filters[key];persistUI();render()}
const searchBeforeFacets=searchbar;
searchbar=function(){const n=activeFilterCount();return searchBeforeFacets().replace(/<p class="small muted">(Proyectos|Disponibilidad): [^<]*<\/p>/g,'').replace(/<button class="softbtn( active)?" id="filterBtn">☷( \d+)?<\/button>/,`<button class="softbtn filterbtn$1" id="filterBtn" aria-label="Filtros">${menuIcon('filter')}<span class="filterlabel">Filtros</span>${n?`<span class="facetcount">${n}</span>`:''}</button>`)+facetBar()};
document.addEventListener('click',e=>{if(openFacet&&!e.target.closest('.facet')){openFacet=null;render()}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&openFacet){openFacet=null;render()}});
const bindBeforeFacets=bind;
bind=function(){bindBeforeFacets();
  document.querySelectorAll('[data-facet]').forEach(b=>b.onclick=()=>{if(!matchMedia('(min-width:1024px)').matches)return openFilters();openFacet=openFacet===b.dataset.facet?null:b.dataset.facet;render()});
  document.querySelectorAll('[data-facet-toggle]').forEach(b=>b.onclick=e=>{e.stopPropagation();toggleFacetValue(b.dataset.facetToggle,b.dataset.facetValue)});
  document.querySelectorAll('[data-facet-clear]').forEach(b=>b.onclick=e=>{e.stopPropagation();delete state.filters[b.dataset.facetClear];persistUI();render()});
  const clear=document.getElementById('clearAllFilters');if(clear)clear.onclick=()=>{state.filters={};openFacet=null;persistUI();render()};
  const saveView=document.getElementById('saveViewQuick');if(saveView)saveView.onclick=savedViewsSheet;
  document.querySelectorAll('[data-quick-view]').forEach(b=>b.onclick=()=>{const v=(tab().views||[]).find(v=>v.id===b.dataset.quickView);if(!v)return;state.search=v.search||'';state.filters=cloneModel(v.filters||{});state.groupBy=v.groupBy||'project';state.view='tasks';state.currentProject=null;openFacet=null;persistUI();render()});
};
const filtersBeforeAvailability=openFilters;
openFilters=function(){filtersBeforeAvailability();const sheet=document.getElementById('sheet');if(!sheet.querySelector('.filterchip'))return;
  (sheet.querySelector('.subtitle')||sheet.querySelector('.sheettitle')).insertAdjacentHTML('afterend','<div class="filtercount" id="filterCount" aria-live="polite"></div>');
  sheet.querySelectorAll('.filterchip').forEach(chip=>{const previous=chip.onclick;chip.onclick=e=>{previous?.(e);refreshFilterSheet()}});
  refreshFilterSheet();
};
const projectsBeforeFilters=filteredProjects;
/* «Entrada» es la bandeja de captura rápida de cada área: solo aparece en Proyectos y Tareas cuando tiene algo pendiente
   (aceptación V1, 4). Sigue existiendo y recibe lo que se añade sin elegir proyecto. */
function quietInbox(p){return p.system==='inbox'&&['projects','tasks'].includes(state.view)&&!p.tasks.some(t=>!t.deleted&&!t.done)}
filteredProjects=function(){const items=projectsBeforeFilters().filter(p=>!quietInbox(p));return projectsMode()?items.filter(projectMatchesFilters):items};
