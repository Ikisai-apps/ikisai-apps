/* P2 · la acción como oficio de Central (docs/tasks/API.md §32). Réplica de spaces-ui.js para los oficios. Solo actúa con
   `tasks.settings.trade_source` = 'central', es decir, después de «Pasar las acciones a oficios»; antes no cambia nada (la
   caracterización es tests/tasks/personas.spec.ts). Los oficios no se sincronizan: `Sync.core.trades` es la última lectura de
   `central.trade_options`, guardada en el dispositivo (sin red siguen saliendo los nombres; si nunca se leyó, la chip dice
   «Oficio»). Aquí: chips «Fontanería › ACS» (una por oficio, con el color de «Tipo: Acción»), faceta «Oficio» en árbol (la
   madre incluye lo de dentro, tres estados), buscar y agrupar por oficio, oficio en las fichas de tarea y de proyecto (con
   los más usados a un toque), «Oficio» en la selección múltiple, la herencia, la pantalla «Oficios» (solo lectura) y el
   botón «Pasar las acciones a oficios» con su vuelta atrás. Va después de spaces-ui.js: reutiliza `afterLabels`, `plural`,
   `usesText` y `pendingWork`, y coloca lo suyo detrás de lo de los espacios. */
function tradesMode(){return !!Sync.core&&typeof Sync.core.tradeSource==='function'&&Sync.core.tradeSource()==='central'}
const tradeNorm=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase();
const TRADE_KINDS=[{kind:'oficio',label:'Oficio',level:1}];
let tradeCache={src:null,rows:[],byId:new Map(),order:new Map()};
function tradeRows(){const src=Sync.core?.trades||[];if(tradeCache.src!==src){
    const rows=src.map(r=>({id:r.trade_id,parentId:r.parent_id||null,kind:'oficio',name:r.name,publicName:null,code:null,position:Number(r.position)||0,active:true,notes:null,attributes:{},path:r.path||r.name}));
    const byId=new Map(rows.map(r=>[r.id,r]));for(const r of rows)if(r.parentId&&!byId.has(r.parentId))r.parentId=null;
    const order=new Map(),walk=parent=>{for(const r of IkisaiKit.childrenOf(rows,parent,true))if(!order.has(r.id)){order.set(r.id,order.size);walk(r.id)}};walk(null);
    tradeCache={src,rows,byId,order}}
  return tradeCache.rows}
function tradeById(id){tradeRows();return tradeCache.byId.get(id)}
/* «Fontanería › ACS»: la ruta de Central. Sin catálogo (nunca se pudo leer) o con un oficio que ya no está, «Oficio». */
function tradeName(id){const r=tradeById(id);return r?(r.path||r.name):'Oficio'}
/* En las chips, como en la ficha (y los espacios): los dos últimos niveles, «Madre › Hija». La ruta entera, en el título. */
function tradeShort(id){return tradeName(id).split(' › ').slice(-2).join(' › ')}
/* El color de la familia «Tipo: Acción» (archivada al pasar), para que la chip se siga reconociendo. */
function actionColor(){for(const a of state.tabs||[])for(const f of a.families||[])if(tradeNorm(f.name)==='tipo: accion')return f.color||'#5a7a8a';return '#5a7a8a'}
/* En el orden del árbol de Central (como las etiquetas, que salen por su posición); los desconocidos, al final. */
function sortTrades(ids){tradeRows();const at=id=>tradeCache.order.has(id)?tradeCache.order.get(id):1e9;return [...new Set(ids||[])].sort((a,b)=>at(a)-at(b))}
function tradeChips(ids=[]){if(!tradesMode())return '';const color=actionColor();return sortTrades(ids).map(id=>`<span class="chip tradechip" style="background:${esc(color)}" data-trade="${esc(id)}" title="${esc(tradeName(id))}">${esc(tradeShort(id))}</span>`).join('')}
/* Con lo de dentro: «Fontanería» encuentra también lo que solo guarda «ACS». */
function expandTrades(ids){const rows=tradeRows(),out=new Set();for(const id of ids||[]){out.add(id);for(const d of IkisaiKit.spaceDescendants(rows,id,true))out.add(d)}return out}
function aggregatedTrades(p){const set=new Set(p.ownTrades||[]);p.tasks.filter(t=>!t.deleted).forEach(t=>(t.trades||[]).forEach(id=>set.add(id)));return [...set]}
/* Sin repetir madre e hija: con «Fontanería» y «ACS», cuenta en «ACS». */
function deepestTrades(ids){tradeRows();const own=[...new Set(ids||[])];return own.filter(id=>!own.some(o=>o!==id&&IkisaiKit.ancestorsOf(tradeCache.byId,o).some(a=>a.id===id)))}
function tradeHit(id,q){return !!tradeById(id)&&tradeNorm(tradeName(id)).includes(q)}
function mostUsedTrades(){const n=new Map();for(const a of state.tabs||[])for(const p of a.projects||[])for(const t of p.tasks||[])if(!t.deleted)for(const id of t.trades||[])n.set(id,(n.get(id)||0)+1);return [...n].filter(([id])=>tradeById(id)).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([id])=>id)}
Object.assign(menuPaths,{trade:'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z'});
/* Si cambia a modo oficios a mitad de sesión (aquí o en otro dispositivo), se lee el catálogo una vez. */
let tradesAsked=false;
function askTrades(force=false){if(!Sync.core?.refreshTrades||!Sync.actor||(tradesAsked&&!force))return Promise.resolve(false);tradesAsked=true;return Sync.core.refreshTrades()}

/* --- Chips: detrás de las de espacio, donde iba la acción («Tipo: Acción» iba delante de la persona) -------------------- */
const rowsBeforeTrades=taskRow;
taskRow=function(t,p=project(),context=false){const html=rowsBeforeTrades(t,p,context),extra=tradeChips(t.trades);return extra?html.replace(/<(span|div) class="chips taskchips">((?:<span class="chip spacechip"[^>]*>[^<]*<\/span>)*)/,m=>m+extra):html};

/* --- Filtro y búsqueda ---------------------------------------------------------------------------------------------- */
const filteredTasksBeforeTrades=filteredTasks;
filteredTasks=function(p){const saved=state.filters||{},inc=saved._trade||[],out=(saved._exclude||[]).filter(id=>tradeById(id)),q=tradeNorm(state.search),bySearch=!!q&&tradesMode();
  if(!inc.length&&!out.length&&!bySearch)return filteredTasksBeforeTrades(p);
  const search=state.search,rest=(saved._exclude||[]).filter(id=>!out.includes(id));state.filters={...saved};delete state.filters._trade;if(rest.length)state.filters._exclude=rest;else delete state.filters._exclude;
  let base,hits=null;try{if(bySearch){hits=new Set(filteredTasksBeforeTrades(p).map(t=>t.id));state.search=''}base=filteredTasksBeforeTrades(p)}finally{state.filters=saved;state.search=search}
  const yes=expandTrades(inc),no=expandTrades(out);
  return base.filter(t=>{const own=t.trades||[];if(inc.length&&!own.some(id=>yes.has(id)))return false;if(own.some(id=>no.has(id)))return false;return !hits||hits.has(t.id)||own.some(id=>tradeHit(id,q))})};
const filteredProjectsBeforeTrades=filteredProjects;
filteredProjects=function(){const items=filteredProjectsBeforeTrades(),q=tradeNorm(state.search);if(!q||!tradesMode())return items;
  const has=new Set(items.map(p=>p.id)),filtered=activeFilterCount()>0;
  const extra=tab().projects.filter(p=>!has.has(p.id)&&!p.deleted&&p.status!=='archived'&&!quietInbox(p)&&(filtered?filteredTasks(p).length>0:((p.ownTrades||[]).some(id=>tradeHit(id,q))||filteredTasks(p).length>0)));
  return extra.length?[...items,...extra].sort((a,b)=>(a.order||0)-(b.order||0)||a.id.localeCompare(b.id)):items};
/* La faceta: los oficios que usan las tareas y proyectos, con los que tienen encima, en árbol. */
function tradeFacetOptions(){const used=new Set();for(const area of areasForTasks())for(const p of area.projects)if(!p.deleted){(p.ownTrades||[]).forEach(id=>used.add(id));p.tasks.forEach(t=>{if(!t.deleted)(t.trades||[]).forEach(id=>used.add(id))})}
  const rows=tradeRows(),shown=new Set();for(const id of used){if(!tradeById(id))continue;shown.add(id);for(const a of IkisaiKit.ancestorsOf(tradeCache.byId,id))shown.add(a.id)}
  const out=[],seen=new Set(),walk=(parent,depth)=>{for(const r of IkisaiKit.childrenOf(rows,parent,true)){if(seen.has(r.id))continue;seen.add(r.id);const on=shown.has(r.id);if(on)out.push({id:r.id,depth});walk(r.id,on?depth+1:depth)}};walk(null,0);
  return out}
const facetDefinitionsBeforeTrades=facetDefinitions;
facetDefinitions=function(){const defs=facetDefinitionsBeforeTrades();if(!tradesMode())return defs;const options=tradeFacetOptions().map(o=>[[o.id],tradeName(o.id)]);if(!options.length)return defs;
  const def={id:'_trade',name:'Oficio',color:actionColor(),options},space=defs.findIndex(d=>d.id==='_space'),at=space>=0?space+1:defs.findIndex(d=>!d.id.startsWith('_'));if(at<0)defs.push(def);else defs.splice(at,0,def);return defs};
const facetPanelBeforeTrades=facetPanel;
facetPanel=function(d){const html=facetPanelBeforeTrades(d);if(d.id!=='_trade')return html;const box=document.createElement('template');box.innerHTML=html;const depth=new Map(tradeFacetOptions().map(o=>[o.id,o.depth]));
  box.content.firstElementChild?.classList.add('tradefacet');
  box.content.querySelectorAll('[data-facet-toggle="_trade"]').forEach(b=>{const id=b.dataset.facetValue,r=tradeById(id);if(!r)return;b.style.marginInlineStart=`${(depth.get(id)||0)*16}px`;if(b.firstChild?.nodeType===3)b.firstChild.textContent=r.name;
    // Tres estados, como las etiquetas: siempre se puede pulsar (excluir tiene sentido aunque incluir dé 0).
    const out=excludedOn([id]);b.classList.toggle('excluded',out);if(out)b.setAttribute('aria-label',`${tradeName(id)}: sin él`);b.disabled=false;b.removeAttribute('title')});
  return box.innerHTML};
const toggleFacetValueBeforeTrades=toggleFacetValue;
toggleFacetValue=function(key,value){if(key!=='_trade')return toggleFacetValueBeforeTrades(key,value);cycleLabelFilter(key,String(value).split(',').filter(Boolean));persistUI();render()};
const activeFilterChipsBeforeTrades=activeFilterChips;
activeFilterChips=function(){const html=activeFilterChipsBeforeTrades(),out=(state.filters?._exclude||[]).filter(id=>tradeById(id));if(!out.length)return html;const color=actionColor();
  return html+out.map(id=>`<button class="chip activechip excludedchip" style="background:${esc(color)}" data-facet-toggle="_exclude" data-facet-value="${esc(id)}" aria-label="Quitar filtro: sin ${esc(tradeName(id))}" data-feedback-id="tasks.filtros.activos.quitar" data-feedback-label="Quitar filtro">Sin ${esc(tradeName(id))}<span class="x">×</span></button>`).join('')};
/* La hoja de filtros (móvil): el mismo árbol, con los tres estados, detrás del de espacios. */
const chipFiltersBeforeTrades=chipFilters;
chipFilters=function(chip){if(chip.dataset.tradeFilter){const probe=structuredClone(state.filters||{});probe._trade=[chip.dataset.tradeFilter];return probe}return chipFiltersBeforeTrades(chip)};
const refreshFilterSheetBeforeTrades=refreshFilterSheet;
refreshFilterSheet=function(){refreshFilterSheetBeforeTrades();document.querySelectorAll('#sheet [data-trade-filter]').forEach(c=>{c.disabled=false;if(c.classList.contains('excluded'))c.classList.remove('unavailable')})};
const openFiltersBeforeTrades=openFilters;
openFilters=function(){openFiltersBeforeTrades();const sheet=document.getElementById('sheet');if(!tradesMode()||!sheet||!sheet.querySelector('.filterchip'))return;const options=tradeFacetOptions();if(!options.length)return;
  const box=document.createElement('div');box.className='filterfamily tradefacet';
  box.innerHTML=`<h4>Oficio</h4>${options.map(o=>{const on=(state.filters._trade||[]).includes(o.id),out=excludedOn([o.id]);return `<button class="filterchip ${on?'on':''} ${out?'excluded':''}" style="margin-inline-start:${o.depth*16}px" data-trade-filter="${esc(o.id)}" data-feedback-id="tasks.filtros.oficio" data-feedback-label="Filtro de oficio">${esc(tradeById(o.id).name)}</button>`}).join('')}`;
  const spaces=sheet.querySelector('.filterfamily.spacefacet'),first=sheet.querySelector('.filterfamily:has([data-filter])');if(spaces)spaces.after(box);else if(first)sheet.insertBefore(box,first);else sheet.append(box);
  box.querySelectorAll('[data-trade-filter]').forEach(b=>b.onclick=()=>{const id=b.dataset.tradeFilter;cycleLabelFilter('_trade',[id]);b.classList.toggle('on',(state.filters._trade||[]).includes(id));b.classList.toggle('excluded',excludedOn([id]));refreshFilterSheet()});
  refreshFilterSheet()};

/* --- Agrupar por oficio (features.js pinta los grupos con tradeGroupKeys y tradeName) --------------------------------- */
function tradeGroupKeys(t){return sortTrades(deepestTrades(t.trades))}
const groupToolbarBeforeTrades=groupToolbar;
groupToolbar=function(){const html=groupToolbarBeforeTrades();if(!tradesMode())return html;const on=(state.groupBy||'project')==='_trade',option=`<option value="_trade" ${on?'selected':''}>Oficio</option>`;
  return /<option value="_space"/.test(html)?html.replace(/(<option value="_space"[^>]*>[^<]*<\/option>)/,`$1${option}`):html.replace(/(<option value="state"[^>]*>[^<]*<\/option>)/,`$1${option}`)};

/* --- Selector: el de espacios del kit, con las filas de los oficios (mismo buscador por ruta y «Más usados») ---------- */
// Los textos de oficio van como opción (kit 0.39.0, `texts`): sin parches sobre lo que pinta el kit.
const TRADE_TEXTS={empty:'Ningún oficio coincide con «{q}».',search:'Buscar oficio…',feedback:{quick:'Oficio más usado',search:'Buscar oficio',remove:'Quitar oficio'}};
function tradePicker(options){return IkisaiKit.createSpacePicker({rows:tradeRows(),kinds:TRADE_KINDS,multiple:true,texts:TRADE_TEXTS,quick:mostUsedTrades(),...options})}

/* --- Ficha de tarea y de proyecto ----------------------------------------------------------------------------------- */
// Borrador del oficio mientras la ficha está abierta (sobrevive a reabrirla al elegir etiquetas) y lo que se guarda al pulsar «Guardar».
// Cada cambio avisa en el campo (`trades-change`): «Quién sabe hacerlo» (who-knows-ui.js) se vuelve a pintar debajo.
let tradeDraft=null,tradePending=null;
function mountTradeField(anchor,key,initial,label,feedbackId,hint){if(!anchor)return;const ids=tradeDraft&&tradeDraft.key===key?tradeDraft.ids:[...initial];tradeDraft={key,ids:[...ids]};
  const field=document.createElement('div');field.className='field tradefield ikisai-kit';
  const picker=tradePicker({label,value:ids,feedbackId,onChange:next=>{tradeDraft={key,ids:[...next]};field.dispatchEvent(new CustomEvent('trades-change',{detail:[...next]}))}});
  field.append(picker.element);if(!tradeRows().length)field.insertAdjacentHTML('beforeend','<p class="small muted">Los oficios de Central no se han podido leer todavía. Vuelve a abrir la ficha con conexión.</p>');
  if(hint)field.insertAdjacentHTML('beforeend',`<p class="small muted">${esc(hint)}</p>`);anchor.insertAdjacentElement('beforebegin',field);
  if(!canEdit())field.querySelectorAll('input,button').forEach(x=>x.disabled=true)}
function rememberTrades(button,pending){if(button&&canEdit())button.addEventListener('click',()=>{tradePending={...pending,ids:[...(tradeDraft?.ids||[])]};setTimeout(()=>{tradePending=null})},true)}
const taskEditorBeforeTrades=openTaskEditor;
openTaskEditor=function(id,selectedOverride=null,valsOverride=null){taskEditorBeforeTrades(id,selectedOverride,valsOverride);if(!tradesMode())return;
  const loc=id?taskLocation(id):null,initial=loc?(loc.t.trades||[]):(project()?.ownTrades||[]);
  mountTradeField(document.getElementById('editLabelsBtn')?.closest('.field'),'task:'+(id||'new'),initial,'Oficio','tasks.editor_tarea.oficio');
  rememberTrades(document.getElementById('saveTaskBtn'),{kind:'task',id:id||null})};
const projectEditorBeforeTrades=openProjectEditor;
openProjectEditor=function(id,selectedOverride=null,valsOverride=null){projectEditorBeforeTrades(id,selectedOverride,valsOverride);if(!tradesMode())return;
  const base=id?tab().projects.find(p=>p.id===id):null;
  mountTradeField(document.getElementById('editProjectLabels')?.closest('.field'),'project:'+(id||'new'),base?.ownTrades||[],'Oficio del proyecto','tasks.editor_proyecto.oficio','Las tareas nuevas del proyecto lo heredan.');
  rememberTrades(document.getElementById('saveProjectBtn'),{kind:'project',id:id||null})};
const closeSheetBeforeTrades=closeSheet;
closeSheet=function(e){closeSheetBeforeTrades(e);if(!document.getElementById('sheetBack').classList.contains('show'))tradeDraft=null};
function setTrades(x,field,ids){const next=[...new Set(ids)];if(JSON.stringify(x[field]||[])===JSON.stringify(next))return;x[field]=next;if(field==='trades')touch(x)}
/* Al guardar: lo elegido en la ficha y, en las tareas nuevas (las que aún no están en el último modelo), los oficios de su proyecto. */
function applyTrades(){const pending=tradePending;tradePending=null;if(!Sync.last)return;const known=new Set();
  for(const a of Sync.last)for(const p of a.projects||[]){known.add('p:'+p.id);for(const t of p.tasks||[])known.add(t.id)}
  for(const a of state.tabs)for(const p of a.projects||[]){
    if(pending?.kind==='project'&&(pending.id?p.id===pending.id:!known.has('p:'+p.id)))setTrades(p,'ownTrades',pending.ids);
    for(const t of p.tasks||[]){if(t.deleted)continue;
      if(pending?.kind==='task'&&pending.id===t.id)setTrades(t,'trades',pending.ids);
      else if(!known.has(t.id)){if(pending?.kind==='task'&&!pending.id)setTrades(t,'trades',pending.ids);else if(t.trades===undefined&&(p.ownTrades||[]).length)t.trades=[...p.ownTrades]}}}}
const saveBeforeTrades=save;
save=function(){if(tradesMode())try{applyTrades()}catch(e){console.error(e)}else tradePending=null;return saveBeforeTrades()};

/* --- Selección múltiple: «Oficio» se añade a lo que ya tengan (si es más concreto, sustituye al de encima) ------------- */
const batchBarBeforeTrades=batchBar;
batchBar=function(){const html=batchBarBeforeTrades();if(!html||!tradesMode())return html;const n=batchSelection.size;
  return html.replace(/<button[^>]*id="batchMove"/,m=>`<button type="button" class="softbtn" id="batchTrade" data-feedback-id="tasks.lote.oficio" data-feedback-label="Oficio" ${n?'':'disabled'}>${menuIcon('trade')}Oficio</button>`+m)};
const bindBatchBarBeforeTrades=bindBatchBar;
bindBatchBar=function(){bindBatchBarBeforeTrades();const b=document.querySelector('#batchBar #batchTrade');if(b)b.onclick=batchTradeSheet};
function batchTradeSheet(){const n=batchSelection.size;openSheet(`<h2 class="sheettitle">Oficio de ${n} ${n===1?'tarea':'tareas'}</h2><p class="subtitle">Se añade a lo que ya tengan.</p><div class="ikisai-kit" id="batchTradePicker"></div><div class="actions"><button class="primary" id="batchTradeDone" disabled data-feedback-id="tasks.lote.oficio.aplicar" data-feedback-label="Aplicar oficio">Aplicar</button></div>`);
  let picked=[];const done=document.getElementById('batchTradeDone');
  const picker=tradePicker({label:'Oficio',value:[],feedbackId:'tasks.lote.oficio',onChange:ids=>{picked=ids;done.disabled=!ids.length}});
  document.getElementById('batchTradePicker').append(picker.element);
  done.onclick=()=>{closeSheet();if(!picked.length)return;batchRun('Oficio añadido a %n tareas',id=>{const {t}=taskLocation(id);const next=deepestTrades([...(t.trades||[]),...picked]);if(JSON.stringify(next)!==JSON.stringify(t.trades||[])){t.trades=next;touch(t);record('edit',[id])}})}}

/* --- Menú: en «Trabajo», tras «Etiquetas» y lo de los espacios («Organización» se pinta oculto) ------------------------- */
function afterSpaces(groups,item){const work=groups.find(g=>g.id==='work')||groups[0];let at=work.items.findIndex(i=>i[0]==='labels');if(at<0)at=work.items.length-1;
  while(at+1<work.items.length&&['spaces','zonesToSpaces'].includes(work.items[at+1][0]))at+=1;work.items.splice(at+1,0,item);return groups}
function canMoveTrades(){return Sync.actor?.role==='owner'&&Sync.actor.scopes==='*'&&Sync.actor.kind!=='agent'&&!Sync.secondary}
function hasActionFamily(){for(const a of state.tabs||[])for(const f of a.families||[])if(!f.archived&&tradeNorm(f.name)==='tipo: accion')return true;return false}
const navigationGroupsBeforeTrades=navigationGroups;
navigationGroups=function(){const groups=navigationGroupsBeforeTrades();if(tradesMode())return afterSpaces(groups,['trades','Oficios','trade','view']);
  if(canMoveTrades()&&hasActionFamily())return afterSpaces(groups,['actionsToTrades','Pasar las acciones a oficios','trade','action']);return groups};
const topActionBeforeTrades=handleTopAction;
handleTopAction=function(action){if(action==='actionsToTrades'){closeNavigation();return actionsSheet()}return topActionBeforeTrades(action)};

/* --- Pantalla «Oficios»: el árbol de Central, de solo lectura (se gestionan en Central) -------------------------------- */
const CENTRAL_URL='https://central.ikisai.com';
function tradeTreeHtml(){const rows=tradeRows();if(!rows.length)return '<div class="empty">Los oficios de Central no se han podido leer todavía. Vuelve a probar con conexión.</div>';
  const uses=new Map();for(const a of state.tabs||[])for(const p of a.projects||[])if(!p.deleted)for(const t of p.tasks||[])if(!t.deleted)for(const id of t.trades||[])uses.set(id,(uses.get(id)||0)+1);
  const out=[],seen=new Set(),walk=(parent,depth)=>{for(const r of IkisaiKit.childrenOf(rows,parent,true)){if(seen.has(r.id))continue;seen.add(r.id);const n=uses.get(r.id)||0;
    out.push(`<li class="tradenode" style="padding-inline-start:${depth*18}px" data-trade="${esc(r.id)}"><span>${esc(r.name)}</span>${n?` <span class="muted small">· ${esc(plural(n,'tarea','tareas'))}</span>`:''}</li>`);walk(r.id,depth+1)}};
  walk(null,0);return `<ul class="tradetree" aria-label="Oficios">${out.join('')}</ul>`}
const mainBeforeTrades=main;
main=function(){if(state.view!=='trades')return mainBeforeTrades();if(!tradesMode()){state.view='projects';return mainBeforeTrades()}
  return `<main class="screen trades-screen"><div class="screenhead"><div><h1 class="title">Oficios</h1><p class="subtitle">Los oficios de la casa vienen de Central. Las tareas los usan como acción.</p></div></div>${tradeTreeHtml()}<div class="catalog-actions"><a class="softbtn" href="${CENTRAL_URL}" target="_blank" rel="noopener" data-feedback-id="tasks.oficios.gestionar" data-feedback-label="Gestionar en Central">Gestionar en Central</a>${canMoveTrades()?'<button class="ghost" id="tradesToActions" data-feedback-id="tasks.oficios.volver" data-feedback-label="Volver a las acciones">Volver a las acciones…</button>':''}</div></main>`};
const renderBeforeTrades=render;
render=function(){const result=renderBeforeTrades();if(tradesMode()&&!tradesAsked&&!Sync.secondary&&navigator.onLine)void askTrades();return result};
const bindBeforeTrades=bind;
bind=function(){bindBeforeTrades();const back=document.getElementById('tradesToActions');if(back)back.onclick=()=>tradesToActionsSheet()};

/* --- «Pasar las acciones a oficios» y «Volver a las acciones» (API.md §32) -------------------------------------------
   Solo la propietaria humana con acceso a todo. Primero la vista previa (`read/tasks.trades_preview`): qué oficio recibe cada
   acción, cuáles se quitan y cuáles faltan por resolver (bloquean hasta marcarlas «Quitar» o hasta que Central tenga su
   oficio). Luego el botón (`actions/to-trades`). La vuelta (`actions/to-labels`) está al pie de la pantalla «Oficios». */
const TRADE_REASON={no_trade:'sin oficio en Central',several_trades:'varios oficios dicen venir de ella',trade_inactive:'su oficio está archivado'};
function tradeError(e){if(e?.status===503||e?.details?.code==='CENTRAL_UNAVAILABLE')return 'No se ha podido leer Central: el catálogo de oficios no responde ahora. Vuelve a probar dentro de un rato.';return e?.details?.message||e?.message||'No se ha podido hacer.'}
function tradeNotice(title,html){openSheet(`<h2 class="sheettitle">${esc(title)}</h2>${html}<div class="actions"><button class="ghost" id="tradesClose" data-feedback-id="tasks.oficios.cerrar" data-feedback-label="Cerrar">Cerrar</button></div>`);document.getElementById('tradesClose').onclick=()=>closeSheet()}
async function actionsSheet(remove=[]){const title='Pasar las acciones a oficios';if(!canMoveTrades())return toast('Solo la propietaria con acceso a todo puede hacerlo.');if(pendingWork())return;
  openSheet(`<h2 class="sheettitle">${title}</h2><p>Preparando la vista previa…</p>`);
  let out;try{out=await api('read/tasks.trades_preview',{method:'POST',body:JSON.stringify({remove})})}catch(e){tradeNotice(title,`<p class="notice tradeerror">${esc(tradeError(e))}</p>`);return}
  if(out.source==='central'){closeSheet();toast('Las acciones ya son oficios.');return render()}
  if(out.centralEmpty)return tradeNotice(title,`<p class="notice tradeempty">Central no tiene oficios: impórtalos primero en <a href="${CENTRAL_URL}" target="_blank" rel="noopener" data-feedback-id="tasks.oficios.ir_a_central" data-feedback-label="Abrir Central">Central › Oficios</a>.</p>`);
  const c=out.counts||{},doubtful=out.doubtful||[],ready=!doubtful.length;
  openSheet(`<h2 class="sheettitle">${title}</h2>
    <p class="subtitle">Las acciones («Tipo: Acción») pasan a ser los oficios de Central, los mismos de las demás apps. Las chips dirán «Fontanería › ACS». Se puede deshacer desde «Oficios».</p>
    <div class="notice zonecounts">${esc(plural(c.tasks||0,'tarea','tareas'))} y ${esc(plural(c.projects||0,'proyecto','proyectos'))} recibirán su oficio · ${esc(plural(c.views||0,'vista guardada se adapta','vistas guardadas se adaptan'))} · ${c.withoutTrade?`<strong>${esc(plural(c.withoutTrade,'se queda','se quedan'))} sin oficio</strong>`:'nadie se queda sin oficio'}</div>
    ${doubtful.length?`<h3>Por resolver (${doubtful.length})</h3><p class="small muted">Márcala para quitarla, o crea su oficio en Central (con esta acción como origen) y vuelve a abrir la vista previa.</p><div class="zonelist">${doubtful.map(d=>`<label class="zoneitem doubtful"><input type="checkbox" data-trade-remove="${esc(d.labelId)}" data-feedback-id="tasks.oficios.quitar" data-feedback-label="Quitar acción"><span><strong>${esc(d.name)}</strong> · ${esc(TRADE_REASON[d.reason]||d.reason)} · ${esc(usesText(d))}${d.sample?.length?` <span class="muted">(${esc(d.sample.join(', '))})</span>`:''}</span><span class="zoneaction">Quitar</span></label>`).join('')}</div>`:''}
    ${(out.removed||[]).length?`<h3>Se quitan (${out.removed.length})</h3><div class="zonelist">${out.removed.map(r=>`<label class="zoneitem">${r.reason==='marked'?`<input type="checkbox" checked data-trade-remove="${esc(r.labelId)}" data-feedback-id="tasks.oficios.quitar" data-feedback-label="Quitar acción">`:''}<span><strong>${esc(r.name)}</strong> · ${esc(usesText(r))} · ${r.withoutTrade?esc(plural(r.withoutTrade,'se queda','se quedan'))+' sin oficio':r.reason==='covered'?'todas tienen otra acción con oficio':'nadie se queda sin oficio'}</span></label>`).join('')}</div>`:''}
    <h3>Cada acción y su oficio (${(out.mapped||[]).length})</h3><div class="zonelist">${(out.mapped||[]).map(m=>`<div class="zoneitem"><span><strong>${esc(m.name)}</strong> → ${esc(m.tradePath||tradeName(m.tradeId))} ${m.tasks||m.projects?`<span class="muted">· ${esc(usesText(m))}</span>`:''}</span></div>`).join('')||'<p class="small muted">Ninguna.</p>'}</div>
    <div class="actions"><button class="ghost" id="tradesCancel" data-feedback-id="tasks.oficios.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="primary" id="tradesApply" ${ready?'':'disabled'} data-feedback-id="tasks.oficios.aplicar" data-feedback-label="Pasar las acciones a oficios">Pasar las acciones a oficios</button></div>
    ${ready?'':'<p class="small muted">Resuelve antes las que faltan.</p>'}`);
  document.getElementById('tradesCancel').onclick=()=>closeSheet();
  document.querySelectorAll('[data-trade-remove]').forEach(b=>b.onchange=()=>actionsSheet([...document.querySelectorAll('[data-trade-remove]:checked')].map(x=>x.dataset.tradeRemove)));
  const apply=document.getElementById('tradesApply');apply.onclick=async()=>{if(pendingWork())return;apply.disabled=true;apply.textContent='Pasando…';
    try{const done=await api('actions/to-trades',{method:'POST',body:JSON.stringify({requestId:uid('req-'),remove})});closeSheet();const n=done.counts||{};
      toast(`Hecho: ${plural(n.taskTrades||0,'tarea','tareas')} y ${plural(n.projectTrades||0,'proyecto','proyectos')} con su oficio.`);await askTrades(true);await syncNow();render()}
    catch(e){toast(tradeError(e));actionsSheet(remove)}}}
async function tradesToActionsSheet(drop=false){const title='Volver a las acciones';if(!canMoveTrades())return;if(pendingWork())return;
  openSheet(`<h2 class="sheettitle">${title}</h2><p>Preparando…</p>`);
  let out;try{out=await api('read/tasks.trades_preview',{method:'POST',body:'{}'})}catch(e){tradeNotice(title,`<p class="notice tradeerror">${esc(tradeError(e))}</p>`);return}
  if(out.source!=='central'){closeSheet();return render()}
  const c=out.counts||{},lost=out.lost||[];
  openSheet(`<h2 class="sheettitle">${title}</h2>
    <p class="subtitle">Los oficios vuelven a ser etiquetas de «Tipo: Acción», con lo que tengan ahora ${esc(plural(c.tasks||0,'tarea','tareas'))} y ${esc(plural(c.projects||0,'proyecto','proyectos'))}. Los oficios siguen en Central para las demás apps.</p>
    ${lost.length?`<h3>Se perderían (${lost.length})</h3><p class="small muted">Estos oficios no vienen de ninguna acción: al volver, sus tareas y proyectos se quedan sin ellos.</p><div class="zonelist">${lost.map(l=>`<div class="zoneitem"><span><strong>${esc(l.tradePath||tradeName(l.tradeId))}</strong> · ${esc(usesText(l))}</span></div>`).join('')}</div><label class="zoneitem"><input type="checkbox" id="tradesDrop" ${drop?'checked':''} data-feedback-id="tasks.oficios.volver.perder" data-feedback-label="Aceptar perderlos"><span>Entendido: quitarlos</span></label>`:''}
    <div class="actions"><button class="ghost" id="tradesBackCancel" data-feedback-id="tasks.oficios.volver.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="danger" id="tradesBackApply" ${lost.length&&!drop?'disabled':''} data-feedback-id="tasks.oficios.volver.aplicar" data-feedback-label="Volver a las acciones">Volver a las acciones</button></div>`);
  document.getElementById('tradesBackCancel').onclick=()=>closeSheet();
  const check=document.getElementById('tradesDrop');if(check)check.onchange=()=>{document.getElementById('tradesBackApply').disabled=!check.checked};
  const apply=document.getElementById('tradesBackApply');apply.onclick=async()=>{if(pendingWork())return;apply.disabled=true;apply.textContent='Volviendo…';
    try{await api('actions/to-labels',{method:'POST',body:JSON.stringify({requestId:uid('req-'),dropUnmapped:!!check?.checked})});closeSheet();toast('Los oficios vuelven a ser acciones.');state.view='labels';await syncNow();render()}
    catch(e){toast(tradeError(e));tradesToActionsSheet(!!check?.checked)}}}
