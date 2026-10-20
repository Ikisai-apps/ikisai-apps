/* Oficios, Personas y Espacios rediseñados (MUELA-090, con el 073 y el 083; tanda 31, zona 4). Una capa encima de
   trades-ui.js, people-ui.js y spaces-ui.js, que no se borran: quitar este archivo devuelve las pantallas de hoy
   (tradeTreeHtml, peopleListHtml y el árbol).
   - Oficios y Personas: «Baldosas con cifra y relleno» (renderGroups + renderTile del kit), un grupo por oficio principal o
     por nivel de casa. Cada baldosa: tareas abiertas, relleno = hechas / total y «D de T hechas · V vencidas». El oficio
     cuenta también lo de dentro (expandTrades, como la faceta), también el de tercer nivel («ACS › Calderas»).
   - Tocar una baldosa abre «Tareas» filtrada (como «Mis tareas») con «‹ Volver a Oficios» (o Personas, Espacios) arriba
     mientras siga ese filtro. Volver quita el filtro.
   - Espacios: «Plano | Lista». El plano es createSpaceMap del kit, en modo «solo plano» (`plan`), de solo lectura (sin `onShape` ni
     «Colocar», que es de Central), con la capa «Tareas abiertas»; la lista es el árbol de hoy (createSpaceTree). Lo que
     tiene tareas y no sale en ningún dibujo va debajo, en filas. Kit 0.55: `mode:'plan'`, `layout:'all'` y `short` en la capa. Tocar una estancia o una fila abre su hoja.
   - Todo se cuenta con lo que esta cuenta ya tiene en el dispositivo (state.tabs): ninguna lectura del servidor que sume
     tareas que no ve. Nada de grados de habilidad ni de disponibilidad. La persona de fuera no llega a estas pantallas
     (OUTSIDER_VIEWS de proposals-ui.js, que va dentro de esta capa).
   Va la última (detrás de etiquetas-ui.js): envuelve `main` y `render` por fuera de las demás capas.
   Prefijo de clases y de nombres: `tko-`. */
const TKO_VIEW_KEY='ikisai-tasks-spaces-view';
const TKO_FROM={trades:'Oficios',people:'Personas',spaces:'Espacios'};
/* Lo que esta cuenta ve en el dispositivo: tareas sin borrar de proyectos sin borrar ni archivar, de todas sus áreas. */
function tkoRows(){const out=[];for(const a of state.tabs||[])for(const p of a.projects||[]){if(p.deleted||p.status==='archived')continue;for(const t of p.tasks||[])if(!t.deleted)out.push({a,p,t})}return out}
function tkoOverdue(t){return !t.done&&!!t.due&&homeDayOf(t.due)<0}
function tkoStats(rows,match){const s={total:0,done:0,open:0,overdue:0};for(const r of rows){if(!match(r.t))continue;s.total+=1;if(r.t.done)s.done+=1;else{s.open+=1;if(tkoOverdue(r.t))s.overdue+=1}}return s}
const tkoN=(n,one,many)=>`${n} ${n===1?one:many}`;
function tkoLevelText(s){return s.total?`${s.done} de ${s.total} hechas · ${tkoN(s.overdue,'vencida','vencidas')}`:'Sin tareas'}
/* La frase de la capa (lista y lector de pantalla): «2 tareas abiertas, 1 vencida». En el dibujo, solo la cifra (`short`). */
function tkoLongText(s){return `${tkoN(s.open,'tarea abierta','tareas abiertas')}${s.overdue?`, ${tkoN(s.overdue,'vencida','vencidas')}`:''}`}
function tkoOpenText(s){return `${tkoN(s.open,'abierta','abiertas')}${s.overdue?` · ${tkoN(s.overdue,'vencida','vencidas')}`:''}`}
function tkoTile(item){const s=item.stats;
  const tile=IkisaiKit.renderTile({title:item.title,value:s.open,levelText:tkoLevelText(s),level:{pct:s.total?Math.round(s.done/s.total*100):0,tone:s.overdue?'alert':s.total&&!s.open?'ok':null},medal:item.medal||null,onClick:()=>{},feedbackId:item.feedbackId});
  // La cifra grande dice qué es (también para el lector de pantalla).
  tile.querySelector('.tile-value')?.append(IkisaiKit.el('span',{class:'vh'},` ${s.open===1?'abierta':'abiertas'}`));
  Object.assign(tile.dataset,item.data);return tile}
function tkoGroupsHtml(groups,label,feedbackId){const view=IkisaiKit.renderGroups({label,groups,toneOf:item=>item.stats.overdue?'alert':null,row:tkoTile,feedbackId});
  view.element.classList.add('tko-groups');return `<div class="ikisai-kit tko-wrap">${view.element.outerHTML}</div>`}

/* --- Oficios: un grupo por oficio principal; dentro, «Fontanería · todo» y cada oficio de dentro (también el nieto) ---- */
function tkoTradeGroups(){const rows=tradeRows(),tasks=tkoRows(),color=actionColor(),seen=new Set();
  const statsOf=id=>{const set=expandTrades([id]);return tkoStats(tasks,t=>(t.trades||[]).some(x=>set.has(x)))};
  const roots=IkisaiKit.childrenOf(rows,null,true).filter(r=>!seen.has(r.id)&&seen.add(r.id));
  return roots.map(root=>{const inside=[],walk=(parent,trail)=>{for(const r of IkisaiKit.childrenOf(rows,parent,true)){if(seen.has(r.id))continue;seen.add(r.id);const path=[...trail,r.name];inside.push({r,title:path.join(' › ')});walk(r.id,path)}};walk(root.id,[]);
    const all=statsOf(root.id),tile=(id,title,stats)=>({title,stats,data:{tkoTrade:id},feedbackId:'tasks.oficios.baldosa'});
    return {key:root.id,title:root.name,medal:{name:root.name,color},open:true,feedbackId:'tasks.oficios.grupo',
      summary:`${tkoN(all.open,'abierta','abiertas')} · ${tkoN(all.overdue,'vencida','vencidas')}`,
      items:[tile(root.id,inside.length?`${root.name} · todo`:root.name,all),...inside.map(x=>tile(x.r.id,x.title,statsOf(x.r.id)))]}})}
const tradeTreeHtmlBeforeTko=tradeTreeHtml;
tradeTreeHtml=function(){if(!tradeRows().length)return tradeTreeHtmlBeforeTko();return tkoGroupsHtml(tkoTradeGroups(),'Oficios','tasks.oficios.grupos')};

/* --- Personas: un grupo por nivel (y «Sin nivel de casa» si hay alguien); dentro, el grupo del nivel y cada persona -------- */
function tkoPeopleGroups(){const {sorted}=peopleIndex(),tasks=tkoRows(),color=personColor();
  const statsOf=keys=>{const set=new Set(keys);return tkoStats(tasks,t=>(t.people||[]).some(k=>set.has(k)))};
  return [...PERSON_LEVELS.map(l=>l[0]),null].map(level=>{const mine=sorted.filter(p=>(p.house_level||null)===level);if(!mine.length&&level===null)return null;
    const all=statsOf(level?[...expandPeople(['level:'+level])]:mine.map(p=>p.person_id));
    const items=[...(level?[{title:levelGroupName(level),stats:statsOf(['level:'+level]),medal:{initials:'',icon:'people',color},data:{tkoPerson:'level:'+level},feedbackId:'tasks.personas.baldosa_grupo'}]:[]),
      ...mine.map(p=>({title:p.name,stats:statsOf([p.person_id]),medal:{name:p.name,initials:p.initials||null,color},data:{tkoPerson:p.person_id},feedbackId:'tasks.personas.baldosa'}))];
    return {key:level||'none',title:level?levelName(level):'Sin nivel de casa',medal:{name:level?levelName(level):'Sin nivel'},open:true,feedbackId:'tasks.personas.grupo',
      summary:`${mine.length?tkoN(mine.length,'persona','personas'):'Nadie con este nivel'} · ${tkoN(all.open,'abierta','abiertas')} · ${tkoN(all.overdue,'vencida','vencidas')}`,items}}).filter(Boolean)}
const peopleListHtmlBeforeTko=peopleListHtml;
peopleListHtml=function(){if(!peopleIndex().sorted.length)return peopleListHtmlBeforeTko();return tkoGroupsHtml(tkoPeopleGroups(),'Personas por nivel','tasks.personas.grupos')};

/* --- Tocar: «Tareas» filtrada, con la vuelta a la pantalla de origen mientras siga ese filtro --------------------------- */
let tkoBack=null;
function tkoOpenTasks(filters,from){state.taskScope='all';state.view='tasks';state.currentProject=null;state.search='';state.groupBy='project';state.filters=filters;
  tkoBack={view:from,filters:JSON.stringify(filters)};persistUI();render();window.scrollTo?.(0,0)}
function tkoGoBack(){const view=tkoBack?.view;tkoBack=null;if(!view)return;state.view=view;state.currentProject=null;state.search='';state.filters={};persistUI();render();window.scrollTo?.(0,0)}
function tkoBackStillValid(){return !!tkoBack&&state.view==='tasks'&&!state.search&&JSON.stringify(state.filters||{})===tkoBack.filters&&!(typeof outsiderMode==='function'&&outsiderMode())}

/* --- Espacios: «Plano | Lista», el plano del kit con la capa «Tareas abiertas» y las filas de lo que no tiene dibujo ---- */
let tkoPlans=[],tkoPlansWatch=null,tkoPlansSeen='',tkoMap=null,tkoSpaceCache=null,tkoKinds=null;
function tkoPlaced(s){return !!s&&!!s.planId&&IkisaiKit.validShape(s.planShape)&&tkoPlans.some(p=>p.id===s.planId)}
/* Dibujos con alguna estancia colocada (los que la pieza enseña). */
function tkoUsefulPlans(){const rows=spaceRows();return tkoPlans.filter(p=>rows.some(s=>s.active&&s.planId===p.id&&IkisaiKit.validShape(s.planShape)))}
function tkoPlansKey(){return tkoUsefulPlans().map(p=>p.id).join(',')}
function tkoWatchPlans(){const src=spacesSource();if(!src||tkoPlansWatch)return;
  const take=next=>{tkoPlans=next||[];const key=tkoPlansKey();if(key!==tkoPlansSeen){tkoPlansSeen=key;if(state.view==='spaces')render()}};
  tkoPlansWatch=src.plans.subscribe?.(take)||(()=>{});void Promise.resolve(src.plans.list()).then(take,()=>{});
  if(!tkoKinds&&src.listKinds)void src.listKinds().then(k=>{tkoKinds=k},()=>{})}
/* «Plano» por defecto si algún edificio tiene dibujo; lo elegido se recuerda en el dispositivo. Sin dibujos, null (la lista). */
function tkoSpacesView(){if(!tkoUsefulPlans().length)return null;let v=null;try{v=localStorage.getItem(TKO_VIEW_KEY)}catch(e){}return v==='list'?'list':'plan'}
function tkoSetSpacesView(v){try{localStorage.setItem(TKO_VIEW_KEY,v)}catch(e){}render();document.querySelector(`[data-tko-view="${v}"]`)?.focus()}
/* Cada espacio cuenta lo suyo y lo de dentro (como expandSpaces y la faceta): la tarea suma en su espacio y en los de encima. */
function tkoSpaceStats(){if(tkoSpaceCache)return tkoSpaceCache;spaceRows();const out=new Map();
  for(const r of tkoRows()){const ids=new Set();for(const id of r.t.spaces||[]){if(!spaceById(id))continue;ids.add(id);for(const a of IkisaiKit.ancestorsOf(spaceCache.byId,id))ids.add(a.id)}
    for(const id of ids){let s=out.get(id);if(!s){s={total:0,done:0,open:0,overdue:0,tasks:[]};out.set(id,s)}s.total+=1;if(r.t.done)s.done+=1;else{s.open+=1;if(tkoOverdue(r.t))s.overdue+=1;s.tasks.push(r)}}}
  return tkoSpaceCache=out}
function tkoLayer(space){const s=tkoSpaceStats().get(space.id);if(!s||!s.open)return null;return {tone:s.overdue?'alert':'accent',short:String(s.open),label:tkoLongText(s)}}
function tkoMapFor(){const source=spacesSource();if(!source)return null;
  // Solo lectura: sin onShape ni «Colocar» (es de Central). El dibujo se baja con la sesión de Recursos, como en Central.
  // Kit 0.55: solo el plano (la lista es el árbol de Tasks) y todos los dibujos a la vez, dos por fila en el ordenador.
  if(!tkoMap)tkoMap=IkisaiKit.createSpaceMap({source,plans:source.plans,mode:'plan',layout:'all',label:'Plano de los espacios',feedbackId:'tasks.espacios.plano',
    planUrl:fileId=>Sync.core.resources.fileUrl(fileId),layer:tkoLayer,onPick:space=>tkoSpaceSheet(space.id)});
  return tkoMap}
/* Lo que tiene tareas abiertas y no sale en ningún dibujo (ni él ni lo que lo contiene), en el orden del árbol. */
function tkoOffPlan(){const stats=tkoSpaceStats(),direct=new Set(),rows=spaceRows(),out=[];
  for(const r of tkoRows())if(!r.t.done)for(const id of r.t.spaces||[])if(spaceById(id))direct.add(id);
  const onPlan=id=>tkoPlaced(spaceById(id))||IkisaiKit.ancestorsOf(spaceCache.byId,id).some(a=>tkoPlaced(a));
  const walk=parent=>{for(const r of IkisaiKit.childrenOf(rows,parent,true)){if(direct.has(r.id)&&!onPlan(r.id)&&stats.get(r.id)?.open)out.push(r);walk(r.id)}};walk(null);
  return out}
function tkoOffPlanHtml(){const items=tkoOffPlan();if(!items.length)return '';const stats=tkoSpaceStats();
  return `<section class="tko-offplan" aria-labelledby="tkoOffPlanTitle"><h2 class="sectionlabel" id="tkoOffPlanTitle">Sin dibujo en el plano</h2><ul class="tko-offlist">${items.map(r=>{const s=stats.get(r.id),up=r.parentId?IkisaiKit.spacePath(spaceCache.byId,r.parentId):'';
    return `<li><button type="button" class="tko-offrow${s.overdue?' tko-alert':''}" data-tko-space="${esc(r.id)}" aria-label="${esc(`${r.name}: ${tkoLongText(s)}${up?` · ${up}`:''}`)}" data-feedback-id="tasks.espacios.sin_dibujo" data-feedback-label="Espacio sin dibujo"><span class="tko-offmain"><strong>${esc(r.name)}</strong>${up?`<span class="tko-offpath">${esc(up)}</span>`:''}</span><span class="tko-offstate">${esc(tkoOpenText(s))}</span></button></li>`}).join('')}</ul></section>`}
function tkoPlanHtml(view){
  const toggle=`<div class="ikisai-kit tko-viewswitch"><div class="segmented" role="group" aria-label="Ver los espacios como">${[['plan','Plano'],['list','Lista']].map(([v,t])=>`<button type="button" class="${view===v?'on':''}" aria-pressed="${view===v}" data-tko-view="${v}" data-feedback-id="tasks.espacios.vista" data-feedback-label="Plano o lista">${t}</button>`).join('')}</div></div>`;
  const legend=`<p class="tko-legend" id="tkoLegend"><span class="tko-key" aria-hidden="true"></span>Capa: <strong>tareas abiertas</strong> de cada estancia, con lo de dentro. <span class="tko-key tko-key-alert" aria-hidden="true"></span>En rojo, si alguna está vencida.</p>`;
  return `${toggle}<section class="tko-plan" id="tkoPlan"${view==='plan'?'':' hidden'}>${legend}<div class="ikisai-kit tko-map" id="tkoSpacesMap"></div>${tkoOffPlanHtml()}</section>`}
/* La hoja de una estancia o una fila: nombre, ruta y tipo; sus tareas abiertas (también lo de dentro) y «Ver en Tareas». */
function tkoSpaceSheet(id){const s=spaceById(id);if(!s)return;const st=tkoSpaceStats().get(id)||{open:0,overdue:0,tasks:[]};
  const kind=IkisaiKit.kindLabel(tkoKinds||IkisaiKit.DEFAULT_SPACE_KINDS,s.kind),path=spaceShort(id);
  const items=st.tasks.map(({a,p,t})=>`<li><button type="button" class="tko-sheettask${tkoOverdue(t)?' tko-alert':''}" data-tko-task="${esc(t.id)}" data-tko-area="${esc(a.id)}" data-feedback-id="tasks.espacios.hoja.tarea" data-feedback-label="Abrir la tarea"><strong>${esc(t.text)}</strong><span class="tko-sheetwhere">${esc([p.title,(t.spaces||[]).filter(x=>x!==id&&spaceById(x)).map(spaceShort).join(', '),tkoOverdue(t)?'vencida':''].filter(Boolean).join(' · '))}</span></button></li>`).join('');
  openSheet(`<h2 class="sheettitle">${esc(s.name)}</h2><p class="subtitle">${esc([path!==s.name?path:'',kind].filter(Boolean).join(' · '))}</p>
    <h3>Tareas abiertas (${st.open})</h3>${items?`<ul class="tko-sheetlist">${items}</ul>`:'<p class="small muted">No hay tareas abiertas aquí ni dentro.</p>'}
    <div class="actions"><button class="ghost" id="tkoSpaceClose" data-feedback-id="tasks.espacios.hoja.cerrar" data-feedback-label="Cerrar">Cerrar</button><button class="primary" id="tkoSpaceTasks" data-feedback-id="tasks.espacios.hoja.ver_tareas" data-feedback-label="Ver en Tareas">Ver en Tareas (${st.open})</button></div>`);
  document.getElementById('tkoSpaceClose').onclick=()=>closeSheet();
  document.getElementById('tkoSpaceTasks').onclick=()=>{closeSheet();tkoOpenTasks({_space:[id]},'spaces')};
  document.querySelectorAll('#sheet [data-tko-task]').forEach(b=>b.onclick=()=>openHomeTask(b.dataset.tkoTask,b.dataset.tkoArea))}

/* --- Pintar: por fuera de las demás capas (la de la persona de fuera ya ha cambiado de vista si no le toca) ------------- */
const mainBeforeTko=main;
main=function(){tkoSpaceCache=null;let html=mainBeforeTko();
  if(tkoBack&&!tkoBackStillValid())tkoBack=null;
  if(tkoBack)html=html.replace(/<main\b[^>]*>/,m=>`${m}<div class="ikisai-kit tko-back"><a class="return-link" href="#" id="tkoBack" data-feedback-id="tasks.tareas.volver_origen" data-feedback-label="Volver a la pantalla de origen">‹ Volver a ${esc(TKO_FROM[tkoBack.view]||'la pantalla anterior')}</a></div>`);
  // «Gestionar en Central» lleva la vuelta (Central enseña «‹ Volver a Tasks»).
  const central=(feedback,hash)=>{html=html.replace(new RegExp(`href="${CENTRAL_URL.replace(/\./g,'\\.')}"(?=[^>]*data-feedback-id="${feedback.replace(/\./g,'\\.')}")`),()=>`href="${esc(IkisaiKit.withReturnTo(CENTRAL_URL+hash,{from:'tasks',url:location.href,title:'Tasks'}))}"`)};
  if(state.view==='trades')central('tasks.oficios.gestionar','/#/personas/oficios');
  if(state.view==='people')central('tasks.personas.gestionar','/#/personas');
  if(state.view==='spaces'&&html.includes('<div class="ikisai-kit" id="spacesTree"></div>')){tkoWatchPlans();const view=tkoSpacesView();
    if(view)html=html.replace('<div class="ikisai-kit" id="spacesTree"></div>',`${tkoPlanHtml(view)}<div class="ikisai-kit" id="spacesTree"${view==='plan'?' hidden':''}></div>`)}
  return html};
const renderBeforeTko=render;
render=function(...args){const out=renderBeforeTko(...args);const host=document.getElementById('tkoSpacesMap');
  if(host){const map=tkoMapFor();if(map){host.append(map.element);map.repaint()}}
  return out};
document.addEventListener('click',e=>{const t=e.target;if(!t?.closest)return;
  if(t.closest('#tkoBack')){e.preventDefault();return tkoGoBack()}
  const view=t.closest('[data-tko-view]');if(view&&state.view==='spaces')return tkoSetSpacesView(view.dataset.tkoView);
  const trade=t.closest('[data-tko-trade]');if(trade&&state.view==='trades'){usage.track('tasks.oficios.baldosa');return tkoOpenTasks({_trade:[trade.dataset.tkoTrade]},'trades')}
  const person=t.closest('[data-tko-person]');if(person&&state.view==='people'){usage.track('tasks.personas.baldosa');return tkoOpenTasks({_person:[person.dataset.tkoPerson]},'people')}
  const space=t.closest('[data-tko-space]');if(space&&state.view==='spaces')return tkoSpaceSheet(space.dataset.tkoSpace)});
