/* Tablero del proyecto: columnas por horizonte de fecha. Arrastrar una tarjeta cambia la fecha objetivo o la completa. */
const BOARD_KEY='ikisai-board';
function boardOn(){try{return localStorage.getItem(BOARD_KEY)==='1'}catch(e){return false}}
function setBoardMode(on){try{if(on)localStorage.setItem(BOARD_KEY,'1');else localStorage.removeItem(BOARD_KEY)}catch(e){}render()}
function boardDay(offset){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+offset);const pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`}
function boardColumns(){
  const dow=new Date().getDay(),today=boardDay(0),tomorrow=boardDay(1),sunday=boardDay((7-dow)%7),nextMonday=boardDay(((8-dow)%7)||7);
  const cols=[{id:'overdue',name:'Vencidas',drop:null},{id:'today',name:'Hoy',drop:today},{id:'tomorrow',name:'Mañana',drop:tomorrow},{id:'week',name:'Esta semana',drop:sunday},{id:'later',name:'Más adelante',drop:nextMonday},{id:'none',name:'Sin fecha',drop:''},{id:'done',name:'Hechas',drop:'done'}];
  const seen=new Set();return cols.filter(c=>{if(c.drop===null||c.drop===''||c.drop==='done')return true;if(seen.has(c.drop))return false;seen.add(c.drop);return true});
}
function boardColumnOf(p,t,cols){
  if(status(p,t)==='done')return 'done';
  if(!t.due)return 'none';
  const today=boardDay(0),ids=cols.map(c=>c.id);
  if(t.due<today)return 'overdue';
  if(t.due===today)return 'today';
  if(ids.includes('tomorrow')&&t.due===boardDay(1))return 'tomorrow';
  const week=cols.find(c=>c.id==='week');if(week&&t.due<=week.drop)return 'week';
  return 'later';
}
function boardCard(p,t){
  const shown=typeof effectivePriority==='function'?effectivePriority(p,t):(t.priority||'normal'),done=status(p,t)==='done',info=t.due&&typeof dueInfo==='function'?dueInfo(t.due,done):null;
  return `<article class="boardcard ${done?'done':''} ${shown!=='normal'?'prio-'+shown:''}" data-board-task="${t.id}" data-feedback-id="tasks.tablero.tarjeta" data-feedback-label="Abrir tarea" tabindex="0" role="button" aria-label="${esc(t.text)}"><span class="boardtext">${shown!=='normal'?priorityStar(shown):''}${esc(t.text)}</span>${(t.labels||[]).length?`<span class="chips">${chips(t.labels)}</span>`:''}<span class="boardmeta">${info?`<span class="due ${info.cls}">${esc(info.label)}</span>`:''}${t.cost?`<span class="cost">${esc(String(t.cost))} €</span>`:''}${t.note?`<span class="muted">${esc(t.note.length>40?t.note.slice(0,40)+'…':t.note)}</span>`:''}</span></article>`;
}
function boardView(p){
  const cols=boardColumns(),tasks=filteredTasks(p).filter(t=>!children(p,t.id).length),groups={};
  for(const t of tasks){const id=boardColumnOf(p,t,cols);(groups[id]=groups[id]||[]).push(t)}
  const show=cols.filter(c=>c.id!=='overdue'||(groups.overdue||[]).length);
  return `<div class="board" aria-label="Tablero por fechas">${show.map(c=>{const list=(groups[c.id]||[]).sort((a,b)=>(a.due||'9')<(b.due||'9')?-1:(a.due||'9')>(b.due||'9')?1:a.order-b.order);return `<section class="boardcol ${c.id} ${c.drop===null?'locked':''}" data-board-col="${c.id}" data-board-drop="${c.drop===null?'':esc(c.drop)}" ${c.drop===null?'data-board-locked="1"':''}><div class="boardhead">${esc(c.name)}<span class="count">${list.length}</span></div>${list.map(t=>boardCard(p,t)).join('')||'<div class="boardempty">Nada aquí</div>'}</section>`}).join('')}</div>`;
}
function boardToggle(){const on=boardOn();return `<div class="segmented" role="group" aria-label="Modo de vista"><button type="button" class="${on?'':'on'}" data-board-mode="list" data-feedback-id="tasks.tablero.modo.lista" data-feedback-label="Vista de lista" aria-pressed="${!on}" data-tip="Lista">${menuIcon('list')}</button><button type="button" class="${on?'on':''}" data-board-mode="board" data-feedback-id="tasks.tablero.modo.tablero" data-feedback-label="Vista de tablero" aria-pressed="${on}" data-tip="Tablero">${menuIcon('board')}</button></div>`}
const projectViewBeforeBoard=projectView;
projectView=function(){
  let html=projectViewBeforeBoard();const p=project();if(!p)return html;
  html=html.replace(/(<div class="sectionlabel">Tareas <span class="count">\d+<\/span>)/,'$1'+boardToggle());
  if(!boardOn())return html;
  html=html.replace(/<button type="button" class="ghost small batchtoggle[^"]*" id="batchToggle"[\s\S]*?<\/button>/,'');
  return html.replace(/<div class="tasklist">[\s\S]*?<\/div><div class="addrow">/,boardView(p)+'<div class="addrow">');
};
let boardDrag=null;
function boardApplyDrop(id,drop){
  const loc=taskLocation(id);if(!loc)return;
  if(drop==='done'){if(!loc.t.done)toggleTask(id);return}
  if(loc.t.due===drop)return;
  loc.t.due=drop;touch(loc.t);record('edit',[id]);save();render();toast(drop?'Fecha cambiada':'Fecha quitada');
}
function boardPointerDown(e){
  if(e.button!==0)return;const card=e.currentTarget,id=card.dataset.boardTask,touchy=e.pointerType==='touch';
  const d={id,x:e.clientX,y:e.clientY,started:false,target:null,ghost:null,timer:null,hold:!touchy};boardDrag=d;
  const start=()=>{if(d.started)return;if(!canEdit()){return}d.started=true;card.classList.add('lifting');card.setPointerCapture(e.pointerId);const g=card.cloneNode(true);g.id='boardGhost';g.classList.remove('lifting');g.style.left=(d.x-40)+'px';g.style.top=(d.y-20)+'px';document.body.append(g);d.ghost=g;document.body.classList.add('dragging')};
  if(touchy)d.timer=setTimeout(()=>{d.hold=true;start()},380);
  const move=ev=>{if(boardDrag!==d)return;const dx=ev.clientX-d.x,dy=ev.clientY-d.y;if(!d.started){if(!d.hold){if(Math.hypot(dx,dy)>8){clearTimeout(d.timer);cleanup()}return}if(Math.hypot(dx,dy)>6)start();if(!d.started)return}ev.preventDefault();d.ghost.style.left=(ev.clientX-40)+'px';d.ghost.style.top=(ev.clientY-20)+'px';const col=document.elementFromPoint(ev.clientX,ev.clientY)?.closest('.boardcol');document.querySelectorAll('.boardcol').forEach(c=>{c.classList.toggle('drop',c===col&&!c.dataset.boardLocked);c.classList.toggle('dragover-locked',c===col&&!!c.dataset.boardLocked)});d.target=col&&!col.dataset.boardLocked?col.dataset.boardDrop:null};
  const cleanup=()=>{clearTimeout(d.timer);card.removeEventListener('pointermove',move);card.removeEventListener('pointerup',end);card.removeEventListener('pointercancel',end);card.classList.remove('lifting');d.ghost?.remove();document.body.classList.remove('dragging');document.querySelectorAll('.boardcol').forEach(c=>c.classList.remove('drop','dragover-locked'));if(boardDrag===d)boardDrag=null};
  const end=ev=>{const started=d.started,target=d.target;cleanup();if(!started){if(ev.type==='pointerup')openTaskEditor(id);return}if(target===null)return;boardApplyDrop(id,target)};
  card.addEventListener('pointermove',move);card.addEventListener('pointerup',end);card.addEventListener('pointercancel',end);
}
const bindBeforeBoard=bind;
bind=function(){
  bindBeforeBoard();
  document.querySelectorAll('[data-board-mode]').forEach(b=>b.onclick=()=>setBoardMode(b.dataset.boardMode==='board'));
  document.querySelectorAll('[data-board-task]').forEach(card=>{card.onpointerdown=boardPointerDown;card.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openTaskEditor(card.dataset.boardTask)}}});
};
