/* Ikisai Tasks · O1, paso 2 (docs/tasks/API.md §31): comentarios de una tarea, para todos, y la casilla de hecha del
   outsider en la ficha.
   - El hilo va en la ficha de la tarea, del más antiguo al más reciente, con el nombre del autor (de Sync.members o del
     perfil, que guarda el servidor al comentar) y la hora relativa. Debajo, «Escribe un comentario…», una foto opcional
     (la misma recompresión que los adjuntos: 1600 px en WebP) y «Enviar».
   - Comentan el editor, la propietaria y el outsider (en lo que tiene abierto); el lector solo lee. Cada uno edita o
     borra lo suyo, y la propietaria borra cualquiera. El servidor lo vuelve a comprobar todo.
   - La tarjeta de la tarea lleva un contador discreto 💬 n si tiene comentarios.
   - El outsider sigue siendo lector para todo lo demás (Sync.actor.role === 'reader'): aquí solo se le habilitan la
     casilla de hecha (también la de las hijas) y el hilo. */
const COMMENT_MAX=2000,COMMENT_PHOTO_LIMIT=25*1024*1024;
/** URL de objeto de la foto de cada comentario (la descargada o la recién elegida, que aún espera en la cola). */
const commentPhotoUrls=new Map();
/** Borrador del hilo abierto: tarea, texto y foto elegida ({sha256,url,name}). */
let commentDraft=null;
let commentEditing=null;

function canComment(){return !!Sync.actor&&!Sync.secondary&&(Sync.actor.role!=='reader'||!!Sync.actor.outsider)}
function isOutsiderActor(){return !!Sync.actor?.outsider&&!Sync.secondary}
function commentsOf(taskId){try{return Sync.core?.comments?.(taskId)||[]}catch{return []}}
function commentMine(c){return !c.author_id||c.author_id===Sync.actor?.id}
function commentAuthor(c){
  if(commentMine(c))return Sync.actor?.name||c.author_name||'Tú';
  const member=(Sync.members||[]).find(m=>m.userId===c.author_id);
  return member?.displayName||c.author_name||'Otra persona'}
function commentWhen(iso){const at=Date.parse(iso);if(!Number.isFinite(at))return '';const s=Math.max(0,Math.round((Date.now()-at)/1000));
  const rel=new Intl.RelativeTimeFormat('es',{numeric:'auto'});
  if(s<45)return 'ahora';if(s<3600)return rel.format(-Math.round(s/60),'minute');if(s<86400)return rel.format(-Math.round(s/3600),'hour');if(s<7*86400)return rel.format(-Math.round(s/86400),'day');
  return new Date(at).toLocaleDateString('es-ES',{day:'numeric',month:'short',year:new Date(at).getFullYear()===new Date().getFullYear()?undefined:'numeric'})}

function commentItemHtml(c){const mine=commentMine(c),owner=Sync.actor?.role==='owner'&&!Sync.secondary,editing=commentEditing===c.id;
  const photo=c.file_id?`<img class="commentphoto" data-comment-photo="${c.id}" alt="Foto de ${esc(commentAuthor(c))}" ${commentPhotoUrls.has(c.id)?`src="${esc(commentPhotoUrls.get(c.id))}"`:''}>`:'';
  const actions=canComment()&&!editing?`${mine?`<button type="button" class="commentaction" data-comment-edit="${c.id}" data-feedback-id="tasks.editor_tarea.comentarios.editar" data-feedback-label="Editar comentario">Editar</button>`:''}${mine||owner?`<button type="button" class="commentaction" data-comment-delete="${c.id}" data-feedback-id="tasks.editor_tarea.comentarios.borrar" data-feedback-label="Borrar comentario">Borrar</button>`:''}`:'';
  const body=editing?`<textarea data-field-id="tasks.editor_tarea.comentarios.editar_texto" data-field-entity="tasks.task_comments" data-field-prop="body" class="commentedit" id="commentEditText" maxlength="${COMMENT_MAX}" data-feedback-id="tasks.editor_tarea.comentarios.editar_texto" data-feedback-label="Texto del comentario">${esc(c.body)}</textarea><div class="commentbar"><button type="button" class="ghost" id="commentEditCancel" data-feedback-id="tasks.editor_tarea.comentarios.cancelar" data-feedback-label="Cancelar edición">Cancelar</button><button type="button" class="primary" id="commentEditSave" data-feedback-id="tasks.editor_tarea.comentarios.guardar" data-feedback-label="Guardar comentario">Guardar</button></div>`:`<p class="commentbody" data-feedback-ignore>${esc(c.body)}</p>`;
  return `<li class="comment${mine?' mine':''}" data-comment="${c.id}"><div class="commenthead"><strong class="commentauthor" data-feedback-ignore>${esc(commentAuthor(c))}</strong><time class="commentwhen" datetime="${esc(c.created_at||'')}" title="${esc(c.created_at?new Date(c.created_at).toLocaleString('es-ES'):'')}">${esc(commentWhen(c.created_at))}</time><span class="commentactions">${actions}</span></div>${body}${photo}</li>`}

function commentListHtml(taskId){const list=commentsOf(taskId);
  return list.length?`<ol class="commentlist">${list.map(commentItemHtml).join('')}</ol>`:'<p class="small muted commentempty">Sin comentarios todavía.</p>'}

function commentFormHtml(taskId){if(!canComment())return '';const draft=commentDraft?.taskId===taskId?commentDraft:null;
  return `<div class="commentform"><textarea data-field-id="tasks.editor_tarea.comentarios.texto" data-field-entity="tasks.task_comments" data-field-prop="body" id="commentText" aria-label="Comentario" maxlength="${COMMENT_MAX}" placeholder="Escribe un comentario…" data-feedback-id="tasks.editor_tarea.comentarios.texto" data-feedback-label="Escribe un comentario">${esc(draft?.body||'')}</textarea>
    <div class="commentbar"><label class="ghost commentphotobtn" data-feedback-id="tasks.editor_tarea.comentarios.foto" data-feedback-label="Añadir foto al comentario"><input data-field-id="tasks.editor_tarea.comentarios.foto" data-field-entity="tasks.task_comments" data-field-prop="file_id" type="file" id="commentPhoto" accept="image/jpeg,image/png,image/webp" hidden>📷 Foto</label><span class="commentpreview" id="commentPhotoPreview">${draft?.photo?`<img src="${esc(draft.photo.url)}" alt="Foto elegida"><button type="button" class="commentaction" id="commentPhotoRemove" aria-label="Quitar la foto" data-feedback-id="tasks.editor_tarea.comentarios.quitar_foto" data-feedback-label="Quitar la foto">×</button>`:''}</span><button type="button" class="primary" id="commentSend" data-feedback-id="tasks.editor_tarea.comentarios.enviar" data-feedback-label="Enviar comentario">Enviar</button></div></div>`}

function outsiderDoneHtml(taskId){if(!isOutsiderActor())return '';const loc=taskLocation(taskId);if(!loc)return '';const done=status(loc.p,loc.t)==='done';
  return `<label class="checkline outsiderdone"><input data-field-id="tasks.editor_tarea.hecha" data-field-entity="tasks.tasks" data-field-prop="done" type="checkbox" id="outsiderDone" ${done?'checked':''} data-feedback-id="tasks.editor_tarea.hecha" data-feedback-label="Marcar hecha"><span><strong>Hecha</strong> <span class="small muted">· marca la tarea cuando esté terminada</span></span></label>`}

function commentSectionHtml(taskId){const n=commentsOf(taskId).length;
  return `<section class="comments" id="taskComments" data-task="${taskId}" data-feedback-id="tasks.editor_tarea.comentarios" data-feedback-label="Comentarios">${outsiderDoneHtml(taskId)}<h3 class="commentstitle">Comentarios${n?` <span class="small muted">${n}</span>`:''}</h3><div id="commentThread">${commentListHtml(taskId)}</div>${commentFormHtml(taskId)}</section>`}

/** Descarga con sesión la foto de un comentario (comprobada en el servidor como su tarea) y la deja en memoria. */
async function loadCommentPhotos(){
  for(const img of document.querySelectorAll('img[data-comment-photo]:not([src])')){const id=img.dataset.commentPhoto;if(img.dataset.loading)continue;img.dataset.loading='1';
    try{const response=await fetch('/api/v1/comments/'+id+'/photo',{headers:{Authorization:'Bearer '+Sync.token}});if(!response.ok)throw Error();const url=URL.createObjectURL(await response.blob());commentPhotoUrls.set(id,url);document.querySelectorAll(`img[data-comment-photo="${id}"]`).forEach(el=>{el.src=url})}
    catch{img.alt='No se pudo cargar la foto';img.classList.add('missing')}}}

function bindCommentThread(taskId){const box=document.getElementById('taskComments');if(!box)return;
  box.querySelectorAll('[data-comment-edit]').forEach(b=>b.onclick=()=>{commentEditing=b.dataset.commentEdit;drawCommentThread(taskId);document.getElementById('commentEditText')?.focus()});
  // Borrar pide un segundo toque (el botón pasa a «¿Borrar?» unos segundos).
  box.querySelectorAll('[data-comment-delete]').forEach(b=>b.onclick=()=>{const id=b.dataset.commentDelete;if(!b.dataset.armed){b.dataset.armed='1';b.textContent='¿Borrar?';b.classList.add('armed');setTimeout(()=>{if(b.isConnected){delete b.dataset.armed;b.textContent='Borrar';b.classList.remove('armed')}},4000);return}commentRun('delete',{commentId:id},'Comentario borrado');drawCommentThread(taskId)});
  const cancel=document.getElementById('commentEditCancel');if(cancel)cancel.onclick=()=>{commentEditing=null;drawCommentThread(taskId)};
  const saveEdit=document.getElementById('commentEditSave');if(saveEdit)saveEdit.onclick=()=>{const body=document.getElementById('commentEditText').value.trim();if(!body)return toast('Escribe un comentario.');if(commentRun('edit',{commentId:commentEditing,body},'Comentario guardado')){commentEditing=null;drawCommentThread(taskId)}};
  loadCommentPhotos()}

function bindCommentForm(taskId){
  const text=document.getElementById('commentText'),send=document.getElementById('commentSend'),picker=document.getElementById('commentPhoto');
  if(text)text.oninput=()=>{commentDraft={...(commentDraft?.taskId===taskId?commentDraft:{taskId}),taskId,body:text.value}};
  if(picker)picker.onchange=async()=>{const file=picker.files?.[0];picker.value='';if(!file)return;send.disabled=true;
    try{const photo=await commentPhotoFrom(file);commentDraft={...(commentDraft?.taskId===taskId?commentDraft:{taskId}),taskId,body:text.value,photo};drawCommentPreview(taskId)}catch(e){toast(e.message||'No se pudo usar la foto.')}finally{send.disabled=false}};
  const remove=document.getElementById('commentPhotoRemove');if(remove)remove.onclick=()=>{if(commentDraft)commentDraft.photo=null;drawCommentPreview(taskId)};
  if(send)send.onclick=()=>{const body=text.value.trim();if(!body)return toast('Escribe un comentario.');if(body.length>COMMENT_MAX)return toast('Máximo 2000 caracteres.');
    const photo=commentDraft?.taskId===taskId?commentDraft.photo:null;
    const ops=commentRun('add',{taskId,body,photo:photo?{$blob:photo.sha256}:null},'Comentario enviado');if(!ops)return;
    if(photo)commentPhotoUrls.set(ops[0].id,photo.url);commentDraft=null;text.value='';drawCommentPreview(taskId);drawCommentThread(taskId)}}

function drawCommentPreview(taskId){const box=document.getElementById('commentPhotoPreview');if(!box)return;const photo=commentDraft?.taskId===taskId?commentDraft.photo:null;
  box.innerHTML=photo?`<img src="${esc(photo.url)}" alt="Foto elegida"><button type="button" class="commentaction" id="commentPhotoRemove" aria-label="Quitar la foto" data-feedback-id="tasks.editor_tarea.comentarios.quitar_foto" data-feedback-label="Quitar la foto">×</button>`:'';
  const remove=document.getElementById('commentPhotoRemove');if(remove)remove.onclick=()=>{if(commentDraft)commentDraft.photo=null;drawCommentPreview(taskId)}}

function drawCommentThread(taskId){const thread=document.getElementById('commentThread');if(!thread)return;thread.innerHTML=commentListHtml(taskId);
  const n=commentsOf(taskId).length,title=document.querySelector('#taskComments .commentstitle');if(title)title.innerHTML='Comentarios'+(n?` <span class="small muted">${n}</span>`:'');
  bindCommentThread(taskId)}

/** La misma recompresión que los adjuntos (cloud-auth.js): 1600 px en WebP; el blob espera en la cola de sync-client. */
async function commentPhotoFrom(file){
  if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw Error('Solo fotos: JPEG, PNG o WebP.');
  let image;try{image=await createImageBitmap(file)}catch{throw Error('No se pudo leer esta imagen.')}
  let blob;try{const scale=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.7));}finally{image.close()}
  if(!blob)throw Error('No se pudo comprimir la foto.');
  if(blob.size>COMMENT_PHOTO_LIMIT)throw Error('Máximo 25 MB por foto.');
  const name=file.name.replace(/\.[^.]+$/,'')+'.webp',mime=blob.type||'image/webp';
  const sha256=await Sync.core.stageBlob(blob,{filename:name,mime});
  return {sha256,url:URL.createObjectURL(blob),name}}

/** Lote de un comentario por la cola, como cualquier guardado (el outsider también puede). Devuelve las operaciones. */
function commentRun(action,input,message){
  if(!Sync.core||!canComment()){toast('Tu acceso es de solo lectura.');return null}
  let ops;try{ops=Sync.core.commentOps(action,input)}catch(e){toast(e.message||'No se pudo guardar el comentario.');return null}
  if(!ops.length)return ops;
  const work=Sync.core.commit([ops],()=>uid('req-'));Sync.chain=Sync.chain.then(()=>work).then(()=>{Sync.channel?.postMessage({type:'changed'})}).catch(storageError);
  Sync.mode='pending';refreshStatus();commentCountsChanged();if(message)toast(message);return ops}

/* Contador 💬 n en la tarjeta de la tarea. Los recuentos se calculan una vez por pintado. */
let commentCountCache=null;
function commentCount(taskId){if(!commentCountCache){try{commentCountCache=Sync.core?.commentCounts?.()||new Map()}catch{commentCountCache=new Map()}queueMicrotask(()=>{commentCountCache=null})}return commentCountCache.get(taskId)||0}
const taskRowBeforeComments=taskRow;
taskRow=function(t,p=project(),context=false){const html=taskRowBeforeComments(t,p,context),n=commentCount(t.id);if(!n)return html;
  const badge=`<span class="commentcount" title="${n} ${n===1?'comentario':'comentarios'}" aria-label="${n} ${n===1?'comentario':'comentarios'}">💬 ${n}</span>`;
  return html.includes('</button><button class="taskmenu"')?html.replace('</button><button class="taskmenu"',badge+'</button><button class="taskmenu"'):html};
let commentSignature='';
function commentCountsChanged(){let sig='';try{sig=JSON.stringify([...(Sync.core?.commentCounts?.()||new Map())].sort())}catch{}if(sig===commentSignature)return false;commentSignature=sig;return true}

/* Al cambiar los datos (de este dispositivo o de otro): se repinta el hilo abierto (sin tocar lo que se está escribiendo)
   y, si cambiaron los recuentos, la lista. */
const refreshModelBeforeComments=refreshModel;
refreshModel=function(){refreshModelBeforeComments();
  const box=document.getElementById('taskComments');if(box&&!commentEditing){drawCommentThread(box.dataset.task);const done=document.getElementById('outsiderDone'),loc=taskLocation(box.dataset.task);if(done&&loc)done.checked=status(loc.p,loc.t)==='done'}
  if(commentCountsChanged()&&Sync.actor&&state.tabs.length)render()};

/* La ficha: el hilo antes de los botones; para el outsider, además, la casilla de hecha (la suya y las de las hijas). */
const openTaskEditorBeforeComments=openTaskEditor;
openTaskEditor=function(id,...rest){openTaskEditorBeforeComments(id,...rest);if(!id||!taskLocation(id))return;
  commentEditing=null;if(commentDraft&&commentDraft.taskId!==id)commentDraft=null;
  document.getElementById('taskComments')?.remove();
  const sheet=document.getElementById('sheet');if(!sheet)return;const actions=sheet.querySelector('.actions');
  if(actions)actions.insertAdjacentHTML('beforebegin',commentSectionHtml(id));else sheet.insertAdjacentHTML('beforeend',commentSectionHtml(id));
  bindCommentThread(id);bindCommentForm(id);
  if(isOutsiderActor()){enableOutsiderChildToggles();const done=document.getElementById('outsiderDone');if(done)done.onchange=()=>{const loc=taskLocation(id);if(!loc){done.checked=!done.checked;return}const want=done.checked;if((status(loc.p,loc.t)==='done')!==want)toggleTask(id);const after=taskLocation(id);done.checked=after?status(after.p,after.t)==='done':false;if(typeof refreshChildSection==='function')refreshChildSection(id)}}};
/* El outsider no deshace desde el historial (contrato §3.10): al marcar hecha solo se avisa; para volver atrás, la casilla. */
if(typeof offerUndo==='function'){const offerUndoBeforeComments=offerUndo;offerUndo=function(label){if(isOutsiderActor()){toast(label);return}return offerUndoBeforeComments(label)}}
function enableOutsiderChildToggles(){if(isOutsiderActor())document.querySelectorAll('#sheet [data-child-toggle]').forEach(b=>{b.disabled=false})}
if(typeof refreshChildSection==='function'){const refreshChildSectionBeforeComments=refreshChildSection;refreshChildSection=function(id){refreshChildSectionBeforeComments(id);enableOutsiderChildToggles()}}
