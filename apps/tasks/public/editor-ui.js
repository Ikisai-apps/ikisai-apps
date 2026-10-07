/* Filas y editor de tarea: estrella de prioridad delante del texto, etiquetas heredadas de las hijas, edición y alta en línea,
   y selector de etiquetas desplegado dentro del editor. Los controles originales siguen en el formulario, ocultos a la vista. */
const PRIORITY_CYCLE=['normal','high','critical'],PRIORITY_NAME={normal:'Normal',high:'Alta',critical:'Crítica'};
function priorityStar(value,label){return `<span class="star star-${esc(value||'normal')}" role="img" aria-label="${esc(label||'Prioridad '+(PRIORITY_NAME[value]||'normal').toLowerCase())}"></span>`}
function inheritedLabels(p,t){const own=new Set(t.labels||[]);return [...new Set(children(p,t.id).flatMap(c=>c.labels||[]))].filter(id=>!own.has(id))}
function inheritedChips(ids){return ids.map(id=>{const l=label(id);if(!l||l.archived)return'';return `<span class="chip inherited" style="background:${familyColorByLabel(id)}" title="Heredada de una tarea hija">${esc(l.text)}</span>`}).join('')}
// Urgencia heredada: una tarea padre toma la mayor de sus hijas pendientes; un proyecto, la mayor de sus tareas. Se calcula, no se guarda.
const PRIORITY_RANK={normal:0,high:1,critical:2};
function effectivePriority(p,t){const own=t.priority||'normal';return children(p,t.id).filter(c=>!c.done).reduce((best,c)=>PRIORITY_RANK[c.priority||'normal']>PRIORITY_RANK[best]?(c.priority||'normal'):best,own)}
function projectPriority(p){return p.tasks.filter(t=>!t.deleted&&!t.parentId&&status(p,t)!=='done').reduce((best,t)=>{const e=effectivePriority(p,t);return PRIORITY_RANK[e]>PRIORITY_RANK[best]?e:best},'normal')}
// Fechas con sentido: vencidas en rojo, «Hoy» y «Mañana» destacados, año solo si no es el actual.
function dueInfo(due,done){if(!due)return null;const today=new Date();today.setHours(0,0,0,0);const d=new Date(due+'T00:00:00');if(isNaN(d))return {label:due,cls:''};const diff=Math.round((d-today)/86400000);let label=fmtDate(due);if(d.getFullYear()!==today.getFullYear())label+=' '+d.getFullYear();let cls='';if(!done){if(diff<0){cls='overdue';label='Vencida · '+label}else if(diff===0){cls='today';label='Hoy'}else if(diff===1){cls='soon';label='Mañana'}}return {label,cls}}
const rowsBeforePriority=taskRow;
taskRow=function(t,p=project(),context=false){
  let html=rowsBeforePriority(t,p,context).replace('<span class="priority">Crítica</span>','').replace('<span class="priority">Alta</span>','');
  if(t.due){const info=dueInfo(t.due,status(p,t)==='done');if(info)html=html.replace(`<span>${fmtDate(t.due)}</span>`,`<span class="due ${info.cls}" title="${esc(t.due)}">${esc(info.label)}</span>`)}
  const shown=effectivePriority(p,t),raised=shown!==(t.priority||'normal');
  if(shown==='high'||shown==='critical')html=html.replace('<span class="tasktext">',`<span class="tasktext">${priorityStar(shown,'Prioridad '+(shown==='critical'?'crítica':'alta')+(raised?' heredada de una hija':''))}`);
  const inherited=inheritedLabels(p,t);if(inherited.length)html=html.replace(`<span class="chips taskchips">${chips(t.labels||[])}`,`<span class="chips taskchips">${chips(t.labels||[])}${inheritedChips(inherited)}`);
  return html;
};
// Editor: estrella, nivel oculto y selector de etiquetas desplegado.
let editorSelection=null;
const editorBeforePriority=openTaskEditor;
openTaskEditor=function(id,selectedOverride=null,valsOverride=null){
  editorBeforePriority(id,selectedOverride,valsOverride);
  const select=document.getElementById('tePriority');if(!select)return;
  select.classList.add('visually-hidden-control');select.tabIndex=-1;
  select.insertAdjacentHTML('afterend','<button type="button" class="prioritybtn" id="priorityStar" data-feedback-id="tasks.editor_tarea.prioridad" data-feedback-label="Prioridad"><span class="star"></span><span class="priorityname"></span></button>');
  const button=document.getElementById('priorityStar');
  const draw=()=>{const name=PRIORITY_NAME[select.value]||'Normal';button.querySelector('.star').className='star star-'+(select.value||'normal');button.querySelector('.priorityname').textContent=name;button.setAttribute('aria-label','Prioridad '+name.toLowerCase()+'. Pulsa para cambiar');button.title='Pulsa para cambiar: normal, alta, crítica'};
  button.onclick=()=>{select.value=PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(select.value)+1)%PRIORITY_CYCLE.length];select.dispatchEvent(new Event('change'));draw()};
  select.addEventListener('change',draw);draw();
  const level=document.getElementById('teParent');if(level)level.closest('.field')?.classList.add('hidden-level');
  const loc=id?taskLocation(id):null,initial=selectedOverride??(loc?.t.labels||project()?.ownLabels||[]);
  mountInlinePicker('editLabelsBtn',editorSelection&&editorSelection.key==='task:'+(id||'new')?editorSelection.ids:[...initial],'task:'+(id||'new'));
};
const projectEditorBeforePicker=openProjectEditor;
openProjectEditor=function(id,selectedOverride=null,valsOverride=null){
  projectEditorBeforePicker(id,selectedOverride,valsOverride);
  if(!document.getElementById('editProjectLabels'))return;
  const base=id?tab().projects.find(x=>x.id===id):null,initial=selectedOverride??(base?.ownLabels||[]);
  mountInlinePicker('editProjectLabels',editorSelection&&editorSelection.key==='project:'+(id||'new')?editorSelection.ids:[...initial],'project:'+(id||'new'));
};
function mountInlinePicker(buttonId,selected,key){
  const button=document.getElementById(buttonId);if(!button)return;editorSelection={key,ids:[...selected]};
  button.classList.add('small','pickermore');button.textContent='+ Nueva etiqueta…';button.title='Abre el selector completo, donde también puedes crear etiquetas';
  const used=new Set((project()?.tasks||[]).flatMap(t=>t.labels||[]));
  // En pantallas estrechas cada familia se pliega; las que tienen selección quedan abiertas.
  const wide=matchMedia('(min-width:1024px)').matches;
  const html=tab().families.filter(f=>!f.archived).map(f=>{const ls=tab().labels.filter(l=>l.family===f.id&&(!l.archived||selected.includes(l.id))).sort((a,b)=>Number(used.has(b.id))-Number(used.has(a.id)));if(!ls.length)return'';const picked=ls.filter(l=>selected.includes(l.id));return `<details class="family inlinefamily" ${wide||picked.length?'open':''}><summary class="familyhead" data-feedback-id="tasks.selector_etiquetas.familia" data-feedback-label="Familia de etiquetas"><span class="dot" style="background:${esc(f.color)}"></span><span class="familyname">${esc(f.name)}</span>${picked.length?`<span class="count">${picked.length}</span>`:''}</summary><div class="familychips">${ls.map(l=>`<button type="button" class="filterchip ${selected.includes(l.id)?'on':''}" style="color:${esc(f.color)}" data-inline-label="${l.id}" data-feedback-id="tasks.selector_etiquetas.etiqueta" data-feedback-label="Etiqueta">${esc(labelName(l))}</button>`).join('')}</div></details>`}).join('');
  button.insertAdjacentHTML('beforebegin',`<div class="inlinepicker">${html||'<p class="small muted">Este área no tiene etiquetas todavía.</p>'}</div>`);
  button.parentElement.querySelector('.chips')?.classList.add('inlinepicker-summary');
  document.querySelectorAll('[data-inline-label]').forEach(chip=>chip.onclick=()=>{const id=chip.dataset.inlineLabel,next=selected.includes(id)?selected.filter(x=>x!==id):[...selected,id],sheet=document.getElementById('sheet'),scroll=sheet.scrollTop;editorSelection={key,ids:next};
    // El selector original devuelve la selección por su propio camino, conservando el borrador y la referencia de edición.
    const original=openLabelPicker;openLabelPicker=(current,cb)=>{openLabelPicker=original;cb(next)};button.click();document.getElementById('sheet').scrollTop=scroll});
}
const closeSheetBeforeEditor=closeSheet;
closeSheet=function(e){closeSheetBeforeEditor(e);if(!document.getElementById('sheetBack').classList.contains('show'))editorSelection=null};
// Edición en línea del texto de una tarea y alta en línea al final de un proyecto.
let inlineEdit=null,inlineNew=null;
function startInlineEdit(id){const loc=taskLocation(id);if(!loc||!canEdit())return;inlineEdit={id,value:loc.t.text,baseline:loc.t.text};render()}
function commitInlineEdit(){if(!inlineEdit)return;const {id,value,baseline}=inlineEdit;inlineEdit=null;const loc=taskLocation(id),text=value.trim();if(!loc||!text||text===baseline)return render();if(loc.t.text!==baseline){toast('La tarea ha cambiado mientras la editabas. Revisa antes de guardar.');return render()}loc.t.text=text;touch(loc.t);record('edit',[id]);save();render()}
function mountInlineEdit(){if(!inlineEdit)return;const body=document.querySelector(`[data-row="${inlineEdit.id}"] .tasktext`);if(!body)return;body.innerHTML=`<input class="inlineedit" value="${esc(inlineEdit.value)}" aria-label="Texto de la tarea" data-feedback-id="tasks.tarea.edicion.texto" data-feedback-label="Texto de la tarea">`;const input=body.querySelector('input');input.oninput=()=>inlineEdit&&(inlineEdit.value=input.value);input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commitInlineEdit()}if(e.key==='Escape'){e.preventDefault();inlineEdit=null;render()}};input.onblur=()=>setTimeout(()=>{if(inlineEdit&&document.activeElement!==input)commitInlineEdit()},120);input.onclick=e=>e.stopPropagation();input.focus();input.setSelectionRange(input.value.length,input.value.length)}
function startInlineNew(pid,parentId=null){if(!canEdit())return;inlineEdit=null;inlineNew={pid,parentId,value:'',priority:'normal'};render()}
function createInlineTask(){if(!inlineNew)return;const {pid,parentId,value,priority}=inlineNew,text=value.trim();if(!text){inlineNew=null;return render()}const p=tab().projects.find(x=>x.id===pid&&!x.deleted&&x.status!=='archived');if(!p){inlineNew=null;toast('El proyecto ya no está disponible.');return render()}const parent=parentId?p.tasks.find(x=>x.id===parentId&&!x.deleted&&!x.parentId):null;const task={id:uid('t'),text,note:'',done:false,priority,due:'',owner:null,parentId:parent?parent.id:null,labels:[...(p.ownLabels||[])],attachments:[],dependsOn:[],order:Math.max(0,...p.tasks.map(x=>x.order||0))+1024,version:1};p.tasks.push(task);if(parent)syncParent(p,parent.id);syncAll(p);record('create',[task.id]);const ok=save();inlineNew=ok===false?null:{pid,parentId:parent?parent.id:null,value:'',priority:'normal'};render()}
function mountInlineNew(){if(!inlineNew)return;const {pid,parentId}=inlineNew;let list=null;if(state.view==='project'&&project()?.id===pid)list=document.querySelector('main .tasklist');else{const adder=document.querySelector(`[data-add-task="${pid}"]`);list=adder?.previousElementSibling?.classList.contains('tasklist')?adder.previousElementSibling:null}if(!list){inlineNew=null;return}list.querySelector(':scope > .empty')?.remove();
  list.insertAdjacentHTML('beforeend',`<article class="task newtask ${parentId?'child':''}"><button type="button" class="newstar" aria-label="Prioridad de la nueva tarea" data-feedback-id="tasks.tarea.alta.prioridad" data-feedback-label="Prioridad de la nueva tarea"><span class="star star-${inlineNew.priority}"></span></button><input class="inlineedit newinput" placeholder="${parentId?'Nueva tarea hija…':'Nueva tarea…'}" aria-label="Nueva tarea" value="${esc(inlineNew.value)}" data-feedback-id="tasks.tarea.alta.texto" data-feedback-label="Nueva tarea"><button type="button" class="ghost small newcancel" aria-label="Cancelar" data-feedback-id="tasks.tarea.alta.cancelar" data-feedback-label="Cancelar">Esc</button></article>`);
  const row=list.lastElementChild,input=row.querySelector('input'),star=row.querySelector('.newstar');
  star.onclick=()=>{inlineNew.priority=PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(inlineNew.priority)+1)%PRIORITY_CYCLE.length];star.querySelector('.star').className='star star-'+inlineNew.priority;input.focus()};
  input.oninput=()=>inlineNew&&(inlineNew.value=input.value);input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();createInlineTask()}if(e.key==='Escape'){e.preventDefault();inlineNew=null;render()}};
  row.querySelector('.newcancel').onclick=()=>{inlineNew=null;render()};
  input.focus();row.scrollIntoView({block:'nearest'});
}
// Completadas al final de cada lista: cada tarea principal viaja con sus hijas.
const treeRowsBeforeOrder=treeRows;
treeRows=function(p){const html=treeRowsBeforeOrder(p);if(!html.includes('class="task'))return html;const holder=document.createElement('template');holder.innerHTML=html;const blocks=[];for(const node of holder.content.children){if(node.classList?.contains('child')&&blocks.length)blocks[blocks.length-1].push(node);else blocks.push([node])}const finished=b=>b[0].classList?.contains('done')&&!b[0].classList.contains('context');return [...blocks.filter(b=>!finished(b)),...blocks.filter(finished)].flat().map(n=>n.outerHTML).join('')};
// En la página de proyecto, «+ Añadir tarea» abre la fila en línea; el botón original sigue en el DOM para los flujos que lo usan. «Cómo mover» pasa a icono.
Object.assign(menuPaths,{help:'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7 M12 17h.01'});
const projectViewBeforeInline=projectView;
projectView=function(){const html=projectViewBeforeInline(),p=project();if(!p)return html;return html.replace('<button class="quickadd" id="quickAdd">+ Añadir tarea</button>',`<div class="addrow"><button class="quickadd addtask" data-add-task="${p.id}" ${canEdit()?'':'disabled'} data-feedback-id="tasks.proyecto.tareas.anadir" data-feedback-label="Añadir tarea">+ Añadir tarea</button><button class="quickadd quickdetail" id="quickAdd" title="Abrir el formulario completo" data-feedback-id="tasks.proyecto.tareas.con_detalles" data-feedback-label="Con detalles">Con detalles…</button></div>`).replace('<button class="ghost small" id="dragHelp">Cómo mover</button>',`<button class="iconbtn helpbtn" id="dragHelp" aria-label="Cómo mover tareas" data-tip="Cómo mover" data-feedback-id="tasks.proyecto.tareas.como_mover" data-feedback-label="Cómo mover">${menuIcon('help')}</button>`)};
// El menú ⋮ de la tarea pierde «Añadir hija»: las hijas se crean desde «+ Añadir tarea» al nivel que toque.
const taskMenuBeforeTrim=openTaskMenu;
openTaskMenu=function(id){taskMenuBeforeTrim(id);const child=document.getElementById('menuChild');if(child){child.classList.add('ghostcontrol');child.tabIndex=-1}};
const renderBeforeInline=render;
render=function(){const result=renderBeforeInline();mountInlineEdit();mountInlineNew();return result};
const bindBeforeInline=bind;
bind=function(){bindBeforeInline();
  document.querySelectorAll('.task:not(.context) .tasktext').forEach(el=>el.addEventListener('click',e=>{if(!canEdit()||inlineEdit)return;e.stopPropagation();e.preventDefault();startInlineEdit(el.closest('[data-row]').dataset.row)}));
  const fab=document.getElementById('fab');if(fab&&state.view==='project'&&project())fab.onclick=()=>startInlineNew(project().id);
  document.querySelectorAll('[data-add-task]').forEach(b=>b.onclick=()=>{if(!canEdit())return;const pid=b.dataset.addTask,rows=b.previousElementSibling?.querySelectorAll('[data-row]')||[],last=rows[rows.length-1],parentId=last?taskLocation(last.dataset.row)?.t.parentId||null:null;startInlineNew(pid,parentId)});
};
/* ✓ de guardar junto a cada campo en línea (aceptación V1, 5): en el móvil Enter no siempre se ve. Hace lo mismo que
   Enter, y no quita el foco al campo al pulsarlo (así no salta antes el guardado o la cancelación por pérdida de foco). */
function addInlineSave(input){if(input.dataset.saveButton)return;input.dataset.saveButton='1';
  const button=document.createElement('button');button.type='button';button.className='inlinesave';button.setAttribute('aria-label','Guardar');button.title='Guardar';button.textContent='✓';
  button.addEventListener('pointerdown',e=>e.preventDefault());button.addEventListener('mousedown',e=>e.preventDefault());
  button.addEventListener('click',()=>{input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))});
  const parent=input.offsetParent||input.parentElement;if(parent&&getComputedStyle(parent).position==='static')parent.style.position='relative';
  input.insertAdjacentElement('afterend',button);
  const place=()=>{if(!button.isConnected)return;const size=Math.min(36,Math.max(28,input.offsetHeight-8));Object.assign(button.style,{width:size+'px',height:size+'px',top:(input.offsetTop+(input.offsetHeight-size)/2)+'px',left:(input.offsetLeft+input.offsetWidth-size-4)+'px'})};
  place();requestAnimationFrame(place)}
new MutationObserver(()=>document.querySelectorAll('input.inlineedit').forEach(addInlineSave)).observe(document.body,{childList:true,subtree:true});
