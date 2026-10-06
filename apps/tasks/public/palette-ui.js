/* Paleta de comandos (Ctrl K o Cmd K): salta a un proyecto, un área, una vista guardada o una tarea, y lanza acciones sin el ratón. */
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
/* La paleta del kit común (IkisaiKit.createCommandPalette) con el mismo catálogo y la misma regla de grupos: sin consulta
   se ocultan «Tareas», «Tema» y «Vistas guardadas», hasta 18 resultados sin consulta y 16 con ella. Se monta en la capa del kit
   (#kitLayer) y conserva #palette, #paletteInput, Ctrl K / Cmd K y [data-open-palette] (taller-ui.js llama a openPalette). */
const tasksPalette=IkisaiKit.createCommandPalette({items:query=>paletteCatalog(query),placeholder:'Buscar o saltar: proyectos, áreas, vistas, tareas…',limit:16,limitWhenEmpty:18,hiddenWhenEmpty:['Tareas','Tema','Vistas guardadas'],hotkey:false,container:()=>sheetKitLayer()});
function openPalette(){if(document.getElementById('palette'))return document.getElementById('paletteInput').focus();if(typeof closeNavigation==='function')closeNavigation();tasksPalette.open()}
function closePalette(){tasksPalette.close()}
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&!e.altKey&&(e.key==='k'||e.key==='K')){e.preventDefault();if(document.getElementById('palette'))closePalette();else openPalette()}});
