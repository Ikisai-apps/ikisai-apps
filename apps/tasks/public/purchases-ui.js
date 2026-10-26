/* Compras no alimentarias (docs/tasks/API.md §18): solicitudes de compra con aprobación del responsable de compras del
   área, suministros («Queda poco: pedir») y planes de compra por proveedor con hoja de ruta.
   Las solicitudes y los planes salen del modelo del núcleo (Sync.core.data: no forman parte del modelo anidado de tareas) y
   los cambios son operaciones del dominio (IkisaiTasks.purchases) que se confirman por el mismo camino que save().
   Desde R6 el almacén es el inventario común de Recursos (el segundo cliente, Sync.core.resources) con las piezas del kit:
   catálogo, ficha, movimiento y recuento. Una solicitud apunta a su artículo con `item_id`. */
const PURCHASE_VIEWS=['purchases','supplies','plans'];
const PURCHASE_STATUS={requested:['Pedida','pending'],approved:['Aprobada','ok'],purchased:['Comprada','ok'],received:['Recibida','ok'],rejected:['Rechazada','trash']};
const PLAN_STATUS={draft:'Preparando',shopping:'De compras',done:'Terminado'};
Object.assign(menuPaths,{cart:'M3 4h2l2.4 11h11.2L21 7H6 M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',box:'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',route:'M5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M7 17h6a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h6'});

const purchasesData=()=>Sync.core?.data||null;
const liveRows=table=>(purchasesData()?.[table]||[]).filter(r=>!r.deleted_at);
const qty=(n,unit)=>n==null?'':`${Number(n).toLocaleString('es-ES',{maximumFractionDigits:3})}${unit?' '+unit:''}`;
const shortDate=v=>v?new Date(v.length===10?v+'T00:00:00':v).toLocaleDateString('es-ES',{day:'numeric',month:'short'}):'';
const today=()=>new Date().toISOString().slice(0,10);
function fullScope(tabId){const s=Sync.actor?.scopes;return s==='*'||s==null||Array.isArray(s)&&s.includes(tabId)||Array.isArray(s?.tabs)&&s.tabs.includes(tabId)}
/* Aprueba el responsable de compras del área; si no hay, la propietaria con el área entera (como el hook de 0305). */
function purchaseApprover(tabId){return purchasesData()?.['tasks.tabs'].find(t=>t.id===tabId)?.purchase_approver_id||null}
function canApprovePurchases(tabId=tab()?.id){if(!Sync.actor||Sync.secondary||Sync.actor.kind==='agent')return false;const approver=purchaseApprover(tabId);return approver?approver===Sync.actor.id:Sync.actor.role==='owner'&&fullScope(tabId)}
function approverName(tabId){const id=purchaseApprover(tabId);if(!id)return 'la propietaria';return (Sync.members||[]).find(m=>m.userId===id)?.displayName||'el responsable de compras'}

/* Confirma un lote de compras: valida como la Edge y lo envía como save(). */
function purchaseCommit(ops,message){
  if(!ops?.length)return true;
  if(!Sync.core||!Sync.actor||Sync.actor.role==='reader'||Sync.secondary){toast('Tu acceso es de solo lectura.');return false}
  try{IkisaiTasks.purchases.validateOperations(ops,{role:Sync.actor.role,scopes:Sync.actor.scopes})}catch(e){toast(e.message||'No se pudo guardar.');return false}
  const work=Sync.core.commit([ops],()=>uid('req-'));Sync.chain=Sync.chain.then(()=>work).then(()=>{Sync.channel?.postMessage({type:'changed'})}).catch(storageError);
  Sync.mode='pending';refreshStatus();render();if(message)toast(message);return true}
function purchaseRun(build,message){try{return purchaseCommit(build(purchasesData()),message)}catch(e){toast(e.message||'No se pudo hacer.');return false}}

/* Las vistas de compras se repintan con cualquier cambio del núcleo (el modelo de tareas puede no haber cambiado). */
let purchaseListening=false;
/* En Inicio, solo si cambia el número del aviso de suministros: un movimiento de almacén no cambia el modelo de tareas. */
let homeLowStock=0;
function lowSupplies(){const inv=Sync.core?.inventory;return inv?IkisaiTasks.purchases.lowStock(purchasesData(),inv.items,inv.movements):[]}
function lowStockCount(){return state.view==='home'&&tab()&&Sync.core&&fullScope(tab().id)?lowSupplies().length:0}
function listenPurchases(){if(purchaseListening||!Sync.core)return;purchaseListening=true;Sync.core.onChange(kind=>{if(kind!=='data'||document.getElementById('sheetBack')?.classList.contains('show'))return;if(PURCHASE_VIEWS.includes(state.view)||state.view==='home'&&lowStockCount()!==homeLowStock)render()})}

/* --- Menú ---------------------------------------------------------------------------------------------------------- */
const navigationBeforePurchases=navigationGroups;
navigationGroups=function(){const groups=navigationBeforePurchases();const at=groups.findIndex(g=>g.id==='transfer');
  const purchases={id:'purchases',name:'Compras',icon:'cart',items:[['purchases','Solicitudes de compra','cart','view'],['supplies','Suministros','box','view'],['plans','Planes de compra','route','view']]};
  groups.splice(at<0?groups.length:at,0,purchases);return groups};

/* --- Finance (Invoices): facturas de cada solicitud y proveedores del catálogo ------------------------------------------
   Dos lecturas de Invoices registradas para Tasks (invoices.allocations_by_target e invoices.supplier_options). Devuelven
   vacío a quien no es miembro de Finance, y sin red no se piden: el proveedor queda como nombre libre. */
const FINANCE_INVOICE_URL='https://finance.ikisai.com/#/facturas/';
const purchaseInvoices=new Map();let invoicesAsked={key:'',at:0};
function loadPurchaseInvoices(ids){const key=[...ids].sort().join(',');if(!ids.length||!Sync.core||!navigator.onLine)return;if(key===invoicesAsked.key&&Date.now()-invoicesAsked.at<60000)return;invoicesAsked={key,at:Date.now()};
  Sync.core.api('/read/invoices.allocations_by_target',{method:'POST',json:{targetApp:'tasks',targetKind:'purchase_request',ids}}).then(out=>{
    for(const id of ids)purchaseInvoices.set(id,[]);for(const row of out?.rows||[])purchaseInvoices.get(row.target_id)?.push(row);
    if(state.view==='purchases'&&!document.getElementById('sheetBack')?.classList.contains('show'))render()}).catch(()=>{invoicesAsked={key:'',at:0}})}
/* Una compra ligada a una factura viva de Finance ya no se deshace (0337): se corrige en Finance. Sin la lectura (sin red o
   sin Finance), no se sabe: se ofrece y, si la hay, el servidor lo rechaza con PURCHASE_INVOICED. */
function purchaseInvoiced(id){return (purchaseInvoices.get(id)||[]).length>0}
function invoiceCodes(id){return [...new Set((purchaseInvoices.get(id)||[]).map(x=>x.invoice_code).filter(Boolean))]}
function invoiceSection(r){if(!r.needs_invoice||!['approved','purchased','received'].includes(r.status)||!purchaseInvoices.has(r.id))return '';const list=purchaseInvoices.get(r.id);
  if(!list.length)return r.status==='approved'?'':'<p class="pmeta pinvoices">Sin factura asignada todavía en Finance.</p>';
  return `<div class="pinvoices"><span class="pmeta">Facturas en Finance</span>${list.map(x=>`<a class="pinvoice" href="${FINANCE_INVOICE_URL}${encodeURIComponent(x.invoice_code)}" target="_blank" rel="noopener" data-feedback-id="tasks.solicitud.facturas.abrir" data-feedback-label="Abrir factura en Finance">${esc(x.invoice_code)}${x.invoice_date?' · '+esc(shortDate(x.invoice_date)):''}${x.allocated_amount!=null?' · '+esc(money(Number(x.allocated_amount))):''}</a>`).join('')}</div>`}
const supplierCache=new Map(),supplierKnown=new Map();
function supplierInput(id,name,supplierId,disabled){return `<input id="${id}" maxlength="200" placeholder="Opcional" list="${id}List" autocomplete="off" value="${esc(name||'')}" data-supplier-id="${esc(supplierId||'')}" data-initial="${esc(name||'')}" ${disabled?'disabled':''} data-feedback-id="tasks.compras.campos.proveedor" data-feedback-label="Proveedor"><datalist id="${id}List"></datalist>`}
function bindSupplierInput(id){const input=document.getElementById(id),list=document.getElementById(id+'List');if(!input||input.disabled||!list)return;let timer=null;
  const fill=items=>{list.innerHTML=items.map(x=>`<option value="${esc(x.name)}"></option>`).join('')};
  const ask=()=>{const q=input.value.trim().toLowerCase();if(supplierCache.has(q))return fill(supplierCache.get(q));if(!Sync.core||!navigator.onLine)return;
    Sync.core.api('/read/invoices.supplier_options',{method:'POST',json:{q,limit:20}}).then(out=>{const items=out?.items||[];supplierCache.set(q,items);for(const x of items)supplierKnown.set(x.name.toLowerCase(),x);if(document.getElementById(id)===input)fill(items)}).catch(()=>{})};
  input.addEventListener('focus',ask);input.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(ask,250)})}
/* Proveedor elegido: del catálogo de Finance si el nombre coincide con uno; si no, nombre libre (sin red o sin Finance). */
function supplierValue(id){const input=document.getElementById(id),name=input.value.trim();if(!name)return {supplier_id:null,supplier_name:null};
  const known=supplierKnown.get(name.toLowerCase());if(known)return {supplier_id:known.id,supplier_name:known.name};
  if(name===input.dataset.initial&&input.dataset.supplierId)return {supplier_id:input.dataset.supplierId,supplier_name:name};
  return {supplier_id:null,supplier_name:name}}
/* Nombre de un proveedor del catálogo de Finance por su id: lo ya buscado o lo que dicen las solicitudes y paradas. */
function supplierNameOf(id){if(!id)return '';for(const x of supplierKnown.values())if(x.id===id)return x.name;
  return liveRows('tasks.purchase_requests').find(r=>r.supplier_id===id&&r.supplier_name)?.supplier_name||liveRows('tasks.purchase_plan_stops').find(s=>s.supplier_id===id)?.supplier_name||''}
/* Proveedor habitual de un artículo (ficha del kit, `supplierField`): solo del catálogo de Finance, porque Recursos guarda
   su id. Vaciarlo lo quita; un nombre que no está en el catálogo no se guarda. */
function itemSupplierField(value,onChange){const wrap=document.createElement('div');wrap.className='field';
  wrap.innerHTML=`<label for="itemSupplier">Proveedor habitual</label>${supplierInput('itemSupplier',supplierNameOf(value),value,!canEdit())}<p class="small muted">Del catálogo de proveedores de Finance.</p>`;
  const input=wrap.querySelector('input'),list=wrap.querySelector('datalist');let timer=null;
  const ask=()=>{const q=input.value.trim().toLowerCase();const fill=items=>{list.innerHTML=items.map(x=>`<option value="${esc(x.name)}"></option>`).join('')};if(supplierCache.has(q))return fill(supplierCache.get(q));if(!Sync.core||!navigator.onLine)return;
    Sync.core.api('/read/invoices.supplier_options',{method:'POST',json:{q,limit:20}}).then(out=>{const items=out?.items||[];supplierCache.set(q,items);for(const x of items)supplierKnown.set(x.name.toLowerCase(),x);fill(items)}).catch(()=>{})};
  input.addEventListener('focus',ask);input.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(ask,250);const name=input.value.trim();
    if(!name)return onChange(null);const known=supplierKnown.get(name.toLowerCase());if(known)onChange(known.id)});
  return wrap}

/* --- Vistas -------------------------------------------------------------------------------------------------------- */
function purchaseAreaNote(){return generalMode()?'<div class="notice">Elige un área en la tira de arriba: las compras se llevan por área.</div>':''}
/* El área de la solicitud (no la activa, que puede faltar al arrancar o al cerrar sesión: «reading 'projects'» en 14 reportes). */
function purchaseAreaOf(r){return (r?.tab_id&&state.tabs.find(t=>t.id===r.tab_id))||tab()||null}
function purchaseRow(r){const [label,tone]=PURCHASE_STATUS[r.status]||[r.status,''];const project=r.project_id?purchaseAreaOf(r)?.projects.find(p=>p.id===r.project_id)?.title:'';
  const meta=[qty(r.quantity,r.unit),r.supplier_name,project,r.due?'para el '+shortDate(r.due):'',r.repeat_days?`cada ${r.repeat_days} días`:'',invoiceCodes(r.id).length?'Factura '+invoiceCodes(r.id).join(', '):''].filter(Boolean).join(' · ');
  return `<button type="button" class="pcard" data-purchase="${r.id}" data-feedback-id="tasks.compras.lista.solicitud" data-feedback-label="Solicitud de compra"><span class="phead">${r.priority!=='normal'?priorityStar(r.priority):''}<strong>${esc(r.title)}</strong><span class="pstate ${tone}">${label}</span></span>${meta?`<span class="pmeta">${esc(meta)}</span>`:''}</button>`}
let showRejectedPurchases=false;
/* «Por proveedor» (8-10-2026): lo pendiente de cada proveedor (pedido, aprobado o comprado sin recibir), esté o no en un plan.
   Se recuerda por dispositivo. */
let purchaseGrouping=(()=>{try{return localStorage.getItem('tasks.purchases.grouping')==='supplier'?'supplier':'status'}catch{return 'status'}})();
/* Lo pendiente agrupado por proveedor (el del catálogo de Finance o el nombre libre; sin proveedor, al final). */
function supplierSections(list){
  if(!list.length)return '<p class="small muted">Nada pendiente.</p>';
  const groups=new Map();
  for(const r of list){const key=r.supplier_id?'id:'+r.supplier_id:r.supplier_name?.trim()?'nombre:'+r.supplier_name.trim().toLowerCase():'';const g=groups.get(key)||{name:r.supplier_name?.trim()||'Sin proveedor',items:[]};g.items.push(r);groups.set(key,g)}
  return [...groups.entries()].sort(([a,ga],[b,gb])=>(a===''?1:0)-(b===''?1:0)||ga.name.localeCompare(gb.name,'es')).map(([,g])=>`<h2 class="sectionlabel">${esc(g.name)} <span class="count">${g.items.length}</span></h2>${g.items.map(purchaseRow).join('')}`).join('')}
function purchasesView(){listenPurchases();if(generalMode()||!tab())return `<main class="screen"><h1 class="title">Solicitudes de compra</h1>${purchaseAreaNote()}</main>`;
  const all=liveRows('tasks.purchase_requests').filter(r=>r.tab_id===tab().id).sort((a,b)=>(a.position||0)-(b.position||0));
  const open=all.filter(r=>['requested','approved','purchased'].includes(r.status)).length;
  loadPurchaseInvoices(all.filter(r=>r.needs_invoice&&['approved','purchased','received'].includes(r.status)).map(r=>r.id));
  const section=(status,title,list)=>list.length?`<h2 class="sectionlabel">${title} <span class="count">${list.length}</span></h2>${list.map(purchaseRow).join('')}`:'';
  const received=all.filter(r=>r.status==='received').sort((a,b)=>(b.received_at||'').localeCompare(a.received_at||'')).slice(0,20),rejected=all.filter(r=>r.status==='rejected');
  return `<main class="screen purchases"><div class="screenhead"><div><h1 class="title">Solicitudes de compra</h1><p class="subtitle">${esc(tab().name)} · ${open} abiertas · ${purchaseApprover(tab().id)&&purchaseApprover(tab().id)===Sync.actor?.id?'apruebas tú':'aprueba '+esc(approverName(tab().id))}</p></div>${canEdit()?'<button class="primary" id="newPurchase" type="button" data-feedback-id="tasks.compras.cabecera.pedir" data-feedback-label="Pedir algo">+ Pedir algo</button>':''}</div>
    ${all.length?'':'<div class="empty">Todavía no hay solicitudes. Pide aquí lo que haga falta comprar; quien aprueba lo verá.</div>'}
    ${all.length?`<div class="segmented purchasegrouping" role="group" aria-label="Agrupar las solicitudes">${[['status','Por estado'],['supplier','Por proveedor']].map(([k,l])=>`<button type="button" class="${purchaseGrouping===k?'on':''}" data-purchase-grouping="${k}" aria-pressed="${purchaseGrouping===k}" data-feedback-id="tasks.compras.lista.agrupar" data-feedback-label="Agrupar las solicitudes" style="width:auto;padding:0 10px">${l}</button>`).join('')}</div>`:''}
    ${purchaseGrouping==='supplier'?supplierSections(all.filter(r=>['requested','approved','purchased'].includes(r.status))):`${section('requested','Pedidas',all.filter(r=>r.status==='requested'))}${section('approved','Aprobadas',all.filter(r=>r.status==='approved'))}${section('purchased','Compradas',all.filter(r=>r.status==='purchased'))}`}${section('received','Recibidas',received)}
    ${rejected.length?`<button class="ghost" id="toggleRejectedPurchases" type="button" data-feedback-id="tasks.compras.lista.ver_rechazadas" data-feedback-label="Ver rechazadas">${showRejectedPurchases?'Ocultar rechazadas':`Ver rechazadas (${rejected.length})`}</button>${showRejectedPurchases?rejected.map(purchaseRow).join(''):''}`:''}</main>`}
function suppliesView(){listenPurchases();if(generalMode()||!tab())return `<main class="screen"><h1 class="title">Suministros</h1>${purchaseAreaNote()}</main>`;
  if(!fullScope(tab().id))return `<main class="screen"><h1 class="title">Suministros</h1><div class="notice">El almacén es del área entera; tu acceso es a algunos proyectos.</div></main>`;
  if(!Sync.core?.resources)return `<main class="screen supplies"><h1 class="title">Suministros</h1><div class="notice">El inventario de la casa no está disponible ahora mismo. Vuelve a intentarlo en un momento.</div></main>`;
  const inv=Sync.core.inventory,items=inv.items.filter(i=>!i.deleted_at&&i.active!==false&&IkisaiTasks.purchases.isSupplyKind(i.kind)),low=lowSupplies().length;
  return `<main class="screen supplies"><div class="screenhead"><div><h1 class="title">Suministros</h1><p class="subtitle">Inventario de la casa · ${items.length} ${items.length===1?'suministro':'suministros'}${low?` · ${low} con poco`:''}</p></div></div>
    <div class="ikisai-kit" id="suppliesCatalog"></div></main>`}

/* --- Inventario de Recursos con las piezas del kit (R6) ------------------------------------------------------------------
   Una fuente de artículos y una de espacios sobre el segundo cliente (como spaces-ui.js); el catálogo se crea una vez y se
   vuelve a enganchar en cada render. Las piezas hacen sus propios lotes en Recursos (entrada, salida, traslado, recuento,
   alta de artículos). Las hojas salen en la capa del kit (setKitLayer, feedback-ui.js). */
let inventoryItems=null,inventorySpaces=null,suppliesCatalog=null,inventoryHandle=null,inventoryTool=null;
function inventorySources(){const r=Sync.core?.resources;if(!r)return null;
  inventoryItems??=IkisaiKit.createSyncItemSource(r,{supplierName:supplierNameOf});inventorySpaces??=IkisaiKit.createSyncSpaceSource(r);return {items:inventoryItems,spaces:inventorySpaces}}
const isSupply=item=>IkisaiTasks.purchases.isSupplyKind(item.kind);
function supplyLow(item){const inv=Sync.core?.inventory;if(!inv||!(Number(item.minQuantity)>0))return false;return IkisaiTasks.purchases.itemStock(inv.movements,item.id)<Number(item.minQuantity)}
function closeInventorySheet(){const h=inventoryHandle;inventoryHandle=null;inventoryTool?.destroy();inventoryTool=null;if(h)void h.close(true)}
function inventorySheet(title,build){closeInventorySheet();inventoryTool=build(()=>closeInventorySheet());
  inventoryHandle=IkisaiKit.openSheet({title,body:inventoryTool.element,onClose:()=>{inventoryTool?.destroy();inventoryTool=null;inventoryHandle=null}})}
/* Gastar, entrada, traslado o recuento de un artículo: el formulario de movimiento o la sesión de recuento del kit. */
function supplyAct(action,item){const src=inventorySources();if(!src||!canEdit())return;
  if(action==='count')return inventorySheet(`Contar ${item.name}`,done=>IkisaiKit.createCountSession({source:src.items,spaces:src.spaces,itemIds:[item.id],feedbackId:'tasks.suministros.recuento',onClosed:done,onLeave:done}));
  const title={spend:'Gastar',entry:'Entrada',transfer:'Trasladar'}[action]||'Movimiento';
  inventorySheet(`${title} · ${item.name}`,done=>IkisaiKit.createMovementForm({source:src.items,spaces:src.spaces,itemId:item.id,sourceApp:'tasks',feedbackId:'tasks.suministros.movimiento',onDone:done,onCancel:done,
    ...(action==='spend'?{modes:['exit'],reason:'uso'}:{mode:action==='entry'?'entry':'transfer'})}))}
/* Ficha del artículo: datos, unidades, stock por sitio y movimientos (lo de Food o Finance también sale: es el mismo). */
function openSupply(item){const src=inventorySources();if(!src)return;closeInventorySheet();
  const sheet=IkisaiKit.createItemSheet({source:src.items,itemId:item.id,spaces:src.spaces,feedbackId:'tasks.suministros.ficha',permissions:{edit:canEdit()},supplierField:itemSupplierField,
    ...(canEdit()?{actions:['spend','entry','transfer','count'],onAction:(a,it)=>supplyAct(a,it)}:{})});
  inventoryTool=sheet;inventoryHandle=IkisaiKit.openSheet({title:item.name,body:sheet.element,onClose:()=>{sheet.destroy();if(inventoryTool===sheet)inventoryTool=null;inventoryHandle=null}})}
/* «Queda poco: pedir» desde un artículo: la hoja de pedir, precargada (cantidad de reposición o lo que falta, en su unidad). */
function reorderItem(item){const inv=Sync.core?.inventory,row=inv?.items.find(i=>i.id===item.id);if(!row)return;
  const op=IkisaiTasks.purchases.reorderItemOps(purchasesData(),{tab_id:tab().id,item:row,stock:IkisaiTasks.purchases.itemStock(inv.movements,row.id),supplier_name:supplierNameOf(row.default_supplier_id)||null})[0];
  purchaseSheet(null,{...op.fields})}
function mountSuppliesCatalog(){const host=document.getElementById('suppliesCatalog');if(!host)return;const src=inventorySources();if(!src)return;
  if(!suppliesCatalog)suppliesCatalog=IkisaiKit.createItemCatalog({source:src.items,spaces:src.spaces,label:'Suministros',filter:isSupply,groupBy:'kind',storageKey:'tasks.suministros',
    feedbackId:'tasks.suministros.catalogo',canCreate:canEdit(),onOpen:item=>openSupply(item),
    ...(canEdit()?{actions:['spend','entry','count'],onAction:(a,item)=>supplyAct(a,item)}:{}),
    rowActions:item=>{if(!supplyLow(item))return [];const open=IkisaiTasks.purchases.openRequestFor(purchasesData(),item.id);
      if(open)return [{label:'Pedido',feedbackId:'tasks.suministros.lista.pedido',onClick:()=>purchaseSheet(open.id)}];
      return canEdit()?[{label:'Queda poco: pedir',feedbackId:'tasks.suministros.lista.pedir',primary:true,onClick:()=>reorderItem(item)}]:[]}});
  host.append(suppliesCatalog.element);
  // Las acciones de fila dependen de las solicitudes de Tasks («Pedido»), que el catálogo no escucha: se repintan aquí.
  suppliesCatalog.refresh()}
function plansView(){listenPurchases();if(generalMode()||!tab())return `<main class="screen"><h1 class="title">Planes de compra</h1>${purchaseAreaNote()}</main>`;
  if(!fullScope(tab().id))return `<main class="screen"><h1 class="title">Planes de compra</h1><div class="notice">Los planes de compra son del área entera.</div></main>`;
  const plans=liveRows('tasks.purchase_plans').filter(p=>p.tab_id===tab().id).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
  const pending=liveRows('tasks.purchase_requests').filter(r=>r.tab_id===tab().id&&r.status==='approved'&&!r.plan_stop_id).length;
  const recurring=IkisaiTasks.purchases.dueRecurring(purchasesData(),tab().id,today()).length;
  return `<main class="screen plans"><div class="screenhead"><div><h1 class="title">Planes de compra</h1><p class="subtitle">${pending} aprobadas sin plan${recurring?` · ${recurring} recurrentes que tocan`:''}</p></div>${canApprovePurchases()?'<button class="primary" id="preparePlan" type="button" data-feedback-id="tasks.planes.cabecera.preparar" data-feedback-label="Preparar plan">Preparar plan</button>':''}</div>
    ${canApprovePurchases()?'':`<p class="small muted">Prepara los planes ${esc(approverName(tab().id))}.</p>`}
    ${plans.length?plans.map(p=>`<button type="button" class="pcard" data-plan="${p.id}" data-feedback-id="tasks.planes.lista.plan" data-feedback-label="Plan de compra"><span class="phead"><strong>${esc(p.title)}</strong><span class="pstate ${p.status==='done'?'':'pending'}">${PLAN_STATUS[p.status]}</span></span><span class="pmeta">${p.planned_for?shortDate(p.planned_for)+' · ':''}${liveRows('tasks.purchase_plan_stops').filter(s=>s.plan_id===p.id).length} proveedores</span></button>`).join(''):'<div class="empty">Un plan reúne lo aprobado por proveedor, en el orden en que vas a pasar, con casillas para marcar al comprar.</div>'}</main>`}

const mainBeforePurchases=main;
main=function(){if(state.view==='purchases')return purchasesView();if(state.view==='supplies')return suppliesView();if(state.view==='plans')return plansView();
  const html=mainBeforePurchases();
  // Aviso en Inicio: suministros bajo mínimo del área.
  if(state.view==='home')listenPurchases();homeLowStock=lowStockCount();
  if(homeLowStock){const n=homeLowStock;return html.replace(/(<main[^>]*>)/,`$1<div class="notice lowstock">Queda poco de ${n} ${n===1?'suministro':'suministros'}. <button class="linkbtn" data-open-supplies type="button" data-feedback-id="tasks.inicio.aviso.ver_suministros" data-feedback-label="Ver suministros">Ver suministros</button></div>`)}
  return html};

/* --- Hojas --------------------------------------------------------------------------------------------------------- */
function purchaseSheet(id=null,preset={}){
  const r=id?liveRows('tasks.purchase_requests').find(x=>x.id===id):{title:'',note:'',quantity:null,unit:'',estimated_amount:null,priority:'normal',needs_invoice:true,repeat_days:null,due:'',supplier_name:'',project_id:null,...preset};
  if(!r)return;const editable=canEdit()&&(!id||['requested','approved'].includes(r.status)),approve=id&&canApprovePurchases(r.tab_id);
  const projects=(purchaseAreaOf(r)?.projects||[]).filter(p=>!p.deleted&&p.status!=='archived');
  openSheet(`<h2 class="sheettitle">${id?'Solicitud de compra':'Pedir algo'}</h2>${id?`<p class="small">${esc((PURCHASE_STATUS[r.status]||[r.status])[0])}${r.approved_at?' · aprobada '+shortDate(r.approved_at):''}${r.purchased_at?' · comprada '+shortDate(r.purchased_at):''}${r.received_at?' · recibida '+shortDate(r.received_at):''}</p>`:''}
    <div class="field"><label for="prTitle">Qué hay que comprar</label><input id="prTitle" maxlength="300" value="${esc(r.title)}" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.titulo" data-feedback-label="Qué hay que comprar"></div>
    ${r.item_id?`<p class="small muted" id="prItem">Del inventario: <strong>${esc(inventoryItemName(r.item_id)||'artículo de Recursos')}</strong>. Al recibirla, entra en el almacén.</p>`:''}
    <div class="row"><div class="field"><label for="prQuantity">Cantidad</label><input id="prQuantity" type="number" min="0" step="any" inputmode="decimal" value="${r.quantity??''}" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.cantidad" data-feedback-label="Cantidad"></div><div class="field"><label for="prUnit">Unidad</label><input id="prUnit" maxlength="20" placeholder="ud, l, kg…" value="${esc(r.unit||'')}" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.unidad" data-feedback-label="Unidad"></div></div>
    <div class="field"><label for="prProject">Para</label><select id="prProject" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.para" data-feedback-label="Para"><option value="">El área en general</option>${projects.map(p=>`<option value="${p.id}" ${p.id===r.project_id?'selected':''}>${esc(p.title)}</option>`).join('')}</select></div>
    <div class="field"><label for="prSupplier">Proveedor</label>${supplierInput('prSupplier',r.supplier_name,r.supplier_id,!editable)}</div>
    <div class="row"><div class="field"><label for="prAmount">Importe estimado (€)</label><input id="prAmount" type="number" min="0" step="0.01" inputmode="decimal" value="${r.estimated_amount??''}" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.importe" data-feedback-label="Importe estimado"></div><div class="field"><label for="prDue">Para cuándo</label><input id="prDue" type="date" value="${esc(r.due||'')}" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.fecha" data-feedback-label="Para cuándo"></div></div>
    <div class="row"><div class="field"><label for="prPriority">Urgencia</label><select id="prPriority" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.urgencia" data-feedback-label="Urgencia"><option value="normal">Normal</option><option value="high">Alta</option><option value="critical">Crítica</option></select></div><div class="field"><label for="prRepeat">Repetir cada (días)</label><input id="prRepeat" type="number" min="1" max="366" step="1" placeholder="No se repite" value="${r.repeat_days??''}" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.repetir" data-feedback-label="Repetir cada (días)"></div></div>
    <label class="checkline"><input type="checkbox" id="prInvoice" ${r.needs_invoice?'checked':''} ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.factura" data-feedback-label="Llegará factura"> Llegará factura</label>
    <div class="field"><label for="prNote">Nota</label><textarea id="prNote" ${editable?'':'disabled'} data-feedback-id="tasks.solicitud.campos.nota" data-feedback-label="Nota">${esc(r.note||'')}</textarea></div>
    ${id?invoiceSection(r):''}
    <div class="actions" style="flex-wrap:wrap">
      ${editable?`<button class="primary" id="prSave" type="button" data-feedback-id="tasks.solicitud.guardar" data-feedback-label="Guardar">${id?'Guardar':'Pedir'}</button>`:''}
      ${approve&&r.status==='requested'?'<button class="primary" id="prApprove" type="button" data-feedback-id="tasks.solicitud.aprobar" data-feedback-label="Aprobar">Aprobar</button><button class="danger" id="prReject" type="button" data-feedback-id="tasks.solicitud.rechazar" data-feedback-label="Rechazar">Rechazar</button>':''}
      ${id&&canEdit()&&r.status==='approved'?'<button class="softbtn" id="prPurchased" type="button" data-feedback-id="tasks.solicitud.marcar_comprada" data-feedback-label="Marcar comprada">Marcar comprada</button>':''}
      ${id&&canEdit()&&r.status==='purchased'?'<button class="softbtn" id="prReceive" type="button" data-feedback-id="tasks.solicitud.recibida" data-feedback-label="Recibida">Recibida</button>':''}
      ${id&&canEdit()&&r.status==='purchased'?(purchaseInvoiced(r.id)?'<p class="small muted" id="prInvoiced">Ya está ligada a una factura: corrígelo en Finance.</p>':'<button class="ghost" id="prUndoPurchase" type="button" data-feedback-id="tasks.solicitud.no_se_compro" data-feedback-label="No se compró">No se compró</button>'):''}
      ${id&&canEdit()&&r.status==='received'&&r.repeat_days?'<button class="softbtn" id="prNext" type="button" data-feedback-id="tasks.solicitud.pedir_siguiente" data-feedback-label="Pedir la siguiente">Pedir la siguiente</button>':''}
      ${id&&canEdit()&&!['purchased','received'].includes(r.status)?'<button class="ghost danger-text" id="prDelete" type="button" data-feedback-id="tasks.solicitud.papelera" data-feedback-label="Papelera">Papelera</button>':''}
    </div>`);
  document.getElementById('prPriority').value=r.priority||'normal';bindSupplierInput('prSupplier');
  const P=IkisaiTasks.purchases,val=()=>{const n=id=>{const v=document.getElementById(id).value.trim();return v===''?null:Number(v)};return {title:document.getElementById('prTitle').value.trim(),quantity:n('prQuantity'),unit:document.getElementById('prUnit').value.trim()||null,project_id:document.getElementById('prProject').value||null,...supplierValue('prSupplier'),estimated_amount:n('prAmount'),due:document.getElementById('prDue').value||null,priority:document.getElementById('prPriority').value,repeat_days:n('prRepeat'),needs_invoice:document.getElementById('prInvoice').checked,note:document.getElementById('prNote').value}};
  const on=(sel,fn)=>{const b=document.getElementById(sel);if(b)b.onclick=fn};
  on('prSave',()=>{const v=val();if(!v.title)return toast('Escribe qué hay que comprar.');
    if(!id){if(purchaseRun(d=>P.requestPurchaseOps(d,{tab_id:tab().id,item_id:preset.item_id||null,...v}),canApprovePurchases()?'Pedido.':'Pedido. Lo verá '+approverName(tab().id)+'.'))closeSheet();return}
    const fields=Object.fromEntries(Object.entries(v).filter(([k,x])=>JSON.stringify(x??null)!==JSON.stringify(r[k]??null)));
    if(!Object.keys(fields).length)return closeSheet();
    if(purchaseCommit([{op:'update',table:'tasks.purchase_requests',id,expectedRevision:r.revision,fields}],'Guardado.'))closeSheet()});
  on('prApprove',()=>{if(purchaseRun(d=>P.setPurchaseStatusOps(d,id,'approved'),'Aprobada.')){usage.track('tasks.compras.aprobar');closeSheet()}});
  on('prReject',()=>{if(purchaseRun(d=>P.setPurchaseStatusOps(d,id,'rejected'),'Rechazada.'))closeSheet()});
  on('prPurchased',()=>{if(purchaseRun(d=>P.setPurchaseStatusOps(d,id,'purchased'),'Marcada como comprada.'))closeSheet()});
  on('prReceive',()=>receivePurchase(r));
  on('prUndoPurchase',()=>undoPurchase(r.id));
  on('prNext',()=>{if(purchaseRun(d=>P.nextRecurringOps(d,id),'Pedida la siguiente.'))closeSheet()});
  on('prDelete',()=>{if(purchaseCommit([{op:'delete',table:'tasks.purchase_requests',id,expectedRevision:r.revision}],'Enviada a la papelera.'))closeSheet()});
}
/* «No se compró» (0337, a petición de VG): la compra marcada por error vuelve a aprobada, al momento y con «Deshacer». Si
   su plan ya estaba terminado sale de él, para poder entrar en otro. */
function undoPurchase(id){const before=liveRows('tasks.purchase_requests').find(x=>x.id===id);if(!before)return;
  if(!purchaseRun(d=>IkisaiTasks.purchases.undoPurchaseOps(d,id,{invoiced:purchaseInvoiced(id)})))return;
  closeSheet();usage.track('tasks.compras.no_se_compro');
  const left=before.plan_stop_id&&!liveRows('tasks.purchase_requests').find(x=>x.id===id)?.plan_stop_id;
  offerLocalUndo(left?'Vuelve a estar aprobada, fuera del plan.':'Vuelve a estar aprobada.',()=>{const now=liveRows('tasks.purchase_requests').find(x=>x.id===id);if(!now||now.status!=='approved')return;
    purchaseCommit([{op:'update',table:'tasks.purchase_requests',id,expectedRevision:now.revision,fields:{status:'purchased',plan_stop_id:before.plan_stop_id}}],'Vuelve a estar comprada.')})}
function inventoryItemName(id){return Sync.core?.inventory?.items.find(i=>i.id===id)?.name||''}
/* Recibir (R6): si la solicitud es de un artículo con cantidad, su entrada en Recursos va primero, en el sitio habitual del
   artículo o en el que se elija aquí; después la solicitud pasa a recibida. Con repetición, pregunta por la siguiente. */
async function receivePurchase(r){const entry=!!r.item_id&&Number(r.quantity)>0;let item=Sync.core?.inventory?.items.find(i=>i.id===r.item_id);
  // El artículo puede ser más nuevo que la copia de este dispositivo: con red, se pone al día antes de decidir el sitio.
  if(entry&&!item&&Sync.core?.resources&&navigator.onLine){try{await Sync.core.resources.sync();item=(await Sync.core.resources.list('resources.items')).find(i=>i.id===r.item_id)}catch{}}
  if(entry&&!item?.default_space_id)return receiptSpaceSheet(r);
  finishReceive(r,entry?item.default_space_id:null)}
function receiptSpaceSheet(r){const rows=(typeof spaceRows==='function'?spaceRows():[]).filter(s=>s.active!==false);
  openSheet(`<h2 class="sheettitle">¿Dónde se guarda?</h2><p class="small">«${esc(r.title)}» entra en el inventario de la casa. Su artículo no tiene sitio habitual: elige dónde se guarda.</p>
    <div class="field"><label for="receiptSpace">Sitio</label><select id="receiptSpace" data-feedback-id="tasks.solicitud.recibir.sitio" data-feedback-label="Sitio"><option value="">Elige un sitio…</option>${rows.map(s=>`<option value="${esc(s.id)}">${esc(spaceShort(s.id)||s.name)}</option>`).join('')}</select></div>
    <div class="actions"><button class="primary" id="receiptSave" type="button" data-feedback-id="tasks.solicitud.recibir.guardar" data-feedback-label="Recibida">Recibida</button><button class="ghost" id="receiptCancel" type="button" data-feedback-id="tasks.solicitud.recibir.cancelar" data-feedback-label="Cancelar">Cancelar</button></div>`);
  document.getElementById('receiptCancel').onclick=()=>closeSheet();
  document.getElementById('receiptSave').onclick=()=>{const space=document.getElementById('receiptSpace').value;if(!space)return toast('Elige dónde se guarda.');finishReceive(r,space)}}
/* Orden inverso de R4: si la factura de esta compra ya se validó en Finance, su entrada en Recursos se cuadra ahora (lo
   pide tasks-api, una vez que «Recibida» está en el servidor). Un fallo no deshace la recepción: se anota y sigue. */
async function reconcileReceipt(id){if(!navigator.onLine||!Sync.core)return;
  try{await Sync.chain;await Sync.core.settle?.();await api('purchases/reconcile',{method:'POST',body:JSON.stringify({requestIds:[id]})});await Sync.core.resources?.sync()}
  catch(e){console.warn('Cuadre con Finance pendiente',e)}}
async function finishReceive(r,spaceId){let entered=false;
  try{entered=await Sync.core.recordReceipt(r.id,spaceId)}catch(e){return toast(e.message||'No se pudo apuntar la entrada en el inventario.')}
  const P=IkisaiTasks.purchases,ok=purchaseRun(d=>P.receivePurchaseOps(d,r.id),entered?'Recibida y sumada al almacén.':'Recibida.');if(!ok)return;usage.track('tasks.compras.recibir');reconcileReceipt(r.id);
  if(!r.repeat_days)return closeSheet();
  openSheet(`<h2 class="sheettitle">Compra recurrente</h2><p>«${esc(r.title)}» se repite cada ${r.repeat_days} días. ¿Pides ya la siguiente?</p><div class="actions"><button class="primary" id="prNextNow" type="button" data-feedback-id="tasks.solicitud.recurrente.pedir_siguiente" data-feedback-label="Pedir la siguiente">Pedir la siguiente</button><button class="ghost" id="prNextLater" type="button" data-feedback-id="tasks.solicitud.recurrente.ahora_no" data-feedback-label="Ahora no">Ahora no</button></div>`);
  document.getElementById('prNextNow').onclick=()=>{if(purchaseRun(d=>P.nextRecurringOps(d,r.id),'Pedida la siguiente.'))closeSheet()};document.getElementById('prNextLater').onclick=()=>closeSheet()}
function planSheet(id){const plan=liveRows('tasks.purchase_plans').find(p=>p.id===id);if(!plan)return;
  const stops=liveRows('tasks.purchase_plan_stops').filter(s=>s.plan_id===id).sort((a,b)=>(a.position||0)-(b.position||0)),requests=liveRows('tasks.purchase_requests');
  const editable=plan.status!=='done'&&canEdit();
  openSheet(`<h2 class="sheettitle">${esc(plan.title)}</h2><p class="purchasearea"><span class="pstate ${plan.status==='done'?'':'pending'}">${PLAN_STATUS[plan.status]}</span>${plan.planned_for?' · '+shortDate(plan.planned_for):''} · hoja de ruta en el orden de visita</p>
    <ol class="routelist">${stops.map((s,i)=>{const items=requests.filter(r=>r.plan_stop_id===s.id);return `<li class="pcard" data-stop="${s.id}"><div class="phead"><strong>${i+1}. ${esc(s.supplier_name)}</strong>${editable?`<button class="iconbtn small" data-stop-move="${s.id}|-1" aria-label="Antes" type="button" ${i===0?'disabled':''} data-feedback-id="tasks.plan.paradas.subir" data-feedback-label="Antes">↑</button><button class="iconbtn small" data-stop-move="${s.id}|1" aria-label="Después" type="button" ${i===stops.length-1?'disabled':''} data-feedback-id="tasks.plan.paradas.bajar" data-feedback-label="Después">↓</button>`:''}</div>
      ${items.map(r=>`<label class="pline"><input type="checkbox" data-route-item="${r.id}" ${['purchased','received'].includes(r.status)?'checked':''} ${editable&&r.status!=='received'&&!(r.status==='purchased'&&purchaseInvoiced(r.id))?'':'disabled'} ${r.status==='purchased'&&purchaseInvoiced(r.id)?'title="Ya está ligada a una factura: corrígelo en Finance."':''} data-feedback-id="tasks.plan.paradas.comprado" data-feedback-label="Comprado"><span>${esc(r.title)}</span><span class="pqty">${qty(r.quantity,r.unit)}</span></label>`).join('')||'<p class="small muted">Sin nada que comprar aquí.</p>'}</li>`}).join('')}</ol>
    <div class="actions" style="flex-wrap:wrap"><button class="softbtn" id="planPrint" type="button" data-feedback-id="tasks.plan.imprimir" data-feedback-label="Imprimir">Imprimir</button>${editable&&plan.status==='draft'?'<button class="primary" id="planShop" type="button" data-feedback-id="tasks.plan.salir_compras" data-feedback-label="Salir de compras">Salir de compras</button>':''}${editable?'<button class="primary" id="planDone" type="button" data-feedback-id="tasks.plan.terminar" data-feedback-label="Terminar">Terminar</button>':''}${plan.status==='done'&&canEdit()?'<button class="softbtn" id="planReopen" type="button" data-feedback-id="tasks.plan.reabrir" data-feedback-label="Reabrir el plan">Reabrir el plan</button>':''}${editable?'<button class="ghost danger-text" id="planDelete" type="button" data-feedback-id="tasks.plan.quitar" data-feedback-label="Quitar plan">Quitar plan</button>':''}</div>`);
  const commitPlan=(fields,msg)=>purchaseCommit([{op:'update',table:'tasks.purchase_plans',id,expectedRevision:plan.revision,fields}],msg);
  document.querySelectorAll('[data-route-item]').forEach(box=>box.onchange=()=>{const ok=purchaseRun(d=>IkisaiTasks.purchases.setPurchaseStatusOps(d,box.dataset.routeItem,box.checked?'purchased':'approved'));if(ok)planSheet(id)});
  document.querySelectorAll('[data-stop-move]').forEach(b=>b.onclick=()=>{const [stopId,dir]=b.dataset.stopMove.split('|'),i=stops.findIndex(s=>s.id===stopId),j=i+Number(dir);if(j<0||j>=stops.length)return;
    const a=stops[i],c=stops[j];if(purchaseCommit([{op:'update',table:'tasks.purchase_plan_stops',id:a.id,expectedRevision:a.revision,fields:{position:c.position}},{op:'update',table:'tasks.purchase_plan_stops',id:c.id,expectedRevision:c.revision,fields:{position:a.position}}]))planSheet(id)});
  const on=(sel,fn)=>{const b=document.getElementById(sel);if(b)b.onclick=fn};
  on('planShop',()=>{if(commitPlan({status:'shopping'},'¡A comprar!'))planSheet(id)});
  on('planDone',()=>{if(commitPlan({status:'done'},'Plan terminado.'))closeSheet()});
  // Reabrir (0337): un plan terminado por error vuelve a «De compras» y sus casillas se pueden volver a desmarcar.
  on('planReopen',()=>{if(commitPlan({status:'shopping'},'Plan reabierto.'))planSheet(id)});
  on('planDelete',()=>{if(purchaseRun(d=>IkisaiTasks.purchases.deletePlanOps(d,id),'Plan quitado; sus solicitudes vuelven a estar sin plan.'))closeSheet()});
  on('planPrint',()=>printRoute(plan,stops,requests));
}
/* Hoja de ruta imprimible: una página aparte con la lista por proveedor y casillas para marcar a mano. */
function printRoute(plan,stops,requests){const w=window.open('','_blank');if(!w)return toast('El navegador ha bloqueado la ventana de impresión.');
  w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(plan.title)}</title><style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#222}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:18px 0 6px;border-bottom:1px solid #999}li{list-style:none;margin:6px 0}li:before{content:'☐  '}small{color:#666}</style></head><body><h1>${esc(plan.title)}</h1><small>${esc(tab().name)}${plan.planned_for?' · '+esc(shortDate(plan.planned_for)):''}</small>
    ${stops.map((s,i)=>`<h2>${i+1}. ${esc(s.supplier_name)}</h2><ul style="padding:0">${requests.filter(r=>r.plan_stop_id===s.id).map(r=>`<li>${esc(r.title)} <small>${esc(qty(r.quantity,r.unit))}</small></li>`).join('')}</ul>`).join('')}</body></html>`);
  w.document.close();w.focus();w.print()}

/* Responsable de compras en el editor de área: una cuenta con el área entera (solo la propietaria lo elige). */
const manageTabBeforePurchases=manageTab;
manageTab=function(id=state.activeTab){manageTabBeforePurchases(id);const sheet=document.getElementById('sheet'),actions=sheet?.querySelector('.actions');if(!actions||!sheet.querySelector('#saveTabName')||!Sync.core)return;
  const row=purchasesData()['tasks.tabs'].find(t=>t.id===id);if(!row)return;
  const people=(Sync.members||[]).filter(m=>['editor','owner'].includes(m.role)&&(m.scopes==null||m.scopes==='*'||Array.isArray(m.scopes)&&m.scopes.includes(id)||Array.isArray(m.scopes?.tabs)&&m.scopes.tabs.includes(id)));
  actions.insertAdjacentHTML('beforebegin',`<div class="field"><label for="tabApprover">Responsable de compras</label><select id="tabApprover" data-feedback-id="tasks.editar_area.responsable_compras" data-feedback-label="Responsable de compras"><option value="">La propietaria</option>${people.map(m=>`<option value="${m.userId}" ${m.userId===row.purchase_approver_id?'selected':''} data-feedback-ignore>${esc(m.displayName||'Sin nombre')}</option>`).join('')}</select><p class="small muted">Aprueba o rechaza las solicitudes de compra de esta área.</p></div>`);
  document.getElementById('tabApprover').onchange=e=>{const value=e.target.value||null,current=purchasesData()['tasks.tabs'].find(t=>t.id===id);if(!current||value===(current.purchase_approver_id||null))return;
    purchaseCommit([{op:'update',table:'tasks.tabs',id,expectedRevision:current.revision,fields:{purchase_approver_id:value}}],'Responsable de compras guardado.')}};

/* --- Enlaces ------------------------------------------------------------------------------------------------------- */
const bindBeforePurchases=bind;
bind=function(){bindBeforePurchases();
  const on=(sel,fn)=>document.querySelectorAll(sel).forEach(fn);
  const np=document.getElementById('newPurchase');if(np)np.onclick=()=>purchaseSheet();
  const pp=document.getElementById('preparePlan');if(pp)pp.onclick=()=>{const title='Compra del '+new Date().toLocaleDateString('es-ES',{day:'numeric',month:'long'});if(purchaseRun(d=>IkisaiTasks.purchases.preparePlanOps(d,{tab_id:tab().id,title,today:today()}),'Plan preparado.'))usage.track('tasks.planes.preparar')};
  const tr=document.getElementById('toggleRejectedPurchases');if(tr)tr.onclick=()=>{showRejectedPurchases=!showRejectedPurchases;render()};
  document.querySelectorAll('[data-purchase-grouping]').forEach(b=>b.onclick=()=>{purchaseGrouping=b.dataset.purchaseGrouping;try{localStorage.setItem('tasks.purchases.grouping',purchaseGrouping)}catch{}render()});
  on('[data-purchase]',b=>b.onclick=()=>purchaseSheet(b.dataset.purchase));
  mountSuppliesCatalog();
  on('[data-plan]',b=>b.onclick=()=>planSheet(b.dataset.plan));
  on('[data-open-supplies]',b=>b.onclick=()=>navigateView('supplies'));
};
