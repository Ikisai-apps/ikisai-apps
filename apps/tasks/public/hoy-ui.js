/* «Plan de hoy» (MUELA-095; docs/tasks/API.md §38). Pantalla nueva (state.view = 'today') y el sol en cada tarea.
   - El plan es de cada persona y día (tasks.day_plans, privado): lo guarda Sync.core.dayPlanOps, que valida como el servidor
     y sin red va a la cola como cualquier cambio. Poner, quitar, ordenar o traer de ayer escriben el plan, NUNCA la tarea.
   - El sol (☀ Hoy / En hoy): en cada fila de tarea (taskRow), en la ficha (encima de la portada) y en «Lo primero» de Inicio
     (☀ Para hoy / ☀ En tu plan, que lleva al plan). Solo si la tarea no está hecha y se puede editar. El foco se queda en él.
   - La pantalla: el arco del día, una línea para buscar o apuntar, «De ayer quedaron…», el plan en su orden
     (createSortableList del kit) y «Para coger» (lo último que tocaste, en marcha, con fecha y todo por proyecto).
   - Quien solo lee tiene plan, en pequeño: el arco, su plan y «Apunta aquí lo tuyo» (solo texto). Sin sol, sin buscar y sin
     «Para coger». El outsider no tiene plan (ni la pestaña, ni la pantalla, tampoco por URL).
   - Cada «Deshacer» sustituye al anterior (hideToast antes de toastWithAction, en offerLocalUndo de extras-ui.js). */
const TKH_TAKE_STRIP=8;
function tkhD(){return IkisaiTasks.dayPlans}
function tkhDay(){return isoDay(0)}
/* Tiene plan quien no es de fuera; lo escribe además desde la pestaña activa. Elegir tareas (sol, buscar, coger, llevar),
   quien puede editar. */
function tkhHasPlan(){return !!Sync.actor&&!Sync.actor.outsider&&!!Sync.core&&typeof Sync.core.dayPlan==='function'}
function tkhCanWrite(){return tkhHasPlan()&&!Sync.secondary}
function tkhCanPick(){return tkhHasPlan()&&canEdit()}
function tkhItems(day=tkhDay()){return tkhHasPlan()?tkhD().dayPlanItems(Sync.core.dayPlan(day)):[]}
/* Una tarea en cualquier área visible (el plan es de todas). */
function tkhFind(taskId){if(!taskId)return null;for(const area of activeAreas())for(const p of area.projects){if(p.deleted)continue;const t=p.tasks.find(x=>x.id===taskId&&!x.deleted);if(t)return {area,p,t}}return null}
function tkhDone(hit){return !!hit&&status(hit.p,hit.t)==='done'}
function tkhItemDone(it){if(it.task_id){const hit=tkhFind(it.task_id);return hit?tkhDone(hit):false}return !!it.done}
function tkhItemGone(it){return !!it.task_id&&!tkhFind(it.task_id)}
function tkhLeft(items=tkhItems()){return items.filter(it=>!tkhItemGone(it)&&!tkhItemDone(it)).length}
function tkhInPlan(taskId,items=tkhItems()){return items.some(it=>it.task_id===taskId)}
function tkhNorm(s){return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLocaleLowerCase('es')}
function tkhSunIcon(size=18){return IkisaiKit.icon('sun',size).outerHTML}
/* ¿Se le puede poner el sol a esta tarea? No hecha, se puede editar y no es de las plantillas. */
function tkhSunFor(hit){return !!hit&&tkhCanPick()&&!tkhDone(hit)&&!(typeof batchMode!=='undefined'&&batchMode)}

/* Guardar el plan: un lote solo del plan, por la cola. */
function tkhWrite(items,options={}){
  if(!tkhCanWrite()){toast(Sync.secondary?'Tu plan de hoy se cambia desde la pestaña activa.':'Inicia sesión primero.');return false}
  let ops;try{ops=Sync.core.dayPlanOps(tkhDay(),items,options)}catch(e){toast(e.message||'No se pudo guardar el plan.');return false}
  if(!ops.length)return true;
  const work=Sync.core.commit([ops],()=>uid('req-'));tkhStamp=tkhPlanStamp();Sync.chain=Sync.chain.then(()=>work).then(()=>{Sync.channel?.postMessage({type:'changed'})}).catch(storageError);
  refreshStatus();return true}
/* Pinta y devuelve el foco al mando que se acaba de usar (o al que diga `next`). */
function tkhRepaint(focus){render();if(!focus)return;setTimeout(()=>{const el=typeof focus==='function'?focus():document.querySelector(focus);el?.focus({preventScroll:false})},0)}
function tkhUndo(message,undo){IkisaiKit.hideToast();offerLocalUndo(message,undo)}

/* --- El sol ------------------------------------------------------------------------------------------------------------ */
function tkhSunHtml(hit,where){const on=tkhInPlan(hit.t.id),name=hit.t.text;
  return `<button type="button" class="tkh-sun ${on?'on':''}" data-tkh-sun="${hit.t.id}" data-tkh-where="${where}" aria-pressed="${on}" aria-label="${esc(on?`En tu plan de hoy: ${name}. Tocar para quitarla`:`Para hoy: ${name}`)}" data-feedback-id="tasks.hoy.sol" data-feedback-label="Para hoy">${tkhSunIcon(18)}<span>${on?'En hoy':'Hoy'}</span></button>`}
function tkhToggleTask(taskId,where){const hit=tkhFind(taskId);if(!hit||!tkhCanPick())return;
  const before=tkhItems(),on=tkhInPlan(taskId,before);
  if(!on&&tkhDone(hit))return;
  let next;try{next=on?tkhD().planWithoutTask(before,taskId):tkhD().planWithTask(before,{id:taskId,tab_id:hit.area.id})}catch(e){return toast(e.message)}
  if(!tkhWrite(next))return;
  tkhRefreshFicha();tkhRepaint(`[data-tkh-sun="${taskId}"][data-tkh-where="${where}"]`);
  tkhUndo(on?'Fuera de tu plan de hoy. La tarea sigue donde estaba.':`Para hoy: ${hit.t.text}. Su fecha no cambia.`,()=>{if(tkhWrite(before)){tkhRefreshFicha();tkhRepaint(`[data-tkh-sun="${taskId}"][data-tkh-where="${where}"]`)}})}
/* En cada fila de tarea, delante de ⋮. */
const taskRowBeforeHoy=taskRow;
taskRow=function(t,p=project(),context=false){const html=taskRowBeforeHoy(t,p,context);if(context||!tkhCanPick())return html;
  const area=state.tabs.find(a=>a.projects.includes(p)),hit={area,p,t};if(!area||!tkhSunFor(hit))return html;
  return html.replace('<button class="taskmenu"',tkhSunHtml(hit,'row')+'<button class="taskmenu"')};
/* En la ficha, encima de la portada. */
function tkhRefreshFicha(){const s=document.getElementById('sheet'),id=s?._tkfId,old=document.getElementById('tkhFichaSun');if(!s||!id)return;
  const hit=tkhFind(id),portada=s.querySelector('.tkf-portada');if(!portada)return;
  if(!tkhSunFor(hit)){old?.remove();return}
  const had=document.activeElement===old,box=document.createElement('div');box.innerHTML=tkhSunHtml(hit,'ficha');const btn=box.firstElementChild;btn.id='tkhFichaSun';btn.classList.add('tkh-sun-ficha');
  if(old)old.replaceWith(btn);else portada.before(btn);if(had)btn.focus({preventScroll:true})}
const fichaLayoutBeforeHoy=fichaLayout;
fichaLayout=function(id){const out=fichaLayoutBeforeHoy(id);try{tkhRefreshFicha()}catch(e){console.error(e)}return out};
/* En «Lo primero» de Inicio: «☀ Para hoy», o «☀ En tu plan», que lleva al plan. */
const mountHomeBeforeHoy=mountHome;
mountHome=function(){const out=mountHomeBeforeHoy();if(!tkhCanPick())return out;
  document.querySelectorAll('#homeLead .lead-card[data-id]').forEach(card=>{const [area,id]=card.dataset.id.split('|'),hit=tkhFind(id);if(!hit||!tkhSunFor(hit))return;
    const on=tkhInPlan(id),box=card.querySelector('.lead-actions');if(!box)return;
    box.insertAdjacentHTML('beforeend',`<button type="button" class="ghost lead-btn tkh-lead ${on?'on':''}" data-tkh-lead="${id}" data-tkh-area="${area}" aria-label="${esc(on?`En tu plan de hoy: ${hit.t.text}. Ver el plan`:`Para hoy: ${hit.t.text}`)}" data-feedback-id="tasks.inicio.lo_primero.hoy" data-feedback-label="Para hoy">${tkhSunIcon(18)}<span>${on?'En tu plan':'Para hoy'}</span></button>`)});
  return out};
function tkhLead(taskId){if(tkhInPlan(taskId)){navigateView('today');return}
  const hit=tkhFind(taskId);if(!hit||!tkhCanPick())return;const before=tkhItems();
  let next;try{next=tkhD().planWithTask(before,{id:taskId,tab_id:hit.area.id})}catch(e){return toast(e.message)}
  if(!tkhWrite(next))return;tkhRepaint(`[data-tkh-lead="${taskId}"]`);
  tkhUndo(`Para hoy: ${hit.t.text}. Su fecha no cambia.`,()=>{if(tkhWrite(before))tkhRepaint(`[data-tkh-lead="${taskId}"]`)})}

/* --- La pantalla «Hoy» -------------------------------------------------------------------------------------------------- */
let tkhQuery='',tkhSortable=null,tkhOpenAll=false;
function tkhDateLabel(){const d=new Date(),f=o=>new Intl.DateTimeFormat('es-ES',o).format(d),w=f({weekday:'long'});return `${w.charAt(0).toLocaleUpperCase('es')+w.slice(1)} ${f({day:'numeric'})} de ${f({month:'long'})}`}
/* El arco del día: media luna con lo hecho frente a lo que hay, y el sol en la punta. */
function tkhArc(done,total){const pct=total?Math.min(1,done/total):0,a=Math.PI*(1-pct),x=70+60*Math.cos(a),y=70-60*Math.sin(a);
  return `<svg class="tkh-arc" viewBox="0 0 140 82" role="img" aria-label="${done} de ${total} hechas hoy"><path class="tkh-arc-track" d="M10 70 A60 60 0 0 1 130 70"/>${pct>0?`<path class="tkh-arc-done" d="M10 70 A60 60 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}"/>`:''}<circle class="tkh-arc-sun" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="8"/><text class="tkh-arc-n" x="70" y="66" text-anchor="middle">${done}/${total}</text></svg>`}
/* Lo que se puede coger: pendiente, sin hijas (las madres van por sus pasos), sin bloqueo y que se puede editar. */
function tkhCandidates(){const out=[];if(!tkhCanPick())return out;const plan=new Set(tkhItems().map(i=>i.task_id).filter(Boolean));
  const tpl=typeof templateArea==='function'?templateArea():null;
  for(const area of activeAreas()){if(area===tpl)continue;for(const p of area.projects.filter(p=>!p.deleted&&p.status!=='archived'))for(const t of p.tasks){
    if(t.deleted||plan.has(t.id)||status(p,t)==='done'||children(p,t.id).length)continue;
    if(withArea(area.id,()=>dependencyBlockers(t,p)).length)continue;out.push({area,p,t})}}
  return out}
function tkhWho(userId){if(!userId)return '';if(userId===Sync.actor?.id)return 'Tú';
  const person=(Sync.core?.people||[]).find(x=>x.user_id===userId);if(person)return person.name.trim().split(/\s+/)[0];
  const member=(Sync.members||[]).find(m=>m.userId===userId);return member?.displayName?.trim().split(/\s+/)[0]||'Otra persona'}
function tkhAgo(iso){const at=Date.parse(iso||'');if(isNaN(at))return '';const min=Math.max(0,Math.round((Date.now()-at)/60000));if(min<1)return 'ahora';if(min<60)return `hace ${min} min`;
  const day=new Date(at);day.setHours(0,0,0,0);const days=Math.round((homeToday()-day)/86400000);if(days<=0)return `hace ${Math.round(min/60)} h`;if(days===1)return 'ayer';return `hace ${days} días`}
function tkhDaysAgo(iso){const at=Date.parse(iso||'');if(isNaN(at))return 99;const day=new Date(at);day.setHours(0,0,0,0);return Math.round((homeToday()-day)/86400000)}
/* Filtro por espacio (encargo de VG, 27-10), por el árbol de espacios de Recursos y no en una fila plana:
   - Arriba, solo lo de primer nivel que tiene tareas en la pantalla (el plan y «Para coger»): cada altura y, si una altura tiene
     una sola cosa dentro (un edificio, un exterior), esa cosa en su lugar. Más «Sin espacio» si hay tareas sin espacio, para
     encontrarlas y ponérselo. Cada chip con su recuento de tareas (de todo lo que tiene debajo).
   - Al pulsar uno, filtra por él (con todo lo de dentro) y debajo salen sus hijos con tareas. Elegir un hijo filtra por el hijo;
     volver a pulsarlo, vuelta al padre. Si el hijo tiene hijos, otra fila. Pulsar otra vez el de arriba lo quita.
   - Varios de arriba marcados, lo que esté en cualquiera (OR); ninguno o todos (sin bajar a un hijo), se ve todo. Se recuerda en
     el dispositivo. Mientras filtra, lo apuntado «solo hoy» no se ve y el plan no se reordena (el orden es del plan entero). */
const TKH_SPACES_KEY='tasks.hoy.espacios',TKH_NONE='__none';
let tkhSpaceFocus=null;
function tkhSpaceSel(){try{const v=JSON.parse(localStorage.getItem(TKH_SPACES_KEY)||'[]');return new Set(Array.isArray(v)?v.filter(x=>typeof x==='string'):[])}catch(e){return new Set()}}
function tkhSpaceSave(set){try{localStorage.setItem(TKH_SPACES_KEY,JSON.stringify([...set]))}catch(e){}}
function tkhNode(id){return typeof spaceById==='function'?spaceById(id)||null:null}
function tkhSpacesOf(t){return [...new Set(t?.spaces||[])].filter(id=>tkhNode(id))}
function tkhSpaceName(id){return id===TKH_NONE?'Sin espacio':tkhNode(id)?.name||''}
/* Del espacio hacia arriba: [él, su padre, …, la raíz]. */
function tkhChain(id){const out=[];let n=tkhNode(id);while(n&&out.length<12){out.push(n.id);n=n.parentId?tkhNode(n.parentId):null}return out}
function tkhKids(id){return (typeof spaceRows==='function'?spaceRows():[]).filter(r=>r.parentId===id&&r.active!==false)}
/* El de primer nivel de un espacio: su altura, o lo único que hay en ella. */
function tkhTopOf(id){const chain=tkhChain(id),root=chain[chain.length-1];if(!root)return null;const r=tkhNode(root);
  if(r?.kind==='altura'){const kids=tkhKids(root);if(kids.length===1&&chain.includes(kids[0].id))return kids[0].id}
  return root}
function tkhByPlace(a,b){const x=tkhNode(a),y=tkhNode(b);return (Number(x?.position)||0)-(Number(y?.position)||0)||tkhSpaceName(a).localeCompare(tkhSpaceName(b),'es')}
/* Las tareas de la pantalla y, por nodo del árbol, cuántas tienen algo debajo de él. */
function tkhSpaceModel(){const tasks=[],seen=new Set(),add=t=>{if(!t||seen.has(t.id))return;seen.add(t.id);tasks.push(t)};
  for(const it of tkhItems())if(it.task_id)add(tkhFind(it.task_id)?.t);
  if(tkhCanPick())for(const x of tkhCandidates())add(x.t);
  const count=new Map(),tops=new Set();let none=0;
  for(const t of tasks){const spaces=tkhSpacesOf(t);if(!spaces.length){none++;continue}
    const nodes=new Set();for(const s of spaces){for(const n of tkhChain(s))nodes.add(n);const top=tkhTopOf(s);if(top)tops.add(top)}
    for(const n of nodes)count.set(n,(count.get(n)||0)+1)}
  if(none)count.set(TKH_NONE,none);
  const topList=[...tops].sort((a,b)=>tkhByPlace(tkhChain(a).at(-1),tkhChain(b).at(-1))||tkhByPlace(a,b));if(none)topList.push(TKH_NONE);
  return {count,tops:topList}}
/* Los hijos de un nodo que tienen tareas en la pantalla. */
function tkhChildren(m,id){if(id===TKH_NONE)return [];return tkhKids(id).map(k=>k.id).filter(k=>m.count.has(k)).sort(tkhByPlace)}
function tkhTopIdOf(m,id){return id===TKH_NONE?TKH_NONE:m.tops.find(t=>tkhChain(id).includes(t))||null}
function tkhSpaceFilter(){const m=tkhSpaceModel(),sel=new Set([...tkhSpaceSel()].filter(id=>m.count.has(id)&&tkhTopIdOf(m,id)));
  const on=sel.size>0&&!m.tops.every(t=>sel.has(t));
  const ids=[...sel].filter(id=>id!==TKH_NONE);
  return {...m,sel,on,match:t=>{if(!on)return true;const spaces=tkhSpacesOf(t);if(!spaces.length)return sel.has(TKH_NONE);return spaces.some(s=>{const c=tkhChain(s);return ids.some(id=>c.includes(id))})}}}
/* Lo marcado debajo de un nodo (él incluido). */
function tkhSelUnder(f,id){return [...f.sel].filter(s=>s===id||(id!==TKH_NONE&&s!==TKH_NONE&&tkhChain(s).includes(id)))}
function tkhPath(f,top){const deep=tkhSelUnder(f,top).sort((a,b)=>tkhChain(b).length-tkhChain(a).length)[0];if(!deep)return [];const c=tkhChain(deep);return c.slice(0,c.indexOf(top)+1).reverse()}
function tkhChip(f,id,parent){const under=tkhSelUnder(f,id),on=under.length>0,deep=under.find(s=>s!==id);
  const label=deep&&!parent?`${tkhSpaceName(id)} › ${tkhSpaceName(deep)}`:tkhSpaceName(id);
  return `<button type="button" class="tkh-space ${id===TKH_NONE?'none':''}" data-tkh-space="${esc(id)}" data-tkh-parent="${esc(parent||'')}" aria-pressed="${on?'true':'false'}" data-feedback-id="tasks.hoy.espacio" data-feedback-label="Filtrar por espacio">${on?'<span class="tkh-space-check" aria-hidden="true">✓</span>':''}${esc(label)} <span class="tkh-space-n">${f.count.get(id)||0}</span></button>`}
function tkhSpaceBar(f){if(f.tops.length<2)return '';
  // El de arriba abierto: el último tocado o, al volver (otra sesión), el primero que tiene un hijo marcado.
  const top=tkhSpaceFocus&&f.tops.includes(tkhSpaceFocus)&&tkhSelUnder(f,tkhSpaceFocus).length?tkhSpaceFocus:f.tops.find(t=>tkhSelUnder(f,t).some(x=>x!==t))||null;
  // Las filas de hijos: del de arriba que se ha tocado, bajando por lo marcado.
  const rows=[];if(top){let at=top;const path=tkhPath(f,top);for(let i=0;i<4&&at;i++){const kids=tkhChildren(f,at);if(!kids.length)break;
      rows.push(`<div class="scrollrow tkh-spaces tkh-spaces-sub" role="group" aria-label="${esc(`Dentro de ${tkhSpaceName(at)}`)}">${kids.map(k=>tkhChip(f,k,at)).join('')}</div>`);
      at=path.find(p=>kids.includes(p))||null}}
  return `<div class="ikisai-kit tkh-spaces-wrap"><div class="scrollrow tkh-spaces" id="tkhSpaces" role="group" aria-label="Filtrar por espacio">${f.tops.map(t=>tkhChip(f,t,'')).join('')}</div>${rows.join('')}</div>`}
/* Lo que se filtra, en una línea (role=status) con «Quitar filtro»: cada marcado con su camino desde arriba. */
function tkhSpaceLabel(f,id){if(id===TKH_NONE)return 'Sin espacio';const top=tkhTopIdOf(f,id),c=tkhChain(id);return c.slice(0,c.indexOf(top)+1).reverse().map(tkhSpaceName).join(' › ')}
function tkhSpaceNames(f){return [...f.sel].map(id=>tkhSpaceLabel(f,id)).sort((a,b)=>a.localeCompare(b,'es')).join(', ')}
function tkhClearButton(){return '<button type="button" class="linkbtn tkh-clear" data-tkh-clear data-feedback-id="tasks.hoy.espacio.quitar" data-feedback-label="Quitar filtro">Quitar filtro</button>'}
function tkhSpaceNotice(f){if(!f.on)return '';const none=f.sel.has(TKH_NONE)?' Sin espacio: ponles uno desde su ficha y saldrán en su sitio.':'';
  return `<p class="tkh-filtering" role="status">Solo ${esc(tkhSpaceNames(f))}.${none} Mientras filtras, lo apuntado «solo hoy» no se ve y el plan no se reordena. ${tkhClearButton()}</p>`}
function tkhSpaceClear(){tkhSpaceSave(new Set());tkhSpaceFocus=null;render();document.getElementById('tkhSpaces')?.querySelector('[data-tkh-space]')?.focus()}
/* Tocar uno de arriba: lo pone (y abre sus hijos) o, si ya estaba (él o algo suyo), lo quita. Tocar un hijo: filtra por él en
   lugar de su padre; volver a tocarlo, vuelta al padre. */
function tkhSpaceToggle(id,parent){const f=tkhSpaceFilter(),sel=f.sel;
  if(!parent){const under=tkhSelUnder(f,id);if(under.length){for(const s of under)sel.delete(s);if(tkhSpaceFocus===id)tkhSpaceFocus=null}else{sel.add(id);tkhSpaceFocus=id}}
  else{const was=sel.has(id);for(const s of tkhSelUnder(f,parent))sel.delete(s);sel.add(was?parent:id);tkhSpaceFocus=tkhTopIdOf(f,parent)}
  tkhSpaceSave(sel);render();
  [...document.querySelectorAll('[data-tkh-space]')].find(b=>b.dataset.tkhSpace===id&&b.dataset.tkhParent===(parent||''))?.focus()}
function tkhStrips(){const F=tkhSpaceFilter(),all=tkhCandidates().filter(x=>F.match(x.t)),seen=new Set(),take=(list,n=TKH_TAKE_STRIP)=>{const out=[];for(const x of list){if(out.length>=n)break;if(seen.has(x.t.id))continue;seen.add(x.t.id);out.push(x)}return out};
  const me=Sync.actor?.id;
  const touched=all.filter(x=>x.t.updatedBy&&x.t.updatedBy===me).sort((a,b)=>String(b.t.updatedAt||'').localeCompare(String(a.t.updatedAt||''))).map(x=>({...x,meta:`la tocaste ${tkhAgo(x.t.updatedAt)}`}));
  const steps=all.filter(x=>x.t.parentId).map(x=>{const kids=children(x.p,x.t.parentId),done=kids.filter(k=>k.done).length;return done?{...x,meta:`${done} de ${kids.length} pasos`}:null}).filter(Boolean);
  const others=all.filter(x=>x.t.updatedBy&&x.t.updatedBy!==me&&tkhDaysAgo(x.t.updatedAt)<=3).sort((a,b)=>String(b.t.updatedAt||'').localeCompare(String(a.t.updatedAt||''))).map(x=>{const d=tkhDaysAgo(x.t.updatedAt);return {...x,meta:`${tkhWho(x.t.updatedBy)}, ${d<=0?'hoy':d===1?'ayer':`hace ${d} días`}`}});
  const dated=take(all.filter(x=>x.t.due&&homeDayOf(x.t.due)!==null&&homeDayOf(x.t.due)<=0).sort((a,b)=>a.t.due.localeCompare(b.t.due)).map(x=>({...x,meta:homeDayOf(x.t.due)<0?'vencida':'para hoy'})));
  const going=take([...steps,...others]);
  // Lo más concreto (con fecha, en marcha) se queda en su tira; «Lo último que tocaste», con lo demás.
  return {all,touched:take(touched),going,dated}}
function tkhWhere(x){const mother=x.t.parentId?x.p.tasks.find(m=>m.id===x.t.parentId):null;return [x.p.system==='inbox'?'Entrada':x.p.title,mother?`↳ ${mother.text}`:''].filter(Boolean).join(' · ')}
function tkhCard(x,strip){return `<button type="button" class="tkh-card" data-tkh-take="${x.t.id}" data-tkh-strip="${strip}" aria-label="${esc(`Añadir a hoy: ${x.t.text}`)}" data-feedback-id="tasks.hoy.coger.tarjeta" data-feedback-label="Añadir a hoy"><span class="tkh-card-title">${esc(x.t.text)}</span><span class="tkh-card-meta">${esc(x.meta||tkhWhere(x))}</span><span class="tkh-card-where">${esc(tkhWhere(x))}</span><span class="tkh-card-add" aria-hidden="true">＋ Hoy</span></button>`}
function tkhStrip(title,key,list){if(!list.length)return '';return `<section class="tkh-strip" aria-label="${esc(title)}"><h3 class="tkh-strip-title">${esc(title)}</h3><div class="tkh-cards">${list.map(x=>tkhCard(x,key)).join('')}</div></section>`}
function tkhTake(){const s=tkhStrips(),byProject=new Map();for(const x of s.all){const k=x.area.id+'|'+x.p.id;if(!byProject.has(k))byProject.set(k,{area:x.area,p:x.p,list:[]});byProject.get(k).list.push(x)}
  const multi=activeAreas().length>1;
  const rest=[...byProject.values()].map(g=>`<section class="tkh-project"><h4 class="tkh-project-title">${esc(g.p.system==='inbox'?'Entrada':g.p.title)}${multi?` <span class="tkh-project-area">· ${esc(g.area.name)}</span>`:''}</h4><div class="tkh-cards wrap">${g.list.map(x=>tkhCard({...x,meta:x.t.due?dueInfo(x.t.due,false)?.label||'':''},'all')).join('')}</div></section>`).join('');
  return `<section class="tkh-take" aria-labelledby="tkhTakeTitle"><h2 class="tkh-h2" id="tkhTakeTitle">Para coger</h2>
    ${tkhStrip('Lo último que tocaste','touched',s.touched)}${tkhStrip('En marcha','going',s.going)}${tkhStrip('Con fecha','dated',s.dated)}
    ${s.all.length?`<details class="tkh-all" id="tkhAll" ${tkhOpenAll?'open':''}><summary data-feedback-id="tasks.hoy.coger.todo" data-feedback-label="Todo, por proyecto">Todo, por proyecto <span class="tkh-n">${s.all.length}</span></summary>${rest}</details>`:tkhSpaceFilter().on?`<p class="tkh-empty">Nada de este espacio para coger. ${tkhClearButton()}</p>`:'<p class="tkh-empty">No queda nada pendiente que puedas coger.</p>'}</section>`}
/* «De ayer quedaron N cosas sin hacer»: lo del último plan anterior que sigue sin hacer. */
function tkhLeftovers(){if(!tkhHasPlan())return null;const today=tkhDay(),plan=Sync.core.dayPlan(today);if(plan?.reviewed)return null;
  const prev=Sync.core.previousDayPlan(today);if(!prev)return null;const now=tkhItems(today);
  const items=tkhD().dayPlanItems(prev).filter(it=>it.task_id?(!tkhItemGone(it)&&!tkhItemDone(it)&&!tkhInPlan(it.task_id,now)&&tkhCanPick()):!it.done);
  return items.length?{prev,items}:null}
function tkhLeftoverText(l){const n=l.items.length,what=n===1?'quedó 1 cosa':`quedaron ${n} cosas`;return `${l.prev.day===isoDay(-1)?'De ayer':`Del ${fmtDate(l.prev.day)}`} ${what} sin hacer`}
function tkhRowNode(it){const K=IkisaiKit,hit=it.task_id?tkhFind(it.task_id):null,done=tkhItemDone(it),gone=tkhItemGone(it);
  const name=hit?hit.t.text:it.text||'',row=document.createElement('div');row.className=`tkh-row ${done?'done':''} ${gone?'gone':''} ${it.task_id?'':'solo'}`;row.dataset.tkhItem=it.id;
  const canCheck=it.task_id?(!!hit&&canEdit()):tkhCanWrite();
  const due=hit?.t.due?dueInfo(hit.t.due,done):null;
  const meta=gone?'Ya no está en tus áreas':hit?[tkhWhere(hit),due?due.label:''].filter(Boolean).join(' · '):'solo hoy';
  const open=hit?`<button type="button" class="tkh-open" data-tkh-open="${hit.t.id}" data-tkh-area="${hit.area.id}" data-feedback-id="tasks.hoy.plan.abrir" data-feedback-label="Abrir la tarea"><span class="tkh-text">${esc(name)}</span></button>`:`<span class="tkh-open"><span class="tkh-text">${esc(name||'Tarea')}</span></span>`;
  row.innerHTML=`<button type="button" class="tkh-check" role="checkbox" aria-checked="${done}" data-tkh-check="${it.id}" ${canCheck?'':'disabled'} aria-label="${esc(`Hecha: ${name}`)}" data-feedback-id="tasks.hoy.plan.hecha" data-feedback-label="Hecha">${done?'✓':''}</button><span class="ikisai-kit tkh-medal"></span><div class="tkh-body">${open}<span class="tkh-line"><span class="ikisai-kit tkh-face"></span><span class="tkh-meta ${due?.cls==='overdue'?'late':''}">${esc(meta)}</span></span>${hit?tkhPlaceChips(hit.t):''}${!it.task_id&&tkhCanPick()?`<button type="button" class="tkh-carry" data-tkh-carry="${it.id}" aria-label="${esc(`Llevar a…: ${name}`)}" data-feedback-id="tasks.hoy.plan.llevar" data-feedback-label="Llevar a…">Llevar a…</button>`:''}</div>${tkhCanWrite()?`<button type="button" class="tkh-remove" data-tkh-remove="${it.id}" aria-label="${esc(`Quitar del plan: ${name}`)}" data-feedback-id="tasks.hoy.plan.quitar" data-feedback-label="Quitar del plan">×</button>`:''}`;
  const medal=row.querySelector('.tkh-medal');
  if(hit){const color=hit.p.color||hit.area.color||null;medal.append(K.renderMedal({name:hit.p.system==='inbox'?'Entrada':hit.p.title,image:typeof fichaImageOf==='function'?fichaImageOf(hit.p,()=>{if(state.view==='today')render()}):null,color,size:32}));
    const key=hit.t.ownerPerson&&!(typeof levelOf==='function'&&levelOf(hit.t.ownerPerson))?hit.t.ownerPerson:hit.t.owner;const face=key&&typeof fichaFace==='function'?fichaFace(key,hit.area):null;
    if(face)row.querySelector('.tkh-face').append(K.renderMedal({...face,size:24,label:`Lo lleva ${face.name}`}));else row.querySelector('.tkh-face').remove()}
  else{medal.append(K.renderMedal({icon:'sun',size:32}));row.querySelector('.tkh-face').remove()}
  /* FB_2026_060: la portada de la tarea (la de su ficha) de fondo, bajo un velo del color del papel para que el texto se lea. */
  const cover=hit&&!gone&&typeof fichaImageOf==='function'?fichaImageOf(hit.t,()=>{if(state.view==='today')render()}):null;
  if(cover){row.classList.add('tkh-cover');row.style.setProperty('--tkh-cover',`url("${String(cover).replace(/"/g,'%22')}")`)}
  return row}
/* FB_2026_059: oficio y lugar de la tarea (los chips de Central y de Recursos, si la casa los usa); personas no. */
function tkhPlaceChips(t){const html=(typeof tradeChips==='function'?tradeChips(t.trades||[]):'')+(typeof spaceChips==='function'?spaceChips(t.spaces||[]):'');return html?`<span class="chips tkh-place">${html}</span>`:''}
function tkhView(){const F=tkhSpaceFilter(),all=tkhItems(),items=F.on?all.filter(it=>it.task_id&&F.match(tkhFind(it.task_id)?.t)):all,done=items.filter(it=>!tkhItemGone(it)&&tkhItemDone(it)).length,total=items.filter(it=>!tkhItemGone(it)).length,pick=tkhCanPick(),left=tkhLeftovers();
  const line=pick?`<form class="tkh-find" role="search" id="tkhFind" aria-label="Buscar o apuntar para hoy"><label class="tkh-vh" for="tkhInput">Busca una tarea o apunta algo para hoy</label><input id="tkhInput" type="search" autocomplete="off" enterkeyhint="done" maxlength="300" placeholder="Busca o apunta algo…" value="${esc(tkhQuery)}" data-feedback-id="tasks.hoy.buscar" data-feedback-label="Buscar o apuntar"><button type="submit" class="tkh-note" data-feedback-id="tasks.hoy.apuntar" data-feedback-label="Apuntar">Apuntar</button></form><p class="tkh-vh" aria-live="polite" id="tkhCount"></p><div id="tkhResults" class="tkh-results-box"></div>`
    :tkhCanWrite()?`<form class="tkh-find solo" id="tkhFind" aria-label="Apunta aquí lo tuyo"><label class="tkh-solo-label" for="tkhInput">Apunta aquí lo tuyo</label><input id="tkhInput" type="text" autocomplete="off" enterkeyhint="done" maxlength="300" placeholder="Algo que hacer hoy…" value="${esc(tkhQuery)}" data-feedback-id="tasks.hoy.apuntar_lector" data-feedback-label="Apunta aquí lo tuyo"><button type="submit" class="tkh-note" data-feedback-id="tasks.hoy.apuntar" data-feedback-label="Apuntar">Apuntar</button></form>`:'';
  return `<main class="screen tkh ${pick?'':'small'}"><section class="tkh-head">${tkhArc(done,total)}<div class="tkh-headtext"><h1 class="title">${esc(tkhDateLabel())}</h1><p class="subtitle">${pick?'Tu plan de hoy. Añade desde aquí o con ☀ en cualquier tarea.':'Tu plan de hoy. Apunta aquí lo tuyo.'}</p></div></section>
    ${tkhSpaceBar(F)}${tkhSpaceNotice(F)}
    ${line}
    ${left?`<section class="tkh-yesterday" aria-label="De ayer"><p>${esc(tkhLeftoverText(left))}</p><div class="tkh-yesterday-actions"><button type="button" class="primary" id="tkhBring" data-feedback-id="tasks.hoy.ayer.traer" data-feedback-label="Traer a hoy">Traer a hoy</button><button type="button" class="ghost" id="tkhLeave" data-feedback-id="tasks.hoy.ayer.dejar" data-feedback-label="Dejarlo">Dejarlo</button></div></section>`:''}
    <section class="tkh-plan" aria-labelledby="tkhPlanTitle"><h2 class="tkh-h2" id="tkhPlanTitle">Tu plan <span class="tkh-n">${tkhLeft(items)} por hacer</span></h2>${items.length?'<div class="ikisai-kit tkh-list" id="tkhList"></div>':F.on&&all.length?`<p class="tkh-empty">Nada de «${esc(tkhSpaceNames(F))}» en tu plan. ${tkhClearButton()}</p>`:`<p class="tkh-empty">${pick?'Todavía no hay nada. Busca arriba, toca ☀ en una tarea o coge algo de abajo.':'Todavía no hay nada. Apunta arriba lo que vas a hacer.'}</p>`}</section>
    ${pick?tkhTake():''}</main>`}
/* La pista de desplazamiento del kit (K4) en las filas .scrollrow: la instala createAppShell, que Tasks no usa; aquí, una vez
   sobre #view (vigila también las filas que aparecen en cada render). */
function tkhScrollHints(){const v=document.getElementById('view');if(!v||v.dataset.tkhHints||typeof window.IkisaiKit?.installScrollHints!=='function')return;
  try{window.IkisaiKit.installScrollHints(v);v.dataset.tkhHints='1'}catch(e){console.error(e)}}
function tkhMount(){tkhScrollHints();document.querySelectorAll('[data-tkh-space]').forEach(b=>b.onclick=()=>tkhSpaceToggle(b.dataset.tkhSpace,b.dataset.tkhParent||''));
  document.querySelectorAll('[data-tkh-clear]').forEach(b=>b.onclick=tkhSpaceClear);
  const host=document.getElementById('tkhList');tkhSortable=null;if(host){const F=tkhSpaceFilter(),items=tkhItems().filter(it=>!F.on||(it.task_id&&F.match(tkhFind(it.task_id)?.t)));
    tkhSortable=IkisaiKit.createSortableList({items,key:it=>it.id,name:it=>(it.task_id?tkhFind(it.task_id)?.t.text:it.text)||'Tarea',render:it=>tkhRowNode(it),label:'Tu plan de hoy',rowClass:'tkh-sortrow',buttons:false,disabled:!tkhCanWrite()||F.on,
      onReorder:list=>{if(tkhWrite(tkhD().planInOrder(tkhItems(),list.map(x=>x.id))))setTimeout(()=>{const f=document.activeElement;render();if(f?.classList.contains('sortable-handle')){const i=[...document.querySelectorAll('#tkhList .sortable-handle')];const k=list.findIndex(x=>x.id===f.closest('[data-key]')?.dataset.key);i[k]?.focus()}},0)}});
    host.replaceChildren(tkhSortable.element)}
  const input=document.getElementById('tkhInput');if(!input)return;
  document.getElementById('tkhFind').onsubmit=e=>{e.preventDefault();tkhNote(input.value)};
  input.oninput=()=>{tkhQuery=input.value;tkhResults()};
  tkhResults();
  const all=document.getElementById('tkhAll');if(all)all.ontoggle=()=>{tkhOpenAll=all.open}}
/* Buscar: por texto, sin acentos, en lo que puedo hacer; hasta 6 y «Apuntar «…» · solo para hoy». Solo la cifra va en vivo. */
function tkhResults(){const box=document.getElementById('tkhResults'),count=document.getElementById('tkhCount');if(!box)return;const q=tkhNorm(tkhQuery).trim();
  if(!q){box.replaceChildren();if(count)count.textContent='';return}
  const words=q.split(/\s+/),match=t=>{const s=tkhNorm(t.text);return words.every(w=>s.includes(w))};
  const already=tkhItems().map(it=>it.task_id?tkhFind(it.task_id):null).filter(h=>h&&match(h.t));
  const hits=tkhCandidates().filter(x=>match(x.t)).slice(0,6),text=tkhQuery.trim();
  box.innerHTML=`${already.length?`<p class="tkh-already">ya en tu plan: ${already.slice(0,3).map(h=>`«${esc(h.t.text)}»`).join(', ')}</p>`:''}<ul class="tkh-results" aria-label="Tareas que encajan">${hits.map(x=>`<li><button type="button" class="tkh-result" data-tkh-pick="${x.t.id}" data-feedback-id="tasks.hoy.buscar.tarea" data-feedback-label="Añadir a hoy"><span class="tkh-text">${esc(x.t.text)}</span><span class="tkh-meta">${esc(tkhWhere(x))}</span></button></li>`).join('')}<li><button type="button" class="tkh-result tkh-asnote" data-tkh-asnote data-feedback-id="tasks.hoy.buscar.apuntar" data-feedback-label="Apuntar solo para hoy">Apuntar «${esc(text)}» · solo para hoy</button></li></ul>`;
  if(count)count.textContent=hits.length===1?'1 tarea encaja':`${hits.length} tareas encajan`}
function tkhFocusInput(){setTimeout(()=>document.getElementById('tkhInput')?.focus(),0)}
function tkhPick(taskId){const hit=tkhFind(taskId);if(!hit)return;const before=tkhItems();
  let next;try{next=tkhD().planWithTask(before,{id:taskId,tab_id:hit.area.id})}catch(e){return toast(e.message)}
  if(!tkhWrite(next))return;tkhQuery='';render();tkhFocusInput();
  tkhUndo(`Para hoy: ${hit.t.text}. Su fecha no cambia.`,()=>{if(tkhWrite(before))render()})}
function tkhNote(value){const text=String(value||'').trim();if(!text){tkhFocusInput();return}const before=tkhItems();
  let next;try{next=tkhD().planWithText(before,text)}catch(e){return toast(e.message)}
  if(!tkhWrite(next))return;tkhQuery='';render();tkhFocusInput();
  tkhUndo(`Apuntado para hoy: ${text}`,()=>{if(tkhWrite(before))render()})}
/* «Para coger»: toda la tarjeta añade; el foco pasa a la siguiente. */
function tkhTakeCard(btn){const id=btn.dataset.tkhTake,strip=btn.dataset.tkhStrip,hit=tkhFind(id);if(!hit)return;
  const cards=[...document.querySelectorAll(`[data-tkh-strip="${strip}"]`)],at=cards.indexOf(btn),following=[...cards.slice(at+1),...cards.slice(0,at)].map(c=>c.dataset.tkhTake);
  const before=tkhItems();let next;try{next=tkhD().planWithTask(before,{id,tab_id:hit.area.id})}catch(e){return toast(e.message)}
  if(!tkhWrite(next))return;
  tkhRepaint(()=>{for(const k of following){const c=document.querySelector(`[data-tkh-take="${k}"][data-tkh-strip="${strip}"]`);if(c)return c}return document.querySelector('[data-tkh-take]')||document.getElementById('tkhInput')});
  tkhUndo(`Para hoy: ${hit.t.text}. Su fecha no cambia.`,()=>{if(tkhWrite(before))render()})}
function tkhRemove(itemId){const before=tkhItems(),it=before.find(x=>x.id===itemId);if(!it)return;
  if(!tkhWrite(tkhD().planWithout(before,itemId)))return;
  const after=tkhItems(),at=before.findIndex(x=>x.id===itemId),stay=after[Math.min(at,after.length-1)]?.id;
  tkhRepaint(()=>stay?document.querySelector(`[data-tkh-remove="${stay}"]`):document.getElementById('tkhInput'));
  tkhUndo('Fuera de tu plan de hoy. La tarea sigue donde estaba.',()=>{if(tkhWrite(before))tkhRepaint(`[data-tkh-remove="${itemId}"]`)})}
function tkhCheck(itemId){const items=tkhItems(),it=items.find(x=>x.id===itemId);if(!it)return;
  if(it.task_id){const hit=tkhFind(it.task_id);if(!hit||!canEdit())return;undoQuietly(hit.area.id,()=>toggleTask(it.task_id));tkhRepaint(`[data-tkh-check="${itemId}"]`);return}
  if(!tkhWrite(tkhD().planWithTextDone(items,itemId,!it.done)))return;tkhRepaint(`[data-tkh-check="${itemId}"]`);
  tkhUndo(it.done?'Vuelve a estar por hacer.':`Hecho: ${it.text}`,()=>{if(tkhWrite(tkhD().planWithTextDone(tkhItems(),itemId,!!it.done)))tkhRepaint(`[data-tkh-check="${itemId}"]`)})}
function tkhBring(){const l=tkhLeftovers();if(!l)return;const before=tkhItems();let next=before;
  try{for(const it of l.items)next=it.task_id?tkhD().planWithTask(next,{id:it.task_id,tab_id:it.tab_id??null}):tkhD().planWithText(next,it.text,undefined,it.tab_id??null)}catch(e){return toast(e.message)}
  if(!tkhWrite(next,{reviewed:true}))return;tkhRepaint('#tkhList .sortable-handle');
  const n=l.items.length;tkhUndo(n===1?'Traída a hoy 1 cosa de ayer.':`Traídas a hoy ${n} cosas de ayer.`,()=>{if(tkhWrite(before,{reviewed:false}))render()})}
function tkhLeave(){if(tkhWrite(tkhItems(),{reviewed:true}))tkhRepaint('#tkhInput')}

/* «Llevar a…»: área → proyecto → tarea madre, con «Ponerla aquí» en cada nivel. Crea la tarea con la forma de
   createInlineTask (editor-ui.js) y la fila del plan pasa a apuntarla. Con «Deshacer». */
function tkhCarry(itemId,level={}){const it=tkhItems().find(x=>x.id===itemId);if(!it||it.task_id||!tkhCanPick())return;
  const areas=activeAreas().filter(a=>a!==(typeof templateArea==='function'?templateArea():null));
  const area=level.area?areas.find(a=>a.id===level.area):null,p=area&&level.project?area.projects.find(x=>x.id===level.project&&!x.deleted&&x.status!=='archived'):null;
  const head=`<h2 class="sheettitle">Llevar a…</h2><p class="subtitle">«${esc(it.text)}» pasa a ser una tarea de verdad.</p>`;
  const opt=(attrs,label,sub='')=>`<button type="button" class="tkh-carryopt" ${attrs}><span>${esc(label)}</span>${sub?`<small>${esc(sub)}</small>`:''}<span aria-hidden="true">›</span></button>`;
  let body='';
  if(!area){body=`<p class="tkh-carrystep">Elige el área</p><div class="tkh-carrylist">${areas.map(a=>opt(`data-tkh-carry-area="${a.id}" data-feedback-id="tasks.hoy.llevar.area" data-feedback-label="Área"`,a.name)).join('')}</div>`}
  else if(!p){const inbox=area.projects.find(x=>x.system==='inbox'&&!x.deleted);const projects=area.projects.filter(x=>!x.deleted&&x.status!=='archived'&&!x.system);
    body=`<button type="button" class="tkh-carryback" data-tkh-carry-back="" data-feedback-id="tasks.hoy.llevar.volver" data-feedback-label="Volver">‹ Áreas</button><p class="tkh-carrystep">${esc(area.name)} · elige el proyecto</p>${inbox?`<button type="button" class="primary tkh-carryhere" data-tkh-carry-here="${area.id}|${inbox.id}|" data-feedback-id="tasks.hoy.llevar.aqui" data-feedback-label="Ponerla aquí">Ponerla aquí · Entrada de ${esc(area.name)}</button>`:''}<div class="tkh-carrylist">${projects.map(x=>opt(`data-tkh-carry-project="${area.id}|${x.id}" data-feedback-id="tasks.hoy.llevar.proyecto" data-feedback-label="Proyecto"`,x.title)).join('')||'<p class="tkh-empty">Sin proyectos en esta área.</p>'}</div>`}
  else{const mothers=p.tasks.filter(t=>!t.deleted&&!t.parentId&&status(p,t)!=='done');
    body=`<button type="button" class="tkh-carryback" data-tkh-carry-back="${area.id}" data-feedback-id="tasks.hoy.llevar.volver" data-feedback-label="Volver">‹ ${esc(area.name)}</button><p class="tkh-carrystep">${esc(p.title)} · dentro de una tarea, o aquí</p><button type="button" class="primary tkh-carryhere" data-tkh-carry-here="${area.id}|${p.id}|" data-feedback-id="tasks.hoy.llevar.aqui" data-feedback-label="Ponerla aquí">Ponerla aquí · ${esc(p.title)}</button><div class="tkh-carrylist">${mothers.map(t=>opt(`data-tkh-carry-here="${area.id}|${p.id}|${t.id}" data-feedback-id="tasks.hoy.llevar.madre" data-feedback-label="Dentro de esta tarea"`,t.text,'como paso')).join('')}</div>`}
  openSheet(head+body);
  const s=document.getElementById('sheet');if(!s)return;
  s.querySelectorAll('[data-tkh-carry-area]').forEach(b=>b.onclick=()=>tkhCarry(itemId,{area:b.dataset.tkhCarryArea}));
  s.querySelectorAll('[data-tkh-carry-project]').forEach(b=>b.onclick=()=>{const [a,x]=b.dataset.tkhCarryProject.split('|');tkhCarry(itemId,{area:a,project:x})});
  s.querySelectorAll('[data-tkh-carry-back]').forEach(b=>b.onclick=()=>tkhCarry(itemId,b.dataset.tkhCarryBack?{area:b.dataset.tkhCarryBack}:{}));
  s.querySelectorAll('[data-tkh-carry-here]').forEach(b=>b.onclick=()=>{const [a,x,m]=b.dataset.tkhCarryHere.split('|');tkhCarryTo(itemId,a,x,m||null)});
  s.querySelector('.tkh-carryopt,.tkh-carryhere')?.focus()}
function tkhCarryTo(itemId,areaId,projectId,parentId){const before=tkhItems(),it=before.find(x=>x.id===itemId);if(!it||it.task_id||!canEdit())return;
  let created=null;
  undoQuietly(areaId,()=>{const p=tab().projects.find(x=>x.id===projectId&&!x.deleted&&x.status!=='archived');if(!p)return toast('El proyecto ya no está disponible.');
    const parent=parentId?p.tasks.find(x=>x.id===parentId&&!x.deleted&&!x.parentId):null;
    const task={id:uid('t'),text:it.text,note:'',done:false,priority:'normal',due:'',owner:null,parentId:parent?parent.id:null,labels:[...(p.ownLabels||[])],attachments:[],dependsOn:[],order:Math.max(0,...p.tasks.map(x=>x.order||0))+1024,version:1};
    p.tasks.push(task);if(parent)syncParent(p,parent.id);syncAll(p);record('create',[task.id]);if(save()===false){p.tasks=p.tasks.filter(x=>x!==task);return}created=task});
  if(!created)return;
  const done=!!it.done;
  tkhWrite(tkhD().linkPlanItem(tkhItems(),itemId,{id:created.id,tab_id:areaId}));
  if(done)undoQuietly(areaId,()=>toggleTask(created.id));
  closeSheet();tkhRepaint(`[data-tkh-check="${itemId}"]`);
  tkhUndo(`Ahora es una tarea: ${created.text}`,()=>{undoQuietly(areaId,()=>{const loc=taskLocation(created.id);if(!loc||loc.t.deleted)return;const batch=uid('del');[loc.t,...children(loc.p,created.id)].forEach(x=>{x.deleted=true;x.deleteBatch=batch;x.deletedAt=new Date().toISOString();touch(x)});syncAll(loc.p);record('delete',[created.id]);save()});
    tkhWrite(tkhD().unlinkPlanItem(tkhItems(),it));render()})}

/* --- Enganches -------------------------------------------------------------------------------------------------------- */
const mainBeforeHoy=main;
main=function(){if(state.view==='today'){if(!tkhHasPlan()){state.view='home';persistUI();return mainBeforeHoy()}if(tab())return tkhView()}return mainBeforeHoy()};
const fabBeforeHoy=fab;
fab=function(){return state.view==='today'?'':fabBeforeHoy()};
const renderBeforeHoy=render;
/* Un repintado (también el que llega de la sincronización) no le quita el foco a un mando del plan ni a la línea. */
const TKH_KEEP=['tkhSun','tkhWhere','tkhLead','tkhCheck','tkhRemove','tkhTake','tkhStrip','tkhCarry'];
function tkhFocusKey(){const a=document.activeElement;if(!a||a===document.body)return null;if(a.id==='tkhInput')return {input:true,pos:a.selectionStart};
  const keys=TKH_KEEP.filter(k=>a.dataset?.[k]!==undefined);if(!keys.length||a.id==='tkhFichaSun')return null;
  return {sel:keys.map(k=>`[data-${k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())}="${CSS.escape(a.dataset[k])}"]`).join('')}}
render=function(...args){const keep=tkhFocusKey();
  const out=renderBeforeHoy(...args);
  if(state.view==='today'&&document.querySelector('#view main.tkh')){try{tkhMount()}catch(e){console.error(e)}}
  if(keep&&(document.activeElement===document.body||!document.activeElement?.isConnected)){
    if(keep.input){const i=document.getElementById('tkhInput');if(i){i.focus();if(keep.pos!=null)i.setSelectionRange(keep.pos,keep.pos)}}
    else document.querySelector(keep.sel)?.focus({preventScroll:true})}
  if(tab()){tkhBadge();tkhRefreshFicha()}return out};
/* La cifra de lo que queda, en la pestaña «Hoy». */
function tkhBadge(){const b=document.querySelector('#shellBottom .navbtn[data-nav="today"]');if(!b)return;
  if(!tkhHasPlan()){b.hidden=true;return}b.hidden=false;const n=tkhLeft();let badge=b.querySelector('.badge');
  if(n){if(!badge){badge=document.createElement('span');badge.className='badge tkh-badge';badge.setAttribute('aria-hidden','true');b.append(badge)}badge.textContent=String(n)}else badge?.remove();
  b.setAttribute('aria-label',n?`Hoy, ${n} por hacer`:'Hoy')}
/* Con el plan cambiado en otro dispositivo (llega por la sincronización), se vuelve a pintar. */
let tkhStamp='';
function tkhPlanStamp(){try{const p=tkhHasPlan()?Sync.core.dayPlan(tkhDay()):null;return p?`${p.id}|${JSON.stringify(tkhD().dayPlanItems(p).map(i=>[i.id,i.task_id||null,i.text||null,!!i.done]))}|${!!p.reviewed}`:''}catch{return ''}}
const refreshModelBeforeHoy=refreshModel;
refreshModel=function(){refreshModelBeforeHoy();const stamp=tkhPlanStamp();if(stamp===tkhStamp)return;tkhStamp=stamp;
  if(document.getElementById('sheetBack')?.classList.contains('show')){tkhBadge();tkhRefreshFicha();return}
  if(Sync.actor&&state.tabs?.some(t=>!t.deleted))render()};
/* Lo que se toca aquí cuenta como tocado por mí («Lo último que tocaste») antes de que llegue del servidor. */
const touchBeforeHoy=touch;
touch=function(t){touchBeforeHoy(t);if(t&&Sync.actor?.id)t.updatedBy=Sync.actor.id};

document.addEventListener('click',e=>{const t=e.target;if(!t?.closest)return;
  const sun=t.closest('[data-tkh-sun]');if(sun){e.preventDefault();e.stopPropagation();return tkhToggleTask(sun.dataset.tkhSun,sun.dataset.tkhWhere||'row')}
  const lead=t.closest('[data-tkh-lead]');if(lead){e.preventDefault();return tkhLead(lead.dataset.tkhLead)}
  if(!t.closest('#view main.tkh'))return;
  const pick=t.closest('[data-tkh-pick]');if(pick)return tkhPick(pick.dataset.tkhPick);
  if(t.closest('[data-tkh-asnote]'))return tkhNote(document.getElementById('tkhInput')?.value);
  const take=t.closest('[data-tkh-take]');if(take)return tkhTakeCard(take);
  const rm=t.closest('[data-tkh-remove]');if(rm)return tkhRemove(rm.dataset.tkhRemove);
  const check=t.closest('[data-tkh-check]');if(check)return tkhCheck(check.dataset.tkhCheck);
  const open=t.closest('[data-tkh-open]');if(open)return openHomeTask(open.dataset.tkhOpen,open.dataset.tkhArea);
  const carry=t.closest('[data-tkh-carry]');if(carry)return tkhCarry(carry.dataset.tkhCarry);
  if(t.closest('#tkhBring'))return tkhBring();
  if(t.closest('#tkhLeave'))return tkhLeave()},true);
