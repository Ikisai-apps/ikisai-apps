/* Ficha de proyecto · «Portada y foco» (MUELA-048, con lo que añade el 073 y el «Abrir a…» del 083; tanda 31, zona 2).
   - La cabecera es la portada del kit (renderCover compacta): la foto del proyecto (o su color con iniciales), «Vence en N
     días» o «En pausa» (nada si no tiene fecha), el título con su estrella, las caras y «4 pendientes · 2 vencidas · 33 %
     hecho» (la cuenta única de project-stats.js). Encima, «‹» (#backBtn), el lápiz que cambia el nombre en el sitio (el
     h1.title.editable de siempre, oculto a la vista y en el DOM) y «⋮» ([data-edit-project]).
   - Debajo, la nota, y las baldosas «Quién» (quién lo lleva, oficios y personas; lleva al editor, en Oficio y Personas, donde
     está «Quién sabe hacerlo») y «Coste» (lo gastado frente al presupuesto, con «excedido»), esta solo para quien ve importes.
   - «Lo que toca ahora» (createFocus del kit): la vencida más antigua o la de fecha más cercana, «✓ Hecha» (toggleTask, con
     su «Deshacer»), «Abrir» y «Siguiente ›», que solo cambia cuál se ve; las siguientes asoman detrás. La lectora, sin «Hecha».
   - Después, lo de siempre: «Etiquetas del proyecto», el buscador, «Cómo mover», Lista/Tablero con todos sus gestos, #quickAdd,
     [data-add-task] y .rootdrop.
   - En el editor del proyecto, «Abrir a…» sube detrás del nombre y la nota, con el medallón de cada persona y «Lo ve» / «No lo
     ve». Se guarda con «Guardar»; si se cierra la hoja con cambios, «“Abrir a…” sin guardar · Aplicar».
   Prefijo de clases: `tkf-` (el de las fichas). */
let fichaProjectFocus=null;
function fichaProjectHead(html){const p=project();if(!p||state.view!=='project')return html;
  const tpl=document.createElement('template');tpl.innerHTML=html;const main=tpl.content.querySelector('main'),head=main?.querySelector('.project-detail-head');if(!head)return html;
  main.classList.add('tkf-project');head.classList.add('tkf-projhead');
  main.querySelector(':scope > .progressline')?.remove();
  const money=main.querySelector(':scope > .money');money?.remove();
  const make=(cls,tag='div')=>{const n=document.createElement(tag);n.className=cls;return n};
  const cover=make('ikisai-kit tkf-pcover');cover.id='projectCover';head.after(cover);
  const note=main.querySelector(':scope > .projectnote');if(note)cover.after(note);
  const tiles=make('tkf-ptiles');tiles.id='projectTiles';(note||cover).after(tiles);
  const focus=make('ikisai-kit tkf-pfocus');focus.id='projectFocus';tiles.after(focus);
  return tpl.innerHTML}
const projectViewBeforeFicha=projectView;
projectView=function(...args){return fichaProjectHead(projectViewBeforeFicha(...args))};

/* La baldosa «Quién»: quién lo lleva, sus oficios y sus personas. */
function fichaProjectQuien(p,s){const area=typeof areaOfProject==='function'?areaOfProject(p):tab(),owner=tkpOwnerKey(p),people=tkpPeople(p);
  const trades=typeof tradesMode==='function'&&tradesMode()?aggregatedTrades(p).map(tradeName):[];
  const outsider=typeof isOutsiderActor==='function'&&isOutsiderActor(),tag=outsider?'div':'button';
  const box=document.createElement(tag);box.className='tkf-tile wide tkf-quien';
  if(!outsider){box.type='button';box.dataset.projectQuien=p.id;box.dataset.feedbackId='tasks.proyecto.baldosa.quien';box.dataset.feedbackLabel='Quién';box.setAttribute('aria-label','Quién: abrir oficio y personas en el editor')}
  box.innerHTML=`<span class="tkf-tname">Quién${people.length?` <span class="tkf-n">${people.length}</span>`:''}</span><span class="tkf-tline">${people.length?'<span class="ikisai-kit tkf-faces"></span>':''}<span>${owner?`Lo lleva <b>${esc(fichaPersonName(owner))}</b>`:fichaNone('Sin responsable')}${trades.length?`<br><span class="tkf-trade">${esc(trades.join(' · '))}</span>`:''}${people.length?`<span class="tkf-vh">. Personas: ${esc(people.map(fichaPersonName).join(', '))}</span>`:''}</span></span>${outsider?'':'<span class="tkf-go" aria-hidden="true">›</span>'}`;
  box.querySelector('.tkf-faces')?.append(...people.slice(0,4).map(k=>IkisaiKit.renderMedal({...fichaFace(k,area),size:30})));
  if(!outsider)box.onclick=()=>{openProjectEditor(p.id);setTimeout(()=>{const f=document.querySelector('#sheet .tradefield')||document.querySelector('#sheet .personfield');if(!f)return;f.scrollIntoView({block:'center'});f.querySelector('input,button')?.focus({preventScroll:true})},60)};
  return box}
/* La baldosa «Coste»: el relleno de lo gastado frente al presupuesto y «excedido». Solo para quien ve importes. */
function fichaProjectCost(p){if(p.system||!canSeeCosts(areaIdOf(p)))return null;const cost=projectCost(p),budget=Number(p.budget)||0;if(!cost&&!budget)return null;
  const pct=budget?Math.round(100*cost/budget):0,over=budget&&cost>budget;
  const tile=IkisaiKit.renderTile({title:'Coste',value:money(cost),icon:'euro',levelText:budget?(over?`de ${money(budget)} · excedido`:`de ${money(budget)} · ${pct} %`):'sin presupuesto',
    level:budget?{pct:Math.min(100,pct),tone:over?'alert':pct>=90?'warn':'ok'}:null,feedbackId:'tasks.proyecto.baldosa.coste',
    onClick:canEdit()?()=>{openProjectEditor(p.id);setTimeout(()=>{const b=document.getElementById('peBudget');if(b){b.scrollIntoView({block:'center'});b.focus({preventScroll:true})}},60)}:undefined});
  const box=document.createElement('div');box.className=`ikisai-kit money tkf-costtile${over?' over':''}`;box.append(tile);return box}
function fichaProjectMount(){const p=project();if(!p||state.view!=='project')return;const K=IkisaiKit,coverHost=document.getElementById('projectCover');if(!coverHost)return;
  const s=projectStats(p,tkpToday()),due=tkpDue(s),area=typeof areaOfProject==='function'?areaOfProject(p):tab(),people=tkpPeople(p);
  // Cabecera: los botones de siempre (con sus manejadores ya puestos) encima de la foto.
  const head=document.querySelector('.tkf-projhead'),back=document.getElementById('backBtn'),edit=head?.querySelector('[data-edit-project]'),h1=head?.querySelector('h1.title');
  const tools=[back,K.el('span',{class:'tkf-toolgap'}),edit];
  const title=p.system==='inbox'?'Entrada':p.title,rename=!p.system&&h1?.classList.contains('editable');
  const stats=s.inbox?fichaPlural(s.open,'tarea por clasificar','tareas por clasificar'):[fichaPlural(s.open,'pendiente','pendientes'),s.late?fichaPlural(s.late,'vencida','vencidas'):null,`${s.pct} % hecho`].filter(Boolean).join(' · ');
  // Tocar el título lo cambia en el sitio, como siempre (el h1 editable de cards-ui.js, que sigue en el DOM).
  const cover=K.renderCover({title,image:fichaImageOf(p,()=>{if(state.view==='project')render()}),color:p.color||null,pill:due?.text||null,pillTone:due?.tone||null,titleExtra:tkpStarNode(p),
    stats,faces:people.slice(0,4).map(k=>fichaFace(k,area)).filter(Boolean),tools:tools.filter(Boolean),compact:true,feedbackId:'tasks.proyecto.portada',...(rename?{onOpen:()=>h1.click()}:{})});
  if(rename){const main=cover.querySelector('.cover-main');main.setAttribute('aria-label',`${title}: cambiar el nombre`);main.title='Pulsa para cambiar el nombre'}
  coverHost.replaceChildren(cover);
  // Baldosas.
  const tiles=document.getElementById('projectTiles');if(tiles){tiles.replaceChildren(...[p.system?null:fichaProjectQuien(p,s),fichaProjectCost(p)].filter(Boolean));tiles.hidden=!tiles.children.length}
  // Lo que toca ahora.
  const host=document.getElementById('projectFocus');if(!host)return;
  const kick={vencida:'Vencida · toca ya',hoy:'Para hoy'};
  const items=s.queue.map(t=>{const when=s.whenOf[t.id],kids=children(p,t.id),info=t.due?dueInfo(t.due,false):null,who=[t.ownerPerson,t.owner].find(k=>k&&fichaPersonName(k));
    return {id:t.id,title:t.text,kicker:kick[when]||'Lo siguiente',tone:when==='vencida'?'alert':null,note:t.note||null,
      meta:[info?info.label:null,kids.length?`${kids.filter(c=>status(p,c)==='done').length}/${kids.length} pasos`:null].filter(Boolean),
      image:fichaImageOf(t,()=>{if(state.view==='project')render()}),color:p.color||null,who:who?{...fichaFace(who,area),name:fichaPersonName(who)}:null}});
  const mark=canEdit()||(typeof isOutsiderActor==='function'&&isOutsiderActor());
  const f=K.createFocus({label:'La tarea que toca ahora',items,feedbackId:'tasks.proyecto.foco',emptyTitle:'Todo hecho en este proyecto',emptyText:mark?'Añade una tarea abajo si falta algo.':null,
    onDone:mark?it=>toggleTask(it.id):undefined,onOpen:it=>openTaskEditor(it.id)});
  // «Siguiente ›» solo cambia cuál se ve: se recuerda para el siguiente pintado (sin escribir nada).
  if(fichaProjectFocus?.project===p.id)for(let i=0;i<items.length&&f.current()&&f.current().id!==fichaProjectFocus.task;i++)f.next();
  f.element.addEventListener('click',e=>{if(e.target.closest('.focus-next'))fichaProjectFocus={project:p.id,task:f.current()?.id||null}});
  host.replaceChildren(f.element)}
const renderBeforeFichaProject=render;
render=function(...args){const out=renderBeforeFichaProject(...args);try{fichaProjectMount()}catch(e){console.error(e)}return out};

/* --- «Abrir a…» arriba del editor del proyecto, con medallones y «Lo ve» / «No lo ve» ------------------------------- */
function fichaOpenToDecorate(){const field=document.getElementById('openToField');if(!field||field.dataset.tkf)return;field.dataset.tkf='1';
  const note=document.getElementById('peNote')?.closest('#sheet > *');if(note)note.after(field);
  field.querySelectorAll('label.checkline').forEach(row=>{const box=row.querySelector('[data-open-to]'),name=row.querySelector('span');if(!box||!name)return;
    const m=outsiderMembers().find(x=>x.userId===box.dataset.openTo),whole=box.disabled;
    const medal=document.createElement('span');medal.className='ikisai-kit tkf-openmedal';medal.append(IkisaiKit.renderMedal({name:m?.displayName||'Sin nombre',size:30}));name.before(medal);
    const sees=document.createElement('span');sees.className='tkf-sees';row.append(sees);
    const paint=()=>{sees.textContent=box.checked?'Lo ve':'No lo ve';sees.classList.toggle('on',box.checked);if(whole)sees.textContent='Lo ve · toda el área'};
    box.addEventListener('change',paint);paint()})}
const mountOpenToBeforeFicha=mountOpenTo;
mountOpenTo=function(...args){const out=mountOpenToBeforeFicha(...args);fichaOpenToDecorate();return out};
function fichaOpenToPending(draft){if(!draft||!draft.want?.size)return false;
  return [...draft.want].some(([userId,open])=>{const m=outsiderMembers().find(x=>x.userId===userId);if(!m)return false;const sees=outsiderSees(m,draft.tabId,draft.projectId);return sees!=='tab'&&!!sees!==open})}
const closeSheetBeforeOpenToFicha=closeSheet;
closeSheet=function(...args){const draft=document.getElementById('openToField')&&fichaOpenToPending(openToDraft)?openToDraft:null;const out=closeSheetBeforeOpenToFicha(...args);
  if(draft&&!document.getElementById('sheetBack')?.classList.contains('show'))IkisaiKit.toastWithAction('“Abrir a…” sin guardar',{label:'Aplicar',onClick:()=>applyOpenTo(draft)},8000);
  return out};
