/* Guiado mínimo del kit (0.68; encargo de Core del 27-10-2026). Tasks no usa createAppShell, así que monta aquí lo mismo que
   hace `createAppShell({ guide: { feedbackId: 'tasks.guia' } })`:
   - con `?campo=…&paso=…` (de `withGuideLink`), una línea arriba explica el paso y el campo se señala; «Ver el campo» lo
     vuelve a señalar. El texto del paso viene de la URL y se pinta como texto;
   - con quien guía en la URL, «‹ Volver a…» lleva de vuelta (la vuelta atrás ya la instala feedback-ui.js con returnTo).
   Sin cliente: no lee nada de Flow. Los campos que viven en una hoja cerrada se abren con registerReveal. */
(function(){const K=window.IkisaiKit;if(!K||typeof K.readGuideLink!=='function')return;
  const link=K.readGuideLink(),origin=typeof K.readReturnTo==='function'?K.readReturnTo():null;
  if(!link?.field&&!link?.step&&!origin)return;
  const box=document.createElement('div');box.className='tkguia ikisai-kit';
  if(origin){const a=document.createElement('a');a.className='return-link tkguia-back';a.href=origin.url;a.dataset.feedbackId='tasks.guia.volver';a.dataset.feedbackLabel='Volver a la otra app';
    a.textContent='‹ Volver a '+(origin.title||origin.from||'la app anterior');box.append(a)}
  let pointer=null;
  if(link?.field||link?.step){pointer=K.createFieldPointer(link,{feedbackId:'tasks.guia',timeoutMs:15000});box.append(pointer.element)}
  const mount=()=>{if(!document.body.contains(box))document.body.append(box)};
  // El campo aparece cuando la app ya ha pintado sus datos: se espera a la primera pintura con áreas.
  const ready=()=>typeof state!=='undefined'&&Array.isArray(state.tabs)&&state.tabs.length>0&&document.querySelector('#app main');
  let tries=0;const start=()=>{mount();if(!pointer)return;if(ready()||tries++>40)void pointer.point();else setTimeout(start,250)};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  // Los campos que viven en una hoja: se abre la hoja y el kit espera a que aparezca el campo.
  K.registerReveal('tasks.filtros',()=>{document.getElementById('filterBtn')?.click()});
  K.registerReveal('tasks.regla_entrada',()=>{if(typeof routesSheet==='function')routesSheet()});
  K.registerReveal('tasks.entradas',()=>{if(typeof routesSheet==='function')routesSheet()});
})();
