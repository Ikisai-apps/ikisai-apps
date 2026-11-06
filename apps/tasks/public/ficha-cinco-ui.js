/* Ficha de la tarea · cinco apartados que se editan en su sitio (VG, 06-11-2026; borrador aprobado en
   MUELA/equipo/feedback/tasks/BORRADOR_FICHA.html). En la portada, antes de las baldosas, y solo en tareas que existen:
   1. Quién: medallones (las iniciales; Central no da foto) de la persona responsable y las demás; al tocar se despliega la
      casa por nivel y se elige una o varias. La primera elegida es la responsable. Por defecto, quien crea (people-ui.js).
   2. Fase: el segmento de fases-ui.js (la actual premarcada, las de antes en gris y elegibles), con el lápiz que abre
      «Etiquetas › Fases» (nombre, orden y la actual; sin fechas).
   3. Espacio: createPlacePicker del kit en modo dos planos (`layout: 'stacked'`): el plano del edificio arriba y la estancia
      con su retícula de 1 m² debajo; la ruta, con picker.path() (o el árbol, si el kit aún no lo trae).
   4. Oficio: createTradePicker del kit, en árbol (oficio entero o especialidad), desplegado en su tarjeta.
   5. Etiquetas: solo las libres (ni personas, ni oficios, ni espacios, ni fases), pequeñas; se añaden escribiendo y se
      quitan con ×.
   Cada cambio vale al momento (como la «Fase»). Las baldosas «Quién» y «Etiquetas» (la página con todos los campos) se
   esconden: sus campos siguen en la hoja y sus borradores se ponen al día, así «Guardar» no deshace lo cambiado aquí.
   Prefijo de clases: `tk5-`. */
const TK5_SYSTEM_NAMES=new Set(['persona','personas','grupo: persona','tipo: accion','oficio','oficios','zona: espacio','fase','etapa','edificio','espacio']);
const tk5Norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').trim();
let tk5Open=null; // el apartado desplegado ('who' | 'space' | 'trade'), mientras la ficha siga abierta
function tk5Loc(id){return typeof taskLocation==='function'?taskLocation(id):null}
function tk5Can(){return canEdit()&&Sync.actor?.role!=='outsider'}
function tk5Save(id,message){const loc=tk5Loc(id);if(!loc)return;touch(loc.t);record('edit',[id]);tk5Drafts(id);if(save()===false)return;render();if(message)toast(message)}
/* Los borradores de los campos de siempre (escondidos en la hoja), al día con el modelo. */
function tk5Drafts(id){const loc=tk5Loc(id);if(!loc)return;const t=loc.t,key='task:'+id;
  try{if(typeof spaceDraft!=='undefined')spaceDraft={key,ids:[...(t.spaces||[])],cells:t.spaceCells?{...t.spaceCells}:null}}catch(e){}
  try{if(typeof tradeDraft!=='undefined')tradeDraft={key,ids:[...(t.trades||[])]}}catch(e){}
  try{if(typeof peopleDraft!=='undefined')peopleDraft={key,ids:[...(t.people||[])]}}catch(e){}
  try{if(typeof ownerDraft!=='undefined')ownerDraft={key,value:t.ownerPerson||''}}catch(e){}
  try{if(typeof editorSelection!=='undefined')editorSelection={key,ids:[...(t.labels||[])]}}catch(e){}
  const owner=document.getElementById('teOwner');if(owner?.dataset.personOwner&&[...owner.options].some(o=>o.value===(t.ownerPerson||'')))owner.value=t.ownerPerson||''}

/* --- 1. Quién ------------------------------------------------------------------------------------------------------- */
function tk5WhoKeys(t){return [...new Set([t.ownerPerson,...(t.people||[])].filter(Boolean))]}
function tk5Medal(key,on=false){const name=personFull(key),short=levelOf(key)?'':(personById(key)?.initials||personShort(key));
  return `<span class="tk5-med ${on?'on':''}" title="${esc(name)}"><b>${esc(short||'')}</b>${levelOf(key)?'<span class="tk5-group" aria-hidden="true">✱</span>':''}</span>`}
function tk5WhoHtml(t){const keys=tk5WhoKeys(t);
  return keys.length?`<span class="tk5-stack">${keys.slice(0,4).map(k=>tk5Medal(k)).join('')}</span><span class="tk5-names">${keys.map((k,i)=>esc(personFull(k))+(i===0?' <small>(responsable)</small>':'')).join(', ')}</span>`:'<span class="muted">Nadie: toca para elegir</span>'}
function tk5WhoPanel(id){const loc=tk5Loc(id);if(!loc)return '';const pick=new Set(tk5WhoKeys(loc.t)),idx=peopleIndex();
  const groups=PERSON_LEVELS.map(([level,name,all])=>({level,name,all,people:idx.sorted.filter(p=>p.active!==false&&p.house_level===level)}));
  const none=idx.sorted.filter(p=>p.active!==false&&!p.house_level);
  const btn=(key,label)=>`<button type="button" class="tk5-person ${pick.has(key)?'on':''}" data-tk5-person="${esc(key)}" aria-pressed="${pick.has(key)}" data-feedback-id="tasks.ficha.quien.persona" data-feedback-label="Persona">${tk5Medal(key,pick.has(key))}<span>${esc(label)}</span></button>`;
  return `<p class="small muted">Toca una o varias. La primera es la responsable.</p>${groups.filter(g=>g.people.length).map(g=>`<p class="tk5-glabel">${esc(g.name)}</p><div class="tk5-people">${btn('level:'+g.level,g.all)}${g.people.map(p=>btn(p.person_id,p.name)).join('')}</div>`).join('')}
    ${none.length?`<p class="tk5-glabel">Sin nivel</p><div class="tk5-people">${none.map(p=>btn(p.person_id,p.name)).join('')}</div>`:''}`}
function tk5ToggleWho(id,key){const loc=tk5Loc(id);if(!loc)return;const t=loc.t,keys=tk5WhoKeys(t),next=keys.includes(key)?keys.filter(k=>k!==key):[...keys,key];
  const owner=next.includes(t.ownerPerson)?t.ownerPerson:(next[0]||null);
  setPeople(t,'people',next);setOwnerPerson(t,owner,true);tk5Save(id,null)}

/* --- 2. Fase: «Etiquetas › Fases» --------------------------------------------------------------------------------- */
function tk5PhasesSheet(id){const loc=tk5Loc(id);if(!loc)return;const p=loc.p;let list=tkphList(p).map(f=>({...f}));
  const body=()=>list.map((f,i)=>`<div class="tk5-phaserow"><input type="text" value="${esc(f.name)}" data-tk5-pn="${i}" maxlength="120" aria-label="Nombre de la fase ${i+1}" data-field-id="tasks.fases.nombre" data-field-entity="tasks.project_phases" data-field-prop="name">
    <label><input type="radio" name="tk5cur" data-tk5-pc="${i}" ${f.current?'checked':''} data-field-id="tasks.fases.actual" data-field-entity="tasks.project_phases" data-field-prop="is_current"> Actual</label>
    <button type="button" class="ghost" data-tk5-pu="${i}" ${i?'':'disabled'} aria-label="Subir">↑</button><button type="button" class="ghost" data-tk5-pd="${i}" ${i<list.length-1?'':'disabled'} aria-label="Bajar">↓</button></div>`).join('');
  const draw=()=>{openSheet(`<h2 class="sheettitle">Etiquetas › Fases</h2><p class="subtitle">${esc(p.title)}</p><p class="small muted">Las fases son etiquetas especiales, en orden y sin fechas. La actual es la que reciben las tareas nuevas.</p>
      <div class="tk5-phaselist">${body()||'<p class="small muted">Aún no tiene fases.</p>'}</div>
      <div class="actions"><button class="primary" id="tk5PhSave" type="button" data-feedback-id="tasks.fases.guardar" data-feedback-label="Guardar las fases">Guardar</button><button class="softbtn" id="tk5PhAdd" type="button" data-feedback-id="tasks.fases.nueva" data-feedback-label="Nueva fase">+ Fase</button><button class="ghost" id="tk5PhBack" type="button">Volver a la tarea</button></div>`);
    const $=s=>document.getElementById(s),read=()=>document.querySelectorAll('[data-tk5-pn]').forEach(n=>{const v=n.value.trim();if(v)list[+n.dataset.tk5Pn].name=v});
    document.querySelectorAll('[data-tk5-pc]').forEach(n=>n.onchange=()=>{read();list.forEach((f,i)=>f.current=i===+n.dataset.tk5Pc)});
    document.querySelectorAll('[data-tk5-pu]').forEach(n=>n.onclick=()=>{read();const i=+n.dataset.tk5Pu;[list[i-1],list[i]]=[list[i],list[i-1]];draw()});
    document.querySelectorAll('[data-tk5-pd]').forEach(n=>n.onclick=()=>{read();const i=+n.dataset.tk5Pd;[list[i+1],list[i]]=[list[i],list[i+1]];draw()});
    $('tk5PhAdd').onclick=()=>{read();list.push({id:crypto.randomUUID(),name:`Fase ${list.length+1}`,status:'pending',start:'',due:'',closedNote:'',version:0,current:!list.length});draw()};
    $('tk5PhBack').onclick=()=>openTaskEditor(id);
    $('tk5PhSave').onclick=()=>{read();const order=list.map(f=>f.id);p.phases||=[];
      for(const [i,f] of list.entries()){const real=p.phases.find(x=>x.id===f.id);const fields={name:f.name,order:(i+1)*1024,current:!!f.current};if(real)Object.assign(real,fields);else p.phases.push({...f,...fields})}
      p.phases.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));touch(p);
      if(typeof tkphSettle==='function')tkphSettle(p);if(save()===false)return;render();toast('Fases guardadas.');openTaskEditor(id)}};
  draw()}

/* --- 3. Espacio ------------------------------------------------------------------------------------------------------ */
let tk5Place=null;
function tk5SpaceValue(t){const id=(t.spaces||[]).slice(-1)[0];return id?{spaceId:id,cell:t.spaceCells?.[id]||null}:null}
function tk5SpaceText(t){const v=tk5SpaceValue(t);if(!v)return null;
  try{if(tk5Place?.path)return tk5Place.path()}catch(e){}
  const path=spaceById(v.spaceId)?IkisaiKit.spacePath(spaceCache.byId,v.spaceId):'Espacio';
  return v.cell?`${path} · 1 m²: ${v.cell.cellX+1}, ${v.cell.cellY+1}`:path}
function tk5SpaceHtml(t){const parts=(tk5SpaceText(t)||'').split(' › ').filter(Boolean),more=(t.spaces||[]).length-1;
  return parts.length?`<span class="tk5-route">${parts.map(p=>`<span>${esc(p)}</span>`).join('<i>›</i>')}</span>${more>0?`<small class="muted"> y ${more} más</small>`:''}`:'<span class="muted">Sin espacio: toca para elegirlo en el plano</span>'}
function tk5MountSpace(id,host){const loc=tk5Loc(id),source=spacesSource();if(!loc||!source||!IkisaiKit.createPlacePicker){host.innerHTML='<p class="small muted">El plano no está disponible ahora.</p>';return}
  tk5Place?.destroy?.();
  tk5Place=IkisaiKit.createPlacePicker({label:'Espacio de la tarea',source,plans:source.plans,planUrl:fileId=>Sync.core.resources.fileUrl(fileId),
    layout:'stacked',cell:true,value:tk5SpaceValue(loc.t),feedbackId:'tasks.ficha.espacio',
    onChange:v=>{const l=tk5Loc(id);if(!l)return;const t=l.t,was=tk5SpaceValue(t)?.spaceId;
      if(!v){t.spaces=(t.spaces||[]).filter(x=>x!==was);if(t.spaceCells&&was){const c={...t.spaceCells};delete c[was];t.spaceCells=c}tk5Save(id,'Sin espacio.');return}
      const up=new Set(IkisaiKit.ancestorsOf(spaceCache.byId,v.spaceId).map(a=>a.id));
      t.spaces=[...(t.spaces||[]).filter(x=>x!==was&&x!==v.spaceId&&!up.has(x)),v.spaceId];
      const cells={...(t.spaceCells||{})};if(was)delete cells[was];if(v.cell)cells[v.spaceId]={cellX:v.cell.cellX,cellY:v.cell.cellY,scale:1};else delete cells[v.spaceId];
      t.spaceCells=cells;tk5Save(id,null)}});
  host.replaceChildren(tk5Place.element);if(!tk5Can())host.querySelectorAll('button,[role="button"]').forEach(x=>{x.disabled=true;x.setAttribute('aria-disabled','true')})}

/* --- 4. Oficio ------------------------------------------------------------------------------------------------------- */
let tk5Trade=null;
function tk5TradeHtml(t){const ids=t.trades||[];return ids.length?ids.map(x=>`<span class="tk5-chip tk5-trade">${esc(tradeShort(x))}</span>`).join(''):'<span class="muted">Sin oficio: toca para elegir</span>'}
function tk5MountTrade(id,host){const loc=tk5Loc(id);if(!loc||!IkisaiKit.createTradePicker){host.innerHTML='<p class="small muted">Los oficios no están disponibles ahora.</p>';return}
  tk5Trade?.destroy?.();
  tk5Trade=IkisaiKit.createTradePicker({label:'Oficio',trades:Sync.core?.trades||[],value:loc.t.trades||[],feedbackId:'tasks.ficha.oficio',
    onChange:ids=>{const l=tk5Loc(id);if(!l)return;setTrades(l.t,'trades',ids);tk5Save(id,null)}});
  host.replaceChildren(tk5Trade.element);if(!tk5Can())host.querySelectorAll('button,input').forEach(x=>x.disabled=true)}

/* --- 5. Etiquetas libres --------------------------------------------------------------------------------------------- */
function tk5FreeFamily(f){return !!f&&!f.system&&!f.archived&&!TK5_SYSTEM_NAMES.has(tk5Norm(f.name))}
function tk5FreeLabels(t){return (t.labels||[]).map(x=>label(x)).filter(l=>l&&!l.archived&&tk5FreeFamily(family(l.family)))}
function tk5AllFree(){return (tab()?.labels||[]).filter(l=>!l.archived&&tk5FreeFamily(family(l.family)))}
function tk5AddTag(id,text){const loc=tk5Loc(id);if(!loc)return;const t=loc.t,v=text.trim();if(!v)return;
  let l=tk5AllFree().find(x=>tk5Norm(x.text)===tk5Norm(v));
  if(!l){if(!canManageCatalog())return toast('Solo quien gestiona las etiquetas crea una nueva: elige una que ya exista.');
    let f=(tab().families||[]).find(x=>tk5FreeFamily(x)&&tk5Norm(x.name)==='etiquetas');
    if(!f){f={id:uid('family-'),name:'Etiquetas',color:'#8a8577',archived:false,version:1};tab().families.push(f)}
    l={id:uid('label-'),text:v,family:f.id,parent:null,archived:false,version:1};tab().labels.push(l)}
  if(!(t.labels||[]).includes(l.id))t.labels=[...(t.labels||[]),l.id];tk5Save(id,null)}
function tk5RemoveTag(id,labelId){const loc=tk5Loc(id);if(!loc)return;loc.t.labels=(loc.t.labels||[]).filter(x=>x!==labelId);tk5Save(id,null)}

/* --- El bloque -------------------------------------------------------------------------------------------------------- */
function tk5Card(key,title,hint,inner,{wide=false,tap=null,open=false}={}){
  return `<section class="tk5-card ${wide?'wide':''}" data-tk5="${key}" aria-labelledby="tk5h-${key}"><h3 id="tk5h-${key}">${esc(title)}${hint?` <span class="tk5-hint">${esc(hint)}</span>`:''}</h3>
    ${tap?`<button type="button" class="tk5-tap" data-tk5-tap="${key}" aria-expanded="${open}" ${tk5Can()?'':'disabled'} data-feedback-id="tasks.ficha.${key}" data-feedback-label="${esc(title)}"><span class="tk5-grow">${tap}</span><span class="tk5-chev" aria-hidden="true">${open?'⌃':'⌄'}</span></button>`:''}
    ${inner}</section>`}
function tk5Html(id){const loc=tk5Loc(id);if(!loc)return '';const t=loc.t,can=tk5Can(),cards=[];
  if(peopleMode())cards.push(tk5Card('quien','Quién',can?'toca para cambiar':'',tk5Open==='who'?`<div class="tk5-panel">${tk5WhoPanel(id)}</div>`:'',{tap:tk5WhoHtml(t),open:tk5Open==='who'}));
  if(!t.parentId&&typeof tkphList==='function'&&tkphList(loc.p).length)cards.push(tk5Card('fase','Fase','siempre una',`<div class="tk5-phasehost"></div>${can?'<button type="button" class="tk5-pencil" id="tk5PhaseEdit" aria-label="Editar fases (en Etiquetas)" title="Editar fases (en Etiquetas)" data-feedback-id="tasks.ficha.fase.editar" data-feedback-label="Editar fases"></button>':''}`));
  if(spacesMode())cards.push(tk5Card('espacio','Espacio',can?'toca para cambiar':'',tk5Open==='space'?'<div class="tk5-panel ikisai-kit" id="tk5SpaceHost"></div>':'',{wide:true,tap:tk5SpaceHtml(t),open:tk5Open==='space'}));
  if(tradesMode())cards.push(tk5Card('oficio','Oficio',can?'toca para cambiar':'',tk5Open==='trade'?'<div class="tk5-panel ikisai-kit" id="tk5TradeHost"></div>':'',{wide:true,tap:`<span class="tk5-chips">${tk5TradeHtml(t)}</span>`,open:tk5Open==='trade'}));
  const tags=tk5FreeLabels(t),all=tk5AllFree().filter(l=>!(t.labels||[]).includes(l.id));
  cards.push(tk5Card('etiquetas','Etiquetas','',`<div class="tk5-chips">${tags.map(l=>`<span class="tk5-chip">${esc(l.text)}${can?`<button type="button" data-tk5-untag="${esc(l.id)}" aria-label="Quitar ${esc(l.text)}">×</button>`:''}</span>`).join('')}
    ${can?`<input class="tk5-addtag" id="tk5TagIn" list="tk5TagList" placeholder="+ etiqueta" maxlength="60" enterkeyhint="done" aria-label="Añadir etiqueta" data-field-id="tasks.ficha.etiquetas" data-field-entity="tasks.task_labels" data-field-prop="label_id"><datalist id="tk5TagList">${all.map(l=>`<option value="${esc(l.text)}"></option>`).join('')}</datalist>`:tags.length?'':'<span class="muted">Sin etiquetas</span>'}</div>`));
  return `<div class="tk5" id="tk5" data-tk5-task="${esc(id)}">${cards.join('')}</div>`}
function tk5Mount(id){const s=document.getElementById('sheet'),portada=s?.querySelector('.tkf-portada');if(!portada||!id)return;
  const tiles=portada.querySelector('.tkf-tiles'),old=s.querySelector('#tk5');
  // El segmento de la fase vive en la tarjeta: sale antes de quitar el bloque viejo, para no perderlo.
  const keep=old?.querySelector('.tkph-field');if(keep){if(tiles)tiles.before(keep);else portada.append(keep)}
  old?.remove();
  const box=document.createElement('div');box.innerHTML=tk5Html(id);const node=box.firstElementChild;if(!node)return;
  if(tiles)tiles.before(node);else portada.append(node);
  // Fase: el segmento de fases-ui.js, dentro de su tarjeta.
  const phase=s.querySelector('.tkph-field'),phHost=node.querySelector('.tk5-phasehost');if(phase&&phHost){phHost.append(phase);phase.querySelector('.tkph-label')?.remove()}
  const pencil=node.querySelector('#tk5PhaseEdit');if(pencil){pencil.innerHTML=IkisaiKit.icon?IkisaiKit.icon('edit',18).outerHTML:'✎';pencil.onclick=()=>tk5PhasesSheet(id)}
  // Las baldosas «Quién» y «Etiquetas» se esconden: lo suyo está aquí.
  for(const k of ['quien','etiquetas'])tiles?.querySelectorAll(`[data-tkf-tile="${k}"]`).forEach(b=>b.hidden=true);
  node.querySelectorAll('[data-tk5-tap]').forEach(b=>b.onclick=()=>{const k={quien:'who',espacio:'space',oficio:'trade'}[b.dataset.tk5Tap];if(!tk5Can()&&k==='who')return;tk5Open=tk5Open===k?null:k;tk5Mount(id)});
  node.querySelectorAll('[data-tk5-person]').forEach(b=>b.onclick=()=>{if(tk5Can())tk5ToggleWho(id,b.dataset.tk5Person)});
  const sp=node.querySelector('#tk5SpaceHost');if(sp)tk5MountSpace(id,sp);
  const tr=node.querySelector('#tk5TradeHost');if(tr)tk5MountTrade(id,tr);
  node.querySelectorAll('[data-tk5-untag]').forEach(b=>b.onclick=()=>tk5RemoveTag(id,b.dataset.tk5Untag));
  const inp=node.querySelector('#tk5TagIn');if(inp){const add=()=>{const v=inp.value.replace(/,$/,'');inp.value='';tk5AddTag(id,v)};
    inp.onkeydown=e=>{if(e.key==='Enter'||e.key===','){e.preventDefault();add()}};inp.onchange=()=>{if(tk5AllFree().some(l=>tk5Norm(l.text)===tk5Norm(inp.value)))add()}}}
const openTaskEditorBeforeCinco=openTaskEditor;
openTaskEditor=function(id,...rest){const same=document.getElementById('tk5')?.dataset.tk5Task===id;if(!same){tk5Open=null;tk5Place?.destroy?.();tk5Place=null;tk5Trade?.destroy?.();tk5Trade=null}
  const out=openTaskEditorBeforeCinco(id,...rest);try{if(id)tk5Mount(id)}catch(e){console.error(e)}return out};
const closeSheetBeforeCinco=closeSheet;
closeSheet=function(e){closeSheetBeforeCinco(e);if(!document.getElementById('sheetBack').classList.contains('show')){tk5Open=null;tk5Place?.destroy?.();tk5Place=null;tk5Trade?.destroy?.();tk5Trade=null}};
/* Al repintar la app con la ficha abierta (tras guardar), el bloque se vuelve a pintar con lo nuevo. */
const renderBeforeCinco=render;
render=function(...a){const out=renderBeforeCinco(...a);try{const box=document.getElementById('tk5'),id=box?.dataset.tk5Task,loc=id&&tk5Loc(id);
    if(!box||!loc){}else if(tk5Open==='space'||tk5Open==='trade'){
      // Con el plano o el árbol abiertos no se rehace la pieza (se perdería dónde está): solo la línea de arriba.
      const sum=box.querySelector(`[data-tk5-tap="${tk5Open==='space'?'espacio':'oficio'}"] .tk5-grow`);
      if(sum)sum.innerHTML=tk5Open==='space'?tk5SpaceHtml(loc.t):`<span class="tk5-chips">${tk5TradeHtml(loc.t)}</span>`}
    else tk5Mount(id)}catch(e){console.error(e)}return out};
