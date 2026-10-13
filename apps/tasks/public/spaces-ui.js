/* R2 · la zona como espacio de Recursos (docs/tasks/API.md §30). Solo actúa con `tasks.settings.zone_source` = 'spaces',
   es decir, después de «Pasar las zonas a espacios»; antes no cambia nada. Decisiones del usuario (13-10-2026): chip
   «Albergue › Hab 3» (los dos últimos niveles), una chip por espacio sin juntar en la madre, y las tareas nuevas de un
   proyecto heredan su espacio. Aquí: chips, faceta «Espacio» en árbol (con lo de dentro y tres estados), agrupar por
   espacio, buscar por espacio, espacio en la ficha de tarea y de proyecto (con los más usados a un toque), «Espacio» en la
   selección múltiple, la herencia y la pantalla «Espacios» con el árbol del kit. Va la última: envuelve a las demás capas. */
function spacesMode(){return !!Sync.core&&Sync.core.zoneSource()==='spaces'}
let spaceCache={src:null,rows:[],byId:new Map()};
function spaceRows(){const src=Sync.core?.spaces||[];if(spaceCache.src!==src){const rows=src.filter(r=>!r.deleted_at).map(r=>IkisaiKit.spaceFromRow(r));spaceCache={src,rows,byId:new Map(rows.map(r=>[r.id,r]))}}return spaceCache.rows}
function spaceById(id){spaceRows();return spaceCache.byId.get(id)}
/* «Albergue › Hab 3»: el espacio y el de encima, salvo que sea una altura (como la ruta corta del selector del kit). */
function spaceShort(id){const r=spaceById(id);if(!r)return '';const up=r.parentId?spaceById(r.parentId):null;return up&&up.kind!=='altura'?`${up.name} › ${r.name}`:r.name}
/* El color de la antigua familia «Zona: Espacio» (archivada al pasar), para que la chip se siga reconociendo. */
function zoneColor(){for(const a of state.tabs||[])for(const f of a.families||[])if(String(f.name||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase()==='zona: espacio')return f.color||'#9c744e';return '#9c744e'}
function spaceChips(ids=[]){if(!spacesMode())return '';const color=zoneColor();return [...new Set(ids||[])].filter(id=>spaceById(id)).map(id=>`<span class="chip spacechip" style="background:${esc(color)}" data-space="${esc(id)}">${esc(spaceShort(id))}</span>`).join('')}
/* Con lo de dentro: «Albergue» encuentra también lo que está en «Hab 3». */
function expandSpaces(ids){const rows=spaceRows(),out=new Set();for(const id of ids||[]){out.add(id);for(const d of IkisaiKit.spaceDescendants(rows,id,true))out.add(d)}return out}
function aggregatedSpaces(p){const set=new Set(p.ownSpaces||[]);p.tasks.filter(t=>!t.deleted).forEach(t=>(t.spaces||[]).forEach(id=>set.add(id)));return [...set]}
/* Sin repetir madre e hija: si una tarea tiene «Albergue» y «Hab 3», cuenta en «Hab 3». */
function deepestSpaces(ids){const own=[...new Set(ids||[])].filter(id=>spaceById(id));return own.filter(id=>!own.some(o=>o!==id&&IkisaiKit.ancestorsOf(spaceCache.byId,o).some(a=>a.id===id)))}
function spaceHit(id,q){return spaceShort(id).toLowerCase().includes(q)}
function mostUsedSpaces(){const n=new Map();for(const a of state.tabs||[])for(const p of a.projects||[])for(const t of p.tasks||[])if(!t.deleted)for(const id of t.spaces||[])n.set(id,(n.get(id)||0)+1);return [...n].filter(([id])=>spaceById(id)?.active).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([id])=>id)}
Object.assign(menuPaths,{space:'M3 11l9-7 9 7 M5 9.5V20h14V9.5 M10 20v-6h4v6'});

/* --- Chips -------------------------------------------------------------------------------------------------------- */
const rowsBeforeSpaces=taskRow;
taskRow=function(t,p=project(),context=false){const html=rowsBeforeSpaces(t,p,context),extra=spaceChips(t.spaces);return extra?html.replace(/<(span|div) class="chips taskchips">/,m=>m+extra):html};

/* --- Filtro y búsqueda ---------------------------------------------------------------------------------------------- */
const filteredTasksBeforeSpaces=filteredTasks;
filteredTasks=function(p){const saved=state.filters||{},inc=saved._space||[],out=(saved._exclude||[]).filter(id=>spaceById(id)),q=(state.search||'').trim().toLowerCase(),bySearch=!!q&&spacesMode();
  if(!inc.length&&!out.length&&!bySearch)return filteredTasksBeforeSpaces(p);
  const search=state.search,rest=(saved._exclude||[]).filter(id=>!out.includes(id));state.filters={...saved};delete state.filters._space;if(rest.length)state.filters._exclude=rest;else delete state.filters._exclude;
  let base,hits=null;try{if(bySearch){hits=new Set(filteredTasksBeforeSpaces(p).map(t=>t.id));state.search=''}base=filteredTasksBeforeSpaces(p)}finally{state.filters=saved;state.search=search}
  const yes=expandSpaces(inc),no=expandSpaces(out);
  return base.filter(t=>{const own=t.spaces||[];if(inc.length&&!own.some(id=>yes.has(id)))return false;if(own.some(id=>no.has(id)))return false;return !hits||hits.has(t.id)||own.some(id=>spaceHit(id,q))})};
const filteredProjectsBeforeSpaces=filteredProjects;
filteredProjects=function(){const items=filteredProjectsBeforeSpaces(),q=(state.search||'').trim().toLowerCase();if(!q||!spacesMode())return items;
  const has=new Set(items.map(p=>p.id)),filtered=activeFilterCount()>0;
  const extra=tab().projects.filter(p=>!has.has(p.id)&&!p.deleted&&p.status!=='archived'&&!quietInbox(p)&&(filtered?filteredTasks(p).length>0:((p.ownSpaces||[]).some(id=>spaceHit(id,q))||filteredTasks(p).length>0)));
  return extra.length?[...items,...extra].sort((a,b)=>(a.order||0)-(b.order||0)||a.id.localeCompare(b.id)):items};
/* La faceta: los espacios que usan las tareas, con lo que tienen encima, en árbol (sin las alturas si no se usan). */
function spaceFacetOptions(){const used=new Set();for(const area of areasForTasks())for(const p of area.projects)if(!p.deleted){(p.ownSpaces||[]).forEach(id=>used.add(id));p.tasks.forEach(t=>{if(!t.deleted)(t.spaces||[]).forEach(id=>used.add(id))})}
  const rows=spaceRows(),shown=new Set();for(const id of used){if(!spaceById(id))continue;shown.add(id);for(const a of IkisaiKit.ancestorsOf(spaceCache.byId,id))if(a.kind!=='altura'||used.has(a.id))shown.add(a.id)}
  const out=[],walk=(parent,depth)=>{for(const r of IkisaiKit.childrenOf(rows,parent,true)){const on=shown.has(r.id);if(on)out.push({id:r.id,depth});walk(r.id,on?depth+1:depth)}};walk(null,0);
  return out}
function spaceDepth(id){return spaceFacetOptions().find(o=>o.id===id)?.depth||0}
const facetDefinitionsBeforeSpaces=facetDefinitions;
facetDefinitions=function(){const defs=facetDefinitionsBeforeSpaces();if(!spacesMode())return defs;const options=spaceFacetOptions().map(o=>[[o.id],spaceShort(o.id)]);if(!options.length)return defs;
  const def={id:'_space',name:'Espacio',color:zoneColor(),options},at=defs.findIndex(d=>!d.id.startsWith('_'));if(at<0)defs.push(def);else defs.splice(at,0,def);return defs};
const facetPanelBeforeSpaces=facetPanel;
facetPanel=function(d){const html=facetPanelBeforeSpaces(d);if(d.id!=='_space')return html;const box=document.createElement('template');box.innerHTML=html;const depth=new Map(spaceFacetOptions().map(o=>[o.id,o.depth]));
  box.content.firstElementChild?.classList.add('spacefacet');
  box.content.querySelectorAll('[data-facet-toggle="_space"]').forEach(b=>{const id=b.dataset.facetValue,r=spaceById(id);if(!r)return;b.style.marginInlineStart=`${(depth.get(id)||0)*16}px`;if(b.firstChild?.nodeType===3)b.firstChild.textContent=r.name;
    // Tres estados, como las etiquetas: siempre se puede pulsar (excluir tiene sentido aunque incluir dé 0).
    const out=excludedOn([id]);b.classList.toggle('excluded',out);if(out)b.setAttribute('aria-label',`${spaceShort(id)}: sin él`);b.disabled=false;b.removeAttribute('title')});
  return box.innerHTML};
const toggleFacetValueBeforeSpaces=toggleFacetValue;
toggleFacetValue=function(key,value){if(key!=='_space')return toggleFacetValueBeforeSpaces(key,value);cycleLabelFilter(key,String(value).split(',').filter(Boolean));persistUI();render()};
const activeFilterChipsBeforeSpaces=activeFilterChips;
activeFilterChips=function(){const html=activeFilterChipsBeforeSpaces(),out=(state.filters?._exclude||[]).filter(id=>spaceById(id));if(!out.length)return html;const color=zoneColor();
  return html+out.map(id=>`<button class="chip activechip excludedchip" style="background:${esc(color)}" data-facet-toggle="_exclude" data-facet-value="${esc(id)}" aria-label="Quitar filtro: sin ${esc(spaceShort(id))}" data-feedback-id="tasks.filtros.activos.quitar" data-feedback-label="Quitar filtro">Sin ${esc(spaceShort(id))}<span class="x">×</span></button>`).join('')};
/* La hoja de filtros (móvil): el mismo árbol, con los tres estados. */
const chipFiltersBeforeSpaces=chipFilters;
chipFilters=function(chip){if(chip.dataset.spaceFilter){const probe=structuredClone(state.filters||{});probe._space=[chip.dataset.spaceFilter];return probe}return chipFiltersBeforeSpaces(chip)};
const refreshFilterSheetBeforeSpaces=refreshFilterSheet;
refreshFilterSheet=function(){refreshFilterSheetBeforeSpaces();document.querySelectorAll('#sheet [data-space-filter]').forEach(c=>{c.disabled=false;if(c.classList.contains('excluded'))c.classList.remove('unavailable')})};
const openFiltersBeforeSpaces=openFilters;
openFilters=function(){openFiltersBeforeSpaces();const sheet=document.getElementById('sheet');if(!spacesMode()||!sheet||!sheet.querySelector('.filterchip'))return;const options=spaceFacetOptions();if(!options.length)return;
  const box=document.createElement('div');box.className='filterfamily spacefacet';
  box.innerHTML=`<h4>Espacio</h4>${options.map(o=>{const on=(state.filters._space||[]).includes(o.id),out=excludedOn([o.id]);return `<button class="filterchip ${on?'on':''} ${out?'excluded':''}" style="margin-inline-start:${o.depth*16}px" data-space-filter="${esc(o.id)}" data-feedback-id="tasks.filtros.espacio" data-feedback-label="Filtro de espacio">${esc(spaceById(o.id).name)}</button>`}).join('')}`;
  const first=sheet.querySelector('.filterfamily:has([data-filter])');if(first)sheet.insertBefore(box,first);else sheet.append(box);
  box.querySelectorAll('[data-space-filter]').forEach(b=>b.onclick=()=>{const id=b.dataset.spaceFilter;cycleLabelFilter('_space',[id]);b.classList.toggle('on',(state.filters._space||[]).includes(id));b.classList.toggle('excluded',excludedOn([id]));refreshFilterSheet()});
  refreshFilterSheet()};

/* --- Agrupar por espacio (features.js pinta los grupos con spaceGroupKeys y spaceShort) -------------------------------- */
function spaceGroupKeys(t){return deepestSpaces(t.spaces)}
const groupToolbarBeforeSpaces=groupToolbar;
groupToolbar=function(){const html=groupToolbarBeforeSpaces();if(!spacesMode())return html;const on=(state.groupBy||'project')==='_space';
  return html.replace(/(<option value="state"[^>]*>[^<]*<\/option>)/,`$1<option value="_space" ${on?'selected':''}>Espacio</option>`)};

/* --- Ficha de tarea y de proyecto ----------------------------------------------------------------------------------- */
// Borrador del espacio mientras la ficha está abierta (sobrevive a reabrirla al elegir etiquetas) y lo que se guarda al pulsar «Guardar».
let spaceDraft=null,spacePending=null;
function mountSpaceField(anchor,key,initial,label,feedbackId,hint){if(!anchor)return;const ids=spaceDraft&&spaceDraft.key===key?spaceDraft.ids:[...initial];spaceDraft={key,ids:[...ids]};
  const field=document.createElement('div');field.className='field spacefield ikisai-kit';
  const picker=IkisaiKit.createSpacePicker({label,rows:spaceRows(),multiple:true,value:ids,quick:mostUsedSpaces(),feedbackId,onChange:next=>{spaceDraft={key,ids:[...next]}}});
  field.append(picker.element);if(hint)field.insertAdjacentHTML('beforeend',`<p class="small muted">${esc(hint)}</p>`);anchor.insertAdjacentElement('beforebegin',field);
  if(!canEdit())field.querySelectorAll('input,button').forEach(x=>x.disabled=true)}
function rememberSpaces(button,pending){if(button&&canEdit())button.addEventListener('click',()=>{spacePending={...pending,ids:[...(spaceDraft?.ids||[])]};setTimeout(()=>{spacePending=null})},true)}
const taskEditorBeforeSpaces=openTaskEditor;
openTaskEditor=function(id,selectedOverride=null,valsOverride=null){taskEditorBeforeSpaces(id,selectedOverride,valsOverride);if(!spacesMode())return;
  const loc=id?taskLocation(id):null,initial=loc?(loc.t.spaces||[]):(project()?.ownSpaces||[]);
  mountSpaceField(document.getElementById('editLabelsBtn')?.closest('.field'),'task:'+(id||'new'),initial,'Espacio','tasks.editor_tarea.espacio');
  rememberSpaces(document.getElementById('saveTaskBtn'),{kind:'task',id:id||null})};
const projectEditorBeforeSpaces=openProjectEditor;
openProjectEditor=function(id,selectedOverride=null,valsOverride=null){projectEditorBeforeSpaces(id,selectedOverride,valsOverride);if(!spacesMode())return;
  const base=id?tab().projects.find(p=>p.id===id):null;
  mountSpaceField(document.getElementById('editProjectLabels')?.closest('.field'),'project:'+(id||'new'),base?.ownSpaces||[],'Espacio del proyecto','tasks.editor_proyecto.espacio','Las tareas nuevas del proyecto lo heredan.');
  rememberSpaces(document.getElementById('saveProjectBtn'),{kind:'project',id:id||null})};
const closeSheetBeforeSpaces=closeSheet;
closeSheet=function(e){closeSheetBeforeSpaces(e);if(!document.getElementById('sheetBack').classList.contains('show'))spaceDraft=null};
function setSpaces(x,field,ids){const next=[...new Set(ids)];if(JSON.stringify(x[field]||[])===JSON.stringify(next))return;x[field]=next;if(field==='spaces')touch(x)}
/* Al guardar: lo elegido en la ficha y, en las tareas nuevas (las que aún no están en el último modelo), el espacio de su proyecto. */
function applySpaces(){const pending=spacePending;spacePending=null;if(!Sync.last)return;const known=new Set();
  for(const a of Sync.last)for(const p of a.projects||[]){known.add('p:'+p.id);for(const t of p.tasks||[])known.add(t.id)}
  for(const a of state.tabs)for(const p of a.projects||[]){
    if(pending?.kind==='project'&&(pending.id?p.id===pending.id:!known.has('p:'+p.id)))setSpaces(p,'ownSpaces',pending.ids);
    for(const t of p.tasks||[]){if(t.deleted)continue;
      if(pending?.kind==='task'&&pending.id===t.id)setSpaces(t,'spaces',pending.ids);
      else if(!known.has(t.id)){if(pending?.kind==='task'&&!pending.id)setSpaces(t,'spaces',pending.ids);else if(t.spaces===undefined&&(p.ownSpaces||[]).length)t.spaces=[...p.ownSpaces]}}}}
const saveBeforeSpaces=save;
save=function(){if(spacesMode())try{applySpaces()}catch(e){console.error(e)}else spacePending=null;return saveBeforeSpaces()};

/* --- Selección múltiple: «Espacio» se añade a lo que ya tengan (si es más concreto, sustituye al de encima) ----------- */
const batchBarBeforeSpaces=batchBar;
batchBar=function(){const html=batchBarBeforeSpaces();if(!html||!spacesMode())return html;const n=batchSelection.size;
  return html.replace(/<button[^>]*id="batchMove"/,m=>`<button type="button" class="softbtn" id="batchSpace" data-feedback-id="tasks.lote.espacio" data-feedback-label="Espacio" ${n?'':'disabled'}>${menuIcon('space')}Espacio</button>`+m)};
const bindBatchBarBeforeSpaces=bindBatchBar;
bindBatchBar=function(){bindBatchBarBeforeSpaces();const b=document.querySelector('#batchBar #batchSpace');if(b)b.onclick=batchSpaceSheet};
function batchSpaceSheet(){const n=batchSelection.size;openSheet(`<h2 class="sheettitle">Espacio de ${n} ${n===1?'tarea':'tareas'}</h2><p class="subtitle">Se añade a lo que ya tengan.</p><div class="ikisai-kit" id="batchSpacePicker"></div><div class="actions"><button class="primary" id="batchSpaceDone" disabled data-feedback-id="tasks.lote.espacio.aplicar" data-feedback-label="Aplicar espacio">Aplicar</button></div>`);
  let picked=[];const done=document.getElementById('batchSpaceDone');
  const picker=IkisaiKit.createSpacePicker({label:'Espacio',rows:spaceRows(),multiple:true,value:[],quick:mostUsedSpaces(),feedbackId:'tasks.lote.espacio',onChange:ids=>{picked=ids;done.disabled=!ids.length}});
  document.getElementById('batchSpacePicker').append(picker.element);
  done.onclick=()=>{closeSheet();if(!picked.length)return;batchRun('Espacio añadido a %n tareas',id=>{const {t}=taskLocation(id);const next=deepestSpaces([...(t.spaces||[]),...picked]);if(JSON.stringify(next)!==JSON.stringify(t.spaces||[])){t.spaces=next;touch(t);record('edit',[id])}})}}

/* --- Pantalla «Espacios»: el árbol del kit, común a todas las apps ---------------------------------------------------- */
let spaceTree=null,spaceSource=null,spaceSheets=null;
function spacesSource(){if(!spaceSource&&Sync.core?.resources)spaceSource=IkisaiKit.createSyncSpaceSource(Sync.core.resources);return spaceSource}
const navigationGroupsBeforeSpaces=navigationGroups;
navigationGroups=function(){const groups=navigationGroupsBeforeSpaces();if(!spacesMode())return groups;const org=groups.find(g=>g.id==='organize');if(org)org.items.splice(1,0,['spaces','Espacios','space','view']);return groups};
const mainBeforeSpaces=main;
main=function(){if(state.view!=='spaces')return mainBeforeSpaces();if(!spacesMode()){state.view='projects';return mainBeforeSpaces()}
  return `<main class="screen spaces-screen"><div class="screenhead"><div><h1 class="title">Espacios</h1><p class="subtitle">Los espacios de la casa, comunes a todas las apps. Las tareas los usan como zona.</p></div></div><div class="ikisai-kit" id="spacesTree"></div></main>`};
const renderBeforeSpaces=render;
render=function(){const result=renderBeforeSpaces();const host=document.getElementById('spacesTree');if(host){const source=spacesSource();
    if(!source)host.innerHTML='<div class="empty">Los espacios no están disponibles ahora. Vuelve a probar con conexión.</div>';
    else{if(!spaceSheets){spaceSheets=document.createElement('div');spaceSheets.className='ikisai-kit';document.body.append(spaceSheets)}
      if(!spaceTree)spaceTree=IkisaiKit.createSpaceTree({source,permissions:{edit:canEdit(),structure:Sync.actor?.role==='owner'&&canEdit()},label:'Espacios',feedbackId:'tasks.espacios.arbol',container:spaceSheets,storageKey:'tasks'});
      host.append(spaceTree.element)}}
  return result};
