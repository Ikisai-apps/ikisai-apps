const CACHE='ikisai-shell-v37';const SHELL=['/cloud-config.js','/sync-core.js','/kit.js','/kit.css','/cloud-auth.js','/updates.js','/photos.js','/','/sync.js','/features.js','/access-ui.js','/history-ui.js','/accounts-ui.js','/csv-ui.js','/navigation-ui.js','/navigation-ui.css','/dependencies-ui.js','/dependencies-ui.css','/views-ui.css','/theme.css','/scope-ui.js','/filters-ui.js','/editor-ui.js','/cards-ui.js','/batch-ui.js','/templates-ui.js','/extras-ui.js','/home-ui.js','/theme-ui.js','/taller.css','/taller-ui.js','/palette-ui.js','/board-ui.js','/project-card-ui.js','/shell-ui.js','/agents-ui.js','/purchases-ui.js','/inbox-ui.js','/feedback-ui.js','/purchases-ui.css','/fonts/fraunces.woff2','/fonts/inter.woff2','/manifest.webmanifest','/icon.svg','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/apple-touch-icon.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'}))))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
let activation=null;
self.addEventListener('message',event=>{
  const data=event.data;
  if(data?.type==='UPDATE_READY'&&activation?.id===data.requestId&&activation.clients.has(event.source?.id)){activation.answers.set(event.source.id,data.ready===true);activation.check();}
  if(data?.type==='APPLY_UPDATE'&&!activation){activation={pending:true};event.waitUntil(activateSafely());}
});
async function activateSafely(){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const id=crypto.randomUUID();
  const approved=await new Promise(resolve=>{
    const timer=setTimeout(()=>resolve(false),4000);
    activation={id,clients:new Set(windows.map(c=>c.id)),answers:new Map(),check(){
      if([...this.answers.values()].some(x=>!x)){clearTimeout(timer);resolve(false);}
      else if(this.answers.size===this.clients.size){clearTimeout(timer);resolve(true);}
    }};
    for(const client of windows)client.postMessage({type:'CHECK_UPDATE_READY',requestId:id});
    activation.check();
  });
  const current=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  if(approved&&current.length===windows.length&&current.every(c=>activation.clients.has(c.id)))await self.skipWaiting();
  else for(const client of current)client.postMessage({type:'UPDATE_ABORT'});
  activation=null;
}
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(url.origin!==location.origin||event.request.method!=='GET'||url.pathname.startsWith('/api/')||url.pathname==='/mcp'||url.pathname==='/health')return;if(SHELL.includes(url.pathname))event.respondWith(caches.open(CACHE).then(cache=>cache.match(event.request,{ignoreSearch:true}).then(cached=>cached||fetch(event.request))));else event.respondWith(fetch(event.request).catch(()=>caches.match(event.request).then(cached=>cached||Response.error())));});
