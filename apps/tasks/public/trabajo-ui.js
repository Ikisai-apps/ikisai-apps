/* Ficha de tarea · «Vista de trabajo» (FB_2026_071; VG eligió «Mesa de trabajo» el 27-10-2026, con dos añadidos). Una baldosa
   ancha más en la portada de la ficha (ficha-tarea-ui.js), solo en las tareas principales, que abre en foco la mesa:
   - «Todo» (marcado al entrar): la lista completa de lo que necesita la tarea, la suya y la de sus pasos: máquinas y
     herramientas, sus EPI (Recursos, `resources.item_links` de la migración 0813, con la parte del cuerpo que protegen) y
     materiales. Al tocar un paso, la lista se queda con lo de ese paso; «Todo» vuelve a la lista completa.
   - «Preparar antes de empezar» (añadido de VG, plegado por defecto): el carro como lista que se marca, con los EPI por
     parte del cuerpo. Lo marcado se recuerda en este dispositivo.
   - Los pasos (las hijas): en orden y «En cualquier momento» (las que están fuera de la cadena, `stepFree`), con «Hecho»,
     «+ Paso», «Fuera de orden» / «Volver a la cadena» y «Abrir el paso». Mismo modelo y mismos guardados que «Tareas hijas».
   Sin EPI en Recursos (o sin conexión al leerlos), la lista sale sin ellos. Prefijo de clases: `tkw-`. */
const TKW_PARTS={head:'Cabeza',eyes:'Ojos',ears:'Oídos',mouth_nose:'Boca y nariz',hands:'Manos',feet:'Pies',legs:'Piernas',knees:'Rodillas',body:'Cuerpo',harness:'Arnés'};
const TKW_PART_ORDER=Object.keys(TKW_PARTS);
let tkwLinks=null,tkwLinksAt=0,tkwSel=null;

/* Los vínculos máquina → EPI de Recursos. Se leen al abrir la mesa (como mucho una vez por minuto); si la tabla aún no existe
   o no hay red, la mesa sigue sin EPI. */
async function tkwLoadLinks(){if(tkwLinks&&Date.now()-tkwLinksAt<60000)return tkwLinks;if(!navigator.onLine||!Sync.core?.api)return tkwLinks||[];
  try{const out=await Sync.core.api('/resources/snapshot?tables=resources.item_links&limit=2000');tkwLinks=(out?.tables?.[0]?.rows||[]).filter(l=>!l.deleted_at&&l.kind==='requires_ppe');tkwLinksAt=Date.now()}catch{tkwLinks=tkwLinks||[]}
  return tkwLinks}
const tkwIsPpe=item=>item?.kind==='epi';
function tkwPartsOf(item){const p=item?.attributes?.body_parts;return Array.isArray(p)?p.filter(x=>TKW_PARTS[x]):[]}
function tkwSteps(p,t){return p.tasks.filter(c=>c.parentId===t.id&&!c.deleted).sort((a,b)=>(a.order||0)-(b.order||0)||(a.id<b.id?-1:1))}

/* Lo que necesita una lista de tareas: máquinas y herramientas, EPI (los puestos a mano y los que piden esas máquinas) y
   materiales, sin repetir (las cantidades de un mismo material se suman). */
function tkwNeeds(taskIds){const equip=new Map(),mats=new Map(),ppe=new Map();
  for(const id of taskIds)for(const m of materialRows(id)){const item=inventoryItem(m.item_id);if(!item)continue;
    if(tkwIsPpe(item))ppe.set(item.id,{item,by:new Set(ppe.get(item.id)?.by||[])});
    else if(!isConsumable(item.id))equip.set(item.id,{item});
    else{const prev=mats.get(item.id);const q=m.quantity==null?null:Number(m.quantity);mats.set(item.id,{item,quantity:prev?(prev.quantity==null||q==null?prev.quantity??q:prev.quantity+q):q})}}
  for(const l of tkwLinks||[]){if(!equip.has(l.item_id))continue;const item=inventoryItem(l.linked_item_id);if(!item||item.deleted_at||!tkwIsPpe(item))continue;
    const row=ppe.get(item.id)||{item,by:new Set()};row.by.add(equip.get(l.item_id).item.name);ppe.set(item.id,row)}
  const byName=(a,b)=>a.item.name.localeCompare(b.item.name,'es');
  return {equip:[...equip.values()].sort(byName),ppe:[...ppe.values()].sort(byName),mats:[...mats.values()].sort(byName)}}
function tkwChip(text,cls=''){return `<span class="tkw-chip ${cls}">${esc(text)}</span>`}
function tkwNeedsHtml(n){const none='<span class="small muted">Nada</span>';
  const ppe=n.ppe.map(x=>{const parts=tkwPartsOf(x.item).map(k=>TKW_PARTS[k]);return tkwChip(`${x.item.name}${parts.length?` · ${parts.join(', ')}`:''}`,'epi')}).join('');
  return `<div class="tkw-group"><span class="tkw-glabel">Máquinas y herramientas</span><span class="tkw-chips">${n.equip.map(x=>tkwChip(x.item.name)).join('')||none}</span></div>
    <div class="tkw-group"><span class="tkw-glabel">EPI</span><span class="tkw-chips">${ppe||none}</span></div>
    <div class="tkw-group"><span class="tkw-glabel">Materiales</span><span class="tkw-chips">${n.mats.map(x=>tkwChip(`${x.item.name}${x.quantity!=null?` · ${materialQty(x.quantity,x.item)}`:''}`)).join('')||none}</span></div>`}
function tkwStepLine(id){const n=tkwNeeds([id]);const bits=[...n.equip.map(x=>x.item.name),...n.mats.map(x=>x.item.name)];return bits.length?bits.join(' · '):'Sin equipos ni material'}

/* «Preparar»: lo marcado, por tarea, en este dispositivo (una comodidad: si se pierde, se vuelve a marcar). */
function tkwPrepKey(id){return 'tkw-prep:'+id}
function tkwPrepGet(id){try{return new Set(JSON.parse(localStorage.getItem(tkwPrepKey(id))||'[]'))}catch{return new Set()}}
function tkwPrepSet(id,set){try{localStorage.setItem(tkwPrepKey(id),JSON.stringify([...set]))}catch{}}
function tkwPrepHtml(id,n,open){const got=tkwPrepGet(id),box=(k,label,extra='')=>`<label class="checkline tkw-check"><input type="checkbox" data-tkw-prep="${esc(k)}" ${got.has(k)?'checked':''} data-feedback-id="tasks.editor_tarea.trabajo.preparar.marcar" data-feedback-label="Marcar preparado"><span>${esc(label)}${extra}</span></label>`;
  const parts=TKW_PART_ORDER.map(k=>[k,n.ppe.filter(x=>tkwPartsOf(x.item).includes(k))]).filter(([,l])=>l.length);
  const loose=n.ppe.filter(x=>!tkwPartsOf(x.item).length);
  const keys=[...n.equip.map(x=>'i:'+x.item.id),...n.ppe.map(x=>'i:'+x.item.id),...n.mats.map(x=>'i:'+x.item.id)],left=keys.filter(k=>!got.has(k)).length;
  if(!keys.length)return '';
  return `<details class="tkw-prep" id="tkwPrep" ${open?'open':''}><summary data-feedback-id="tasks.editor_tarea.trabajo.preparar" data-feedback-label="Preparar antes de empezar">Preparar antes de empezar <span class="small muted" id="tkwPrepLeft">· ${left?`faltan ${left}`:'todo listo'}</span></summary>
    ${n.equip.length?`<p class="tkw-glabel">Máquinas y herramientas</p>${n.equip.map(x=>box('i:'+x.item.id,x.item.name)).join('')}`:''}
    ${n.ppe.length?`<p class="tkw-glabel">Protección</p>${parts.map(([k,l])=>`<p class="tkw-part">${esc(TKW_PARTS[k])}</p>${l.map(x=>box('i:'+x.item.id,x.item.name,x.by.size?` <span class="small muted">· la pide ${esc([...x.by].join(', '))}</span>`:'')).join('')}`).join('')}${loose.map(x=>box('i:'+x.item.id,x.item.name)).join('')}`:''}
    ${n.mats.length?`<p class="tkw-glabel">Materiales</p>${n.mats.map(x=>box('i:'+x.item.id,`${x.item.name}${x.quantity!=null?` · ${materialQty(x.quantity,x.item)}`:''}`)).join('')}`:''}
  </details>`}

function tkwStepRow(c,index,inOrder,n){const sel=tkwSel===c.id,blocker=inOrder&&!c.stepFree?stepBefore(c,index):null,edit=canEdit();
  return `<li class="tkw-step ${c.done?'done':''} ${c.stepFree&&inOrder?'free':''}"><button class="childcheck" type="button" data-tkw-done="${c.id}" aria-pressed="${!!c.done}" aria-label="${c.done?'Marcar pendiente':'Marcar hecho'}: ${esc(c.text)}" ${edit||isOutsiderActor()?'':'disabled'} data-feedback-id="tasks.editor_tarea.trabajo.paso.hecho" data-feedback-label="Marcar paso">${c.done?'✓':''}</button>
    <button class="tkw-steptext" type="button" data-tkw-step="${c.id}" aria-pressed="${sel}" data-feedback-id="tasks.editor_tarea.trabajo.paso.elegir" data-feedback-label="Ver lo que necesita el paso"><span class="tkw-n">${n}</span><span><span class="tkw-st">${esc(c.text)}</span><small>${esc(tkwStepLine(c.id))}${blocker&&!c.done?' · espera al paso anterior':''}</small></span></button></li>`}

function tkwHtml(id){const loc=taskLocation(id);if(!loc)return '';const {p,t}=loc,steps=tkwSteps(p,t),inOrder=!!t.stepsInOrder,index=dependencyIndex(),edit=canEdit();
  if(tkwSel&&!steps.some(c=>c.id===tkwSel))tkwSel=null;
  const chain=inOrder?steps.filter(c=>!c.stepFree):steps,free=inOrder?steps.filter(c=>c.stepFree):[];
  const all=tkwNeeds([t.id,...steps.map(c=>c.id)]),sel=tkwSel?steps.find(c=>c.id===tkwSel):null,shown=sel?tkwNeeds([sel.id]):all;
  const open=document.getElementById('tkwPrep')?.open||false;
  return `<section class="tkw" id="taskWork" data-task="${t.id}" aria-label="Vista de trabajo">
    <div class="tkw-filter" role="group" aria-label="Qué enseñar"><button type="button" class="tkw-all" id="tkwAll" aria-pressed="${!sel}" data-feedback-id="tasks.editor_tarea.trabajo.todo" data-feedback-label="Todo lo que necesita la tarea">Todo</button><span class="small muted">${sel?`Lo de «${esc(sel.text)}» · toca «Todo» para verlo todo`:'Todo lo que necesita la tarea y sus pasos'}</span></div>
    <div class="tkw-need" id="tkwNeed">${tkwNeedsHtml(shown)}</div>
    ${tkwPrepHtml(t.id,all,open)}
    <h4 class="tkw-h">${inOrder?'Pasos en orden':'Pasos'} <span class="count">${chain.length}</span></h4>
    <ol class="tkw-steps">${chain.map((c,i)=>tkwStepRow(c,index,inOrder,inOrder?i+1:'·')).join('')||'<li class="small muted">Aún no hay pasos.</li>'}</ol>
    ${inOrder?`<h4 class="tkw-h">En cualquier momento <span class="count">${free.length}</span></h4><ul class="tkw-steps">${free.map(c=>tkwStepRow(c,index,inOrder,'·')).join('')||'<li class="small muted">Ninguno: marca un paso como «Fuera de orden».</li>'}</ul>`:''}
    ${edit?`<div class="row tkw-add"><input id="tkwNewStep" maxlength="1000" placeholder="Nuevo paso…" aria-label="Nuevo paso" data-feedback-id="tasks.editor_tarea.trabajo.paso.nuevo_texto" data-feedback-label="Texto del nuevo paso"><button class="ghost" id="tkwAddStep" type="button" data-feedback-id="tasks.editor_tarea.trabajo.paso.nuevo" data-feedback-label="Añadir paso">+ Paso</button></div>`:''}
    ${sel?`<div class="row tkw-selactions">${edit&&inOrder?`<button class="ghost small" id="tkwFree" type="button" data-feedback-id="tasks.editor_tarea.trabajo.paso.fuera_de_orden" data-feedback-label="Fuera de orden o volver a la cadena">${sel.stepFree?'Volver a la cadena':'Fuera de orden'}</button>`:''}<button class="ghost small" id="tkwOpen" type="button" data-feedback-id="tasks.editor_tarea.trabajo.paso.abrir" data-feedback-label="Abrir el paso">Abrir el paso</button></div>`:''}
    ${!inOrder&&steps.length>1&&edit?'<p class="small muted">Para que cada paso espere al anterior, activa «Pasos en orden» en la baldosa «Pasos».</p>':''}
  </section>`}

function tkwPaint(id){const box=document.getElementById('taskWork');if(!box)return;box.outerHTML=tkwHtml(id);const s=document.getElementById('sheet');if(s?._tkfParts)s._tkfParts.work=document.getElementById('taskWork');tkwBind(id)}
function tkwBind(id){const box=document.getElementById('taskWork');if(!box)return;
  const after=()=>{if(typeof render==='function')render();tkwPaint(id)};
  box.querySelector('#tkwAll').onclick=()=>{tkwSel=null;tkwPaint(id)};
  box.querySelectorAll('[data-tkw-step]').forEach(b=>b.onclick=()=>{tkwSel=tkwSel===b.dataset.tkwStep?null:b.dataset.tkwStep;tkwPaint(id);document.getElementById('tkwNeed')?.scrollIntoView({block:'nearest'})});
  box.querySelectorAll('[data-tkw-done]').forEach(b=>b.onclick=()=>{toggleTask(b.dataset.tkwDone);setTimeout(()=>tkwPaint(id),0)});
  box.querySelectorAll('[data-tkw-prep]').forEach(c=>c.onchange=()=>{const got=tkwPrepGet(id);c.checked?got.add(c.dataset.tkwPrep):got.delete(c.dataset.tkwPrep);tkwPrepSet(id,got);
    const left=[...box.querySelectorAll('[data-tkw-prep]')].filter(x=>!x.checked).length,el=document.getElementById('tkwPrepLeft');if(el)el.textContent=`· ${left?`faltan ${left}`:'todo listo'}`});
  const input=box.querySelector('#tkwNewStep'),add=box.querySelector('#tkwAddStep');
  const create=()=>{const text=input.value.trim();if(!text)return input.focus();const l=taskLocation(id);if(!l||l.t.parentId)return;const {p,t}=l;
    const task={id:uid('t'),text,note:'',done:false,priority:'normal',due:'',owner:null,parentId:t.id,labels:[...(p.ownLabels||[])],attachments:[],dependsOn:[],order:Math.max(0,...p.tasks.map(x=>x.order||0))+1024,version:1};
    p.tasks.push(task);syncParent(p,t.id);syncAll(p);record('create',[task.id]);if(save()!==false){after();toast('Paso añadido.');setTimeout(()=>document.getElementById('tkwNewStep')?.focus(),0)}};
  if(add)add.onclick=create;if(input)input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();create()}};
  const free=box.querySelector('#tkwFree');if(free)free.onclick=()=>{const l=tkwSel&&taskLocation(tkwSel);if(!l)return;l.t.stepFree=!l.t.stepFree;if(typeof touch==='function')touch(l.t);
    if(save()!==false){toast(l.t.stepFree?`«${l.t.text}» se puede hacer en cualquier momento.`:`«${l.t.text}» vuelve a la cadena.`);after()}};
  const open=box.querySelector('#tkwOpen');if(open)open.onclick=()=>{const step=tkwSel;tkwSel=null;openTaskEditor(step)};
}

/* --- Enganche con la ficha «Portada y foco» ------------------------------------------------------------------------- */
FICHA_BLOCKS.unshift({key:'trabajo',name:'Vista de trabajo',feedbackId:'tasks.editor_tarea.baldosa.trabajo',wide:true});
const fichaPartsBeforeWork=fichaParts;
fichaParts=function(s){const P=fichaPartsBeforeWork(s);
  let work=s.querySelector('#taskWork');
  // Solo en las tareas principales (las que tienen o pueden tener pasos): donde está «Tareas hijas».
  if(!work&&s.querySelector('#taskChildren')){s.insertAdjacentHTML('beforeend','<section class="tkw" id="taskWork" aria-label="Vista de trabajo"></section>');work=s.querySelector('#taskWork')}
  P.work=work;return P};
const fichaBlockNodesBeforeWork=fichaBlockNodes;
fichaBlockNodes=function(P,key){return key==='trabajo'?[P.work].filter(Boolean):fichaBlockNodesBeforeWork(P,key)};
const fichaLineBeforeWork=fichaLine;
fichaLine=function(k,m){if(k!=='trabajo')return fichaLineBeforeWork(k,m);const n=tkwNeeds([m.t.id,...tkwSteps(m.p,m.t).map(c=>c.id)]);
  const bits=[m.kids?`${m.kidsDone} de ${m.kids} pasos`:null,n.equip.length?fichaPlural(n.equip.length,'equipo','equipos'):null,n.ppe.length?`${n.ppe.length} EPI`:null,n.mats.length?fichaPlural(n.mats.length,'material','materiales'):null].filter(Boolean);
  return bits.length?esc(bits.join(' · ')):fichaNone('Pasos, equipos y material juntos')};
const fichaCountBeforeWork=fichaCount;
fichaCount=function(k,m){return k==='trabajo'?0:fichaCountBeforeWork(k,m)};
const fichaShowBeforeWork=fichaShow;
fichaShow=function(s,id,key){if(key==='trabajo'){tkwSel=null;const P=s._tkfParts;if(P?.work){P.work.outerHTML=tkwHtml(id);P.work=s.querySelector('#taskWork')}
    fichaShowBeforeWork(s,id,key);tkwBind(id);
    // Los EPI llegan de Recursos: al tenerlos, se repinta (si la mesa sigue abierta).
    tkwLoadLinks().then(()=>{if(s.querySelector('.tkf-stage')?.dataset.tkfOpen==='trabajo')tkwPaint(id)});return}
  const out=fichaShowBeforeWork(s,id,key);
  // Fuera de la mesa, su sección se vacía: se pinta al abrirla (así no deja controles sueltos en la hoja).
  const work=s._tkfParts?.work;if(work)work.replaceChildren();
  return out};
/* Al llegar datos con la mesa abierta (hijas, materiales), se pone al día. */
const refreshModelBeforeWork=refreshModel;
refreshModel=function(){refreshModelBeforeWork();const s=document.getElementById('sheet'),id=s?._tkfId;
  if(id&&s.querySelector('.tkf-stage')?.dataset.tkfOpen==='trabajo'&&taskLocation(id))tkwPaint(id)};
