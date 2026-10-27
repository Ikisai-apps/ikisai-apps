/* Inicio (MUELA-055, con lo que quita y añade el 073; tanda 31): portada del área o de «General» con las cifras de color del kit
   (renderStats: pendientes, vencidas, para hoy, bloqueadas, hechas esta semana y % hecho), filtros por área y por persona,
   «Lo primero» y «La cola» (renderLead: las tres más urgentes en grande con «✓ Hecha», «Abrir» y «⋯ Mover a…», y el resto
   numerado, en el orden de priorityOf, home-priority.js). Después, los bloques de siempre: proyectos (con su coste solo para
   quien ve importes, costs-ui.js), la semana (días en hora local; tocar un punto abre «Mover a…», que cambia la FECHA, sin
   arrastre), carga por persona, dónde se acumula (el calor filtra Tareas), bloqueos, actividad y atajos con vistas y
   plantillas. «Queda poco» lo sigue poniendo purchases-ui.js arriba, para las mismas personas. La lectora no tiene controles
   que cambien nada. Quien viene de fuera (outsider) tiene su propio Inicio, «Mi trabajo» (MUELA-083 §2). */
const HOME_DAYS=['dom','lun','mar','mié','jue','vie','sáb'];
function homeToday(){const d=new Date();d.setHours(0,0,0,0);return d}
function homeDayOf(due){const d=new Date(due+'T00:00:00');if(isNaN(d))return null;return Math.round((d-homeToday())/86400000)}
/* El día en hora local (no con toISOString, que en España lo daba en UTC: el de antes de medianoche). */
function isoDay(offset){const d=homeToday();d.setDate(d.getDate()+offset);const pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`}
function homeTasks(){const rows=[];for(const area of areasForTasks())withArea(area.id,()=>{for(const p of tab().projects.filter(p=>!p.deleted&&p.status!=='archived'))for(const t of p.tasks.filter(t=>!t.deleted))rows.push({area,p,t,done:status(p,t)==='done',leaf:!children(p,t.id).length,blocked:dependencyBlockers(t,p),prio:effectivePriority(p,t)})});return rows}
function ringSvg(pct,size,label){return `<svg class="ring" viewBox="0 0 36 36" style="width:${size}px;height:${size}px" role="img" aria-label="${esc(label||pct+' por ciento')}"><circle class="track" cx="18" cy="18" r="15.9"></circle><circle class="value" cx="18" cy="18" r="15.9" stroke-dasharray="${pct} ${100-pct}" stroke-dashoffset="25"></circle><text x="18" y="21.5" text-anchor="middle">${pct}%</text></svg>`}
function hexRgb(hex){const m=/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex||'');return m?[parseInt(m[1],16),parseInt(m[2],16),parseInt(m[3],16)].join(','):'104,112,74'}
function homeTaskRow(r){const due=r.t.due?dueInfo(r.t.due,false):null;return `<button type="button" class="hometask" data-home-task="${r.t.id}" data-home-area="${r.area.id}" data-feedback-id="tasks.inicio.ahora.tarea" data-feedback-label="Tarea">${r.prio!=='normal'?priorityStar(r.prio):'<span class="star-slot"></span>'}<span class="hometext">${esc(r.t.text)}</span><span class="homeproject-name">${esc(r.p.title)}${areasForTasks().length>1?' · '+esc(r.area.name):''}</span>${due?`<span class="due ${due.cls}">${esc(due.label)}</span>`:''}</button>`}

/* Personas de una tarea, para «Carga por persona» y el filtro: las etiquetas de la familia Persona y, con las personas de
   Central, las de la tarea y su responsable (sin los grupos por nivel). Clave → nombre. */
function homePeopleOf(r){const out=new Map();
  for(const f of personFamilies(r.area))for(const id of r.t.labels||[]){const l=r.area.labels.find(l=>l.id===id&&l.family===f.id&&!l.archived);if(l)out.set('l:'+l.text.trim().toLocaleLowerCase(),l.text.trim())}
  if(typeof peopleMode==='function'&&peopleMode())for(const k of [...(r.t.people||[]),r.t.ownerPerson].filter(Boolean)){if(levelOf(k)||!personById(k))continue;out.set('p:'+k,personFull(k))}
  return out}
/* El filtro de persona es de este dispositivo y de esta pantalla (no cambia los filtros de Tareas). */
let homePerson='';
let homeData=null;
/* «para hoy» cuenta también lo puesto en el plan de hoy con el sol, no solo lo que vence hoy (FB_2026_074). hoy-ui.js se carga
   después: se mira al pintar. */
function homePlanIds(){try{return new Set(typeof tkhItems==='function'?tkhItems().map(it=>it.task_id).filter(Boolean):[])}catch{return new Set()}}
function homeView(){
  if(typeof outsiderMode==='function'&&outsiderMode())return outsiderHomeView();
  const areas=areasForTasks(),single=areas.length===1?areas[0]:null,all=homeTasks(),today=isoDay(0);
  const peopleNames=new Map();for(const r of all)for(const [k,n] of homePeopleOf(r))if(!peopleNames.has(k))peopleNames.set(k,n);
  if(homePerson&&!peopleNames.has(homePerson))homePerson='';
  const rows=homePerson?all.filter(r=>homePeopleOf(r).has(homePerson)):all;
  const leaves=rows.filter(r=>r.leaf),pendingRows=rows.filter(r=>!r.done),planIds=homePlanIds();
  const overdue=pendingRows.filter(r=>r.t.due&&homeDayOf(r.t.due)<0),dueToday=pendingRows.filter(r=>(r.t.due&&homeDayOf(r.t.due)===0)||planIds.has(r.t.id)),doneWeek=rows.filter(r=>r.done&&r.t.updatedAt&&Date.now()-new Date(r.t.updatedAt).getTime()<7*86400000);
  const blockedRows=pendingRows.filter(r=>r.blocked.length);
  const progressPct=leaves.length?Math.round(100*leaves.filter(r=>r.done).length/leaves.length):0,pendingLeaves=leaves.filter(r=>!r.done).length;
  const dateLabel=new Intl.DateTimeFormat('es-ES',{weekday:'long',day:'numeric',month:'long'}).format(new Date());
  // La cola: hojas pendientes y no bloqueadas, de más a menos urgente (home-priority.js).
  const blocking=new Map();for(const r of pendingRows)for(const id of r.blocked)blocking.set(id,(blocking.get(id)||0)+1);
  const queue=homeQueue(pendingRows.filter(r=>r.leaf),today,Date.now(),r=>({done:r.done,blocked:r.blocked.length,due:r.t.due||'',prio:r.prio,blocksOthers:blocking.get(r.t.id)||0,updatedAt:r.t.updatedAt,title:r.t.text}));
  homeData={areas,rows,queue,stats:{pendingLeaves,overdue:overdue.length,dueToday:dueToday.length,blocked:blockedRows.length,doneWeek:doneWeek.length,progressPct}};
  // Proyectos con anillo (el coste solo para quien ve importes: projectCost da 0 a los demás).
  const projects=[];for(const area of areas)withArea(area.id,()=>{for(const p of activeProjects().filter(p=>!p.system||p.tasks.some(t=>!t.deleted)))projects.push({area,p,pct:progress(p),pend:pending(p),urg:projectPriority(p),blocked:p.tasks.filter(t=>!t.deleted&&!t.done&&dependencyBlockers(t,p).length).length,cost:typeof projectCost==='function'?projectCost(p):0})});
  // Semana.
  const days=[...Array(7)].map((_,i)=>({offset:i,iso:isoDay(i),items:pendingRows.filter(r=>r.t.due&&homeDayOf(r.t.due)===i)}));
  // Personas.
  const people=new Map();for(const r of rows)for(const [key,name] of homePeopleOf(r)){const e=people.get(key)||{name,pend:0,done:0};r.done?e.done++:e.pend++;people.set(key,e)}
  const peopleRows=[...people.values()].sort((a,b)=>b.pend-a.pend);const peopleMax=Math.max(1,...peopleRows.map(x=>x.pend+x.done));
  // Oficios y demás familias: calor por pendientes.
  const heat=[];for(const area of areas){for(const f of area.families.filter(f=>!f.archived&&!personFamilies(area).includes(f))){const cells=area.labels.filter(l=>l.family===f.id&&!l.archived).map(l=>({id:l.id,fid:f.id,area:area.id,text:labelName(l),n:pendingRows.filter(r=>r.area===area&&(r.t.labels||[]).includes(l.id)).length})).filter(c=>c.n);if(cells.length)heat.push({name:f.name+(areas.length>1?' · '+area.name:''),color:f.color,cells})}}
  const heatMax=Math.max(1,...heat.flatMap(h=>h.cells.map(c=>c.n)));
  const blocked=blockedRows.slice(0,8);
  const views=single?(single.views||[]).filter(v=>!v.deleted):[],templates=typeof templateProjects==='function'?templateProjects():[];
  const dot=r=>`<button type="button" class="weekdot prio-${r.prio}" data-home-week="${r.t.id}" data-home-area="${r.area.id}" title="${esc(r.t.text)}" aria-label="${esc(r.t.text)}${canEdit()?': abrir o mover a otro día':''}" data-feedback-id="tasks.inicio.semana.tarea" data-feedback-label="Tarea de la semana"></button>`;
  const areaSelect=`<label class="inicio-filter"><span>Área</span><select data-field-id="tasks.inicio.filtros.area" id="homeArea" data-feedback-id="tasks.inicio.filtros.area" data-feedback-label="Área">${activeAreas().map(t=>`<option value="${t.id}" ${state.taskScope!=='all'&&t.id===state.activeTab?'selected':''}>${esc(t.name)}</option>`).join('')}<option value="*" ${state.taskScope==='all'?'selected':''}>General · todas las áreas</option></select></label>`;
  const personSelect=peopleNames.size?`<label class="inicio-filter"><span>Persona</span><select data-field-id="tasks.inicio.filtros.persona" id="homePerson" data-feedback-id="tasks.inicio.filtros.persona" data-feedback-label="Persona"><option value="">Todas</option>${[...peopleNames].sort((a,b)=>a[1].localeCompare(b[1],'es')).map(([k,n])=>`<option value="${esc(k)}" ${k===homePerson?'selected':''}>${esc(n)}</option>`).join('')}</select></label>`:'';
  return `<main class="screen home"><section class="homehead" style="${single?.color?colorVars(single.color):''}"><div class="hometitle"><h1 class="title">${single?esc(single.name):'General'}</h1><p class="subtitle">${esc(dateLabel)}${areas.length>1?' · '+areas.length+' áreas':''}${homePerson?' · '+esc(peopleNames.get(homePerson)||''):''}</p></div></section>
  <div class="inicio-filters">${areaSelect}${personSelect}</div>
  <div class="ikisai-kit inicio-stats" id="homeStats"></div>
  <div class="ikisai-kit inicio-lead" id="homeLead"></div>
  <section class="homecard homeprojects"><h2 class="homecard-title">Proyectos</h2><div class="homeprojectgrid">${projects.length?projects.map(x=>`<button type="button" class="homeproject ${x.p.color?'colored':''}" style="${x.p.color?colorVars(x.p.color):''}" data-home-project="${x.p.id}" data-home-area="${x.area.id}" data-feedback-id="tasks.inicio.proyectos.proyecto" data-feedback-label="Proyecto">${ringSvg(x.pct,48,x.p.title+' al '+x.pct+' por ciento')}<span class="homeproject-body"><span class="homeproject-title">${x.urg!=='normal'?priorityStar(x.urg):''}${esc(x.p.title)}</span><span class="homeproject-meta">${x.pend} pendientes${x.blocked?` · ${x.blocked} bloqueadas`:''}${x.cost?` · ${money(x.cost)}`:''}${areas.length>1?' · '+esc(x.area.name):''}</span></span></button>`).join(''):'<p class="muted small">Sin proyectos activos.</p>'}</div></section>
  <section class="homecard homeweek"><h2 class="homecard-title">Semana <span class="small muted">${canEdit()?'toca un punto para abrir la tarea o moverla a otro día':'toca un punto para abrir la tarea'}</span></h2><div class="weekgrid"><div class="weekday overdue ${overdue.length?'has':''}" data-home-day="overdue"><span class="weeklabel">Vencidas</span><strong>${overdue.length}</strong>${overdue.slice(0,6).map(dot).join('')}</div>${days.map(d=>{const dt=new Date(d.iso+'T00:00:00');return `<div class="weekday ${d.offset===0?'today':''}" data-home-day="${d.iso}"><span class="weeklabel">${d.offset===0?'Hoy':HOME_DAYS[dt.getDay()]+' '+dt.getDate()}</span><strong>${d.items.length||''}</strong>${d.items.slice(0,8).map(dot).join('')}${d.items.length>8?`<span class="small muted">+${d.items.length-8}</span>`:''}</div>`}).join('')}</div></section>
  <section class="homecard homepeople"><h2 class="homecard-title">Carga por persona</h2>${peopleRows.length?peopleRows.map(x=>`<div class="personrow"><span class="personname" data-feedback-ignore>${esc(x.name)}</span><div class="personbar"><span class="pend" style="width:${Math.round(100*x.pend/peopleMax)}%"></span><span class="donepart" style="width:${Math.round(100*x.done/peopleMax)}%"></span></div><span class="personnums"><strong>${x.pend}</strong> · ${x.done} hechas</span></div>`).join(''):'<p class="muted small">Sin tareas asignadas a personas.</p>'}</section>
  <section class="homecard homeheat"><h2 class="homecard-title">Dónde se acumula el trabajo</h2>${heat.length?heat.map(h=>`<div class="heatfamily"><span class="heatname"><span class="dot" style="background:${esc(h.color)}"></span>${esc(h.name)}</span><div class="heatcells">${h.cells.sort((a,b)=>b.n-a.n).map(c=>`<button type="button" class="heat" style="background:rgba(${hexRgb(h.color)},${(0.18+0.72*c.n/heatMax).toFixed(2)});color:${c.n/heatMax>0.5?'#fff':'inherit'}" data-home-filter="${c.fid}|${c.id}" data-home-area="${c.area}" title="${c.n} pendientes" data-feedback-id="tasks.inicio.carga.etiqueta" data-feedback-label="Etiqueta con pendientes">${esc(c.text)}<strong>${c.n}</strong></button>`).join('')}</div></div>`).join(''):'<p class="muted small">Sin pendientes con etiquetas.</p>'}</section>
  <section class="homecard homeblocked"><h2 class="homecard-title">Bloqueos</h2>${blocked.length?blocked.map(r=>`<div class="blockrow"><button type="button" class="hometask" data-home-task="${r.t.id}" data-home-area="${r.area.id}" data-feedback-id="tasks.inicio.bloqueos.tarea" data-feedback-label="Tarea bloqueada"><span class="hometext">${esc(r.t.text)}</span><span class="homeproject-name">${esc(r.p.title)}</span></button><span class="blockby">espera a ${r.blocked.map(id=>{const name=withArea(r.area.id,()=>dependencyText(id));return id==='hidden-dependency'?esc(name):`<button type="button" class="linkbtn" data-home-task="${id}" data-home-area="${r.area.id}" data-feedback-id="tasks.inicio.bloqueos.bloqueante" data-feedback-label="Tarea que bloquea">${esc(name)}</button>`}).join(', ')}</span></div>`).join(''):'<p class="muted small">Nada bloqueado.</p>'}</section>
  <section class="homecard homeactivity"><h2 class="homecard-title">Actividad</h2><div id="homeActivity"><div class="skeleton" aria-busy="true" aria-label="Cargando actividad"><span></span><span></span><span></span></div></div></section>
  <section class="homecard homeshortcuts"><h2 class="homecard-title">Atajos</h2><div class="shortcuts">${views.map(v=>`<button type="button" class="viewpill" data-quick-view="${v.id}" data-feedback-id="tasks.inicio.atajos.vista" data-feedback-label="Vista guardada">${menuIcon('view')}${esc(v.name)}</button>`).join('')}${templates.map(p=>`<button type="button" class="viewpill" data-home-template="${p.id}" data-feedback-id="tasks.inicio.atajos.plantilla" data-feedback-label="Plantilla">${menuIcon('template')}${esc(p.title)}</button>`).join('')}${!views.length&&!templates.length?'<p class="muted small">Guarda una vista o una plantilla y aparecerá aquí.</p>':''}</div></section></main>`}

/* Cifras y «Lo primero» con las piezas del kit, montadas tras pintar. */
function mountHome(){const d=homeData,K=IkisaiKit;if(!d)return;
  const s=d.stats,stats=document.getElementById('homeStats');
  if(stats)stats.replaceChildren(K.renderStats([
    {value:s.pendingLeaves,label:'pendientes',feedbackId:'tasks.inicio.cifras.pendientes'},
    {value:s.overdue,label:'vencidas',tone:s.overdue?'alert':null,feedbackId:'tasks.inicio.cifras.vencidas'},
    {value:s.dueToday,label:'para hoy',tone:s.dueToday?'warn':null,feedbackId:'tasks.inicio.cifras.hoy'},
    {value:s.blocked,label:'bloqueadas',tone:s.blocked?'warn':null,feedbackId:'tasks.inicio.cifras.bloqueadas'},
    {value:s.doneWeek,label:'hechas esta semana',tone:'ok',feedbackId:'tasks.inicio.cifras.hechas'},
    {value:s.progressPct+'%',label:'hecho',hint:s.pendingLeaves?null:'todo al día',feedbackId:'tasks.inicio.cifras.progreso'},
  ],{label:'Cómo va'}));
  const lead=document.getElementById('homeLead');if(!lead)return;
  const max=Math.max(1,...d.queue.map(x=>x.score)),multi=d.areas.length>1,edit=canEdit();
  const items=d.queue.map(({item:r,score})=>{const due=r.t.due?dueInfo(r.t.due,false):null,color=r.p.color||r.area.color||null;
    const owner=r.t.ownerPerson&&typeof personFull==='function'&&!levelOf(r.t.ownerPerson)&&personById(r.t.ownerPerson)?personFull(r.t.ownerPerson):null;
    return {id:`${r.area.id}|${r.t.id}`,title:r.t.text,where:`${r.p.title}${multi?' · '+r.area.name:''}`,due:due?.label||null,tone:due?.cls==='overdue'?'alert':due?.cls==='today'?'warn':null,color,
      who:owner?{name:owner}:null,medal:{name:r.p.title,color},weight:score/max}});
  const split=item=>item.id.split('|');
  lead.replaceChildren(K.renderLead({title:'Lo primero',items,top:3,max:5,feedbackId:'tasks.inicio.lo_primero',emptyText:'Nada pendiente que pida atención: todo está hecho o bloqueado.',
    onOpen:item=>{const [area,id]=split(item);openHomeTask(id,area)},
    ...(edit?{onDone:item=>{const [area,id]=split(item);homeDone(area,id)},
      extra:item=>[K.el('button',{type:'button',class:'ghost lead-btn','aria-label':`Mover a otro día: ${item.title}`,'data-feedback-id':'tasks.inicio.lo_primero.mover','data-feedback-label':'Mover a…',onclick:()=>{const [area,id]=split(item);homeMoveSheet(area,id)}},'⋯ Mover a…')]}:{})}));
}
/* «✓ Hecha» desde Inicio, también de otra área (General): en su área, con un solo pintado al final y su «Deshacer». */
function homeDone(area,id){if(!canEdit())return;undoQuietly(area,()=>{const loc=taskLocation(id);if(loc&&status(loc.p,loc.t)!=='done')toggleTask(id)})}
/* «Mover a…» cambia la FECHA de la tarea (no el proyecto): hoy, mañana, los próximos días, otro día o sin fecha. */
function homeMoveSheet(area,id){const loc=withArea(area,()=>taskLocation(id));if(!loc)return;if(!canEdit())return openHomeTask(id,area);
  const options=[[isoDay(0),'Hoy'],[isoDay(1),'Mañana'],...[2,3,4,5,6].map(i=>{const d=new Date(isoDay(i)+'T00:00:00');return [isoDay(i),`${HOME_DAYS[d.getDay()]} ${d.getDate()}`]}),[isoDay(7),'Dentro de una semana']];
  openSheet(`<h2 class="sheettitle">Mover a…</h2><p class="subtitle">${esc(loc.t.text)} · cambia la fecha${loc.t.due?' (ahora: '+esc(dueInfo(loc.t.due,false)?.label||loc.t.due)+')':''}</p><div class="inicio-days">${options.map(([v,l])=>`<button type="button" class="softbtn ${v===loc.t.due?'on':''}" data-home-move="${v}" aria-pressed="${v===loc.t.due}" data-feedback-id="tasks.inicio.mover.dia" data-feedback-label="Mover a un día">${esc(l)}</button>`).join('')}</div><div class="field"><label for="homeMoveDate">Otro día</label><input data-field-id="tasks.inicio.mover.fecha" data-field-entity="tasks.tasks" data-field-prop="due" type="date" id="homeMoveDate" value="${esc(loc.t.due||'')}" data-feedback-id="tasks.inicio.mover.fecha" data-feedback-label="Otro día"></div><div class="actions"><button type="button" class="ghost" id="homeMoveNone" ${loc.t.due?'':'disabled'} data-feedback-id="tasks.inicio.mover.sin_fecha" data-feedback-label="Sin fecha">Sin fecha</button><button type="button" class="ghost" id="homeMoveOpen" data-feedback-id="tasks.inicio.mover.abrir" data-feedback-label="Abrir la tarea">Abrir la tarea</button><button type="button" class="primary" id="homeMoveSave" data-feedback-id="tasks.inicio.mover.guardar" data-feedback-label="Guardar la fecha">Guardar</button></div>`);
  const apply=value=>{if(!canEdit())return;let changed=false;undoQuietly(area,()=>{const now=taskLocation(id);if(!now||(now.t.due||'')===value)return;now.t.due=value;touch(now.t);record('edit',[id]);changed=save()!==false});closeSheet();if(changed)toast(value?'Fecha cambiada: '+(dueInfo(value,false)?.label||value):'Sin fecha')};
  document.querySelectorAll('[data-home-move]').forEach(b=>b.onclick=()=>apply(b.dataset.homeMove));
  document.getElementById('homeMoveSave').onclick=()=>{const v=document.getElementById('homeMoveDate').value;if(!v)return toast('Elige un día.');apply(v)};
  document.getElementById('homeMoveNone').onclick=()=>apply('');
  document.getElementById('homeMoveOpen').onclick=()=>{closeSheet();openHomeTask(id,area)}}

async function fillHomeActivity(){const box=document.getElementById('homeActivity');if(!box)return;try{const data=await api('history'),events=(data.events||[]).slice().sort((a,b)=>b.cursor-a.cursor).slice(0,6);if(!document.getElementById('homeActivity'))return;box.innerHTML=events.length?events.map(e=>`<div class="activityrow"><span class="activitywho" data-feedback-ignore>${esc(e.actorName||e.actor)}</span><span class="activitywhat">${(e.delta||[]).slice(0,2).map(p=>esc(eventTitle(p))).join(' · ')||'Cambio'}</span><span class="activitywhen">${esc(new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(e.at)))}</span></div>`).join(''):'<p class="muted small">Sin actividad todavía.</p>'}catch(e){box.innerHTML='<p class="muted small">Historial no disponible sin conexión.</p>'}}
function openHomeTask(id,area){state.activeTab=area;const loc=taskLocation(id);if(!loc)return;state.currentProject=loc.p.id;openTaskEditor(id)}

/* --- «Mi trabajo»: el Inicio de quien viene de fuera (MUELA-083 §2) ---------------------------------------------------- */
/* Sus tareas: donde está en Personas o es responsable (myPerson(): su ficha de Central). Sin ficha, solo donde es responsable
   (la etiqueta de responsable con su nombre). */
function outsiderIsMine(t){const me=typeof myPerson==='function'?myPerson():null,name=(Sync.actor?.name||'').trim().toLocaleLowerCase();
  if(me&&((t.people||[]).includes(me.person_id)||t.ownerPerson===me.person_id))return true;
  const owner=t.owner?label(t.owner):null;return !!name&&!!owner&&owner.text.trim().toLocaleLowerCase()===name}
function outsiderMine(){const out=[];
  for(const area of activeAreas())withArea(area.id,()=>{for(const p of tab().projects.filter(p=>!p.deleted&&p.status!=='archived'))for(const t of p.tasks.filter(t=>!t.deleted))if(outsiderIsMine(t)&&status(p,t)!=='done')out.push({area,p,t})});
  return out.sort((a,b)=>(a.t.due||'9999').localeCompare(b.t.due||'9999')||a.t.text.localeCompare(b.t.text,'es'))}
const PROPOSAL_STATE={pending:'Pendiente',approved:'Aprobada',rejected:'Descartada',withdrawn:'Retirada'};
function outsiderHomeView(){
  const name=(Sync.actor?.name||(typeof myPerson==='function'?myPerson()?.name:'')||'').trim().split(/\s+/)[0];
  const mine=outsiderMine(),projects=typeof proposableProjects==='function'?proposableProjects():[];
  const row=x=>{const due=x.t.due?dueInfo(x.t.due,false):null,place=(x.t.spaces||[]).length&&typeof spaceShort==='function'?spaceShort(x.t.spaces[0]):'',n=typeof commentCount==='function'?commentCount(x.t.id):0;
    return `<li class="inicio-mine"><button type="button" class="softbtn inicio-done" data-out-done="${x.t.id}" data-home-area="${x.area.id}" aria-label="Marcar hecha: ${esc(x.t.text)}" data-feedback-id="tasks.inicio.mi_trabajo.hecha" data-feedback-label="Hecha">✓ Hecha</button><button type="button" class="inicio-minetext" data-home-task="${x.t.id}" data-home-area="${x.area.id}" data-feedback-id="tasks.inicio.mi_trabajo.tarea" data-feedback-label="Abrir la tarea"><strong>${esc(x.t.text)}</strong><span class="small muted">${[esc(x.p.title),place?esc(place):'',due?`<span class="due ${due.cls}">${esc(due.label)}</span>`:'',n?`💬 ${n}`:''].filter(Boolean).join(' · ')}</span></button></li>`};
  return `<main class="screen home inicio-outsider"><section class="homehead"><div class="hometitle"><h1 class="title">Hola${name?', '+esc(name):''}</h1><p class="subtitle">Tu trabajo en Ikisai. Lo que propongas lo deciden staff o dirección.</p></div></section>
  <button type="button" class="primary inicio-propose" id="homePropose" data-feedback-id="tasks.inicio.mi_trabajo.proponer" data-feedback-label="Proponer algo">＋ Proponer algo</button>
  <section class="homecard"><h2 class="homecard-title">Tus tareas${mine.length?` <span class="small muted">${mine.length}</span>`:''}</h2>${mine.length?`<ul class="inicio-minelist">${mine.map(row).join('')}</ul>`:'<p class="muted small">Ahora no tienes tareas abiertas. Cuando te pongan en una, saldrá aquí.</p>'}</section>
  <section class="homecard"><h2 class="homecard-title">Tus propuestas</h2><div id="homeProposals"><p class="muted small">${navigator.onLine?'Cargando…':esc(typeof PROPOSAL_NETWORK==='string'?PROPOSAL_NETWORK:'Sin conexión.')}</p></div><button type="button" class="softbtn inicio-all" id="homeProposalsAll" data-feedback-id="tasks.inicio.mi_trabajo.ver_propuestas" data-feedback-label="Ver todas las propuestas">Ver todas</button></section>
  <section class="homecard"><h2 class="homecard-title">Lo demás que ves</h2>${projects.length?`<div class="shortcuts">${projects.map(x=>`<button type="button" class="viewpill" data-home-project="${x.p.id}" data-home-area="${x.tab.id}" data-feedback-id="tasks.inicio.mi_trabajo.proyecto" data-feedback-label="Proyecto que ves">${esc(x.p.title)}</button>`).join('')}</div>`:'<p class="muted small">Todavía no te han abierto ningún proyecto.</p>'}<button type="button" class="softbtn inicio-all" id="homeAllTasks" data-feedback-id="tasks.inicio.mi_trabajo.todas" data-feedback-label="Todas las tareas que ves">Todas las tareas que ves</button></section></main>`}
/* Las tres últimas propuestas, con su estado (necesitan red). */
let outsiderProposalsRun=0;
async function fillOutsiderProposals(){const box=document.getElementById('homeProposals'),client=typeof proposalClient==='function'?proposalClient():null;if(!box||!client||!navigator.onLine)return;const run=++outsiderProposalsRun;
  try{const res=await client.suggestions({scope:'mine',limit:3});if(run!==outsiderProposalsRun||!document.getElementById('homeProposals'))return;const items=(res.items||[]).slice(0,3);
    box.innerHTML=items.length?`<ul class="inicio-proposals">${items.map(s=>`<li><span>${esc(s.summary)}</span><span class="inicio-state ${esc(s.status)}">${PROPOSAL_STATE[s.status]||esc(s.status)}</span></li>`).join('')}</ul>`:'<p class="muted small">Aún no has propuesto nada.</p>'}
  catch(e){if(document.getElementById('homeProposals'))box.innerHTML=`<p class="muted small">${esc(typeof proposalError==='function'?proposalError(e):'No se pudieron leer tus propuestas.')}</p>`}}

const mainBeforeHome=main;
main=function(){if(state.view==='home'&&tab())return homeView();return mainBeforeHome()};
const groupsBeforeHome=navigationGroups;
navigationGroups=function(){const groups=groupsBeforeHome(),work=groups.find(g=>g.id==='work');if(work)work.items.unshift(['home','Inicio','home','view']);return groups};
const renderBeforeHome=render;
render=function(){const result=renderBeforeHome();if(state.view==='home'&&tab()&&document.querySelector('#view main.home')){if(typeof outsiderMode==='function'&&outsiderMode())fillOutsiderProposals();else{mountHome();fillHomeActivity()}}return result};
const bindBeforeHome=bind;
bind=function(){bindBeforeHome();
  // Cambiar de área desde Inicio mantiene Inicio; desde otra vista se conserva el comportamiento original.
  document.querySelectorAll('[data-tab]').forEach(b=>{const previous=b.onclick;b.onclick=e=>{const wasHome=state.view==='home';previous?.(e);if(wasHome){state.view='home';state.currentProject=null;persistUI();render()}}});
  if(state.view!=='home')return;
  document.querySelectorAll('[data-home-task]').forEach(b=>b.onclick=()=>openHomeTask(b.dataset.homeTask,b.dataset.homeArea));
  document.querySelectorAll('[data-home-week]').forEach(b=>b.onclick=()=>canEdit()?homeMoveSheet(b.dataset.homeArea,b.dataset.homeWeek):openHomeTask(b.dataset.homeWeek,b.dataset.homeArea));
  document.querySelectorAll('[data-home-project]').forEach(b=>b.onclick=()=>{state.activeTab=b.dataset.homeArea;state.taskScope='area';state.view='project';state.currentProject=b.dataset.homeProject;persistUI();render()});
  document.querySelectorAll('[data-home-filter]').forEach(b=>b.onclick=()=>{const [fid,lid]=b.dataset.homeFilter.split('|');state.activeTab=b.dataset.homeArea;if(areasForTasks().length===1)state.taskScope='area';navigateView('tasks');state.filters={[fid]:[lid]};persistUI();render()});
  document.querySelectorAll('[data-home-template]').forEach(b=>b.onclick=()=>{if(typeof fromTemplateSheet==='function')fromTemplateSheet()});
  const area=document.getElementById('homeArea');if(area)area.onchange=()=>{if(area.value==='*')state.taskScope='all';else{state.taskScope='area';state.activeTab=area.value}persistUI();render()};
  const person=document.getElementById('homePerson');if(person)person.onchange=()=>{homePerson=person.value;render()};
  // «Mi trabajo» (outsider).
  document.querySelectorAll('[data-out-done]').forEach(b=>b.onclick=()=>homeDoneOutsider(b.dataset.homeArea,b.dataset.outDone));
  const propose=document.getElementById('homePropose');if(propose)propose.onclick=()=>proposeTaskSheet();
  const all=document.getElementById('homeProposalsAll');if(all)all.onclick=()=>navigateView('myproposals');
  const tasks=document.getElementById('homeAllTasks');if(tasks)tasks.onclick=()=>{state.taskScope='all';navigateView('tasks')};
};
/* El outsider puede marcar hecha (y deshacer con el aviso), como en la ficha (#outsiderDone). */
function homeDoneOutsider(area,id){undoQuietly(area,()=>{const loc=taskLocation(id);if(loc&&status(loc.p,loc.t)!=='done')toggleTask(id)})}
