/* Updating the shell must never interrupt an editor or a durable outbox. */
if ('serviceWorker' in navigator && isSecureContext) {
  let registration, updateLocked=false, unlockTimer;
  /* Al abrir la app (decisión del usuario, 8-10-2026): si hay versión nueva y es seguro, se aplica sola en los primeros
     segundos, para que ninguna PWA se quede atrás sin que nadie pulse el botón. Si no es seguro (cola, conflicto, fallo de
     sincronización o algo a medias), se queda el aviso «Nueva versión disponible» de siempre. Las pruebas cambian la
     ventana con window.TASKS_UPDATE_AUTO_MS (0 la apaga). */
  const bootAt=Date.now(),autoWindow=typeof window.TASKS_UPDATE_AUTO_MS==='number'?window.TASKS_UPDATE_AUTO_MS:20000;let autoTried=false;
  function maybeAutoUpdate(){if(autoTried||Date.now()-bootAt>autoWindow||!registration?.waiting||!Sync.ready||Sync.secondary||!safeToUpdate())return;autoTried=true;applyUpdate()}
  function unlock(){updateLocked=false;Sync.updateLocked=false;clearTimeout(unlockTimer);}
  /* Algo a medias en esta pestaña: un campo en línea, una hoja abierta, la paleta, una selección múltiple o un campo de texto
     con el foco (la búsqueda no cuenta: no es un borrador). */
  function draftInProgress(){const active=document.activeElement,typing=!!active&&active.id!=='searchInput'&&(active.tagName==='TEXTAREA'||active.isContentEditable||active.tagName==='INPUT'&&!['checkbox','radio','button','submit','file','range','color'].includes(active.type));return typing||!!document.querySelector('.inlineedit,#paletteInput,.task.selected')||!!document.getElementById('sheetBack')?.classList.contains('show');}
  function safeToUpdate(){return !!Sync.record&&!Sync.busy&&!Sync.record.queue.length&&!Sync.record.conflict&&!Sync.record.failure&&!draftInProgress();}
  const originalSyncMode=setMode;
  setMode=function(mode){originalSyncMode(mode);showUpdate();};
  function showUpdate(){
    if(!registration?.waiting){navigator.serviceWorker.getRegistration().then(found=>{registration=found;if(found?.waiting)showUpdate();}).catch(()=>{});return;}
    let button=document.getElementById('appUpdate');
    if(!button){button=document.createElement('button');button.id='appUpdate';button.dataset.feedbackId='tasks.actualizacion.aplicar';button.dataset.feedbackLabel='Nueva versión disponible';button.className='syncbadge';button.textContent='Nueva versión disponible';button.onclick=applyUpdate;document.querySelector('.brandrow')?.append(button);}
  ;maybeAutoUpdate()}
  async function applyUpdate(){
    if(Sync.secondary)return toast('Actualiza desde la pestaña activa.');
    await Sync.chain;
    if(!safeToUpdate())return toast('Guarda y cierra el editor; sincroniza o resuelve tus cambios pendientes antes de actualizar.');
    registration?.waiting?.postMessage({type:'APPLY_UPDATE'});
  }
  navigator.serviceWorker.addEventListener('message',async event=>{
    if(event.data?.type==='UPDATE_ABORT'){unlock();toast('Hay otra pestaña con cambios o un editor abierto. Ciérrala o termina de guardar antes de actualizar.');return;}
    if(event.data?.type!=='CHECK_UPDATE_READY')return;
    updateLocked=true;Sync.updateLocked=true;
    await Sync.chain;
    const ready=safeToUpdate();
    // Un solo temporizador de desbloqueo a la vez: si llega otra comprobación, el anterior no debe soltar el bloqueo antes de tiempo.
    clearTimeout(unlockTimer);if(!ready)unlock();else unlockTimer=setTimeout(unlock,8000);
    event.source?.postMessage({type:'UPDATE_READY',requestId:event.data.requestId,ready});
  });
  // Prevent new user edits during the short, coordinated activation handshake.
  for(const name of ['pointerdown','click','keydown','submit'])document.addEventListener(name,event=>{if(updateLocked){event.preventDefault();event.stopImmediatePropagation();}},true);
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(updateLocked)location.reload();});
  navigator.serviceWorker.ready.then(async current=>{
    registration=current;showUpdate();
    current.addEventListener('updatefound',()=>{const worker=current.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed')showUpdate();});});
    if(navigator.onLine)await current.update();
  }).catch(()=>{});
  addEventListener('online',()=>registration?.update().catch(()=>{}));
  // Una PWA puede pasar días abierta en segundo plano: al volver a primer plano también se busca versión nueva (y, si la hay,
  // sale el aviso; la aplicación automática es solo al abrir).
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')registration?.update().catch(()=>{})});
  setInterval(()=>{if(!document.hidden&&navigator.onLine)registration?.update().catch(()=>{});},5*60*1000);
}
