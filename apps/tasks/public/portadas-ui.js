/* Proyectos con portada (MUELA-041 «Proyectos», tanda 31, zona 2). Cada tarjeta es la portada del kit (renderCover): la foto
   del proyecto (su primer adjunto de imagen) o su color con iniciales, el título con su estrella, «Vence en N días» solo si
   tiene fecha (o «En pausa»); debajo, las tres cifras del kit (renderStats: pendientes, vencidas, % hecho), las caras de quien
   trabaja en él (la de quien lo lleva, rodeada) y las dos tareas siguientes, para marcarlas sin entrar.
   - Arriba, «Con vencidas · Vencen esta semana · En pausa»: un toque filtra (es de este dispositivo y de esta pantalla).
   - Orden: la Entrada, el proyecto fijado y después por atención y fecha; a igualdad, el orden de siempre, que se sigue
     cambiando arrastrando (⠿), con «Ordenar» o fijando (project-stats.js, attentionOrder).
   - Se conservan: una fila de chips de espacio y oficio (decisión de Core hasta la n.º 7), la barra de presupuesto para quien
     ve importes (moneyBlock, que costs-ui.js filtra con canSeeCosts), la estrella, «pausado», fijar, arrastrar y ordenar, y
     el alta en línea. Los ganchos de siempre: data-open-project, data-drop-project, data-project-drag, data-project-pin
     (.pinned), data-project-order, .project.colored[style*="--item-ink"], .projecttitle .star y .money .moneybar.
   La cuenta es la única (project-stats.js), la misma de la ficha del proyecto y del tablero. Prefijo de clases: `tkp-`. */
let tkpFocus='';
const TKP_BAND=[
  {key:'atencion',label:'Con vencidas',tone:'alert',feedbackId:'tasks.proyectos.salud.vencidas'},
  {key:'semana',label:'Vencen esta semana',tone:'warn',feedbackId:'tasks.proyectos.salud.semana'},
  {key:'pausa',label:'En pausa',tone:null,feedbackId:'tasks.proyectos.salud.pausa'},
];
function tkpToday(){return typeof isoDay==='function'?isoDay(0):new Date().toISOString().slice(0,10)}
function tkpStats(p){return projectStats(p,tkpToday())}
/* Quién lleva el proyecto y quién trabaja en él (personas de Central o, si siguen en etiquetas, las de la familia Persona). */
function tkpOwnerKey(p){return [p.ownerPerson,p.owner].find(k=>k&&fichaPersonName(k))||null}
function tkpPeople(p){const live=p.tasks.filter(t=>!t.deleted&&!t.done);
  const keys=[tkpOwnerKey(p),...(p.ownPeople||[]),...live.flatMap(t=>[t.ownerPerson,...(t.people||[])]),...live.flatMap(t=>fichaLegacyPeople([t.owner,...(t.labels||[])].filter(Boolean)))];
  return [...new Set(keys.filter(k=>k&&fichaPersonName(k)))]}
/* El plazo del proyecto en palabras, solo si tiene fecha («Si no tiene fecha, que no ponga sin fecha», VG). */
function tkpDue(s){if(s.inbox)return {text:'Para clasificar',tone:null};if(s.paused)return {text:'En pausa',tone:null};if(!s.due||s.dueIn==null)return null;
  const d=s.dueIn,txt=fmtDate(s.due);
  return d<0?{text:`Venció el ${txt}`,tone:'alert'}:d===0?{text:'Vence hoy',tone:'warn'}:d===1?{text:'Vence mañana',tone:'warn'}:d<=7?{text:`Vence en ${d} días`,tone:'warn'}:{text:`Hasta el ${txt}`,tone:null}}
function tkpHtml(node){const box=document.createElement('div');box.append(node);return box.innerHTML}
function tkpStarNode(p){const u=projectPriority(p);if(u==='normal')return null;const t=document.createElement('template');t.innerHTML=priorityStar(u,'Urgencia '+(u==='critical'?'crítica':'alta')+' heredada de sus tareas');return t.content.firstElementChild}
function tkpCover(p,s){const K=IkisaiKit,due=tkpDue(s),edit=canEdit(),pinned=!p.system&&activeProjects()[0]?.id===p.id,title=p.system==='inbox'?'Entrada':p.title;
  const tools=[];
  if(!p.system&&edit){
    tools.push(K.el('button',{class:'draghandle',type:'button',dataset:{projectDrag:p.id},'aria-label':`Arrastrar proyecto ${p.title}`,style:'touch-action:none','data-feedback-id':'tasks.tarjeta_proyecto.arrastrar','data-feedback-label':'Arrastrar proyecto'},'⠿'));
    tools.push(K.el('span',{class:'tkp-toolgap'}));
    tools.push(K.el('button',{class:`iconbtn small pinbtn${pinned?' pinned':''}`,type:'button',dataset:{projectPin:p.id,tip:pinned?'Fijado arriba':'Fijar arriba'},'aria-pressed':String(pinned),'data-feedback-id':'tasks.tarjeta_proyecto.fijar','data-feedback-label':'Fijar arriba','aria-label':pinned?`${p.title} está fijado en primera posición`:`Fijar ${p.title} en primera posición`},K.icon('pin',16)));
  }
  const cover=K.renderCover({title,image:fichaImageOf(p,()=>{if(state.view==='projects')render()}),color:p.color||null,pill:due?.text||null,pillTone:due?.tone||null,titleExtra:tkpStarNode(p),tools,onOpen:()=>{},feedbackId:'tasks.tarjeta_proyecto.abrir'});
  const open=cover.querySelector('.cover-main');open.dataset.openProject=p.id;open.setAttribute('aria-label',`Abrir ${title}${due?' · '+due.text:''}`);
  cover.querySelector('.cover-title')?.classList.add('projecttitle');
  return cover}
/* El control de ordenar por menú (invisible, para el teclado y las pruebas), al final de la tarjeta, donde nada lo tapa. */
function tkpOrderControl(p){if(p.system||!canEdit())return '';return tkpHtml(IkisaiKit.el('button',{class:'ghostcontrol',type:'button',dataset:{projectOrder:p.id},'aria-label':`Ordenar proyecto ${p.title}`,tabindex:'-1','data-feedback-id':'tasks.tarjeta_proyecto.ordenar','data-feedback-label':'Ordenar proyecto'},'↕'))}
function tkpTaskLine(p,t,when,mark){const late=when==='vencida',info=t.due?dueInfo(t.due,false):null;
  const box=mark?`<button type="button" class="tkp-check" data-toggle-task="${t.id}" role="checkbox" aria-checked="false" aria-label="Completar ${esc(t.text)}" data-feedback-id="tasks.tarjeta_proyecto.completar" data-feedback-label="Completar tarea"></button>`:'';
  return `<li class="tkp-task ${late?'late':''} ${mark?'':'ro'}">${box}<button type="button" class="tkp-tasktext" data-edit-task="${t.id}" data-feedback-id="tasks.tarjeta_proyecto.tarea" data-feedback-label="Abrir tarea"><span>${esc(t.text)}</span>${info?`<small>${esc(info.label)}</small>`:''}</button></li>`}
/* Familias de etiquetas de sitio (Zona, Edificio, «Zona: Espacio») y de oficio (Oficio, «Tipo: Acción»), las de antes de Central. */
function tkpFamilyKind(id){let f=null;for(const a of state.tabs||[]){f=(a.families||[]).find(x=>x.id===id);if(f)break}if(!f)return null;
  const name=String(f.name||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase();
  if(['space','building'].includes(f.system)||name==='zona: espacio')return 'site';if(f.system==='trade'||name==='tipo: accion')return 'trade';return null}
/* Una fila de chips de espacio y oficio (hasta la n.º 7): dónde y de qué oficio es cada proyecto. */
function tkpChips(p){const out=[],spaces=typeof spacesMode==='function'&&spacesMode(),trades=typeof tradesMode==='function'&&tradesMode();
  // Mientras sigan en etiquetas, las de las familias de sitio (Zona, Edificio) y de oficio, una por etiqueta madre.
  const labelChips=kind=>labelGroups(aggregatedLabels(p)).filter(g=>tkpFamilyKind(g.mother.family)===kind).map(g=>`<span class="chip" style="--chip:${esc(familyColorByLabel(g.mother.id))}" data-label="${esc(g.mother.id)}" data-pastel="1"><span>${esc(g.text)}</span></span>`);
  if(spaces)out.push(...aggregatedSpaces(p).filter(id=>spaceById(id)).map(id=>`<span class="chip spacechip" style="--chip:${esc(zoneColor())}" data-space="${esc(id)}" data-pastel="1"><span>${esc(spaceShort(id))}</span></span>`));
  else out.push(...labelChips('site'));
  if(trades)out.push(...sortTrades(aggregatedTrades(p)).map(id=>`<span class="chip tradechip" style="--chip:${esc(actionColor())}" data-trade="${esc(id)}" data-pastel="1"><span>${esc(tradeShort(id))}</span></span>`));
  else out.push(...labelChips('trade'));
  return out.length?`<span class="chips tkp-chips" aria-label="Dónde y de qué oficio">${out.join('')}</span>`:''}
/* La tarjeta: sustituye a la del kit de siempre (project-card-ui.js) y a su filtro de importes (costs-ui.js). */
projectCard=function(p){const K=IkisaiKit,s=tkpStats(p),health=healthOf(s),area=typeof areaOfProject==='function'?areaOfProject(p):tab(),owner=tkpOwnerKey(p),people=tkpPeople(p).slice(0,5);
  const stats=s.inbox?K.renderStats([{value:s.open,label:s.open===1?'tarea por clasificar':'tareas por clasificar'}],{label:'Entrada'})
    :K.renderStats([{value:s.open,label:s.open===1?'pendiente':'pendientes'},{value:s.late,label:s.late===1?'vencida':'vencidas',tone:s.late?'alert':null},{value:s.pct+' %',label:'hecho',tone:s.total&&!s.open?'ok':null}],{label:'Cómo va'});
  const faces=people.length?`<div class="tkp-people"><span class="tkp-faces" aria-hidden="true">${people.map((k,i)=>`<span class="tkp-face ${i===0&&k===owner?'tkp-lead':''}">${tkpHtml(K.renderMedal({...fichaFace(k,area),size:i===0&&k===owner?32:28}))}</span>`).join('')}</span><span>${owner?`Lleva ${esc(fichaPersonName(owner))}`:'Sin responsable'}${people.length>1?` · ${people.length} personas`:''}</span></div>`:'';
  const mark=canEdit()||(typeof isOutsiderActor==='function'&&isOutsiderActor());
  const next=s.queue.slice(0,2),money=!s.inbox&&canSeeCosts(areaIdOf(p))?moneyBlock(p):'';
  return `<div class="ikisai-kit projectcard tkp-wrap" data-tkp-health="${health}" data-tkp-order="${Number(p.order)||0}" style="display:grid"><article class="project card tkp-card tkp-${health}${p.color?' colored':''}${p.system?' system':''}${p.status==='paused'?' paused':''}" data-drop-project="${p.id}" ${p.color?`style="${colorVars(p.color)}"`:''}>${tkpHtml(tkpCover(p,s))}${tkpHtml(stats)}${faces}${next.length?`<ul class="tkp-tasks" aria-label="Lo siguiente de ${esc(p.title)}">${next.map(t=>tkpTaskLine(p,t,s.whenOf[t.id],mark)).join('')}</ul>`:`<p class="tkp-alldone">${s.inbox?'Nada por clasificar':'Nada pendiente'}</p>`}${tkpChips(p)}${money}${tkpOrderControl(p)}</article></div>`};

/* La galería: la banda de arriba, el filtro y el orden por atención. Vale para un área y para General (un bloque por área). */
function tkpBandCounts(projects){const c={atencion:0,semana:0,pausa:0};for(const p of projects){const h=healthOf(tkpStats(p));if(h in c)c[h]++}return c}
function tkpArrange(html,projects){const tpl=document.createElement('template');tpl.innerHTML=html;const main=tpl.content.querySelector('main');if(!main)return html;
  main.classList.add('tkp-gallery');const pinned=new Set();
  for(const grid of main.querySelectorAll('.project-grid')){const cards=[...grid.querySelectorAll(':scope > .tkp-wrap')];if(!cards.length)continue;
    const area=grid.closest('[data-area-block]')?.dataset.areaBlock||state.activeTab,first=withArea(area,()=>activeProjects()[0]?.id);pinned.add(first);
    const list=cards.map(node=>{const id=node.querySelector('[data-drop-project]').dataset.dropProject,p=withArea(area,()=>tab().projects.find(x=>x.id===id));return {node,order:Number(node.dataset.tkpOrder)||0,stats:p?tkpStats(p):{id,inbox:false}}});
    const sorted=attentionOrder(list,first).filter(x=>!tkpFocus||x.stats.inbox||healthOf(x.stats)===tkpFocus);
    for(const c of cards)c.remove();const anchor=grid.firstChild;for(const x of sorted)grid.insertBefore(x.node,anchor);
    if(tkpFocus&&!sorted.some(x=>!x.stats.inbox))grid.insertAdjacentHTML('beforeend','<div class="empty">Ningún proyecto en este grupo.</div>')}
  const counts=tkpBandCounts(projects),band=document.createElement('div');band.className='ikisai-kit tkp-band';
  band.append(IkisaiKit.renderStats(TKP_BAND.map(b=>({value:counts[b.key],label:b.label,tone:counts[b.key]?b.tone:null,feedbackId:b.feedbackId,onClick:()=>{},selected:tkpFocus===b.key})),{label:'Lo que pide atención'}));
  band.querySelectorAll('button.stat-item').forEach((b,i)=>{b.dataset.tkpFocus=TKP_BAND[i].key});
  band.insertAdjacentHTML('afterbegin',tkpProgressHtml(projects));
  const at=main.querySelector(':scope > [data-area-block], :scope > .sectionlabel, :scope > .project-grid');if(at)at.before(band);else main.append(band);
  return tpl.innerHTML}
/* FB_2026_063 (opción a, sin datos nuevos): de un vistazo, cuánto trabajo hay y cuánto falta, contando tareas (las hojas, como
   projectStats). Dos barras: todo lo que hay (con lo hecho dentro) y lo que falta. */
function tkpProgressHtml(projects){let total=0,open=0;for(const p of projects){const s=tkpStats(p);total+=s.total;open+=s.open}
  if(!total)return '';const done=total-open,pct=Math.round(100*done/total),left=Math.round(100*open/total);
  return `<div class="tkp-progress" role="group" aria-label="Cómo vamos en general">
    <div class="tkp-bar"><span class="tkp-bar-label"><b>${total}</b> ${total===1?'tarea en total':'tareas en total'} · ${pct}% hecho</span><span class="tkp-bar-track" role="img" aria-label="${done} de ${total} hechas"><span class="tkp-bar-fill done" style="width:${pct}%"></span></span></div>
    <div class="tkp-bar"><span class="tkp-bar-label"><b>${open}</b> ${open===1?'falta':'faltan'}</span><span class="tkp-bar-track" role="img" aria-label="Faltan ${open} de ${total}"><span class="tkp-bar-fill left" style="width:${left}%"></span></span></div></div>`}
const projectsViewBeforePortadas=projectsView;
projectsView=function(){return tkpArrange(projectsViewBeforePortadas(),tab().projects.filter(p=>!p.deleted&&p.status!=='archived'&&!p.system))};
const generalProjectsViewBeforePortadas=generalProjectsView;
generalProjectsView=function(){const projects=generalAreas().flatMap(a=>withArea(a.id,()=>tab().projects.filter(p=>!p.deleted&&p.status!=='archived'&&!p.system)));return tkpArrange(generalProjectsViewBeforePortadas(),projects)};
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-tkp-focus]');if(!b)return;e.preventDefault();tkpFocus=tkpFocus===b.dataset.tkpFocus?'':b.dataset.tkpFocus;render();
  document.querySelector(`[data-tkp-focus="${b.dataset.tkpFocus}"]`)?.focus()},true);
