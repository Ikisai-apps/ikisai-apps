/* Photos stay private and enter the same durable attachment outbox as documents. */
async function pickedAttachment(file){
 let blob=file,name=file.name;
 if(/^image\/(jpeg|png|webp)$/.test(file.type)){
  if(file.size>24*1024*1024)throw Error('Foto demasiado grande: máximo 24 MB antes de comprimir.');
  let image;try{image=await createImageBitmap(file);}catch{throw Error('No se pudo leer esta imagen.');}
  try{const scale=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const type=file.type==='image/jpeg'?'image/jpeg':'image/webp';
   for(const quality of [.85,.7,.5]){blob=await new Promise(resolve=>canvas.toBlob(resolve,type,quality));if(blob&&blob.size<=1024*1024)break;}
   if(!blob)throw Error('No se pudo comprimir la foto.');name=file.name.replace(/\.[^.]+$/,'')+(blob.type==='image/jpeg'?'.jpg':'.webp');
  }finally{image.close();}
 }
 if(blob.size>1024*1024)throw Error('Máximo 1 MB por documento o foto comprimida.');
 const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('No se pudo leer el archivo.'));reader.readAsDataURL(blob);});
 return {id:uid('a'),name,data};
}
let thumbnailPending=false;
async function photoThumbnails(){
 thumbnailPending=false;
 for(const link of document.querySelectorAll('#sheet a[download]')){
  if(link.dataset.thumbnail)continue;link.dataset.thumbnail='pending';const href=link.getAttribute('href');let blob;
  try{if(/^data:image\/(jpeg|png|webp);base64,/.test(href))blob=await (await fetch(href)).blob();
   else if(href?.startsWith('/api/v1/attachments/')){const id=href.split('/').at(-1),attachment=state.tabs.flatMap(t=>t.projects.flatMap(p=>[...(p.attachments||[]),...p.tasks.flatMap(t=>t.attachments||[])])).find(a=>a.id===id);if(!/^image\/(jpeg|png|webp)$/.test(attachment?.mime))continue;let cached=await cachedAttachment(id);if(cached?.actorId===Sync.actor?.id)blob=cached.blob;else if(navigator.onLine){const response=await fetch(href,{headers:{Authorization:'Bearer '+Sync.token}});if(!response.ok)continue;blob=await response.blob();await cachedAttachment(id,{blob,actorId:Sync.actor.id});}}
   if(!blob||!link.isConnected)continue;const image=await createImageBitmap(blob);try{const scale=Math.min(1,128/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const preview=document.createElement('img');preview.src=canvas.toDataURL('image/webp',.75);preview.alt='Vista previa';preview.width=canvas.width;preview.height=canvas.height;preview.style.cssText='display:block;max-width:128px;border-radius:8px;margin-bottom:6px';if(link.isConnected)link.prepend(preview);}finally{image.close();}
  }catch{/* Download remains available when a thumbnail cannot be decoded. */}
 }
}
new MutationObserver(()=>{if(!thumbnailPending){thumbnailPending=true;queueMicrotask(photoThumbnails);}}).observe(document.getElementById('sheet'),{childList:true,subtree:true});
