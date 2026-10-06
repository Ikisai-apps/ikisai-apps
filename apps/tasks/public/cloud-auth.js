/* Ikisai Tasks · cuenta, sesión y adjuntos sobre el núcleo común. Se carga después de los módulos que definen
   las hojas originales (accounts-ui, navigation-ui, photos) y las sustituye; al final arranca la app. */
const PENDING_FEATURES=new Set(['accesses','proposals','accessLog']);
const originalNavigationGroups=navigationGroups;
navigationGroups=function(){
  // Claves de acceso, propuestas de agentes y registro de accesos son de la fase de agentes: no se ofrecen todavía.
  return originalNavigationGroups().map(group=>({...group,
    items:group.items.filter(item=>!PENDING_FEATURES.has(item[0])).map(item=>item[0]==='sessions'?['sessions','Mi cuenta','key','action',!!Sync.actor]:item)
  }));
};
logoutAccount=async function(){
  if(Sync.secondary)return toast('Cierra sesión desde la pestaña activa.');
  if(Sync.record.queue.length||Sync.busy)return toast('Sincroniza o exporta los cambios pendientes antes de salir.');
  try{
    // Mientras se cierra la sesión la app deja de estar «lista»: así el aviso de sesión perdida no abre la hoja de
    // entrada antes de que termine la limpieza local. Tampoco se repinta: el espejo se vacía y ya no hay área activa.
    Sync.ready=false;Sync.leaving=true;
    await Sync.core.logout();
    const db=await localDB();await new Promise((resolve,reject)=>{const tx=db.transaction('attachments','readwrite');tx.objectStore('attachments').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    try{localStorage.removeItem(UI_KEY)}catch{}
    Sync.ready=false;Sync.actor=null;Sync.last=null;Sync.lastComposed='';Sync.members=null;Sync.record={schemaVersion:1,tabs:[],queue:[],conflict:null,failure:null,cursor:0,ui:{},actorId:null,actor:null};state.tabs=[];
    loginSheet('Sesión cerrada.');setMode('unauthorized');
  }catch(e){toast(e.message)}finally{Sync.leaving=false}
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

/* Cuentas de personas (API.md §16, decisión D6): una persona invitada es una cuenta con rol y ámbitos sobre
   `members` y `members/invite` del núcleo. La contraseña temporal se muestra una sola vez. Quitar el acceso deja la
   pertenencia sin ámbitos (el núcleo aún no tiene baja ni cierre de sesiones ajenas, petición C7). */
const NO_ACCESS={tabs:[],projects:{}};
function memberHasAccess(m){const s=m.scopes;return s==null||s==='*'||(Array.isArray(s)?s.length>0:(s.tabs||[]).length>0||Object.values(s.projects||{}).some(list=>list.length))}
usersSheet=async function(){
  try{const items=await Sync.core.api('/members');Sync.members=items;
    openSheet(`<h2 class="sheettitle">Cuentas de personas</h2><button class="primary" id="newUser">Invitar a una persona</button>${items.map(u=>`<section style="padding:12px 0"><strong>${esc(u.displayName||'Sin nombre')}</strong>${u.userId===Sync.actor?.id?' · tú':''}<p class="small">${esc({reader:'Solo lectura',editor:'Editar',owner:'Propietario'}[u.role]||u.role)} · ${memberHasAccess(u)?esc(accessScopeText(u.scopes==null?'*':u.scopes)):'Sin acceso'}</p><button class="softbtn" data-edit-user="${u.userId}">Permisos</button></section>`).join('')}`);
    document.getElementById('newUser').onclick=()=>userEditor();
    document.querySelectorAll('[data-edit-user]').forEach(b=>b.onclick=()=>userEditor(items.find(u=>u.userId===b.dataset.editUser)));
  }catch(e){toast(e.message)}
};
userEditor=function(user=null){
  const scopesNow=user?(user.scopes==null?'*':user.scopes):null,self=user&&user.userId===Sync.actor?.id;
  openSheet(`<h2 class="sheettitle">${user?'Permisos de '+esc(user.displayName||'la cuenta'):'Invitar a una persona'}</h2>${user?'':'<div class="field"><label for="userUsername">Correo electrónico</label><input id="userUsername" type="email" autocomplete="off" required></div>'}<div class="field"><label for="userName">Nombre</label><input id="userName" value="${esc(user?.displayName||'')}" maxlength="100"></div><div class="field"><label for="userRole">Permiso</label><select id="userRole"><option value="reader">Solo lectura</option><option value="editor">Editar</option><option value="owner">Propietario</option></select></div><label><input type="checkbox" id="userAll"> Todas las áreas, también las futuras</label>${state.tabs.filter(t=>!t.deleted).map(t=>`<section class="filterfamily"><label><input type="checkbox" data-user-tab="${t.id}"> Todo ${esc(t.name)}</label>${t.projects.filter(p=>!p.deleted&&!p.system).map(p=>`<label style="display:block;padding:6px 12px"><input type="checkbox" data-user-project="${t.id}|${p.id}"> ${esc(p.title)}</label>`).join('')}</section>`).join('')}${user&&!self?'<button class="danger" id="revokeUser">Quitar el acceso</button>':''}<button class="primary" id="saveUser">${user?'Guardar permisos':'Crear cuenta'}</button>`);
  document.getElementById('userRole').value=user?.role||'editor';document.getElementById('userAll').checked=scopesNow==='*';
  if(user&&scopesNow!=='*'){document.querySelectorAll('[data-user-tab]').forEach(b=>b.checked=Array.isArray(scopesNow)?scopesNow.includes(b.dataset.userTab):!!scopesNow.tabs?.includes(b.dataset.userTab));document.querySelectorAll('[data-user-project]').forEach(b=>{const [t,p]=b.dataset.userProject.split('|');b.checked=!!scopesNow.projects?.[t]?.includes(p)})}
  const chosenScopes=()=>{if(document.getElementById('userAll').checked)return '*';const tabs=[...document.querySelectorAll('[data-user-tab]:checked')].map(b=>b.dataset.userTab),projects={};document.querySelectorAll('[data-user-project]:checked').forEach(b=>{const [t,p]=b.dataset.userProject.split('|');if(!tabs.includes(t))(projects[t]||=[]).push(p)});return {tabs,projects}};
  document.getElementById('saveUser').onclick=async()=>{
    const scopes=chosenScopes(),role=document.getElementById('userRole').value,displayName=document.getElementById('userName').value.trim(),button=document.getElementById('saveUser');
    if(scopes!=='*'&&!memberHasAccess({scopes}))return toast('Elige al menos un área o un proyecto.');
    button.disabled=true;
    try{
      if(user){await Sync.core.api('/members',{method:'POST',json:{userId:user.userId,role,scopes,displayName}});await usersSheet();toast('Permisos guardados.');return}
      const email=document.getElementById('userUsername').value.trim().toLowerCase();
      const result=await Sync.core.api('/members/invite',{method:'POST',json:{email,role,scopes,displayName}});
      if(!result.temporaryPassword){await usersSheet();toast('Esa cuenta ya existía: se le ha dado acceso.');return}
      openSheet(`<h2 class="sheettitle">Cuenta creada</h2><p>Entrega a ${esc(displayName||email)} su correo y esta contraseña temporal. Solo se muestra ahora; podrá cambiarla en «Mi cuenta».</p><div class="field"><label for="issuedPassword">Contraseña temporal</label><input id="issuedPassword" readonly value="${esc(result.temporaryPassword)}"></div><button class="primary" id="userDone">Hecho</button>`);
      document.getElementById('userDone').onclick=usersSheet;
    }catch(e){button.disabled=false;toast(e.message)}
  };
  const revoke=document.getElementById('revokeUser');
  if(revoke)revoke.onclick=async()=>{revoke.disabled=true;try{await Sync.core.api('/members',{method:'POST',json:{userId:user.userId,role:'reader',scopes:NO_ACCESS,displayName:user.displayName}});await usersSheet();toast('Acceso retirado.')}catch(e){revoke.disabled=false;toast(e.message)}};
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
