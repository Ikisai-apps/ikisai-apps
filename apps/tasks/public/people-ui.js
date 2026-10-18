/* P2, PR 3b · la persona como ficha de Central (docs/tasks/API.md §33). Réplica de trades-ui.js para las personas. Solo actúa
   con `tasks.settings.people_source` = 'central', es decir, después de «Pasar las personas a Central»; antes no cambia nada (la
   caracterización es tests/tasks/personas.spec.ts). Las personas no se sincronizan: `Sync.core.people` es la última lectura de
   `central.people_options`, guardada en el dispositivo (sin red siguen saliendo los nombres; si nunca se leyó, la chip dice
   «Persona»). Una persona se guarda como su id de Central o como un grupo por nivel de casa (`level:staff`: «Todo el staff»).
   Aquí: chips con las iniciales (o el nombre de pila; el grupo, «Todo el staff»), una por persona o grupo, donde iba la
   persona; faceta «Persona» en árbol por nivel (el nivel incluye a sus personas y a las tareas del grupo, tres estados y
   búsqueda por nombre e iniciales); buscar y agrupar; «Personas» y «Responsable principal» en las fichas de tarea y de
   proyecto; «Persona» en la selección múltiple; la herencia; «Mis tareas» por la cuenta; las reglas de Entrada; la pantalla
   «Personas» y el botón «Pasar las personas a Central» con su vuelta atrás. Va después de trades-ui.js: reutiliza `plural`,
   `pendingWork` y `CENTRAL_URL`, y coloca lo suyo detrás de lo de los oficios. */
function peopleMode(){return !!Sync.core&&typeof Sync.core.peopleSource==='function'&&Sync.core.peopleSource()==='central'}
const personNorm=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase().replace(/\s+/g,' ');
/* Los niveles de casa, en el orden fijo de Central: [nivel, nombre, nombre del grupo]. */
const PERSON_LEVELS=[['direccion','Dirección','Toda la dirección'],['staff','Staff','Todo el staff'],['outsider','Outsider','Todos los outsiders']];
function levelOf(key){return /^level:(direccion|staff|outsider)$/.exec(String(key||''))?.[1]||null}
function levelRank(level){const i=PERSON_LEVELS.findIndex(l=>l[0]===level);return i<0?PERSON_LEVELS.length:i}
function levelGroupName(level){return PERSON_LEVELS.find(l=>l[0]===level)?.[2]||'Grupo'}
function levelName(level){return PERSON_LEVELS.find(l=>l[0]===level)?.[1]||'Sin nivel'}
const personCompare=(a,b)=>levelRank(a.house_level)-levelRank(b.house_level)||a.name.localeCompare(b.name,'es')||a.person_id.localeCompare(b.person_id);
let personCache={src:null,byId:new Map(),order:new Map(),sorted:[]};
function peopleIndex(){const src=Sync.core?.people||[];if(personCache.src!==src){
    const sorted=[...src].sort(personCompare),order=new Map();
    // Orden estable de chips, selectores y grupos: por nivel (el grupo delante de sus personas) y por nombre.
    PERSON_LEVELS.forEach(([level],i)=>order.set('level:'+level,i*100000));
    sorted.forEach((p,i)=>order.set(p.person_id,levelRank(p.house_level)*100000+1+i));
    personCache={src,byId:new Map(src.map(p=>[p.person_id,p])),order,sorted}}
  return personCache}
function personById(id){return peopleIndex().byId.get(id)}
function knownPerson(key){return !!levelOf(key)||!!personById(key)}
/* El nombre entero («Valeria Gómez», «Todo el staff»); sin catálogo, «Persona». */
function personFull(key){const level=levelOf(key);if(level)return levelGroupName(level);const p=personById(key);return p?p.name:'Persona'}
/* La chip: las iniciales de Central y, si no tiene, el nombre de pila. */
function personShort(key){const level=levelOf(key);if(level)return levelGroupName(level);const p=personById(key);if(!p)return 'Persona';return p.initials||p.name.trim().split(/\s+/)[0]}
function sortPeople(keys){const {order}=peopleIndex(),at=k=>order.has(k)?order.get(k):1e9;return [...new Set(keys||[])].sort((a,b)=>at(a)-at(b))}
/* El color de la familia de personas (archivada al pasar), para que la chip se siga reconociendo. */
function personFamilyOf(area){const fams=area?.families||[];const i=fams.findIndex(f=>f.system==='person');return i>=0?i:fams.findIndex(f=>['persona','grupo: persona'].includes(personNorm(f.name)))}
function personColor(area=tab()){for(const a of [area,...(state.tabs||[])]){const i=personFamilyOf(a);if(i>=0)return a.families[i].color||'#7b6a8c'}return '#7b6a8c'}
function areaOfProject(p){return (state.tabs||[]).find(a=>(a.projects||[]).includes(p))||tab()}
function personChips(keys=[],area){if(!peopleMode())return '';const color=personColor(area);return sortPeople(keys).map(k=>`<span class="chip personchip" style="background:${esc(color)}" data-person="${esc(k)}" title="${esc(personFull(k))}">${esc(personShort(k))}</span>`).join('')}
/* Dónde va la persona entre las chips de etiqueta: donde salía su familia (después de la acción, antes de la fase). */
function personSlot(ids,area){const pi=personFamilyOf(area);if(pi<0)return 0;
  return labelGroups(ids||[]).filter(g=>{const s=(state.tabs||[]).find(t=>(t.labels||[]).some(x=>x.id===g.mother.id)),fi=(s?.families||[]).findIndex(f=>f.id===g.mother.family);return fi>=0&&fi<pi}).length}
function skipLabelChips(html,at,n){const one=/^<span class="chip" style="[^"]*">[^<]*<\/span>/;for(let i=0;i<n;i++){const m=one.exec(html.slice(at));if(!m)break;at+=m[0].length}return at}
/* Las chips de etiqueta con las de persona en su sitio (el tablero). */
function labelChipsWithPeople(t,p){const html=chips(t.labels||[]),extra=personChips(t.people,areaOfProject(p));if(!extra)return html;const at=skipLabelChips(html,0,personSlot(t.labels,areaOfProject(p)));return html.slice(0,at)+extra+html.slice(at)}
/* Con lo de dentro: «Todo el staff» encuentra también lo que tienen sus personas. */
function expandPeople(keys){const out=new Set();for(const k of keys||[]){out.add(k);const level=levelOf(k);if(level)for(const p of Sync.core?.people||[])if(p.house_level===level)out.add(p.person_id)}return out}
function aggregatedPeople(p){const set=new Set(p.ownPeople||[]);p.tasks.filter(t=>!t.deleted).forEach(t=>(t.people||[]).forEach(k=>set.add(k)));return [...set]}
/* Sin repetir el grupo y su persona: con «Todo el staff» y AN (de staff), cuenta en AN. */
function deepestPeople(keys){const own=[...new Set(keys||[])];return own.filter(k=>{const level=levelOf(k);return !level||!own.some(o=>personById(o)?.house_level===level)})}
function personHit(key,q){if(!knownPerson(key))return false;const p=personById(key);return personNorm(personFull(key)).includes(q)||!!p?.initials&&personNorm(p.initials).includes(q)}
function mostUsedPeople(){const n=new Map();for(const a of state.tabs||[])for(const p of a.projects||[])for(const t of p.tasks||[])if(!t.deleted)for(const k of t.people||[])n.set(k,(n.get(k)||0)+1);return [...n].filter(([k])=>knownPerson(k)).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k])=>k)}
Object.assign(menuPaths,{people:'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20a6.5 6.5 0 0 1 13 0 M15.5 4.3a3.5 3.5 0 0 1 0 6.4 M17.5 13.6A6.5 6.5 0 0 1 21.5 20'});
/* Si cambia a modo central a mitad de sesión (aquí o en otro dispositivo), se lee el catálogo una vez. */
let peopleAsked=false;
function askPeople(force=false){if(!Sync.core?.refreshPeople||!Sync.actor||(peopleAsked&&!force))return Promise.resolve(false);peopleAsked=true;return Sync.core.refreshPeople()}

/* --- Chips: detrás de las de espacio y oficio y de las etiquetas que iban antes de la persona ------------------------- */
const rowsBeforePeople=taskRow;
taskRow=function(t,p=project(),context=false){const html=rowsBeforePeople(t,p,context),area=areaOfProject(p),extra=personChips(t.people,area);if(!extra)return html;
  const m=/<(span|div) class="chips taskchips">((?:<span class="chip (?:spacechip|tradechip)"[^>]*>[^<]*<\/span>)*)/.exec(html);if(!m)return html;
  const at=skipLabelChips(html,m.index+m[0].length,personSlot(t.labels,area));return html.slice(0,at)+extra+html.slice(at)};

/* --- Filtro y búsqueda ---------------------------------------------------------------------------------------------- */
const filteredTasksBeforePeople=filteredTasks;
filteredTasks=function(p){const saved=state.filters||{},inc=saved._person||[],out=(saved._exclude||[]).filter(knownPerson),q=personNorm(state.search),bySearch=!!q&&peopleMode();
  if(!inc.length&&!out.length&&!bySearch)return filteredTasksBeforePeople(p);
  const search=state.search,rest=(saved._exclude||[]).filter(id=>!out.includes(id));state.filters={...saved};delete state.filters._person;if(rest.length)state.filters._exclude=rest;else delete state.filters._exclude;
  let base,hits=null;try{if(bySearch){hits=new Set(filteredTasksBeforePeople(p).map(t=>t.id));state.search=''}base=filteredTasksBeforePeople(p)}finally{state.filters=saved;state.search=search}
  const yes=expandPeople(inc),no=expandPeople(out);
  return base.filter(t=>{const own=t.people||[];if(inc.length&&!own.some(k=>yes.has(k)))return false;if(own.some(k=>no.has(k)))return false;return !hits||hits.has(t.id)||own.some(k=>personHit(k,q))})};
const filteredProjectsBeforePeople=filteredProjects;
filteredProjects=function(){const items=filteredProjectsBeforePeople(),q=personNorm(state.search);if(!q||!peopleMode())return items;
  const has=new Set(items.map(p=>p.id)),filtered=activeFilterCount()>0;
  const extra=tab().projects.filter(p=>!has.has(p.id)&&!p.deleted&&p.status!=='archived'&&!quietInbox(p)&&(filtered?filteredTasks(p).length>0:((p.ownPeople||[]).some(k=>personHit(k,q))||filteredTasks(p).length>0)));
  return extra.length?[...items,...extra].sort((a,b)=>(a.order||0)-(b.order||0)||a.id.localeCompare(b.id)):items};
/* La faceta: los niveles y las personas que usan las tareas y los proyectos, en árbol (nivel › personas). */
function personFacetOptions(){const used=new Set();for(const area of areasForTasks())for(const p of area.projects)if(!p.deleted){(p.ownPeople||[]).forEach(k=>used.add(k));p.tasks.forEach(t=>{if(!t.deleted)(t.people||[]).forEach(k=>used.add(k))})}
  const people=peopleIndex().sorted.filter(p=>used.has(p.person_id)),out=[];
  for(const [level] of PERSON_LEVELS){const mine=people.filter(p=>p.house_level===level);if(!mine.length&&!used.has('level:'+level))continue;
    out.push({id:'level:'+level,depth:0,name:levelName(level)});for(const p of mine)out.push({id:p.person_id,depth:1,name:p.name,initials:p.initials})}
  for(const p of people.filter(p=>levelRank(p.house_level)>=PERSON_LEVELS.length))out.push({id:p.person_id,depth:0,name:p.name,initials:p.initials});
  return out}
const facetDefinitionsBeforePeople=facetDefinitions;
facetDefinitions=function(){const defs=facetDefinitionsBeforePeople();if(!peopleMode())return defs;const options=personFacetOptions().map(o=>[[o.id],o.name]);if(!options.length)return defs;
  const def={id:'_person',name:'Persona',color:personColor(),options},after=['_trade','_space'].map(id=>defs.findIndex(d=>d.id===id)).find(i=>i>=0),at=after!==undefined?after+1:defs.findIndex(d=>!d.id.startsWith('_'));
  if(at<0)defs.push(def);else defs.splice(at,0,def);return defs};
let personFacetQuery='';
const personSearchText=o=>personNorm([o.name,o.initials||'',o.depth===0&&levelOf(o.id)?levelGroupName(levelOf(o.id)):''].join(' '));
function personSearchInput(){return `<input type="search" class="personfacetsearch" placeholder="Buscar por nombre o iniciales…" aria-label="Buscar persona" value="${esc(personFacetQuery)}" data-feedback-id="tasks.filtros.persona.buscar" data-feedback-label="Buscar persona">`}
/* Deja a la vista lo que casa con lo buscado y los niveles que lo contienen. */
function filterPersonOptions(root,query){const q=personNorm(query),options=personFacetOptions(),text=new Map(options.map(o=>[o.id,personSearchText(o)]));
  const shown=new Set();if(q){let level=null;for(const o of options){if(o.depth===0)level=o.id;if(text.get(o.id).includes(q)){shown.add(o.id);if(o.depth===1&&level)shown.add(level)}}}
  root.querySelectorAll('[data-person-option]').forEach(b=>{b.hidden=!!q&&!shown.has(b.dataset.personOption)})}
const facetPanelBeforePeople=facetPanel;
facetPanel=function(d){const html=facetPanelBeforePeople(d);if(d.id!=='_person')return html;const box=document.createElement('template');box.innerHTML=html;const info=new Map(personFacetOptions().map(o=>[o.id,o]));
  const panel=box.content.firstElementChild;panel?.classList.add('personfacet');panel?.insertAdjacentHTML('afterbegin',personSearchInput());
  box.content.querySelectorAll('[data-facet-toggle="_person"]').forEach(b=>{const o=info.get(b.dataset.facetValue);if(!o)return;b.dataset.personOption=o.id;b.style.marginInlineStart=`${o.depth*16}px`;
    if(o.initials&&b.firstChild?.nodeType===3)b.firstChild.textContent=`${o.name} · ${o.initials}`;
    // Tres estados, como las etiquetas: siempre se puede pulsar (excluir tiene sentido aunque incluir dé 0).
    const out=excludedOn([o.id]);b.classList.toggle('excluded',out);if(out)b.setAttribute('aria-label',`${personFull(o.id)}: sin ella`);b.disabled=false;b.removeAttribute('title')});
  if(personFacetQuery)filterPersonOptions(box.content,personFacetQuery);
  return box.innerHTML};
const toggleFacetValueBeforePeople=toggleFacetValue;
toggleFacetValue=function(key,value){if(key!=='_person')return toggleFacetValueBeforePeople(key,value);cycleLabelFilter(key,String(value).split(',').filter(Boolean));persistUI();render()};
const activeFilterChipsBeforePeople=activeFilterChips;
activeFilterChips=function(){const html=activeFilterChipsBeforePeople(),out=(state.filters?._exclude||[]).filter(knownPerson);if(!out.length)return html;const color=personColor();
  return html+out.map(k=>`<button class="chip activechip excludedchip" style="background:${esc(color)}" data-facet-toggle="_exclude" data-facet-value="${esc(k)}" aria-label="Quitar filtro: sin ${esc(personFull(k))}" data-feedback-id="tasks.filtros.activos.quitar" data-feedback-label="Quitar filtro">Sin ${esc(personFull(k))}<span class="x">×</span></button>`).join('')};
/* La hoja de filtros (móvil): el mismo árbol, con los tres estados y el buscador, detrás del de oficios. */
const chipFiltersBeforePeople=chipFilters;
chipFilters=function(chip){if(chip.dataset.personFilter){const probe=structuredClone(state.filters||{});probe._person=[chip.dataset.personFilter];return probe}return chipFiltersBeforePeople(chip)};
const refreshFilterSheetBeforePeople=refreshFilterSheet;
refreshFilterSheet=function(){refreshFilterSheetBeforePeople();document.querySelectorAll('#sheet [data-person-filter]').forEach(c=>{c.disabled=false;if(c.classList.contains('excluded'))c.classList.remove('unavailable')})};
const openFiltersBeforePeople=openFilters;
openFilters=function(){openFiltersBeforePeople();const sheet=document.getElementById('sheet');if(!peopleMode()||!sheet||!sheet.querySelector('.filterchip'))return;const options=personFacetOptions();if(!options.length)return;
  const box=document.createElement('div');box.className='filterfamily personfacet';
  box.innerHTML=`<h4>Persona</h4>${personSearchInput()}${options.map(o=>{const on=(state.filters._person||[]).includes(o.id),out=excludedOn([o.id]);return `<button class="filterchip ${on?'on':''} ${out?'excluded':''}" style="margin-inline-start:${o.depth*16}px" data-person-filter="${esc(o.id)}" data-person-option="${esc(o.id)}" data-feedback-id="tasks.filtros.persona" data-feedback-label="Filtro de persona">${esc(o.initials?`${o.name} · ${o.initials}`:o.name)}</button>`}).join('')}`;
  const after=sheet.querySelector('.filterfamily.tradefacet')||sheet.querySelector('.filterfamily.spacefacet'),first=sheet.querySelector('.filterfamily:has([data-filter])');if(after)after.after(box);else if(first)sheet.insertBefore(box,first);else sheet.append(box);
  box.querySelectorAll('[data-person-filter]').forEach(b=>b.onclick=()=>{const k=b.dataset.personFilter;cycleLabelFilter('_person',[k]);b.classList.toggle('on',(state.filters._person||[]).includes(k));b.classList.toggle('excluded',excludedOn([k]));refreshFilterSheet()});
  const input=box.querySelector('.personfacetsearch');input.oninput=()=>{personFacetQuery=input.value;filterPersonOptions(box,input.value)};if(personFacetQuery)filterPersonOptions(box,personFacetQuery);
  refreshFilterSheet()};

/* --- Agrupar por persona (features.js pinta los grupos con personGroupKeys y personFull) -------------------------------- */
function personGroupKeys(t){return sortPeople(deepestPeople(t.people))}
const groupToolbarBeforePeople=groupToolbar;
groupToolbar=function(){const html=groupToolbarBeforePeople();if(!peopleMode())return html;const on=(state.groupBy||'project')==='_person',option=`<option value="_person" ${on?'selected':''}>Persona</option>`;
  const after=['_trade','_space','state'].find(v=>new RegExp(`<option value="${v}"`).test(html));return html.replace(new RegExp(`(<option value="${after}"[^>]*>[^<]*<\\/option>)`),`$1${option}`)};

/* --- Selector «Personas»: el de espacios del kit, con filas en árbol nivel › persona (el nivel se elige como grupo) ------ */
const PERSON_KINDS=[{kind:'altura',label:'Grupo',level:1},{kind:'persona',label:'Persona',level:2}];
const PERSON_TEXTS={empty:'Ninguna persona coincide con «{q}».',search:'Buscar por nombre o iniciales…',feedback:{quick:'Persona más usada',search:'Buscar persona',remove:'Quitar persona'}};
// Con el tipo «altura», el kit no antepone el nivel al nombre en lo elegido: sale «Valeria Gómez», no «Todo el staff › …».
function personRows(){const rows=PERSON_LEVELS.map(([level],i)=>({id:'level:'+level,parentId:null,kind:'altura',name:levelGroupName(level),publicName:levelName(level),code:null,position:i,active:true,notes:null,attributes:{}}));
  peopleIndex().sorted.filter(p=>p.house_level).forEach((p,i)=>rows.push({id:p.person_id,parentId:'level:'+p.house_level,kind:'persona',name:p.name,publicName:null,code:p.initials,position:i,active:true,notes:null,attributes:{}}));
  return rows}
function personPicker(options){return IkisaiKit.createSpacePicker({rows:personRows(),kinds:PERSON_KINDS,multiple:true,texts:PERSON_TEXTS,quick:mostUsedPeople(),...options})}

/* --- «Responsable principal»: un select agrupado por nivel, con el grupo delante y las personas por nombre -------------- */
function ownerOptionsHtml(value){const {sorted}=peopleIndex(),known=!value||knownPerson(value),on=v=>v===(value||'')?' selected':'';
  return `<option value=""${on('')}>Sin asignar</option>${PERSON_LEVELS.map(([level,name,group])=>`<optgroup label="${esc(name)}"><option value="level:${level}"${on('level:'+level)}>${esc(group)}</option>${sorted.filter(p=>p.house_level===level).map(p=>`<option value="${esc(p.person_id)}"${on(p.person_id)}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}${known?'':`<option value="${esc(value)}" selected>Persona (no disponible)</option>`}`}
function mountOwnerSelect(select,key,initial){if(!select)return null;const value=ownerDraft&&ownerDraft.key===key?ownerDraft.value:(initial||'');ownerDraft={key,value};
  select.innerHTML=ownerOptionsHtml(value);select.value=value;select.dataset.personOwner='1';select.addEventListener('change',()=>{ownerDraft={key,value:select.value}});return select}

/* --- Ficha de tarea y de proyecto ----------------------------------------------------------------------------------- */
// Borradores mientras la ficha está abierta (sobreviven a reabrirla al elegir etiquetas) y lo que se guarda al pulsar «Guardar».
let peopleDraft=null,ownerDraft=null,peoplePending=null,peopleField=null;
/* Para «Quién sabe hacerlo» (who-knows-ui.js): añade una persona al campo «Personas» de la ficha abierta, si no estaba. Nada más:
   se guarda con el resto de la ficha al pulsar «Guardar». Devuelve si la ha añadido. */
function addPersonToField(personId){const f=peopleField;if(!f||!f.field.isConnected||!peopleDraft||peopleDraft.key!==f.key||!canEdit())return false;
  if(peopleDraft.ids.includes(personId))return false;const next=[...peopleDraft.ids,personId];f.picker.set(next);peopleDraft={key:f.key,ids:next};
  f.field.dispatchEvent(new CustomEvent('people-change',{detail:[...next]}));return true}
function mountPeopleField(anchor,key,initial,label,feedbackId,hint){if(!anchor)return;const ids=peopleDraft&&peopleDraft.key===key?peopleDraft.ids:[...initial];peopleDraft={key,ids:[...ids]};
  const field=document.createElement('div');field.className='field personfield ikisai-kit';
  const picker=personPicker({label,value:ids,feedbackId,onChange:next=>{peopleDraft={key,ids:[...next]};field.dispatchEvent(new CustomEvent('people-change',{detail:[...next]}))}});
  peopleField={key,picker,field};field.append(picker.element);if(!(Sync.core?.people||[]).length)field.insertAdjacentHTML('beforeend','<p class="small muted">Las personas de Central no se han podido leer todavía. Vuelve a abrir la ficha con conexión.</p>');
  if(hint)field.insertAdjacentHTML('beforeend',`<p class="small muted">${esc(hint)}</p>`);anchor.insertAdjacentElement('beforebegin',field);
  if(!canEdit())field.querySelectorAll('input,button').forEach(x=>x.disabled=true)}
/* Al pulsar «Guardar» (antes que la ficha): se apunta lo elegido y el select del responsable se vacía para que la ficha no
   escriba el id de la persona como etiqueta (`owner`); se restaura si la ficha no llega a guardar. */
function rememberPeople(button,select,pending){if(!button||!canEdit())return;button.addEventListener('click',()=>{const owner=select?.value||'';peoplePending={...pending,ids:[...(peopleDraft?.ids||[])],owner:select?owner:undefined};
  if(select)select.value='';setTimeout(()=>{peoplePending=null;if(select?.isConnected)select.value=owner})},true)}
const taskEditorBeforePeople=openTaskEditor;
openTaskEditor=function(id,selectedOverride=null,valsOverride=null){taskEditorBeforePeople(id,selectedOverride,valsOverride);if(!peopleMode())return;
  const loc=id?taskLocation(id):null,key='task:'+(id||'new'),initial=loc?(loc.t.people||[]):(project()?.ownPeople||[]);
  mountPeopleField(document.getElementById('editLabelsBtn')?.closest('.field'),key,initial,'Personas','tasks.editor_tarea.personas');
  const select=mountOwnerSelect(document.getElementById('teOwner'),key,loc?.t.ownerPerson);
  rememberPeople(document.getElementById('saveTaskBtn'),select,{kind:'task',id:id||null})};
const projectEditorBeforePeople=openProjectEditor;
openProjectEditor=function(id,selectedOverride=null,valsOverride=null){projectEditorBeforePeople(id,selectedOverride,valsOverride);if(!peopleMode())return;
  const base=id?tab().projects.find(p=>p.id===id):null,key='project:'+(id||'new');
  mountPeopleField(document.getElementById('editProjectLabels')?.closest('.field'),key,base?.ownPeople||[],'Personas del proyecto','tasks.editor_proyecto.personas','Las tareas nuevas del proyecto las heredan.');
  const select=mountOwnerSelect(document.getElementById('peOwner'),key,base?.ownerPerson);
  rememberPeople(document.getElementById('saveProjectBtn'),select,{kind:'project',id:id||null})};
const closeSheetBeforePeople=closeSheet;
closeSheet=function(e){closeSheetBeforePeople(e);if(!document.getElementById('sheetBack').classList.contains('show')){peopleDraft=null;ownerDraft=null;peopleField=null;personFacetQuery=''}};
function setPeople(x,field,keys){const next=[...new Set(keys)];if(JSON.stringify(x[field]||[])===JSON.stringify(next))return;x[field]=next;if(field==='people')touch(x)}
/* El responsable de Central (`ownerPerson`, una persona o `level:<nivel>`); la etiqueta (`owner`) se queda vacía. */
function setOwnerPerson(x,value,isTask){const next=value||null;if((x.ownerPerson||null)===next&&!x.owner)return;x.ownerPerson=next;x.owner=null;if(isTask)touch(x)}
/* Al guardar: lo elegido en la ficha y, en las tareas nuevas (las que aún no están en el último modelo), las personas del proyecto. */
function applyPeople(){const pending=peoplePending;peoplePending=null;if(!Sync.last)return;const known=new Set();
  for(const a of Sync.last)for(const p of a.projects||[]){known.add('p:'+p.id);for(const t of p.tasks||[])known.add(t.id)}
  for(const a of state.tabs)for(const p of a.projects||[]){
    if(pending?.kind==='project'&&(pending.id?p.id===pending.id:!known.has('p:'+p.id))){setPeople(p,'ownPeople',pending.ids);if(pending.owner!==undefined)setOwnerPerson(p,pending.owner,false)}
    for(const t of p.tasks||[]){if(t.deleted)continue;
      const mine=pending?.kind==='task'&&(pending.id?pending.id===t.id:!known.has(t.id));
      if(mine){setPeople(t,'people',pending.ids);if(pending.owner!==undefined)setOwnerPerson(t,pending.owner,true)}
      else if(!known.has(t.id)&&t.people===undefined&&(p.ownPeople||[]).length)t.people=[...p.ownPeople]}}}
const saveBeforePeople=save;
save=function(){if(peopleMode())try{applyPeople()}catch(e){console.error(e)}else peoplePending=null;return saveBeforePeople()};

/* --- Selección múltiple: «Persona» se añade a lo que ya tengan (una persona sustituye a su grupo) --------------------- */
const batchBarBeforePeople=batchBar;
batchBar=function(){const html=batchBarBeforePeople();if(!html||!peopleMode())return html;const n=batchSelection.size;
  return html.replace(/<button[^>]*id="batchMove"/,m=>`<button type="button" class="softbtn" id="batchPerson" data-feedback-id="tasks.lote.persona" data-feedback-label="Persona" ${n?'':'disabled'}>${menuIcon('people')}Persona</button>`+m)};
const bindBatchBarBeforePeople=bindBatchBar;
bindBatchBar=function(){bindBatchBarBeforePeople();const b=document.querySelector('#batchBar #batchPerson');if(b)b.onclick=batchPersonSheet};
function batchPersonSheet(){const n=batchSelection.size;openSheet(`<h2 class="sheettitle">Persona de ${n} ${n===1?'tarea':'tareas'}</h2><p class="subtitle">Se añade a lo que ya tengan.</p><div class="ikisai-kit" id="batchPersonPicker"></div><div class="actions"><button class="primary" id="batchPersonDone" disabled data-feedback-id="tasks.lote.persona.aplicar" data-feedback-label="Aplicar persona">Aplicar</button></div>`);
  let picked=[];const done=document.getElementById('batchPersonDone');
  const picker=personPicker({label:'Persona',value:[],feedbackId:'tasks.lote.persona',onChange:ids=>{picked=ids;done.disabled=!ids.length}});
  document.getElementById('batchPersonPicker').append(picker.element);
  done.onclick=()=>{closeSheet();if(!picked.length)return;batchRun('Persona añadida a %n tareas',id=>{const {t}=taskLocation(id);const next=deepestPeople([...(t.people||[]),...picked]);if(JSON.stringify(next)!==JSON.stringify(t.people||[])){t.people=next;touch(t);record('edit',[id])}})}}

/* --- «Mis tareas»: en modo central, la persona de Central enlazada a esta cuenta (no el alias) ----------------------- */
function myPerson(){const me=Sync.actor?.id;return me?(Sync.core?.people||[]).find(p=>p.user_id===me)||null:null}
const myTaskFiltersBeforePeople=myTaskFilters;
myTaskFilters=function(){if(!peopleMode())return myTaskFiltersBeforePeople();const me=myPerson();return me?{_person:[me.person_id]}:null};
const showMyTasksBeforePeople=showMyTasks;
showMyTasks=function(){if(!peopleMode())return showMyTasksBeforePeople();const filters=myTaskFilters();
  if(!filters){closeNavigation();return toast('Tu cuenta no está enlazada a ninguna persona de Central: enlázala en Central › Personas.')}
  closeNavigation();closeSheet();state.taskScope='all';state.view='tasks';state.currentProject=null;state.search='';state.groupBy='project';state.filters=filters;persistUI();render()};

/* --- Menú: en «Trabajo», tras «Etiquetas» y lo de los espacios y los oficios («Organización» se pinta oculto) ----------- */
function afterTrades(groups,item){const work=groups.find(g=>g.id==='work')||groups[0];let at=work.items.findIndex(i=>i[0]==='labels');if(at<0)at=work.items.length-1;
  while(at+1<work.items.length&&['spaces','zonesToSpaces','trades','actionsToTrades'].includes(work.items[at+1][0]))at+=1;work.items.splice(at+1,0,item);return groups}
function canMovePeople(){return Sync.actor?.role==='owner'&&Sync.actor.scopes==='*'&&Sync.actor.kind!=='agent'&&!Sync.secondary}
function hasPersonFamily(){for(const a of state.tabs||[])for(const f of a.families||[])if(!f.archived&&(f.system==='person'||['persona','grupo: persona'].includes(personNorm(f.name))))return true;return false}
const navigationGroupsBeforePeople=navigationGroups;
navigationGroups=function(){const groups=navigationGroupsBeforePeople();if(peopleMode())return afterTrades(groups,['people','Personas','people','view']);
  if(canMovePeople()&&hasPersonFamily())return afterTrades(groups,['peopleToCentral','Pasar las personas a Central','people','action']);return groups};
const topActionBeforePeople=handleTopAction;
handleTopAction=function(action){if(action==='peopleToCentral'){closeNavigation();return peopleSheet()}return topActionBeforePeople(action)};

/* --- Pantalla «Personas»: las de Central por nivel, de solo lectura (se gestionan en Central) ----------------------------- */
function peopleListHtml(){const {sorted}=peopleIndex();if(!sorted.length)return '<div class="empty">Las personas de Central no se han podido leer todavía. Vuelve a probar con conexión.</div>';
  const uses=new Map();for(const a of state.tabs||[])for(const p of a.projects||[])if(!p.deleted)for(const t of p.tasks||[])if(!t.deleted)for(const k of t.people||[])uses.set(k,(uses.get(k)||0)+1);
  const count=k=>uses.get(k)?` <span class="muted small">· ${esc(plural(uses.get(k),'tarea','tareas'))}</span>`:'';
  const levels=[...PERSON_LEVELS.map(l=>l[0]),null].map(level=>{const mine=sorted.filter(p=>(p.house_level||null)===level);if(!mine.length&&level===null)return '';
    return `<li class="personlevel"><strong>${esc(level?levelName(level):'Sin nivel de casa')}</strong>${level?` <span class="muted small">· ${esc(levelGroupName(level))}</span>${count('level:'+level)}`:''}<ul>${mine.map(p=>`<li class="personnode" data-person="${esc(p.person_id)}"><span>${esc(p.name)}</span>${p.initials?` <span class="pstate">${esc(p.initials)}</span>`:''}${count(p.person_id)}</li>`).join('')||'<li class="muted small">Nadie con este nivel.</li>'}</ul></li>`}).join('');
  return `<ul class="peoplelist" aria-label="Personas">${levels}</ul>`}
const mainBeforePeople=main;
main=function(){if(state.view!=='people')return mainBeforePeople();if(!peopleMode()){state.view='projects';return mainBeforePeople()}
  return `<main class="screen people-screen"><div class="screenhead"><div><h1 class="title">Personas</h1><p class="subtitle">Las personas de la casa vienen de Central, con su nivel. Las tareas las usan como responsables.</p></div></div>${peopleListHtml()}<div class="catalog-actions"><a class="softbtn" href="${CENTRAL_URL}" target="_blank" rel="noopener" data-feedback-id="tasks.personas.gestionar" data-feedback-label="Gestionar en Central">Gestionar en Central</a>${canMovePeople()?'<button class="ghost" id="peopleToLabels" data-feedback-id="tasks.personas.volver" data-feedback-label="Volver a las etiquetas de persona">Volver a las etiquetas de persona…</button>':''}</div></main>`};
const renderBeforePeople=render;
render=function(){const result=renderBeforePeople();if(peopleMode()&&!peopleAsked&&!Sync.secondary&&navigator.onLine)void askPeople();return result};
const bindBeforePeople=bind;
bind=function(){bindBeforePeople();const back=document.getElementById('peopleToLabels');if(back)back.onclick=()=>peopleToLabelsSheet();
  document.querySelectorAll('.facet.open .personfacetsearch').forEach(input=>{input.onclick=e=>e.stopPropagation();input.oninput=()=>{personFacetQuery=input.value;filterPersonOptions(input.closest('.facetpanel'),input.value)}})};

/* --- «Pasar las personas a Central» y «Volver a las etiquetas de persona» (API.md §33) ---------------------------------
   Solo la propietaria humana con acceso a todo. La vista previa (`read/tasks.people_preview`) propone una persona para cada
   etiqueta y la propietaria confirma cada una en su select (un borrador en el dispositivo, que se manda como `mapping` al
   volver a pedir la vista previa). «Pasar» no se puede pulsar mientras quede alguna en uso sin elegir. La ida es
   `actions/people-to-central` y la vuelta, `actions/people-to-labels`, al pie de la pantalla «Personas». */
const PEOPLE_DRAFT_KEY='ikisai-tasks-people-mapping';
function readPeopleDraft(){try{const v=JSON.parse(localStorage.getItem(PEOPLE_DRAFT_KEY)||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}catch(e){return {}}}
function writePeopleDraft(v){try{if(Object.keys(v).length)localStorage.setItem(PEOPLE_DRAFT_KEY,JSON.stringify(v));else localStorage.removeItem(PEOPLE_DRAFT_KEY)}catch(e){}}
const PROPOSAL_BY={initials:'por las iniciales',name:'por el nombre',first_name:'por el nombre de pila'};
function peopleError(e){if(e?.status===503||e?.details?.code==='CENTRAL_UNAVAILABLE')return 'No se ha podido leer Central: la lista de personas no responde ahora. Vuelve a probar dentro de un rato.';
  if(e?.details?.code==='CENTRAL_PEOPLE_EMPTY')return 'Central no tiene personas con nivel de casa: ponlo primero en Central › Personas.';
  if(e?.details?.code==='PEOPLE_UNCONFIRMED')return 'Falta elegir la persona de alguna etiqueta.';
  if(e?.details?.code==='INVALID_PERSON')return 'Alguna de las personas elegidas ya no está activa en Central: vuelve a elegirla.';
  return e?.details?.message||e?.message||'No se ha podido hacer.'}
function peopleNotice(title,html){openSheet(`<h2 class="sheettitle">${esc(title)}</h2>${html}<div class="actions"><button class="ghost" id="peopleClose" data-feedback-id="tasks.personas.cerrar" data-feedback-label="Cerrar">Cerrar</button></div>`);document.getElementById('peopleClose').onclick=()=>closeSheet()}
const proposalValue=p=>!p?'':p.houseLevel?'level:'+p.houseLevel:p.personId||'';
function personUses(l){return [l.tasks?plural(l.tasks,'tarea','tareas'):'',l.projects?plural(l.projects,'proyecto','proyectos'):'',l.owners?`responsable de ${l.owners}`:'',l.routes?plural(l.routes,'regla de Entrada','reglas de Entrada'):''].filter(Boolean).join(' · ')||'sin uso'}
function mappingSelect(l,people,value){const label=[l.parentName,l.name].filter(Boolean).join(' › ');
  return `<select data-person-map="${esc(l.labelId)}" aria-label="Persona de Central para ${esc(label)}" data-feedback-id="tasks.personas.pasar.elegir" data-feedback-label="Persona de Central"><option value="" ${value?'':'selected'}>Elige…</option>${PERSON_LEVELS.map(([level,name,group])=>`<optgroup label="${esc(name)}"><option value="level:${level}" ${value==='level:'+level?'selected':''}>${esc(group)}</option>${people.filter(p=>p.houseLevel===level).sort((a,b)=>a.name.localeCompare(b.name,'es')).map(p=>`<option value="${esc(p.personId)}" ${value===p.personId?'selected':''}>${esc(p.name)}${p.initials?' · '+esc(p.initials):''}</option>`).join('')}</optgroup>`).join('')}<option value="remove" ${value==='remove'?'selected':''}>Quitar</option></select>`}
async function peopleSheet(){const title='Pasar las personas a Central';if(!canMovePeople())return toast('Solo la propietaria con acceso a todo puede hacerlo.');if(pendingWork())return;
  const scroll=document.getElementById('sheet')?.scrollTop||0,reopening=!!document.querySelector('#sheet [data-person-map]');
  if(!reopening)openSheet(`<h2 class="sheettitle">${title}</h2><p>Preparando la vista previa…</p>`);
  let draft=readPeopleDraft(),out;
  const ask=()=>api('read/tasks.people_preview',{method:'POST',body:JSON.stringify(Object.keys(draft).length?{mapping:draft}:{})});
  try{out=await ask()}catch(e){
    // Un borrador viejo (etiquetas o personas que ya no están) no debe bloquear: se descarta y se vuelve a pedir.
    if(Object.keys(draft).length&&e?.status===422){draft={};writePeopleDraft(draft);try{out=await ask()}catch(e2){return peopleNotice(title,`<p class="notice peopleerror">${esc(peopleError(e2))}</p>`)}}
    else return peopleNotice(title,`<p class="notice peopleerror">${esc(peopleError(e))}</p>`)}
  if(out.source==='central'){closeSheet();toast('Las personas ya vienen de Central.');return render()}
  if(out.centralEmpty)return peopleNotice(title,`<p class="notice peopleempty">Central no tiene personas con nivel de casa: ponlo primero en <a href="${CENTRAL_URL}" target="_blank" rel="noopener" data-feedback-id="tasks.personas.ir_a_central" data-feedback-label="Abrir Central">Central › Personas</a>.</p>`);
  const c=out.counts||{},people=out.people||[],labels=out.labels||[];
  const value=l=>draft[l.labelId]??l.chosen??l.confirmed??proposalValue(l.proposal);
  const missing=labels.filter(l=>l.used&&!value(l));
  const row=l=>{const v=value(l),fromProposal=!draft[l.labelId]&&!l.chosen&&!l.confirmed&&!!l.proposal;
    return `<div class="zoneitem personmap ${v?'':'doubtful'}" data-person-row="${esc(l.labelId)}"><span class="personmapname"><strong>${esc([l.parentName,l.name].filter(Boolean).join(' › '))}</strong> · ${esc((l.areas||[]).map(a=>a.name||'General').join(', '))} · ${esc(personUses(l))}${!v&&l.used?' <span class="pstate pending">Por confirmar</span>':''}${fromProposal&&l.proposal.by?` <span class="muted small">· propuesta ${esc(PROPOSAL_BY[l.proposal.by]||'')}</span>`:''}${l.confirmed&&!draft[l.labelId]?' <span class="muted small">· confirmada antes</span>':''}</span>${mappingSelect(l,people,v)}</div>`};
  openSheet(`<h2 class="sheettitle">${title}</h2>
    <p class="subtitle">Las etiquetas de persona pasan a ser las personas de Central, las mismas de las demás apps, con su nivel de casa. Las chips dirán sus iniciales. Elige o confirma cada una; se puede deshacer desde «Personas».</p>
    <div class="notice zonecounts">${esc(plural(c.tasks||0,'tarea','tareas'))} y ${esc(plural(c.projects||0,'proyecto','proyectos'))} recibirán su persona · ${esc(plural(c.owners||0,'responsable','responsables'))} y ${esc(plural(c.routes||0,'regla de Entrada','reglas de Entrada'))} pasan a Central · ${esc(plural(c.views||0,'vista guardada se adapta','vistas guardadas se adaptan'))} · ${c.withoutPerson?`<strong>${esc(plural(c.withoutPerson,'se queda','se quedan'))} sin persona</strong>`:'nadie se queda sin persona'}</div>
    <h3>Cada etiqueta y su persona (${labels.length})</h3><div class="zonelist personmaplist">${labels.map(row).join('')||'<p class="small muted">Ninguna.</p>'}</div>
    <div class="actions"><button class="ghost" id="peopleCancel" data-feedback-id="tasks.personas.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="primary" id="peopleApply" ${missing.length?'disabled':''} data-feedback-id="tasks.personas.aplicar" data-feedback-label="Pasar las personas a Central">Pasar las personas a Central</button></div>
    ${missing.length?`<p class="small muted" id="peopleMissing">Falta elegir ${esc(plural(missing.length,'etiqueta','etiquetas'))} («Por confirmar»).</p>`:''}`);
  const sheet=document.getElementById('sheet');if(sheet&&reopening)sheet.scrollTop=scroll;
  document.getElementById('peopleCancel').onclick=()=>closeSheet();
  document.querySelectorAll('[data-person-map]').forEach(s=>s.onchange=()=>{const next=readPeopleDraft();if(s.value)next[s.dataset.personMap]=s.value;else delete next[s.dataset.personMap];writePeopleDraft(next);peopleSheet()});
  const apply=document.getElementById('peopleApply');apply.onclick=async()=>{if(pendingWork())return;const mapping={};
    document.querySelectorAll('[data-person-map]').forEach(s=>{if(s.value)mapping[s.dataset.personMap]=s.value});
    apply.disabled=true;apply.textContent='Pasando…';
    try{const done=await api('actions/people-to-central',{method:'POST',body:JSON.stringify({requestId:uid('req-'),mapping})});closeSheet();writePeopleDraft({});const n=done.counts||{};
      toast(`Hecho: ${plural(n.taskPeople||0,'tarea','tareas')} y ${plural(n.projectPeople||0,'proyecto','proyectos')} con su persona.`);await askPeople(true);await syncNow();render()}
    catch(e){toast(peopleError(e));peopleSheet()}}}
async function peopleToLabelsSheet(drop=false){const title='Volver a las etiquetas de persona';if(!canMovePeople())return;if(pendingWork())return;
  openSheet(`<h2 class="sheettitle">${title}</h2><p>Preparando…</p>`);
  let out;try{out=await api('read/tasks.people_preview',{method:'POST',body:'{}'})}catch(e){return peopleNotice(title,`<p class="notice peopleerror">${esc(peopleError(e))}</p>`)}
  if(out.source!=='central'){closeSheet();return render()}
  const c=out.counts||{},lost=out.lost||[],lostName=l=>l.name||(l.houseLevel?levelGroupName(l.houseLevel):personFull(l.value));
  openSheet(`<h2 class="sheettitle">${title}</h2>
    <p class="subtitle">Las personas vuelven a ser etiquetas de persona de cada área, con lo que tengan ahora ${esc(plural(c.tasks||0,'tarea','tareas'))} y ${esc(plural(c.projects||0,'proyecto','proyectos'))}, y los responsables, a su etiqueta. Las personas siguen en Central para las demás apps.</p>
    ${lost.length?`<h3>Se perderían (${lost.length})</h3><p class="small muted">Estas personas no vienen de ninguna etiqueta: al volver, sus tareas y proyectos se quedan sin ellas.</p><div class="zonelist">${lost.map(l=>`<div class="zoneitem"><span><strong>${esc(lostName(l))}</strong> · ${esc(personUses(l))}</span></div>`).join('')}</div><label class="zoneitem"><input type="checkbox" id="peopleDrop" ${drop?'checked':''} data-feedback-id="tasks.personas.volver.perder" data-feedback-label="Aceptar perderlas"><span>Entendido: quitarlos</span></label>`:''}
    <div class="actions"><button class="ghost" id="peopleBackCancel" data-feedback-id="tasks.personas.volver.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="danger" id="peopleBackApply" ${lost.length&&!drop?'disabled':''} data-feedback-id="tasks.personas.volver.aplicar" data-feedback-label="Volver a las etiquetas de persona">Volver a las etiquetas</button></div>`);
  document.getElementById('peopleBackCancel').onclick=()=>closeSheet();
  const check=document.getElementById('peopleDrop');if(check)check.onchange=()=>{document.getElementById('peopleBackApply').disabled=!check.checked};
  const apply=document.getElementById('peopleBackApply');apply.onclick=async()=>{if(pendingWork())return;apply.disabled=true;apply.textContent='Volviendo…';
    try{await api('actions/people-to-labels',{method:'POST',body:JSON.stringify({requestId:uid('req-'),dropUnmapped:!!check?.checked})});closeSheet();toast('Las personas vuelven a ser etiquetas.');state.view='labels';await syncNow();render()}
    catch(e){toast(peopleError(e));peopleToLabelsSheet(!!check?.checked)}}}
