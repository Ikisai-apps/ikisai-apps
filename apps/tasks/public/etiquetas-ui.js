/* «Etiquetas» en fichas con su uso (MUELA-061, con el 073; tanda 31, zona 3). Cada familia es un grupo (renderGroups del kit)
   con una baldosa por etiqueta (renderTile): la cifra de tareas abiertas, el relleno de su color según el uso dentro de la
   familia y el nombre («0 · sin uso» si no tiene). Las personas llevan su medallón y en cada etiqueta salen quienes tienen
   tareas abiertas con ella (hasta 3 y «+N»). Tocar abre «Tareas» filtradas por esa etiqueta o persona.
   - «Editar el catálogo» (quien puede) lleva al catálogo de siempre (general-ui.js y navigation-ui.js), con todos sus
     mandos: General frente a «solo de esta área», «Hacer General», «Repetidas → General», los avisos de nombre, «Ver
     archivadas», las hijas «↳» y «+ Nueva familia». Quien solo lee lo consulta con «Ver el catálogo completo».
   - La vista General, igual: lo General una vez y un bloque por área.
   - Hallazgo 9: con los oficios o las personas en Central (tradesMode / peopleMode), las familias de etiquetas Oficio y
     Persona no se pintan aquí como fichas (salían a cero). No se archivan ni se borran: siguen en el catálogo, con sus
     referencias. Las personas de Central salen como fichas, contadas por responsable y Personas de cada tarea.
   Prefijo de clases: `tke-`. */
let tkeCatalog=false;
const tkeNorm=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase();
function tkeTradeFamily(f){return f.system==='trade'||['tipo: accion','oficio','oficios'].includes(tkeNorm(f.name))}
function tkePersonFamily(f){return f.system==='person'||['persona','personas','grupo: persona'].includes(tkeNorm(f.name))}
function tkeHiddenFamily(f){return (typeof tradesMode==='function'&&tradesMode()&&tkeTradeFamily(f))||(typeof peopleMode==='function'&&peopleMode()&&tkePersonFamily(f))}
function tkeTasks(areas){return areas.flatMap(a=>withArea(a.id,()=>tab().projects.filter(p=>!p.deleted).flatMap(p=>p.tasks.filter(t=>!t.deleted))))}
/* Quién tiene tareas abiertas con una etiqueta: personas de Central (responsable y Personas) y, si siguen en etiquetas, la
   etiqueta responsable y las de la familia Persona. Claves que fichaPersonName sabe nombrar. */
function tkePeopleOn(tasks,labelId){const keys=[];
  for(const t of tasks){if(t.done||!(t.labels||[]).includes(labelId)&&t.owner!==labelId)continue;
    keys.push(t.ownerPerson,...(t.people||[]),...(typeof fichaLegacyPeople==='function'?fichaLegacyPeople([t.owner,...(t.labels||[])].filter(Boolean)):[]))}
  return [...new Set(keys.filter(k=>k&&k!==labelId&&typeof fichaPersonName==='function'&&fichaPersonName(k)))].map(k=>({name:fichaPersonName(k),face:typeof fichaFace==='function'?fichaFace(k,null):{name:fichaPersonName(k)}}))}
function tkeLevel(n){return n?(n===1?'1 tarea abierta':`${n} tareas abiertas`):'0 · sin uso'}
function tkeTile({title,n,max,color,medal,people,data,feedbackId}){const K=IkisaiKit;
  const tile=K.renderTile({title,value:n,levelText:tkeLevel(n),level:{pct:max?Math.round(n/max*100):0,tone:null},medal:medal||null,onClick:()=>{},feedbackId});
  Object.assign(tile.dataset,data);if(color)tile.style.setProperty('--tke-color',color);
  if(people?.length){const shown=people.slice(0,3),names=shown.map(x=>x.name),more=people.length-shown.length;
    const faces=K.el('span',{class:'tke-faces','aria-hidden':'true'},...shown.map(x=>K.renderMedal({...x.face,size:24})),more?K.el('span',{class:'tke-more'},`+${more}`):null);
    tile.append(faces,K.el('span',{class:'vh'},` · con ${names.join(', ')}${more?` y ${more} más`:''}`))}
  return tile}
/* Las familias de un área (o solo lo General, o solo lo propio del área) como grupos de fichas. */
function tkeFamilyGroups(area,only,tasks){return withArea(area.id,()=>{const scope=tab(),usage=labelUsage(tasks);
  return catalogFamilies().filter(f=>!f.archived&&!tkeHiddenFamily(f)&&(only==='general'?f.general:true)).map(f=>{const ids=catalogFamilyIds(f);
    const ls=catalogOrder(scope.labels.filter(l=>ids.includes(l.family)&&!l.archived&&(only==='general'?l.general:only==='area'?!l.general:true)));
    if(!ls.length)return null;const max=Math.max(0,...ls.map(l=>usage.get(l.id)||0)),person=tkePersonFamily(f),open=ls.reduce((s,l)=>s+(usage.get(l.id)||0),0);
    return {key:`${area.id}:${f.id}`,title:f.name,medal:{color:f.color,name:f.name},open:true,feedbackId:'tasks.etiquetas.familia',
      summary:`${ls.length===1?'1 etiqueta':`${ls.length} etiquetas`} · ${tkeLevel(open).replace('0 · sin uso','sin tareas abiertas')}`,
      items:ls.map(l=>({title:`${l.parent&&ls.some(x=>x.id===l.parent)?'↳ ':''}${l.text}`,n:usage.get(l.id)||0,max,color:f.color,medal:person?{name:l.text,color:f.color}:null,
        people:person?[]:tkePeopleOn(tasks,l.id),data:{tkeLabel:l.id,tkeFamily:f.id,tkeArea:area.id},feedbackId:'tasks.etiquetas.ficha'}))}}).filter(Boolean)})}
/* Personas de Central como fichas (peopleMode): las que tienen tareas abiertas, por responsable y Personas. */
function tkePeopleGroup(area,tasks){if(typeof peopleMode!=='function'||!peopleMode())return null;const usage=personUsage(tasks);
  const keys=[...usage.keys()].filter(k=>typeof fichaPersonName==='function'&&fichaPersonName(k)).sort((a,b)=>usage.get(b)-usage.get(a)||fichaPersonName(a).localeCompare(fichaPersonName(b),'es'));
  if(!keys.length)return null;const max=Math.max(...keys.map(k=>usage.get(k)));
  return {key:`${area?.id||'all'}:personas`,title:'Personas',medal:{name:'Personas'},open:true,feedbackId:'tasks.etiquetas.familia',summary:`${keys.length===1?'1 persona':`${keys.length} personas`} con tareas abiertas · de Central`,
    items:keys.map(k=>({title:fichaPersonName(k),n:usage.get(k),max,color:typeof personColor==='function'?personColor():null,medal:typeof fichaFace==='function'?fichaFace(k,area):{name:fichaPersonName(k)},data:{tkePerson:k,tkeArea:area?.id||''},feedbackId:'tasks.etiquetas.ficha_persona'}))}}
function tkeGroupsHtml(groups,label){if(!groups.length)return '';const view=IkisaiKit.renderGroups({label,groups,row:item=>tkeTile(item),feedbackId:'tasks.etiquetas.familias'});view.element.classList.add('tke-groups');return `<div class="ikisai-kit tke-wrap">${tkcHtml(view.element)}</div>`}
function tkeHiddenNote(){const t=typeof tradesMode==='function'&&tradesMode(),p=typeof peopleMode==='function'&&peopleMode();if(!t&&!p)return '';
  return `<p class="small muted tke-central" id="tkeCentralNote">${t&&p?'Los oficios y las personas':t?'Los oficios':'Las personas'} vienen de Central. Sus antiguas familias de etiquetas no salen aquí; siguen en el catálogo, sin perder nada.</p>`}
function tkeCatalogButton(){const edit=canManageCatalog()||isAdministrator();
  return `<button class="softbtn" id="labelsCatalog" type="button" data-feedback-id="tasks.etiquetas.editar_catalogo" data-feedback-label="${edit?'Editar el catálogo':'Ver el catálogo completo'}">${edit?'Editar el catálogo':'Ver el catálogo completo'}</button>`}
function tkeAreaView(){const area=tab(),tasks=tkeTasks([area]),groups=tkeFamilyGroups(area,null,tasks),people=tkePeopleGroup(area,tasks);if(people)groups.push(people);
  return `<main class="screen tke-screen"><div class="screenhead"><div><h1 class="title">Etiquetas</h1><p class="subtitle">Cuántas tareas abiertas lleva cada una en ${esc(area.name)}. Toca una para ver sus tareas.</p></div>${tkeCatalogButton()}</div>${tkeHiddenNote()}
    ${tkeGroupsHtml(groups,'Etiquetas por familia')||'<div class="empty">Todavía no hay etiquetas en esta área.</div>'}</main>`}
function tkeGeneralView(){const areas=generalAreas(),tasks=tkeTasks(areas),first=areas[0];
  const general=first?tkeFamilyGroups(first,'general',tasks):[],people=tkePeopleGroup(null,tasks);if(people)general.push(people);
  const blocks=areas.map(a=>{const own=tkeTasks([a]),groups=withArea(a.id,()=>tkeFamilyGroups(a,'area',own));return groups.length?areaBlock(a,tkeGroupsHtml(groups,`Etiquetas de ${a.name}`),null,false):''}).join('');
  return `<main class="screen tke-screen"><div class="screenhead"><div><h1 class="title">Etiquetas</h1><p class="subtitle">General · lo común y lo de cada área. Toca una para ver sus tareas.</p></div>${tkeCatalogButton()}</div>${tkeHiddenNote()}
    <section class="areablock" id="tkeGeneral"><h2 class="sectionlabel areatitle"><span>General · en todas las áreas</span></h2>${tkeGroupsHtml(general,'Etiquetas General')||'<p class="small muted">Aún no hay etiquetas General.</p>'}</section>${blocks}</main>`}
/* El catálogo de siempre, con la vuelta a las fichas arriba. */
function tkeCatalogWrap(html){const tpl=document.createElement('template');tpl.innerHTML=html;const head=tpl.content.querySelector('main > .screenhead');
  const back=`<button class="softbtn" id="labelsTiles" type="button" data-feedback-id="tasks.etiquetas.ver_fichas" data-feedback-label="Volver a las fichas">‹ Volver a las fichas</button>`;
  if(head)head.insertAdjacentHTML('beforeend',back);else tpl.content.querySelector('main')?.insertAdjacentHTML('afterbegin',back);
  return tpl.innerHTML}
const labelsViewBeforeFichas=labelsView;
labelsView=function(){return tkeCatalog?tkeCatalogWrap(labelsViewBeforeFichas()):tkeAreaView()};
const generalLabelsViewBeforeFichas=generalLabelsView;
generalLabelsView=function(){return tkeCatalog?tkeCatalogWrap(generalLabelsViewBeforeFichas()):tkeGeneralView()};
const mainBeforeFichasEtiquetas=main;
main=function(){if(state.view!=='labels')tkeCatalog=false;return mainBeforeFichasEtiquetas()};
/* Tocar una ficha: «Tareas» filtradas por esa etiqueta (en su familia) o por esa persona. */
function tkeOpenTasks(filters,area){if(area&&!(typeof generalMode==='function'&&generalMode())&&state.tabs.some(t=>t.id===area))state.activeTab=area;
  state.view='tasks';state.currentProject=null;state.search='';state.filters=filters;persistUI();render();window.scrollTo?.(0,0)}
document.addEventListener('click',e=>{const t=e.target;if(!t.closest)return;
  if(t.closest('#labelsCatalog')){tkeCatalog=true;render();return}
  if(t.closest('#labelsTiles')){tkeCatalog=false;render();return}
  const tile=t.closest('[data-tke-label],[data-tke-person]');if(!tile||state.view!=='labels')return;
  if(tile.dataset.tkePerson){usage.track('tasks.etiquetas.ficha_persona');return tkeOpenTasks({_person:[tile.dataset.tkePerson]},tile.dataset.tkeArea)}
  usage.track('tasks.etiquetas.ficha');tkeOpenTasks({[tile.dataset.tkeFamily]:[tile.dataset.tkeLabel]},tile.dataset.tkeArea)});
