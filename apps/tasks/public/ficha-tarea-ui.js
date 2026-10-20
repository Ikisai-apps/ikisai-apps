/* Ficha de tarea · «Portada y foco» (MUELA-083 §1; tanda 31, zona 2). Solo disposición: abre la ficha de siempre
   (openTaskEditor con todos sus envoltorios) y MUEVE sus nodos. Cada bloque es el nodo de hoy, con su mismo código (guardar,
   papelera, mover, historial, hijas, dependencias, adjuntos, materiales, coste, comentarios…).
   - Arriba, la portada del kit (renderCover compacta): la foto de la tarea o del proyecto (o su color con iniciales), el título,
     la píldora del plazo («Vence mañana», «Vencida · …», «Hecha»), las caras de quien está y las cifras en texto. El lápiz
     edita el título ahí mismo, con el campo de siempre (#teText).
   - Debajo: medallón del proyecto · «Abierta» / «Abierta · se pasó la fecha» / «Hecha» · «Lo lleva X»; el origen («Pedida
     desde … · Abrir»); prioridad y fecha, y «Hecha» con «Deshacer» (el outsider, su #outsiderDone).
   - Baldosas que se abren en foco con «‹ Portada»: Quién, Nota, Comentarios, Pasos, Material y coste, Etiquetas (con el
     Espacio), Depende de, Adjuntos y Más (mover, historial, nivel).
   - Un solo «Coste»: la sección de R6 (#taskCosts). El campo «Coste (€)» deja de verse, pero sigue en la hoja y se guarda
     (sync.js, editorExtraFields); su línea «Coste (€) de la tarea» lleva lápiz y «×» para corregirla.
   - Importes solo con canSeeCosts: para los demás, la baldosa se llama «Material» y no lleva euros.
   - Outsider: «Quién» sin «Quién sabe hacerlo». Lector y outsider: lo que no se guarda, desactivado y con el motivo.
   Solo para tareas que existen; la hoja de una tarea nueva sigue igual (sin «Coste (€)»: se añade una vez guardada).
   Prefijo de clases: `tkf-`. */
const FICHA_BLOCKS=[
  {key:'quien',name:'Quién',feedbackId:'tasks.editor_tarea.baldosa.quien',wide:true},
  {key:'nota',name:'Nota',feedbackId:'tasks.editor_tarea.baldosa.nota',wide:true},
  {key:'comentarios',name:'Comentarios',feedbackId:'tasks.editor_tarea.baldosa.comentarios',wide:true},
  {key:'pasos',name:'Pasos',feedbackId:'tasks.editor_tarea.baldosa.pasos'},
  {key:'material',name:'Material y coste',feedbackId:'tasks.editor_tarea.baldosa.material'},
  {key:'etiquetas',name:'Etiquetas',feedbackId:'tasks.editor_tarea.baldosa.etiquetas'},
  {key:'depende',name:'Depende de',feedbackId:'tasks.editor_tarea.baldosa.depende'},
  {key:'adjuntos',name:'Adjuntos',feedbackId:'tasks.editor_tarea.baldosa.adjuntos'},
  {key:'mas',name:'Más',feedbackId:'tasks.editor_tarea.baldosa.mas'},
];
const FICHA_READONLY='Puedes marcarla hecha, comentar y proponer cambios. Lo demás lo cambian staff o dirección.';
const FICHA_READER='Solo lectura: lo cambian staff o dirección.';
/* El bloque abierto en foco (sobrevive a reabrir la ficha al elegir etiquetas o soltar de la cadena; se olvida al cerrarla). */
let fichaFocus=null;
function fichaToday(){return typeof isoDay==='function'?isoDay(0):new Date().toISOString().slice(0,10)}
function fichaPlural(n,one,many){return `${n} ${n===1?one:many}`}

/* --- Fotos de portada: el primer adjunto de imagen (de la tarea o del proyecto). Las del servidor necesitan la sesión: se
   leen una vez (caché del dispositivo o red) y se vuelve a pintar quien las pidió. --------------------------------------- */
const fichaPhotos=new Map();
function fichaImageOf(item,onReady){
  for(const a of item?.attachments||[]){const href=a.data||a.url||'';
    if(/^data:image\/(jpeg|png|webp)/.test(href))return href;
    if(!href.startsWith('/api/v1/attachments/')||!/^image\/(jpeg|png|webp)$/.test(a.mime||''))continue;
    const id=href.split('/').at(-1),known=fichaPhotos.get(id);if(known)return known==='pending'||known==='none'?null:known;
    fichaPhotos.set(id,'pending');
    (async()=>{let blob=null;try{const cached=typeof cachedAttachment==='function'?await cachedAttachment(id):null;if(cached?.actorId===Sync.actor?.id)blob=cached.blob;
      else if(navigator.onLine&&Sync.token){const res=await fetch(href,{headers:{Authorization:'Bearer '+Sync.token}});if(res.ok)blob=await res.blob()}}catch{}
      fichaPhotos.set(id,blob?URL.createObjectURL(blob):'none');if(blob)onReady?.()})();
    return null}
  return null}

/* --- Personas de una tarea (caras y «Lo lleva»): las de Central o, con las personas en etiquetas, las de la familia Persona. */
function fichaPersonName(key){if(!key)return '';if(typeof levelOf==='function'&&levelOf(key))return '';
  if(typeof personById==='function'&&personById(key))return personFull(key);
  const l=typeof label==='function'?label(key):null;return l&&isPersonFamily(l.family)?l.text:''}
function fichaFace(key,area){const name=fichaPersonName(key);if(!name)return null;
  const p=typeof personById==='function'?personById(key):null,short=/^[\p{Lu}\p{N}]{2,3}$/u.test(name)?name:null;return {name,initials:p?.initials||short,color:typeof personColor==='function'?personColor(area):null}}

/* Las etiquetas Persona de una lista, sin los grupos («Staff» cuando también está «VG», su hija). */
function fichaLegacyPeople(ids){const set=new Set(ids);return ids.filter(id=>{const l=label(id);return l&&isPersonFamily(l.family)&&!ids.some(x=>x!==id&&label(x)?.parent===id)&&set.has(id)})}
/* --- Partes de la hoja ------------------------------------------------------------------------------------------------- */
function fichaParts(s){const top=sel=>s.querySelector(sel)?.closest('#sheet > *')||null;
  return {title:s.querySelector(':scope > .sheettitle'),origin:s.querySelector('#taskOrigin'),text:top('#teText'),note:top('#teNote'),when:top('#tePriority'),
    cost:s.querySelector(':scope > .costfield'),level:top('#teParent'),owner:top('#teOwner'),trade:s.querySelector(':scope > .tradefield'),who:s.querySelector('#whoKnows'),
    people:s.querySelector(':scope > .personfield'),space:s.querySelector(':scope > .spacefield'),labels:top('#editLabelsBtn'),deps:s.querySelector(':scope > .dependency-field'),
    files:top('#teFiles'),children:s.querySelector('#taskChildren'),step:s.querySelector('#stepInfo'),materials:s.querySelector('#taskMaterials'),costs:s.querySelector('#taskCosts'),
    comments:s.querySelector('#taskComments'),actions:s.querySelector(':scope > .actions'),more:s.querySelector('#taskMoreActions')}}
function fichaBlockNodes(P,key){return ({quien:[P.owner,P.trade,P.who,P.people],nota:[P.note],comentarios:[P.comments],pasos:[P.children,P.step],material:[P.materials,P.costs,P.cost],
  etiquetas:[P.space,P.labels],depende:[P.deps],adjuntos:[P.files],mas:[P.more,P.level]})[key].filter(Boolean)}

/* --- Lo que dice cada baldosa en una línea -------------------------------------------------------------------------- */
function fichaSummary(id){const loc=taskLocation(id);if(!loc)return null;const {p,t}=loc,s=document.getElementById('sheet'),area=typeof areaOfProject==='function'?areaOfProject(p):tab();
  const key='task:'+id,people=(typeof peopleDraft!=='undefined'&&peopleDraft?.key===key?peopleDraft.ids:t.people)||[];
  const trades=(typeof tradeDraft!=='undefined'&&tradeDraft?.key===key?tradeDraft.ids:t.trades)||[];
  const owner=document.getElementById('teOwner'),ownerText=owner?.value?(fichaPersonName(owner.value)||owner.selectedOptions[0]?.textContent.trim()||''):'';
  const legacyPeople=typeof peopleMode==='function'&&peopleMode()?[]:fichaLegacyPeople(t.labels||[]);
  const faceKeys=[...new Set([owner?.value||'',...people,...legacyPeople].filter(k=>fichaPersonName(k)))];
  const comments=typeof commentsOf==='function'?commentsOf(id):[],kids=children(p,id),materials=s?.querySelectorAll('#taskMaterials .materialrow').length||0;
  const mother=t.parentId?p.tasks.find(x=>x.id===t.parentId):null;
  return {p,t,area,faceKeys,ownerText,trades,comments,last:comments[comments.length-1]||null,kids:kids.length,kidsDone:kids.filter(k=>status(p,k)==='done').length,mother,materials,
    total:document.getElementById('taskCostTotal')?.textContent.trim()||'',labels:(editorSelection?.key===key?editorSelection.ids:t.labels||[]).filter(x=>label(x)&&!label(x).archived).length,
    spaces:(typeof spaceDraft!=='undefined'&&spaceDraft?.key===key?spaceDraft.ids:t.spaces)||[],deps:s?.querySelectorAll('[data-dependency]:checked').length||0,
    files:s?.querySelectorAll('#attachmentsList a').length||0,note:document.getElementById('teNote')?.value.trim()||'',due:document.getElementById('teDue')?.value||'',done:status(p,t)==='done',
    money:typeof canSeeCosts==='function'&&canSeeCosts(typeof areaIdOf==='function'?areaIdOf(p):tab().id)}}
function fichaNone(text){return `<span class="tkf-none">${esc(text)}</span>`}
function fichaLine(k,m){
  if(k==='quien')return `${m.faceKeys.length?'<span class="ikisai-kit tkf-faces" data-tkf-faces></span>':''}<span>${m.ownerText?`Lo lleva <b>${esc(m.ownerText)}</b>`:fichaNone('Sin responsable')}${m.trades.length&&typeof tradeName==='function'?`<br><span class="tkf-trade">${esc(m.trades.map(tradeName).join(' · '))}</span>`:''}</span>`;
  if(k==='nota')return m.note?esc(m.note.length>90?m.note.slice(0,90)+'…':m.note):fichaNone('Sin nota');
  if(k==='comentarios')return m.last?`<b>${esc(commentAuthor(m.last))}</b> · ${esc(commentWhen(m.last.created_at))}<br>${m.last.file_id?'📷 ':''}${esc(String(m.last.body||'').slice(0,70))}`:fichaNone('Sin comentarios');
  if(k==='pasos')return m.kids?`${m.kidsDone} de ${m.kids} hechos`:m.mother?`Paso de «${esc(m.mother.text)}»`:fichaNone('Sin pasos');
  if(k==='material'){const mat=m.materials?fichaPlural(m.materials,'material','materiales'):'Sin material';return m.money&&m.total?`${esc(mat)} · ${esc(m.total)}`:esc(mat)}
  if(k==='etiquetas'){const bits=[m.spaces.length&&typeof spaceShort==='function'?m.spaces.map(spaceShort).filter(Boolean).join(', '):'',m.labels?fichaPlural(m.labels,'etiqueta','etiquetas'):''].filter(Boolean);return bits.length?esc(bits.join(' · ')):fichaNone('Ninguna')}
  if(k==='depende')return m.deps?fichaPlural(m.deps,'tarea previa','tareas previas'):fichaNone('De nada');
  if(k==='adjuntos')return m.files?fichaPlural(m.files,'archivo','archivos'):fichaNone('Ninguno');
  return canEdit()?'Mover · Historial':fichaNone('Nivel')}
function fichaCount(k,m){return ({quien:m.faceKeys.length,comentarios:m.comments.length,pasos:m.kids,material:m.materials})[k]||0}

/* --- La portada (kit) y la línea de estado --------------------------------------------------------------------------- */
function fichaPaintHead(s,id){const m=fichaSummary(id);if(!m)return;const K=IkisaiKit,input=document.getElementById('teText'),host=s.querySelector('.tkf-cover');if(!host)return;
  const today=fichaToday(),info=m.due?dueInfo(m.due,false):null;
  const pill=m.done?'Hecha':!m.due?null:m.due<today?`Vencida · ${fmtDate(m.due)}`:m.due===today?'Vence hoy':info?.cls==='soon'?'Vence mañana':`Vence el ${fmtDate(m.due)}`;
  const tone=m.done?'ok':!m.due?null:m.due<today?'alert':m.due===today||info?.cls==='soon'?'warn':null;
  const stats=[m.comments.length?fichaPlural(m.comments.length,'comentario','comentarios'):null,m.kids?`${m.kidsDone}/${m.kids} pasos`:null,m.materials?fichaPlural(m.materials,'material','materiales'):null].filter(Boolean).join(' · ')||null;
  const repaint=()=>{if(host.isConnected)fichaPaintHead(s,id)};
  const tools=[];if(canEdit()){const pencil=K.el('button',{type:'button',class:'iconbtn tkf-pencil',id:'tkfTitleEdit','aria-label':'Cambiar el título','data-tip':'Cambiar el título','data-feedback-id':'tasks.editor_tarea.portada.titulo','data-feedback-label':'Cambiar el título',onclick:()=>fichaEditTitle(s,id)},K.icon('edit',20));tools.push(K.el('span',{class:'tkf-toolgap'}),pencil)}
  const cover=K.renderCover({title:input?.value.trim()||m.t.text,image:fichaImageOf(m.t,repaint)||fichaImageOf(m.p,repaint),color:m.p.color||m.area?.color||null,pill,pillTone:tone,stats,
    faces:m.faceKeys.map(k=>fichaFace(k,m.area)).filter(Boolean),tools,compact:true,feedbackId:'tasks.editor_tarea.portada'});
  host.replaceChildren(cover);
  const state=s.querySelector('.tkf-state');if(state){const st=m.done?'Hecha':m.due&&m.due<today?'Abierta · se pasó la fecha':'Abierta';
    state.innerHTML=`<span class="ikisai-kit tkf-medal"></span><span><b>${esc(m.p.system==='inbox'?'Entrada':m.p.title)}</b> · <span class="tkf-st ${m.done?'ok':m.due&&m.due<today?'alert':''}">${st}</span>${m.ownerText?` · Lo lleva <b>${esc(m.ownerText)}</b>`:''}</span>`;
    state.querySelector('.tkf-medal').append(K.renderMedal({name:m.p.system==='inbox'?'Entrada':m.p.title,image:fichaImageOf(m.p,repaint),color:m.p.color||null,size:30}))}
  const done=document.getElementById('tkfDone');if(done)done.checked=m.done;
  fichaPaintTiles(s,id,m)}
function fichaPaintTiles(s,id,m=fichaSummary(id)){const box=s.querySelector('.tkf-tiles');if(!box||!m)return;const P=s._tkfParts;if(!P)return;
  box.innerHTML=FICHA_BLOCKS.filter(b=>fichaBlockNodes(P,b.key).length&&(b.key!=='mas'||P.more)).map(b=>{const name=b.key==='material'&&!m.money?'Material':b.name,n=fichaCount(b.key,m);
    return `<button type="button" class="tkf-tile ${b.wide?'wide':''}" data-tkf-tile="${b.key}" aria-label="${esc(name)}: abrir" data-feedback-label="${esc(name)}"><span class="tkf-tname">${esc(name)}${n?` <span class="tkf-n">${n}</span>`:''}</span><span class="tkf-tline">${fichaLine(b.key,m)}</span><span class="tkf-go" aria-hidden="true">›</span></button>`}).join('');
  const faces=box.querySelector('[data-tkf-faces]');if(faces)faces.append(...m.faceKeys.slice(0,4).map(k=>fichaFace(k,m.area)).filter(Boolean).map(f=>IkisaiKit.renderMedal({...f,size:30})));
  // La marca de feedback de cada baldosa es la literal de la tabla de arriba.
  box.querySelectorAll('[data-tkf-tile]').forEach(b=>{b.dataset.feedbackId=FICHA_BLOCKS.find(x=>x.key===b.dataset.tkfTile).feedbackId;b.onclick=()=>fichaShow(s,id,b.dataset.tkfTile)})}

/* --- Foco: un bloque entero, con «‹ Portada» -------------------------------------------------------------------------- */
function fichaShow(s,id,key){const P=s._tkfParts;if(!P)return;const store=s.querySelector('.tkf-store'),stage=s.querySelector('.tkf-stage'),portada=s.querySelector('.tkf-portada');
  for(const b of FICHA_BLOCKS)for(const n of fichaBlockNodes(P,b.key))store.append(n);
  fichaFocus=key?{id,key}:null;
  if(!key){stage.hidden=true;stage.replaceChildren();delete stage.dataset.tkfOpen;portada.hidden=false;fichaPaintHead(s,id);const back=s.querySelector(`[data-tkf-tile="${s._tkfLast||''}"]`);back?.focus({preventScroll:false});return}
  const block=FICHA_BLOCKS.find(b=>b.key===key),m=fichaSummary(id),name=key==='material'&&!m?.money?'Material':block.name;s._tkfLast=key;stage.dataset.tkfOpen=key;
  stage.innerHTML=`<button type="button" class="tkf-back" data-feedback-id="tasks.editor_tarea.baldosa.portada" data-feedback-label="Volver a la portada">‹ Portada</button><h3 class="tkf-ftitle" tabindex="-1">${esc(name)}</h3>`;
  for(const n of fichaBlockNodes(P,key))stage.append(n);
  stage.querySelector('.tkf-back').onclick=()=>fichaShow(s,id,null);
  portada.hidden=true;stage.hidden=false;stage.querySelector('.tkf-ftitle').focus({preventScroll:true});s.scrollTop=0}

/* --- El título, en el sitio: el lápiz enseña el campo de siempre (#teText); Enter o salir lo vuelve a la portada. ------- */
function fichaEditTitle(s,id){const field=s._tkfParts?.text,input=document.getElementById('teText');if(!field||!input||input.disabled)return;
  field.classList.remove('tkf-hide');input.focus();input.select()}
function fichaBindTitle(s,id){const field=s._tkfParts?.text,input=document.getElementById('teText');if(!field||!input)return;field.classList.add('tkf-hide','tkf-titlefield');
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();input.blur()}});
  input.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement===input||!field.isConnected)return;field.classList.add('tkf-hide');fichaPaintHead(s,id);document.getElementById('tkfTitleEdit')?.focus({preventScroll:true})},0))}

/* --- «Hecha» arriba: staff, una casilla nueva; outsider, la suya (#outsiderDone), subida junto a prioridad y fecha. Los dos
   pasan por toggleTask, que ya ofrece «Deshacer» (extras-ui.js) y aplaza «Confirmar consumo» (materials-ui.js). ---------- */
function fichaDoneControl(s,id){const row=s._tkfParts?.when;if(!row)return;
  const own=s.querySelector('.outsiderdone');if(own){row.after(own);return}
  if(!canEdit())return;const loc=taskLocation(id);if(!loc)return;
  row.insertAdjacentHTML('afterend',`<label class="checkline outsiderdone tkf-done"><input type="checkbox" id="tkfDone" ${status(loc.p,loc.t)==='done'?'checked':''} data-feedback-id="tasks.editor_tarea.hecha" data-feedback-label="Marcar hecha"><span><strong>Hecha</strong> <span class="small muted">· a un toque, con «Deshacer»</span></span></label>`);
  const box=document.getElementById('tkfDone');box.onchange=()=>{const now=taskLocation(id);if(!now){box.checked=!box.checked;return}
    if((status(now.p,now.t)==='done')!==box.checked)toggleTask(id);const after=taskLocation(id);box.checked=after?status(after.p,after.t)==='done':false;if(typeof refreshChildSection==='function')refreshChildSection(id);fichaPaintHead(s,id)}}
const syncOutsiderDoneBeforeFicha=syncOutsiderDone;
syncOutsiderDone=function(){syncOutsiderDoneBeforeFicha();const s=document.getElementById('sheet'),id=s?._tkfId;if(id&&s.querySelector('.tkf-cover'))fichaPaintHead(s,id)};

/* --- Solo lectura (lector y outsider): lo que no se guarda, desactivado y con el motivo. Comentar, marcar hecha (también
   las hijas, el outsider) y «Proponer un cambio» siguen. ------------------------------------------------------------------ */
function fichaLock(s){if(canEdit())return;const P=s._tkfParts;
  for(const box of [P.text,P.note,P.when,P.labels,P.trade,P.people,P.who,P.space,P.deps,P.files,P.owner,P.level,P.cost])
    box?.querySelectorAll('button,input,select,textarea').forEach(c=>{c.disabled=true;c.setAttribute('aria-disabled','true')});
  s.querySelectorAll('#stepsInOrder,#newChildText,#newChildAdd,#stepFreeToggle').forEach(c=>{c.disabled=true;c.setAttribute('aria-disabled','true')});
  const why=document.createElement('p');why.className='tkf-ro small';why.id='tkfReadOnly';why.textContent=isOutsiderActor()?FICHA_READONLY:FICHA_READER;
  s.querySelector('.tkf-state')?.after(why)}

/* --- La disposición -------------------------------------------------------------------------------------------------- */
function fichaLayout(id){const s=document.getElementById('sheet');if(!s||!s.querySelector('#teText')||s.querySelector('.tkf-portada'))return;
  const P=fichaParts(s);if(!P.actions)return;s._tkfParts=P;s._tkfId=id;s.classList.add('tkf');
  // Outsider: «Quién» sin «Quién sabe hacerlo» (PERDIDAS §2: son datos internos del staff).
  if(isOutsiderActor()&&P.who){P.who.remove();P.who=null}
  const portada=document.createElement('div');portada.className='tkf-portada';
  const stage=document.createElement('div');stage.className='tkf-stage';stage.hidden=true;stage.setAttribute('role','region');stage.setAttribute('aria-label','Bloque de la tarea');
  const store=document.createElement('div');store.className='tkf-store';store.hidden=true;
  const cover=document.createElement('div');cover.className='ikisai-kit tkf-cover';
  const state=document.createElement('p');state.className='tkf-state';
  const tiles=document.createElement('div');tiles.className='tkf-tiles';tiles.setAttribute('role','group');tiles.setAttribute('aria-label','Lo que tiene la tarea');
  portada.append(cover);if(P.text)portada.append(P.text);portada.append(state);if(P.origin)portada.append(P.origin);if(P.when)portada.append(P.when);portada.append(tiles);
  (P.title||s.firstElementChild)?.after(portada);portada.after(stage);P.actions.before(stage);s.append(store);
  for(const b of FICHA_BLOCKS)for(const n of fichaBlockNodes(P,b.key))store.append(n);
  if(P.cost){P.cost.hidden=true;P.cost.classList.add('tkf-hide')}
  fichaBindTitle(s,id);fichaDoneControl(s,id);fichaLock(s);fichaPaintHead(s,id);
  // Lo que cambia la portada mientras la hoja está abierta: fecha, responsable, personas, oficios, hijas, nota.
  const later=()=>setTimeout(()=>{const now=s._tkfId;if(now&&s.isConnected&&s.querySelector('.tkf-portada')&&taskLocation(now))fichaPaintHead(s,now)},0);
  if(!s._tkfBound){s._tkfBound=true;
    s.addEventListener('change',e=>{if(e.target.matches?.('#teDue,#teOwner,#outsiderDone,[data-dependency],#teFiles'))later()});
    s.addEventListener('click',e=>{if(e.target.closest?.('[data-child-toggle],[data-remove-file]'))setTimeout(later,0)})}
  for(const [node,ev] of [[P.people,'people-change'],[P.trade,'trades-change']])node?.addEventListener(ev,later);
  const keep=fichaFocus&&fichaFocus.id===id?fichaFocus.key:null;
  if(keep&&fichaBlockNodes(P,keep).length)fichaShow(s,id,keep);else fichaFocus=null}
const openTaskEditorBeforeFicha=openTaskEditor;
openTaskEditor=function(id,...rest){const out=openTaskEditorBeforeFicha(id,...rest);
  // Un solo «Coste»: el campo suelto no se ve, en ninguna ficha (también la nueva); sigue en la hoja y se guarda.
  document.querySelectorAll('#sheet .costfield').forEach(f=>{f.hidden=true;f.classList.add('tkf-hide')});
  if(id&&taskLocation(id))try{fichaLayout(id)}catch(e){console.error(e)}
  return out};
const closeSheetBeforeFicha=closeSheet;
closeSheet=function(...args){const out=closeSheetBeforeFicha(...args);if(!document.getElementById('sheetBack')?.classList.contains('show'))fichaFocus=null;return out};
/* Al llegar datos (comentarios, materiales, coste, hijas), las líneas de la portada se ponen al día; el foco no se toca. */
const refreshModelBeforeFicha=refreshModel;
refreshModel=function(){refreshModelBeforeFicha();const s=document.getElementById('sheet'),id=s?._tkfId;
  if(!id||!s.querySelector('.tkf-portada')||!taskLocation(id))return;const P=s._tkfParts;
  // Las secciones que se repintan con outerHTML son nodos nuevos: se vuelven a apuntar.
  P.children=s.querySelector('#taskChildren');P.materials=s.querySelector('#taskMaterials');P.costs=s.querySelector('#taskCosts');P.comments=s.querySelector('#taskComments');P.step=s.querySelector('#stepInfo');
  if(!s.querySelector('.tkf-portada').hidden)fichaPaintHead(s,id)};
/* Las secciones que se repintan solas (hijas, coste, materiales) también cambian el nodo: se vuelve a apuntar al nuevo. */
for(const [fn,part,sel] of [['refreshChildSection','children','#taskChildren'],['drawCosts','costs','#taskCosts'],['drawMaterials','materials','#taskMaterials']]){
  if(typeof window[fn]!=='function')continue;const before=window[fn];
  window[fn]=function(...args){const out=before.apply(this,args);const s=document.getElementById('sheet');if(s?._tkfParts){s._tkfParts[part]=s.querySelector(sel);if(!s.querySelector('.tkf-portada')?.hidden)fichaPaintTiles(s,s._tkfId)}return out}}

/* --- «Coste (€) de la tarea» (el campo de antes) se corrige en su línea: lápiz y «×», como los costes a mano. Para quien ve
   importes y puede editar. Se guarda al momento (como «Añadir coste») y el campo oculto de la hoja sigue al valor. ---------- */
function fichaLegacyEditable(taskId){const loc=taskLocation(taskId);return !!loc&&canEdit()&&canSeeCosts(areaIdOf(loc.p))}
const costSectionHtmlBeforeFicha=costSectionHtml;
costSectionHtml=function(taskId){const html=costSectionHtmlBeforeFicha(taskId);if(!fichaLegacyEditable(taskId))return html;
  return html.replace(/<li class="costline"><span>Coste \(€\) de la tarea<\/span><strong>([^<]*)<\/strong><\/li>/,(all,amount)=>`<li class="costline" data-cost-legacy><span>Coste (€) de la tarea</span><strong>${amount}</strong><button class="iconbtn small" type="button" data-cost-legacy-edit aria-label="Corregir el Coste (€) de la tarea" data-feedback-id="tasks.tarea.coste.corregir" data-feedback-label="Corregir el coste de la tarea">✎</button><button class="iconbtn small" type="button" data-cost-legacy-remove aria-label="Quitar el Coste (€) de la tarea" data-feedback-id="tasks.tarea.coste.quitar_antiguo" data-feedback-label="Quitar el coste de la tarea">×</button></li>`)};
function fichaSetLegacyCost(taskId,value){const loc=taskLocation(taskId);if(!loc||!fichaLegacyEditable(taskId))return false;
  loc.t.cost=value;touch(loc.t);record('edit',[taskId]);if(save()===false)return false;
  const input=document.getElementById('teCost');if(input){input.value=value==null?'':String(value);if(typeof editorCost!=='undefined')editorCost={key:'task:'+taskId,value:input.value}}
  setTimeout(()=>{if(document.getElementById('taskCosts'))drawCosts(taskId)},0);return true}
const bindCostsBeforeFicha=bindCosts;
bindCosts=function(taskId){bindCostsBeforeFicha(taskId);const line=document.querySelector('#taskCosts [data-cost-legacy]');if(!line)return;
  const old=()=>taskLocation(taskId)?.t.cost??null;
  line.querySelector('[data-cost-legacy-remove]').onclick=()=>{const before=old();if(!fichaSetLegacyCost(taskId,null))return;
    if(typeof offerLocalUndo==='function')offerLocalUndo('Coste (€) de la tarea quitado',()=>fichaSetLegacyCost(taskId,before));else toast('Coste quitado.')};
  line.querySelector('[data-cost-legacy-edit]').onclick=()=>{const strong=line.querySelector('strong');
    strong.innerHTML=`<input class="inlineedit tkf-costedit" id="costLegacyInput" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(String(old()??''))}" aria-label="Coste (€) de la tarea" data-feedback-id="tasks.tarea.coste.corregir_importe" data-feedback-label="Importe de la tarea">`;
    line.querySelectorAll('button').forEach(b=>b.hidden=true);const input=strong.querySelector('input');input.focus();input.select();
    const commit=()=>{const raw=input.value.trim(),n=Number(raw);if(raw!==''&&(!Number.isFinite(n)||n<0)){toast('El coste debe ser un número finito no negativo.');return input.focus()}
      const value=raw===''||n===0?null:n;if(value===old()){drawCosts(taskId);return}if(fichaSetLegacyCost(taskId,value))toast(value==null?'Coste (€) de la tarea quitado.':'Coste corregido.')};
    input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commit()}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();drawCosts(taskId)}}}};
