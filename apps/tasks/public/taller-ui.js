/* Dirección visual «Taller»: el acento se deriva del color que la persona eligió para el área o el proyecto y nunca lo sustituye.
   Sin color propio, el acento es neutro. También: chips pastel, filete de prioridad, anillo en tarjetas y entrada animada de vista. */
Object.assign(menuPaths,{search:'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-3.5-3.5',board:'M4 4h5v16H4z M10 4h5v11h-5z M16 4h4v8h-4z',list:'M9 6h12 M9 12h12 M9 18h12 M4 6h.01 M4 12h.01 M4 18h.01'});
function accentSource(){
  if(typeof tab!=='function'||!tab())return null;
  if(state.view==='project'){const p=project();if(p&&p.color)return p.color}
  if(typeof generalMode==='function'&&generalMode())return null;
  return tab().color||null;
}
function applyAccent(){
  const root=document.documentElement,color=accentSource();
  if(color){root.style.setProperty('--accent',color);root.style.setProperty('--accent-ink',inkOn(color))}
  else{root.style.removeProperty('--accent');root.style.removeProperty('--accent-ink')}
}
// Chips pastel: el color de la familia pasa a una variable para que el CSS lo mezcle con el papel.
function pastelize(root=document){
  root.querySelectorAll('.chip:not([data-pastel])').forEach(el=>{const c=el.style.backgroundColor;if(!c)return;el.style.setProperty('--chip',c);el.dataset.pastel='1'});
}
let pastelQueued=false;
new MutationObserver(()=>{if(pastelQueued)return;pastelQueued=true;requestAnimationFrame(()=>{pastelQueued=false;pastelize()})}).observe(document.documentElement,{childList:true,subtree:true});
// Filete lateral de prioridad en filas y en «Ahora».
const taskRowBeforeTaller=taskRow;
taskRow=function(t,p=project(),context=false){
  let html=taskRowBeforeTaller(t,p,context);
  const shown=typeof effectivePriority==='function'?effectivePriority(p,t):(t.priority||'normal');
  if(shown==='high'||shown==='critical')html=html.replace('<article class="task ',`<article class="task prio-${shown} `);
  return html;
};
if(typeof homeTaskRow==='function'){
  const homeTaskRowBeforeTaller=homeTaskRow;
  homeTaskRow=function(r){
    const cls=['hometask'];if(r.prio&&r.prio!=='normal')cls.push('prio-'+r.prio);if(r.t.due&&homeDayOf(r.t.due)===0)cls.push('urgent');
    return homeTaskRowBeforeTaller(r).replace('class="hometask"',`class="${cls.join(' ')}"`);
  };
}
// Anillo de progreso en la esquina de cada tarjeta de proyecto.
// Atajo a la paleta dentro del buscador.
const searchbarBeforeTaller=searchbar;
searchbar=function(){return searchbarBeforeTaller().replace(/(<input id="searchInput"[^>]*>)/,'<div class="searchwrap">$1<button type="button" class="kbdhint" data-open-palette aria-label="Abrir la paleta de comandos" title="Ctrl K">'+menuIcon('search')+'<span>Ctrl K</span></button></div>')};
// Entrada de vista animada solo cuando cambia la pantalla, no en cada repintado; y marca de solo lectura.
let tallerViewKey='';
const renderBeforeTaller=render;
render=function(){
  renderBeforeTaller();applyAccent();
  const app=document.getElementById('app');if(!app)return;
  app.classList.toggle('readonly',typeof canEdit==='function'&&!canEdit());
  const key=[state.view,state.activeTab,state.currentProject,state.taskScope].join('|');
  if(key!==tallerViewKey){app.classList.add('view-enter');setTimeout(()=>app.classList.remove('view-enter'),320)}
  tallerViewKey=key;
  document.querySelectorAll('[data-open-palette]').forEach(b=>b.onclick=()=>typeof openPalette==='function'&&openPalette());
};
