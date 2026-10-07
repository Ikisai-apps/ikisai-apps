/* Dependencias: mismo grafo que el servidor, también al trabajar offline. */
function dependencyIndex(scope=tab()){return new Map(scope.projects.flatMap(p=>p.tasks.map(t=>[t.id,{t,p}])))}
function effectiveDependencies(t,index){return [...new Set([...(t.dependsOn||[]),...(index.get(t.parentId)?.t.dependsOn||[])])]}
function dependencyBlockers(t,p,scope=tab()){
 if(status(p,t)==='done')return [];
 const index=dependencyIndex(scope),subjects=[t,...children(p,t.id).filter(c=>!c.done)],out=[];
 for(const subject of subjects){for(const id of effectiveDependencies(subject,index)){const target=index.get(id);if(target?target.t.deleted||target.p.deleted||status(target.p,target.t)!=='done':subject.hiddenBlockers>0||typeof subject.hiddenBlockers!=='number')out.push(id)}if(subject.hiddenBlockers>0)out.push('hidden-dependency')}
 return [...new Set(out)];
}
function dependencyText(id,scope=tab()){if(id==='hidden-dependency')return 'Tarea fuera de tu acceso';const target=dependencyIndex(scope).get(id);return target?target.t.text+(target.t.deleted||target.p.deleted?' (en papelera)':''):'Tarea no disponible'}
function dependencyEditor(t,id,p){
 const selected=t.dependsOn||[],index=dependencyIndex(),rows=[];
 for(const [key,{t:task,p:project}] of index){if(key===id||((task.deleted||project.deleted||project.status==='archived')&&!selected.includes(key)))continue;const path=project.title+' · '+(task.parentId?'Hija: ':'')+task.text+(task.deleted||project.deleted?' (en papelera)':'');rows.push({key,path})}
 for(const key of selected)if(!index.has(key))rows.push({key,path:'Tarea fuera de tu acceso o no disponible'});
 const inherited=t.parentId?index.get(t.parentId)?.t.dependsOn||[]:[];
 return `<div class="field dependency-field"><label>Depende de</label><details id="dependencyPicker" ${selected.length?'open':''}><summary data-feedback-id="tasks.dependencias.desplegar" data-feedback-label="Tareas previas"><span id="dependencyCount">${selected.length}</span> tareas previas</summary><p class="small muted">Solo estará disponible cuando estén terminadas todas. Puedes elegir tareas de otros proyectos de esta área.</p><input id="dependencySearch" data-feedback-id="tasks.dependencias.buscar" data-feedback-label="Buscar dependencias" type="search" placeholder="Buscar tarea o proyecto" aria-label="Buscar dependencias"><div class="dependency-options">${rows.map(({key,path})=>`<label class="dependency-option" data-dependency-path="${esc(path.toLowerCase())}"><input type="checkbox" data-dependency="${key}" data-feedback-id="tasks.dependencias.anadir" data-feedback-label="Depende de esta tarea" ${selected.includes(key)?'checked':''}><span>${esc(path)}</span></label>`).join('')||'<p class="small muted">Crea otra tarea para poder elegirla como condición.</p>'}</div></details>${inherited.length?`<p class="small muted">Heredadas del padre: ${inherited.map(d=>esc(dependencyText(d))).join(', ')}</p>`:''}</div>`;
}
function bindDependencyEditor(){const search=document.getElementById('dependencySearch');if(!search)return;search.oninput=()=>{const q=search.value.toLowerCase().trim();document.querySelectorAll('[data-dependency-path]').forEach(row=>row.hidden=!row.dataset.dependencyPath.includes(q))};document.querySelectorAll('[data-dependency]').forEach(c=>c.onchange=()=>{document.getElementById('dependencyCount').textContent=document.querySelectorAll('[data-dependency]:checked').length})}
function validateLocalDependencies(before,after){
 const old=flat(before);
 for(const scope of after){const index=dependencyIndex(scope),edges=new Map();
  for(const [id,{t}] of index){const deps=t.dependsOn||[],existing=old.get('task|'+scope.id+'|'+id)?.item.dependsOn||[];if(!Array.isArray(deps)||new Set(deps).size!==deps.length||deps.some(d=>typeof d!=='string'||d===id||!index.has(d)&&!existing.includes(d)))throw Error('Elige otras tareas de esta área, sin duplicados.');edges.set(id,new Set(effectiveDependencies(t,index).filter(d=>index.has(d))))}
  for(const [id,{t}] of index)if(t.parentId&&edges.has(t.parentId))edges.get(t.parentId).add(id);
  const marks=new Map();for(const start of edges.keys()){if(marks.get(start)===2)continue;const stack=[[start,false]];while(stack.length){const [node,exit]=stack.pop();if(exit){marks.set(node,2);continue}if(marks.get(node)===1)throw Error('Estas dependencias forman un ciclo, incluido el nivel padre/hija.');if(marks.get(node)===2)continue;marks.set(node,1);stack.push([node,true]);for(const dep of edges.get(node))stack.push([dep,false])}}
  for(const [id,{t,p}] of index){const previous=old.get('task|'+scope.id+'|'+id)?.item;if(t.deleted||p.deleted||!t.done||previous?.done||children(p,id).length)continue;
   // Evaluate the final batch: internal dependencies completed together are valid.
   const pending=effectiveDependencies(t,index).filter(d=>{const target=index.get(d);return target?target.t.deleted||target.p.deleted||status(target.p,target.t)!=='done':t.hiddenBlockers>0||typeof t.hiddenBlockers!=='number'});if(pending.length||t.hiddenBlockers>0)throw Error('Completa primero: '+(pending.map(d=>dependencyText(d,scope)).join(', ')||'la tarea fuera de tu acceso')+'.');
  }
 }
}
const saveBeforeDependencies=save;
save=function(){try{validateLocalDependencies(Sync.last||[],state.tabs)}catch(e){if(Sync.last)adopt(Sync.last);toast(e.message);return false}return saveBeforeDependencies()};
const rowsBeforeDependencies=taskRow;
taskRow=function(t,p=project(),context=false){let html=rowsBeforeDependencies(t,p,context);const blockers=dependencyBlockers(t,p);if(context)html=html.replace('data-toggle-task=', 'disabled title="Padre mostrado como contexto" data-toggle-task=');if(blockers.length)html=html.replace('</button><button class="taskmenu"',`<span class="dependency-blocked">Bloqueada · ${esc(blockers.map(id=>dependencyText(id)).join(', '))}</span></button><button class="taskmenu"`);return html};
const tasksBeforeDependencies=filteredTasks;
filteredTasks=function(p){const selected=state.filters?._availability||[];return tasksBeforeDependencies(p).filter(t=>!selected.length||status(p,t)!=='done'&&selected.includes(dependencyBlockers(t,p).length?'blocked':'ready'))};
const filtersBeforeDependencies=openFilters;
openFilters=function(){filtersBeforeDependencies();const box=document.createElement('div');box.className='filterfamily';box.innerHTML=`<h4>Disponibilidad</h4>${[['ready','Disponibles ahora'],['blocked','Bloqueadas']].map(([key,name])=>`<button class="filterchip ${(state.filters._availability||[]).includes(key)?'on':''}" data-availability="${key}" data-feedback-id="tasks.filtros.disponibilidad" data-feedback-label="Filtro de disponibilidad">${name}</button>`).join('')}`;document.getElementById('sheet').insertBefore(box,document.querySelector('#sheet .filterfamily'));box.querySelectorAll('button').forEach(b=>b.onclick=()=>{const ids=state.filters._availability||[],id=b.dataset.availability;state.filters._availability=ids.includes(id)?ids.filter(x=>x!==id):[...ids,id];b.classList.toggle('on')})};
const searchBeforeDependencies=searchbar;
searchbar=function(){return searchBeforeDependencies()+((state.filters._availability||[]).length?`<p class="small muted">Disponibilidad: ${state.filters._availability.map(s=>s==='ready'?'Disponibles ahora':'Bloqueadas').join(', ')}</p>`:'')};
