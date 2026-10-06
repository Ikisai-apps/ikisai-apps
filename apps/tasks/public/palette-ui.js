/* Paleta de comandos (Ctrl K o Cmd K): salta a un proyecto, un área, una vista guardada o una tarea, y lanza acciones sin el ratón. */
let paletteIndex=0,paletteRows=[];
function foldText(s){return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()}
function paletteOpenProject(areaId,projectId){state.activeTab=areaId;state.taskScope='area';state.currentProject=projectId;state.view='project';state.search='';state.filters={};persistUI();render()}
function paletteCatalog(query){
  const items=[],areas=state.tabs.filter(t=>!t.deleted),after=fn=>()=>{closePalette();fn()};
  if(typeof canEdit==='function'&&canEdit())items.push({group:'Acciones',text:'Nueva tarea',hint:'N',run:after(()=>{const add=document.querySelector('[data-add-task]:not([disabled])');if(add)add.click();else openTaskEditor(null)})});
  items.push({group:'Ir a',text:'Inicio',hint:'I',run:after(()=>navigateView('home'))},{group:'Ir a',text:'Proyectos',run:after(()=>navigateView('projects'))},{group:'Ir a',text:'Todas las tareas',run:after(()=>navigateView('tasks'))},{group:'Ir a',text:'Etiquetas',run:after(()=>navigateView('labels'))});
  if(typeof showMyTasks==='function')items.push({group:'Ir a',text:'Mis tareas',run:after(showMyTasks)});
  items.push({group:'Ir a',text:'Papelera',run:after(()=>showTrash())},{group:'Ir a',text:'Archivados',run:after(()=>showArchive())});
  items.push({group:'Áreas',text:'General',sub:'Todas las áreas',run:after(()=>enterGeneral())});
  for(const a of areas)items.push({group:'Áreas',text:a.name,color:a.color,run:after(()=>{const pill=document.querySelector(`[data-tab="${a.id}"]`);if(pill)pill.click();else{state.activeTab=a.id;state.taskScope='area';navigateView('projects')}})});
  for(const a of areas)for(const p of a.projects||[])if(!p.deleted&&p.status!=='archived'&&!p.system)items.push({group:'Proyectos',text:p.title,sub:a.name,color:p.color,run:after(()=>paletteOpenProject(a.id,p.id))});
  for(const a of areas)for(const v of a.views||[])if(!v.deleted)items.push({group:'Vistas guardadas',text:v.name,sub:a.name,run:after(()=>{state.activeTab=a.id;state.taskScope='area';state.search=v.search||'';state.filters=cloneModel(v.filters||{});state.groupBy=v.groupBy||'project';state.view='tasks';state.currentProject=null;persistUI();render()})});
  if(typeof setTheme==='function')items.push({group:'Tema',text:'Tema claro',run:after(()=>setTheme('light'))},{group:'Tema',text:'Tema oscuro',run:after(()=>setTheme('dark'))},{group:'Tema',text:'Tema del sistema',run:after(()=>setTheme('system'))});
  if(query.length>=2){let n=0;for(const a of areas)for(const p of a.projects||[]){if(p.deleted||p.status==='archived')continue;for(const t of p.tasks||[]){if(t.deleted||t.done||n>=8)continue;if(!foldText(t.text).includes(query))continue;n++;items.push({group:'Tareas',text:t.text,sub:p.title+' · '+a.name,run:after(()=>{state.activeTab=a.id;state.taskScope='area';state.currentProject=p.id;openTaskEditor(t.id)})})}}}
  return items;
}
function paletteFilter(query){
  const all=paletteCatalog(query);
  if(!query)return all.filter(i=>i.group!=='Tareas'&&i.group!=='Tema'&&i.group!=='Vistas guardadas').slice(0,18);
  const words=query.split(/\s+/).filter(Boolean);
  return all.map(i=>{const hay=foldText(i.text+' '+(i.sub||''));if(!words.every(w=>hay.includes(w)))return null;return {...i,rank:foldText(i.text).startsWith(words[0])?0:1}}).filter(Boolean).sort((x,y)=>x.rank-y.rank).slice(0,16);
}
function drawPalette(){
  const box=document.getElementById('paletteList');if(!box)return;
  const query=foldText(document.getElementById('paletteInput').value.trim());
  paletteRows=paletteFilter(query);paletteIndex=Math.min(paletteIndex,Math.max(0,paletteRows.length-1));
  if(!paletteRows.length){box.innerHTML='<div class="palette-empty">Nada coincide. Prueba con el nombre de un proyecto, un área o una tarea.</div>';return}
  let html='',group='';
  paletteRows.forEach((i,n)=>{if(i.group!==group){group=i.group;html+=`<div class="palette-group">${esc(group)}</div>`}html+=`<button type="button" class="palette-item ${n===paletteIndex?'on':''}" data-palette-item="${n}" role="option" aria-selected="${n===paletteIndex}"><span class="pdot ${i.color?'':'plain'}" style="${i.color?`--pcolor:${esc(i.color)}`:''}"></span><span class="ptext"><span>${esc(i.text)}</span>${i.sub?`<small>${esc(i.sub)}</small>`:''}</span>${i.hint?`<span class="phint">${esc(i.hint)}</span>`:'<span></span>'}</button>`});
  box.innerHTML=html;
  box.querySelectorAll('[data-palette-item]').forEach(b=>{b.onclick=()=>paletteRows[+b.dataset.paletteItem]?.run();b.onmousemove=()=>{const n=+b.dataset.paletteItem;if(n!==paletteIndex){paletteIndex=n;box.querySelectorAll('.palette-item').forEach(x=>x.classList.toggle('on',+x.dataset.paletteItem===n))}}});
  box.querySelector('.palette-item.on')?.scrollIntoView({block:'nearest'});
}
function openPalette(){
  if(document.getElementById('palette'))return document.getElementById('paletteInput').focus();
  if(typeof closeNavigation==='function')closeNavigation();
  const back=document.createElement('div');back.id='palette';back.className='palette-back';
  back.innerHTML=`<div class="palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos"><div class="palette-input">${menuIcon('search')}<input id="paletteInput" placeholder="Buscar o saltar: proyectos, áreas, vistas, tareas…" autocomplete="off" spellcheck="false" aria-label="Buscar o saltar"><kbd>Esc</kbd></div><div class="palette-list" id="paletteList" role="listbox"></div><div class="palette-foot"><span>↑ ↓ moverse</span><span>Enter abrir</span><span>Esc cerrar</span></div></div>`;
  document.body.append(back);paletteIndex=0;drawPalette();
  const input=document.getElementById('paletteInput');input.focus();
  input.oninput=()=>{paletteIndex=0;drawPalette()};
  input.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();paletteIndex=Math.min(paletteRows.length-1,paletteIndex+1);drawPalette()}else if(e.key==='ArrowUp'){e.preventDefault();paletteIndex=Math.max(0,paletteIndex-1);drawPalette()}else if(e.key==='Enter'){e.preventDefault();paletteRows[paletteIndex]?.run()}else if(e.key==='Escape'){e.preventDefault();closePalette()}};
  back.onclick=e=>{if(e.target===back)closePalette()};
}
function closePalette(){document.getElementById('palette')?.remove()}
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&!e.altKey&&(e.key==='k'||e.key==='K')){e.preventDefault();if(document.getElementById('palette'))closePalette();else openPalette()}});
