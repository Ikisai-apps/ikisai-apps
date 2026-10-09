/* Ikisai Tasks · catálogo General de etiquetas (FB_2026_023; aprobado por el usuario el 9-10-2026; arreglos tras el primer
   uso real, 9-10-2026). Lo General (tab_id nulo) vale en todas las áreas. Para la propietaria con acceso completo:
   - «Repetidas → General», siempre a la vista: los grupos de la misma etiqueta (mismo nombre de familia y mismo nombre,
     aunque las claves de sistema no coincidan) en dos o más áreas, con casillas. Si las madres no coinciden (VG en la raíz
     y bajo «Staff»), la General queda en la raíz, y se dice. Aparte, los parecidos que no son iguales.
   - «Claves por corregir»: familias con una clave de sistema que no casa con su nombre («Zona: Espacio» marcada como
     responsables, «Persona» marcada como fases). Se corrigen antes de fusionar (quitando la clave y, si eran responsables,
     esos responsables).
   - «Hacer General» en una etiqueta o en una familia del área: la lleva a General con sus iguales de otras áreas. */
const generalNorm=s=>String(s||'').trim().toLowerCase();
const generalLoose=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/gi,'').toLowerCase();
const GENERAL_KEY_NAMES={person:['persona','personas','responsable','responsables','equipo','staff','gente'],phase:['fase','fases','etapa','etapas'],trade:['oficio','oficios','gremio','gremios'],building:['edificio','edificios'],space:['espacio','espacios','zona','zonas','lugar','lugares']};
function generalNameFits(key,name){const words=String(name||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().split(/[^a-z0-9]+/);return (GENERAL_KEY_NAMES[key]||[]).some(w=>words.includes(w))}
function generalCatalog(){
  const data=Sync.core?.data||{},fams=new Map((data['tasks.families']||[]).map(f=>[f.id,f])),tabs=new Map((data['tasks.tabs']||[]).filter(t=>!t.deleted_at).map(t=>[t.id,t]));
  const all=(data['tasks.labels']||[]).filter(l=>!l.deleted_at),byId=new Map(all.map(l=>[l.id,l]));
  const famName=l=>generalNorm(fams.get(l.family_id)?.name);
  return {data,fams,tabs,all,byId,famName,keyOf:l=>famName(l)+'|'+generalNorm(l.name),live:all.filter(l=>!l.archived&&l.tab_id&&tabs.has(l.tab_id))};
}
/* Un grupo: la misma etiqueta en varias áreas (una por área), con la madre como decisión. */
function generalGroupOf(c,labels){
  const count=new Map();for(const l of labels)count.set(l.name.trim(),(count.get(l.name.trim())||0)+1);
  // El nombre que más se repite (y, a igualdad, el del área actual) va primero: es el que toma la General.
  const name=[...count.entries()].sort((a,b)=>b[1]-a[1]||(labels.find(l=>l.name.trim()===b[0])?.tab_id===tab()?.id)-(labels.find(l=>l.name.trim()===a[0])?.tab_id===tab()?.id))[0][0];
  const sorted=[...labels].sort((a,b)=>(b.name.trim()===name)-(a.name.trim()===name));
  const parents=sorted.map(l=>l.parent_id?c.byId.get(l.parent_id):null);
  const mother=parents.every(p=>!p)?null:parents.every(p=>p&&p.tab_id)&&new Set(parents.map(c.keyOf)).size===1?c.keyOf(parents[0]):parents.every(p=>p&&!p.tab_id)&&new Set(parents.map(p=>p.id)).size===1?'general':'mixed';
  const keys=new Set(sorted.map(l=>c.fams.get(l.family_id)?.system_key||null));
  return {key:c.keyOf(sorted[0]),name,family:c.fams.get(sorted[0].family_id),labels:sorted,areas:sorted.map(l=>c.tabs.get(l.tab_id)?.name||''),mother,keyConflict:keys.size>1,
    parentNames:[...new Set(parents.filter(Boolean).map(p=>p.name))]};
}
function generalMergeGroups(){
  const c=generalCatalog(),groups=new Map();
  for(const l of c.live){const k=c.keyOf(l);const list=groups.get(k)||[];if(!list.some(x=>x.tab_id===l.tab_id))list.push(l);groups.set(k,list)}
  const out=[...groups.values()].filter(ls=>ls.length>=2).map(ls=>generalGroupOf(c,ls));
  // Una hija cuya madre también se fusiona (igual en todas) conserva la madre; si las madres no coinciden, queda en la raíz.
  for(const g of out){g.root=g.mother==='mixed'||(g.mother&&g.mother!=='general'&&!out.some(m=>m.key===g.mother&&m.labels.length===g.labels.length));g.mergeable=true}
  return out.sort((a,b)=>(a.mother&&!a.root?1:0)-(b.mother&&!b.root?1:0)||a.name.localeCompare(b.name,'es'));
}
function generalLookalikes(){
  const c=generalCatalog(),loose=new Map();
  for(const l of c.all.filter(l=>!l.archived&&(!l.tab_id||c.tabs.has(l.tab_id)))){const k=c.famName(l)+'|'+generalLoose(l.name);const set=loose.get(k)||new Set();set.add(l.name.trim());loose.set(k,set)}
  return [...loose.values()].filter(s=>new Set([...s].map(generalNorm)).size>1).map(s=>[...s])}
/* Familias con una clave de sistema que no casa con su nombre y sí con otra (o que otra área llama igual sin esa clave). */
function generalKeyConflicts(){
  const c=generalCatalog(),live=[...c.fams.values()].filter(f=>!f.deleted_at&&(!f.tab_id||c.tabs.has(f.tab_id)));
  return live.filter(f=>f.system_key&&!generalNameFits(f.system_key,f.name)&&(Object.keys(GENERAL_KEY_NAMES).some(k=>k!==f.system_key&&generalNameFits(k,f.name))
      ||live.some(o=>o.id!==f.id&&generalNorm(o.name)===generalNorm(f.name)&&o.system_key!==f.system_key)))
    .map(f=>({family:f,area:f.tab_id?c.tabs.get(f.tab_id)?.name||'':'General',owners:f.system_key==='person'?generalOwnersOf(c,f.id):[]}));
}
function generalOwnersOf(c,familyId){const ids=new Set(c.all.filter(l=>l.family_id===familyId).map(l=>l.id));
  return [...(c.data['tasks.tasks']||[]).filter(t=>!t.deleted_at&&ids.has(t.owner_label_id)).map(t=>['tasks.tasks',t]),...(c.data['tasks.projects']||[]).filter(p=>!p.deleted_at&&ids.has(p.owner_label_id)).map(p=>['tasks.projects',p]),
    ...(c.data['tasks.request_routes']||[]).filter(r=>!r.deleted_at&&ids.has(r.owner_label_id)).map(r=>['tasks.request_routes',r])]}
function generalFixOps(conflicts){return conflicts.flatMap(x=>[{op:'update',table:'tasks.families',id:x.family.id,expectedRevision:x.family.revision,fields:{system_key:null}},
  ...x.owners.map(([table,row])=>({op:'update',table,id:row.id,expectedRevision:row.revision,fields:{owner_label_id:null}}))])}
async function generalWaitSync(){for(let i=0;i<40&&(Sync.record.queue.length||Sync.busy);i++){await syncNow();await new Promise(r=>setTimeout(r,150))}if(Sync.record.queue.length)throw new Error('No se pudo guardar la corrección: revisa la conexión.')}
async function generalMerge(groups){return usage.run('tasks.etiquetas.general.fusionar',()=>Sync.core.api('/labels/general/merge',{method:'POST',json:{groups:groups.map(g=>g.root?{ids:g.labels.map(l=>l.id),root:true}:g.labels.map(l=>l.id)),requestId:uid('req-')}}))}
function generalReady(){if(!isAdministrator()){toast('Solo una propietaria con acceso completo gestiona el catálogo General.');return false}
  if(Sync.record.queue.length||Sync.busy){toast('Sincroniza los cambios pendientes antes de seguir.');return false}
  if(!navigator.onLine){toast('Hace falta conexión para esto.');return false}return true}

function generalMergeSheet(){
  if(!generalReady())return;
  const groups=generalMergeGroups(),lookalikes=generalLookalikes(),conflicts=generalKeyConflicts(),chosen=new Set(groups.map(g=>g.key)),fixes=new Set(conflicts.map(x=>x.family.id));
  const keyName={person:'responsables (Persona)',phase:'Fase',trade:'Oficio',building:'Edificio',space:'Espacio'};
  const paint=()=>{
    const n=chosen.size,m=fixes.size;
    openSheet(`<h2 class="sheettitle">Repetidas → General</h2><p class="small muted">Cada etiqueta marcada pasa a ser una sola, General, válida en todas las áreas. Las tareas, los responsables, las reglas y las vistas pasan a usarla; las copias de cada área quedan archivadas.</p>
      ${conflicts.length?`<h3 class="sectionlabel">Claves por corregir</h3><p class="small muted">Estas familias tienen una marca de sistema que no casa con su nombre. Se corrigen antes de fusionar.</p><div class="generalgroups">${conflicts.map(x=>`<label class="checkline generalconflict"><input type="checkbox" data-general-fix="${x.family.id}" ${fixes.has(x.family.id)?'checked':''} data-feedback-id="tasks.etiquetas.general.corregir_clave" data-feedback-label="Corregir la clave de la familia"><span><strong>${esc(x.family.name)}</strong> <span class="small muted">· ${esc(x.area)} · marcada como ${esc(keyName[x.family.system_key]||x.family.system_key)}: se quita la marca${x.owners.length?`, y ${x.owners.length} ${x.owners.length===1?'responsable que era':'responsables que eran'} de esta familia se quedan sin responsable`:''}</span></span></label>`).join('')}</div>`:''}
      <h3 class="sectionlabel">Repetidas entre áreas</h3>
      ${groups.length?`<div class="generalgroups">${groups.map(g=>`<label class="checkline generalgroup ${g.mother&&!g.root?'child':''}"><input type="checkbox" data-general-group="${esc(g.key)}" ${chosen.has(g.key)?'checked':''} data-feedback-id="tasks.etiquetas.general.grupo" data-feedback-label="Fusionar este grupo"><span><strong>${g.mother&&!g.root?'↳ ':''}${esc(g.name)}</strong> <span class="small muted">· ${esc(g.family?.name||'')} · en ${g.labels.length} áreas: ${esc(g.areas.join(', '))}${g.root&&g.parentNames.length?` · en alguna cuelga de ${esc(g.parentNames.join(', '))}: la General quedará en la raíz`:''}${g.keyConflict?' · las familias tienen marcas distintas: la General, sin marca':''}</span></span></label>`).join('')}</div>`:'<p class="small">No hay etiquetas repetidas entre áreas. Puedes llevar una etiqueta o una familia a General con «Hacer General».</p>'}
      ${lookalikes.length?`<div class="notice"><strong>Parecidas, pero no iguales</strong> (decide a mano si son la misma; renómbralas y vuelve aquí):<ul>${lookalikes.map(l=>`<li>${l.map(esc).join(' · ')}</li>`).join('')}</ul></div>`:''}
      <div class="actions"><button class="ghost" id="generalCancel" data-feedback-id="tasks.etiquetas.general.cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="primary" id="generalMerge" ${n||m?'':'disabled'} data-feedback-id="tasks.etiquetas.general.fusionar" data-feedback-label="Fusionar en General">${n?`Fusionar ${n}`:m?`Corregir ${m}`:'Fusionar'}</button></div>`);
    document.querySelectorAll('[data-general-group]').forEach(b=>b.onchange=()=>{const k=b.dataset.generalGroup;if(b.checked)chosen.add(k);else{chosen.delete(k);for(const g of groups)if(g.mother===k&&!g.root)chosen.delete(g.key)}
      for(const g of groups)if(g.mother&&!g.root&&g.mother!=='general'&&!chosen.has(g.mother))chosen.delete(g.key);paint()});
    document.querySelectorAll('[data-general-fix]').forEach(b=>b.onchange=()=>{if(b.checked)fixes.add(b.dataset.generalFix);else fixes.delete(b.dataset.generalFix);paint()});
    document.getElementById('generalCancel').onclick=closeSheet;
    document.getElementById('generalMerge').onclick=async()=>{const button=document.getElementById('generalMerge');button.disabled=true;
      try{const fixing=conflicts.filter(x=>fixes.has(x.family.id));
        if(fixing.length){if(!purchaseCommit(generalFixOps(fixing),null))throw new Error('No se pudo corregir las claves.');await generalWaitSync()}
        // Con las claves corregidas, se recalcula (las marcas ya no separan nada) y se fusiona lo marcado.
        const picked=generalMergeGroups().filter(g=>chosen.has(g.key));
        const out=picked.length?await generalMerge(picked):null;
        await syncNow();closeSheet();render();toast(out?`Fusionadas en General: ${out.counts?.groups??picked.length} etiquetas${fixing.length?` · ${fixing.length} claves corregidas`:''}.`:`${fixing.length} claves corregidas.`)}
      catch(e){button.disabled=false;toast(e.message)}};
  };
  paint();
}

/* «Hacer General»: una etiqueta del área (con sus iguales de otras áreas) o una familia entera. */
function generalGroupsFor(labelIds){
  const c=generalCatalog(),out=[];
  for(const id of labelIds){const l=c.byId.get(id);if(!l||!l.tab_id||l.archived||out.some(g=>g.labels.some(x=>x.id===id)))continue;
    const same=c.live.filter(x=>c.keyOf(x)===c.keyOf(l)),perTab=[l,...same.filter(x=>x.tab_id!==l.tab_id)].filter((x,i,a)=>a.findIndex(y=>y.tab_id===x.tab_id)===i);
    out.push(generalGroupOf(c,perTab))}
  for(const g of out)g.root=g.mother==='mixed'||(g.mother&&g.mother!=='general'&&!out.some(m=>m.key===g.mother));
  return out.sort((a,b)=>(a.mother&&!a.root?1:0)-(b.mother&&!b.root?1:0));
}
function generalMakeSheet(labelIds,what){
  if(!generalReady())return;
  const groups=generalGroupsFor(labelIds);if(!groups.length)return toast('No hay nada del área que llevar a General.');
  openSheet(`<h2 class="sheettitle">Hacer General</h2><p class="small muted">${esc(what)} pasa a General, válida en todas las áreas, junto con las iguales de otras áreas. Las copias de cada área quedan archivadas.</p><ul class="small">${groups.map(g=>`<li><strong>${esc(g.name)}</strong> · ${esc(g.family?.name||'')} · ${g.labels.length===1?`de ${esc(g.areas[0])}`:`en ${g.labels.length} áreas: ${esc(g.areas.join(', '))}`}${g.root&&g.parentNames.length?' · quedará en la raíz':''}</li>`).join('')}</ul>
    <div class="actions"><button class="ghost" id="generalMakeCancel" data-feedback-id="tasks.etiquetas.general.hacer_cancelar" data-feedback-label="Cancelar">Cancelar</button><button class="primary" id="generalMakeGo" data-feedback-id="tasks.etiquetas.general.hacer" data-feedback-label="Hacer General">Hacer General</button></div>`);
  document.getElementById('generalMakeCancel').onclick=closeSheet;
  document.getElementById('generalMakeGo').onclick=async()=>{const b=document.getElementById('generalMakeGo');b.disabled=true;
    try{const out=await generalMerge(groups);await syncNow();closeSheet();render();toast(`En General: ${out.counts?.groups??groups.length} etiquetas.`)}catch(e){b.disabled=false;toast(e.message)}};
}
/* + Nueva familia General: la siguiente familia que se cree con el editor abierto es General. */
let generalFamilyArmed=false;
function newGeneralFamily(){if(!isAdministrator())return toast('El catálogo General es de quien tiene acceso a toda la app.');
  // No enumerable: el modelo se copia con structuredClone, que no admite funciones.
  const fams=tab().families;Object.defineProperty(fams,'push',{configurable:true,writable:true,enumerable:false,value:function(...items){if(generalFamilyArmed){items.forEach(i=>{i.general=true});generalFamilyArmed=false;delete this.push}return Array.prototype.push.apply(this,items)}});
  generalFamilyArmed=true;openFamilyEditor(null)}
const renderBeforeGeneralFamily=render;
render=function(...args){const out=renderBeforeGeneralFamily(...args);if(generalFamilyArmed&&!document.getElementById('feName'))generalFamilyArmed=false;return out};
document.addEventListener('click',e=>{const t=e.target;
  if(t.closest?.('#generalFamilyNew'))return newGeneralFamily();
  const fam=t.closest?.('[data-general-family]');if(fam){const id=fam.dataset.generalFamily,f=tab().families.find(x=>x.id===id);return generalMakeSheet(tab().labels.filter(l=>l.family===id&&!l.general&&!l.archived).map(l=>l.id),`La familia «${f?.name||''}», con sus etiquetas,`)}
  const one=t.closest?.('[data-general-label]');if(one){const l=label(one.dataset.generalLabel);return generalMakeSheet([one.dataset.generalLabel],`«${l?.text||''}»`)}});

/* «Etiquetas» (FB_2026_023): primero General, con sus familias (y, marcadas, las etiquetas de esa familia que solo son de
   esta área); debajo, «Solo de <área>», con las familias que no tienen General equivalente. Lo General lo edita quien
   tiene acceso a toda la app; una familia General no se archiva desde aquí (sus etiquetas, una a una). */
function generalFamilyCard(f){
  const scope=tab(),ids=catalogFamilyIds(f),admin=isAdministrator();
  const ls=catalogOrder(scope.labels.filter(l=>ids.includes(l.family)&&(showArchivedCatalog||!l.archived)).sort((a,b)=>Number(b.general||0)-Number(a.general||0)));
  return `<section class="family-card generalfamily"><div class="family-card-head"><span class="dot" style="background:${esc(f.color)}"></span><strong>${esc(f.name)}${f.archived?' · archivada':''}</strong><div class="spacer"></div>${admin?`<button class="ghost" data-edit-family="${f.id}" data-feedback-id="tasks.etiquetas.familia.editar" data-feedback-label="Editar familia">Editar familia</button>`:''}</div><div class="chips">${ls.map(l=>`<button class="chip label-edit ${l.archived?'archivedchip':''} ${l.general?'':'arealabel'}" style="background:${esc(f.color)}" data-edit-label="${l.id}" title="${l.general?'General: en todas las áreas':`Solo de ${esc(scope.name)}`}" data-feedback-id="tasks.etiquetas.familia.etiqueta" data-feedback-label="Editar etiqueta">${l.parent&&ls.some(x=>x.id===l.parent)?'↳ ':''}${esc(l.text)}${l.general?'':`<span class="scopemark"> · solo de ${esc(scope.name)}</span>`}${l.archived?' · archivada':''}</button>`).join('')||'<span class="small muted">Sin etiquetas.</span>'}</div>${!f.archived?`<div class="row generalnew">${admin?`<button class="ghost" data-new-general-label="${f.id}" data-feedback-id="tasks.etiquetas.general.nueva" data-feedback-label="Nueva etiqueta General">+ General</button>`:''}${canManageCatalog()?`<button class="ghost" data-new-label="${f.id}" data-feedback-id="tasks.etiquetas.familia.nueva_etiqueta" data-feedback-label="Nueva etiqueta">+ Solo de ${esc(scope.name)}</button>`:''}</div>`:''}</section>`}
labelsView=function(){const scope=tab(),generals=catalogFamilies().filter(f=>f.general&&(showArchivedCatalog||!f.archived)),own=catalogFamilies().filter(f=>!f.general);
  return `<main class="screen label-manager"><div class="screenhead"><div><h1 class="title">Etiquetas</h1><p class="subtitle">General, en todas las áreas, y lo propio de ${esc(scope.name)}. Pulsa una etiqueta para editarla.</p></div></div><div class="notice">Las familias agrupan etiquetas por color. Archivar una etiqueta conserva sus referencias en tareas e historial.${!canManageCatalog()?' Tu acceso permite consultar este catálogo.':''}</div>
    <h2 class="sectionlabel catalogsection" id="catalogGeneral">General <span class="small muted">· en todas las áreas</span></h2>${isAdministrator()?`<div class="row generalnew generaltools"><button class="ghost" id="generalMergeOpen" type="button" data-feedback-id="tasks.etiquetas.general.abrir" data-feedback-label="Repetidas a General">Repetidas → General (${generalMergeGroups().length+generalKeyConflicts().length})</button><button class="ghost" id="generalFamilyNew" type="button" data-feedback-id="tasks.etiquetas.general.nueva_familia" data-feedback-label="Nueva familia General">+ Nueva familia General</button></div>`:''}${generals.map(generalFamilyCard).join('')||`<p class="small muted">Aún no hay etiquetas General.${isAdministrator()?' Lleva a General las repetidas, una etiqueta o una familia («Hacer General»), o crea una familia General.':''}</p>`}
    <h2 class="sectionlabel catalogsection" id="catalogOwn">Solo de ${esc(scope.name)}</h2>${own.map(ownFamilyCard).join('')||'<p class="small muted">Todo lo de esta área está en General.</p>'}
    <div class="catalog-actions"><button class="primary" id="newFamily" ${canManageCatalog()?'':'disabled'} data-feedback-id="tasks.etiquetas.catalogo.nueva_familia" data-feedback-label="Nueva familia">+ Nueva familia</button>${archivedCatalogButton()}</div></main>`};
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-new-general-label]');if(!b)return;labelEditorScope='general';openLabelEditor(b.dataset.newGeneralLabel)});

document.addEventListener('click',e=>{if(e.target.closest?.('#generalMergeOpen'))generalMergeSheet()});

/* «Hacer General» en una familia del área y en el editor de una etiqueta del área (propietaria con acceso completo). */
function ownFamilyCard(f){const html=familyCard(f);if(!isAdministrator()||!html||!tab().labels.some(l=>l.family===f.id&&!l.general&&!l.archived))return html;
  return html.replace('<div class="spacer"></div>',`<div class="spacer"></div><button class="ghost" data-general-family="${f.id}" data-feedback-id="tasks.etiquetas.general.hacer_familia" data-feedback-label="Hacer General la familia">Hacer General</button>`)}
const labelEditorBeforeGeneral=openLabelEditor;
openLabelEditor=function(fid,id=null,returnTo=null){const out=labelEditorBeforeGeneral(fid,id,returnTo);const l=id?label(id):null;
  if(l&&!l.general&&!l.archived&&isAdministrator()){const actions=document.querySelector('#sheet .actions');if(actions&&!document.querySelector('[data-general-label]'))actions.insertAdjacentHTML('afterbegin',`<button class="ghost" data-general-label="${l.id}" data-feedback-id="tasks.editor_etiqueta.hacer_general" data-feedback-label="Hacer General">Hacer General</button>`)}
  return out};
