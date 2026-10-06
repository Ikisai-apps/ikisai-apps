/* Updating the shell must never interrupt an editor or a durable outbox. */
if ('serviceWorker' in navigator && isSecureContext) {
  let registration, updateLocked=false, unlockTimer;
  function unlock(){updateLocked=false;Sync.updateLocked=false;clearTimeout(unlockTimer);}
  function safeToUpdate(){return !!Sync.record&&!Sync.busy&&!Sync.record.queue.length&&!Sync.record.conflict&&!Sync.record.failure&&!document.querySelector('.inlineedit')&&!document.getElementById('sheetBack')?.classList.contains('show');}
  const originalSyncMode=setMode;
  setMode=function(mode){originalSyncMode(mode);showUpdate();};
  function showUpdate(){
    if(!registration?.waiting){navigator.serviceWorker.getRegistration().then(found=>{registration=found;if(found?.waiting)showUpdate();}).catch(()=>{});return;}
    let button=document.getElementById('appUpdate');
    if(!button){button=document.createElement('button');button.id='appUpdate';button.className='syncbadge';button.textContent='Nueva versión disponible';button.onclick=applyUpdate;document.querySelector('.brandrow')?.append(button);}
  }
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
    if(!ready)unlock();else unlockTimer=setTimeout(unlock,8000);
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
  setInterval(()=>{if(!document.hidden&&navigator.onLine)registration?.update().catch(()=>{});},5*60*1000);
}
