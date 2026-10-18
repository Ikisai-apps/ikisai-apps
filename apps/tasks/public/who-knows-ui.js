/* P2, PR 4 · «Quién sabe hacerlo» (docs/tasks/API.md §34). Al poner un oficio en la ficha de tarea o de proyecto, debajo del
   campo «Oficio» salen las personas que lo saben hacer, como sugerencia: tocar una la añade al campo «Personas» de la misma
   ficha (si no estaba), y se guarda con el resto al pulsar «Guardar». Nada se asigna solo.
   Solo con los oficios y las personas en Central (`trade_source` y `people_source` = 'central'); si las personas siguen en
   etiquetas, no sale. Las capacidades (`central.capability_options`, con el grado efectivo y la herencia de padre a hijos ya
   resuelta por Central) y la disponibilidad (`central.availability_options`, que el outsider no lee) son la última lectura
   guardada en el dispositivo (`Sync.core.capabilities` y `Sync.core.availability`). La lógica pura (orden, unión de varios
   oficios, aprendices) está en apps/tasks/src/who-knows.ts. Va después de people-ui.js: reutiliza `tradesMode`, `peopleMode`,
   `personById`, `personShort`, `personFull`, `personColor`, `addPersonToField`, `tradeDraft`, `peopleDraft` y `CENTRAL_URL`. */
function whoKnowsMode(){return tradesMode()&&peopleMode()&&typeof Sync.core?.refreshCapabilities==='function'}
const WHO_LEVELS=['Aprende','Sabe','Experto'];
const WHO_AVAILABILITY={alta:'disponibilidad alta',media:'disponibilidad media',segun_calendario:'según calendario',baja:'disponibilidad baja',no_disponible:'no disponible'};
/* Se lee al arrancar en los dos modos (core.ts) y, como mucho una vez por minuto, al abrir una ficha con conexión. */
let whoAskedAt=0;
function askCapabilities(force=false){if(!Sync.core?.refreshCapabilities||!Sync.actor||Sync.secondary||!navigator.onLine)return Promise.resolve(false);
  if(!force&&Date.now()-whoAskedAt<60000)return Promise.resolve(false);whoAskedAt=Date.now();return Sync.core.refreshCapabilities()}
/* «Ver también aprendices», por ficha: se olvida al cerrarla. */
let whoApprentices=null;
function whoKnowsList(tradeIds,apprentices){const fn=window.IkisaiTasks?.whoKnows;if(!fn||!Sync.core)return [];
  return fn.whoKnows(tradeIds,Sync.core.capabilities||[],Sync.core.availability||[],{apprentices,known:id=>!!personById(id),nameOf:id=>personById(id)?.name||''})}
function whoHasApprentices(tradeIds){const fn=window.IkisaiTasks?.whoKnows;return !!fn&&!!Sync.core&&fn.hasApprentices(tradeIds,Sync.core.capabilities||[],{known:id=>!!personById(id)})}
function whoChip(w,chosen,color,editable){const name=personFull(w.person_id),level=WHO_LEVELS[w.level]||'',avail=w.availability?WHO_AVAILABILITY[w.availability]||'':'';
  const on=chosen.has(w.person_id),title=[name,level,avail].filter(Boolean).join(' · ');
  const label=on?`${name} (${[level,avail].filter(Boolean).join(', ')}): ya está en Personas`:`Añadir a ${name} (${[level,avail].filter(Boolean).join(', ')}) a Personas`;
  return `<button type="button" class="whochip ${on?'on':''}" style="--who:${esc(color)}" data-who-person="${esc(w.person_id)}" data-level="${w.level}" aria-pressed="${on}" ${on||!editable?'aria-disabled="true"':''} title="${esc(title)}" aria-label="${esc(label)}" data-feedback-id="tasks.ficha.quien_sabe.persona" data-feedback-label="Persona que sabe hacerlo">${w.availability?`<span class="whodot" data-availability="${esc(w.availability)}" aria-hidden="true"></span>`:''}<span class="whoname">${esc(personShort(w.person_id))}</span><span class="ikisai-kit whostar" data-who-star="${w.level}"></span></button>`}
/* Pinta el bloque con lo que haya ahora en los borradores de la ficha (oficios elegidos y personas puestas). */
function paintWhoKnows(box){const tradeIds=tradeDraft&&tradeDraft.key===box.dataset.key?tradeDraft.ids:[],chosen=new Set(peopleDraft&&peopleDraft.key===box.dataset.key?peopleDraft.ids:[]);
  const caps=Sync.core?.capabilities||[];
  // Sin oficio, o sin capacidades leídas nunca (sin red desde siempre), no sale nada.
  if(!tradeIds.length||!caps.length){box.hidden=true;box.innerHTML='';return}
  const apprentices=whoApprentices===box.dataset.key,list=whoKnowsList(tradeIds,apprentices),more=whoHasApprentices(tradeIds),editable=canEdit();
  if(!list.length&&!more){box.hidden=false;box.innerHTML=`<span class="whotitle">Quién sabe hacerlo</span><p class="small muted whoempty">Nadie tiene este oficio todavía. <a href="${CENTRAL_URL}" target="_blank" rel="noopener" data-feedback-id="tasks.ficha.quien_sabe.central" data-feedback-label="Abrir Central">Ponlo en Central</a></p>`;return}
  const color=personColor();box.hidden=false;
  box.innerHTML=`<span class="whotitle" id="${esc(box.id)}-title">Quién sabe hacerlo</span>
    <div class="whochips" role="group" aria-labelledby="${esc(box.id)}-title">${list.map(w=>whoChip(w,chosen,color,editable)).join('')||'<span class="small muted">Solo hay aprendices.</span>'}</div>
    ${more?`<button type="button" class="whomore" data-who-apprentices aria-expanded="${apprentices}" data-feedback-id="tasks.ficha.quien_sabe.aprendices" data-feedback-label="Ver también aprendices">${apprentices?'Ocultar aprendices':'Ver también aprendices'}</button>`:''}`;
  box.querySelectorAll('[data-who-star]').forEach(s=>{const v=Number(s.dataset.whoStar);s.append(IkisaiKit.renderLevelStar(v,3,WHO_LEVELS[v]||''))});
  box.querySelectorAll('[data-who-person]').forEach(b=>b.onclick=e=>{e.preventDefault();if(b.getAttribute('aria-disabled')==='true')return;if(addPersonToField(b.dataset.whoPerson))paintWhoKnows(box)});
  const toggle=box.querySelector('[data-who-apprentices]');if(toggle)toggle.onclick=e=>{e.preventDefault();whoApprentices=apprentices?null:box.dataset.key;paintWhoKnows(box);box.querySelector('[data-who-apprentices]')?.focus()}}
/* Debajo de «Oficio» (y encima de «Personas»): se vuelve a pintar al cambiar el oficio o las personas de la ficha. */
function mountWhoKnows(key){if(!whoKnowsMode())return;const sheet=document.getElementById('sheet'),trade=sheet?.querySelector('.tradefield'),people=sheet?.querySelector('.personfield');if(!trade||!people)return;
  const box=document.createElement('div');box.className='field whoknows';box.id='whoKnows';box.dataset.key=key;box.setAttribute('aria-live','polite');trade.insertAdjacentElement('afterend',box);
  trade.addEventListener('trades-change',()=>paintWhoKnows(box));people.addEventListener('people-change',()=>paintWhoKnows(box));paintWhoKnows(box);
  void askCapabilities().then(ok=>{if(ok&&box.isConnected)paintWhoKnows(box)})}
const taskEditorBeforeWhoKnows=openTaskEditor;
openTaskEditor=function(id,selectedOverride=null,valsOverride=null){taskEditorBeforeWhoKnows(id,selectedOverride,valsOverride);mountWhoKnows('task:'+(id||'new'))};
const projectEditorBeforeWhoKnows=openProjectEditor;
openProjectEditor=function(id,selectedOverride=null,valsOverride=null){projectEditorBeforeWhoKnows(id,selectedOverride,valsOverride);mountWhoKnows('project:'+(id||'new'))};
const closeSheetBeforeWhoKnows=closeSheet;
closeSheet=function(e){closeSheetBeforeWhoKnows(e);if(!document.getElementById('sheetBack').classList.contains('show'))whoApprentices=null};
/* Al arrancar ya las lee core.ts; si se pasa a los dos modos a mitad de sesión (aquí o en otro dispositivo), se leen una vez. */
let whoModeLast=null;
const renderBeforeWhoKnows=render;
render=function(){const result=renderBeforeWhoKnows(),on=whoKnowsMode();if(whoModeLast===null){if(on)whoAskedAt=Date.now()}else if(on&&!whoModeLast)void askCapabilities(true);whoModeLast=on;return result};
