/* Ikisai Tasks · cuenta, sesión y adjuntos sobre el núcleo común. Se carga después de los módulos que definen
   las hojas originales (accounts-ui, navigation-ui, photos) y las sustituye; al final arranca la app. */
const PENDING_FEATURES=new Set(['csvImport','csvExport','portableImport','portableExport','backup','users','accesses','proposals','accessLog']);
const originalNavigationGroups=navigationGroups;
navigationGroups=function(){
  // Lo que todavía no tiene ruta en tasks-api (CSV, copia portable, respaldo, cuentas) o es de la fase de agentes no se ofrece.
  return originalNavigationGroups().map(group=>({...group,
    items:group.items.filter(item=>!PENDING_FEATURES.has(item[0])).map(item=>item[0]==='sessions'?['sessions','Mi cuenta','key','action',!!Sync.actor]:item)
  }));
};
logoutAccount=async function(){
  if(Sync.secondary)return toast('Cierra sesión desde la pestaña activa.');
  if(Sync.record.queue.length||Sync.busy)return toast('Sincroniza o exporta los cambios pendientes antes de salir.');
  try{
    await Sync.core.logout();
    await new Promise((resolve,reject)=>{const tx=Sync.db.transaction('attachments','readwrite');tx.objectStore('attachments').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    try{localStorage.removeItem(UI_KEY)}catch{}
    Sync.actor=null;Sync.last=null;Sync.lastComposed='';Sync.members=null;Sync.record={schemaVersion:1,tabs:[],queue:[],conflict:null,failure:null,cursor:0,ui:{},actorId:null,actor:null};state.tabs=[];
    closeSheet();document.getElementById('app').innerHTML='<div class="boot"><h1>Ikisai · Tareas</h1><p>Sesión cerrada.</p></div>';
    loginSheet();setMode('unauthorized');
  }catch(e){toast(e.message)}
};
sessionsSheet=async function(){
  let email='';try{email=(await Sync.core.api('/me')).email||''}catch{}
  openSheet(`<h2 class="sheettitle">Mi cuenta</h2><p>Cuenta conectada: ${esc(Sync.actor?.name||email)}</p>${email?`<p class="small muted">${esc(email)}</p>`:''}<button class="softbtn" id="changePassword">Cambiar contraseña</button><button class="danger" id="logoutAccount">Cerrar sesión</button>`);
  document.getElementById('changePassword').onclick=passwordSheet;document.getElementById('logoutAccount').onclick=logoutAccount;
};
passwordSheet=function(){
  openSheet('<h2 class="sheettitle">Cambiar contraseña</h2><div class="field"><label for="oldPassword">Contraseña actual</label><input id="oldPassword" type="password" autocomplete="current-password"></div><div class="field"><label for="newPassword">Nueva contraseña (mínimo 12 caracteres)</label><input id="newPassword" type="password" autocomplete="new-password" minlength="12"></div><p>Se cerrarán tus otras sesiones. Los cambios locales se conservan.</p><button class="primary" id="savePassword">Cambiar contraseña</button>');
  document.getElementById('savePassword').onclick=async()=>{
    if(Sync.record.queue.length||Sync.busy)return toast('Sincroniza los cambios pendientes antes de cambiar la contraseña.');
    const next=document.getElementById('newPassword').value;if(next.length<12)return toast('Usa una contraseña de al menos 12 caracteres.');
    const button=document.getElementById('savePassword');button.disabled=true;
    try{await api('auth/password',{method:'POST',body:JSON.stringify({currentPassword:document.getElementById('oldPassword').value,password:next})});closeSheet();toast('Contraseña cambiada.')}catch(error){button.disabled=false;toast(error.message)}
  };
};

/* Adjuntos (API.md §8): las fotos se recomprimen a 1600 px en WebP sin conservar el original; el blob espera en la cola
   de sync-client y la fila viaja con su huella. Se guarda también en este dispositivo para abrirlo sin red. */
const ATTACHMENT_LIMIT=25*1024*1024;
pickedAttachment=async function(file){
  let blob=file,name=file.name;
  if(/^image\/(jpeg|png|webp)$/.test(file.type)){
    let image;try{image=await createImageBitmap(file)}catch{throw Error('No se pudo leer esta imagen.')}
    try{const scale=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
      blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.7));if(!blob)throw Error('No se pudo comprimir la foto.');name=file.name.replace(/\.[^.]+$/,'')+'.webp';
    }finally{image.close()}
  }
  if(blob.size>ATTACHMENT_LIMIT)throw Error('Máximo 25 MB por archivo.');
  const mime=blob.type||file.type||'application/octet-stream';
  const sha256=await Sync.core.stageBlob(blob,{filename:name,mime});
  const id=uid('a');
  await cachedAttachment(id,{blob,actorId:Sync.actor.id,local:true});
  return {id,name,mime,size:blob.size,sha256,url:'/api/v1/attachments/'+id};
};
boot();
