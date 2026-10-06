/* Compras no alimentarias (docs/tasks/API.md §18): solicitudes de compra con aprobación del responsable de compras del
   área, suministros con stock por movimientos («Queda poco: pedir») y planes de compra por proveedor con hoja de ruta.
   Las filas salen del modelo del núcleo (Sync.core.data: no forman parte del modelo anidado de tareas) y los cambios son
   operaciones del dominio (IkisaiTasks.purchases) que se confirman por el mismo camino que save(). */
const PURCHASE_VIEWS=['purchases','supplies','plans'];
const PURCHASE_STATUS={requested:['Pedida','pending'],approved:['Aprobada','ok'],purchased:['Comprada','ok'],received:['Recibida','ok'],rejected:['Rechazada','trash']};
const SUPPLY_CATEGORY={cleaning:'Limpieza',pool:'Piscina',maintenance:'Mantenimiento',textile:'Textil',other:'Otros'};
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
function listenPurchases(){if(purchaseListening||!Sync.core)return;purchaseListening=true;Sync.core.onChange(kind=>{if(kind==='data'&&PURCHASE_VIEWS.includes(state.view)&&!document.getElementById('sheetBack')?.classList.contains('show'))render()})}

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
function invoiceCodes(id){return [...new Set((purchaseInvoices.get(id)||[]).map(x=>x.invoice_code).filter(Boolean))]}
function invoiceSection(r){if(!r.needs_invoice||!['approved','purchased','received'].includes(r.status)||!purchaseInvoices.has(r.id))return '';const list=purchaseInvoices.get(r.id);
  if(!list.length)return r.status==='approved'?'':'<p class="pmeta pinvoices">Sin factura asignada todavía en Finance.</p>';
  return `<div class="pinvoices"><span class="pmeta">Facturas en Finance</span>${list.map(x=>`<a class="pinvoice" href="${FINANCE_INVOICE_URL}${encodeURIComponent(x.invoice_code)}" target="_blank" rel="noopener">${esc(x.invoice_code)}${x.invoice_date?' · '+esc(shortDate(x.invoice_date)):''}${x.allocated_amount!=null?' · '+esc(money(Number(x.allocated_amount))):''}</a>`).join('')}</div>`}
const supplierCache=new Map(),supplierKnown=new Map();
function supplierInput(id,name,supplierId,disabled){return `<input id="${id}" maxlength="200" placeholder="Opcional" list="${id}List" autocomplete="off" value="${esc(name||'')}" data-supplier-id="${esc(supplierId||'')}" data-initial="${esc(name||'')}" ${disabled?'disabled':''}><datalist id="${id}List"></datalist>`}
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

/* --- Vistas -------------------------------------------------------------------------------------------------------- */
function purchaseAreaNote(){return generalMode()?'<div class="notice">Elige un área en la tira de arriba: las compras se llevan por área.</div>':''}
function purchaseRow(r){const [label,tone]=PURCHASE_STATUS[r.status]||[r.status,''];const project=r.project_id?tab().projects.find(p=>p.id===r.project_id)?.title:'';
  const meta=[qty(r.quantity,r.unit),r.supplier_name,project,r.due?'para el '+shortDate(r.due):'',r.repeat_days?`cada ${r.repeat_days} días`:'',invoiceCodes(r.id).length?'Factura '+invoiceCodes(r.id).join(', '):''].filter(Boolean).join(' · ');
  return `<button type="button" class="pcard" data-purchase="${r.id}"><span class="phead">${r.priority!=='normal'?priorityStar(r.priority):''}<strong>${esc(r.title)}</strong><span class="pstate ${tone}">${label}</span></span>${meta?`<span class="pmeta">${esc(meta)}</span>`:''}</button>`}
let showRejectedPurchases=false;
function purchasesView(){listenPurchases();if(generalMode()||!tab())return `<main class="screen"><h1 class="title">Solicitudes de compra</h1>${purchaseAreaNote()}</main>`;
  const all=liveRows('tasks.purchase_requests').filter(r=>r.tab_id===tab().id).sort((a,b)=>(a.position||0)-(b.position||0));
  const open=all.filter(r=>['requested','approved','purchased'].includes(r.status)).length;
  loadPurchaseInvoices(all.filter(r=>r.needs_invoice&&['approved','purchased','received'].includes(r.status)).map(r=>r.id));
  const section=(status,title,list)=>list.length?`<h2 class="sectionlabel">${title} <span class="count">${list.length}</span></h2>${list.map(purchaseRow).join('')}`:'';
  const received=all.filter(r=>r.status==='received').sort((a,b)=>(b.received_at||'').localeCompare(a.received_at||'')).slice(0,20),rejected=all.filter(r=>r.status==='rejected');
  return `<main class="screen purchases"><div class="screenhead"><div><h1 class="title">Solicitudes de compra</h1><p class="subtitle">${esc(tab().name)} · ${open} abiertas · ${purchaseApprover(tab().id)&&purchaseApprover(tab().id)===Sync.actor?.id?'apruebas tú':'aprueba '+esc(approverName(tab().id))}</p></div>${canEdit()?'<button class="primary" id="newPurchase" type="button">+ Pedir algo</button>':''}</div>
    ${all.length?'':'<div class="empty">Todavía no hay solicitudes. Pide aquí lo que haga falta comprar; quien aprueba lo verá.</div>'}
    ${section('requested','Pedidas',all.filter(r=>r.status==='requested'))}${section('approved','Aprobadas',all.filter(r=>r.status==='approved'))}${section('purchased','Compradas',all.filter(r=>r.status==='purchased'))}${section('received','Recibidas',received)}
    ${rejected.length?`<button class="ghost" id="toggleRejectedPurchases" type="button">${showRejectedPurchases?'Ocultar rechazadas':`Ver rechazadas (${rejected.length})`}</button>${showRejectedPurchases?rejected.map(purchaseRow).join(''):''}`:''}</main>`}
function suppliesView(){listenPurchases();if(generalMode()||!tab())return `<main class="screen"><h1 class="title">Suministros</h1>${purchaseAreaNote()}</main>`;
  if(!fullScope(tab().id))return `<main class="screen"><h1 class="title">Suministros</h1><div class="notice">El almacén es del área entera; tu acceso es a algunos proyectos.</div></main>`;
  const P=IkisaiTasks.purchases,data=purchasesData(),items=liveRows('tasks.supply_items').filter(s=>s.tab_id===tab().id&&!s.archived).sort((a,b)=>(a.position||0)-(b.position||0));
  const low=new Map(P.lowStock(data,tab().id).map(x=>[x.item.id,x]));
  const row=s=>{const stock=P.supplyStock(data,s.id),l=low.get(s.id);return `<div class="pcard supplyrow" data-supply-row="${s.id}"><button type="button" class="psupply" data-supply="${s.id}"><span class="phead"><strong>${esc(s.name)}</strong></span><span class="pmeta">${esc(SUPPLY_CATEGORY[s.category]||'')}${s.location?' · '+esc(s.location):''}</span></button>
      <div class="pactions"><span class="pstock ${l?'alert':''}" data-stock>${qty(stock,s.unit)}</span><span class="pmeta" style="margin:0">mínimo ${qty(s.min_quantity,s.unit)}</span><span class="pgrow"></span>
      ${l?(l.openRequest?'<span class="pstate pending">Pedido</span>':canEdit()?`<button class="softbtn small" data-reorder="${s.id}" type="button">Queda poco: pedir</button>`:'<span class="pstate alert">Queda poco</span>'):''}
      ${canEdit()?`<button class="ghost small" data-supply-move="${s.id}|out" type="button">Gastar</button><button class="ghost small" data-supply-move="${s.id}|in" type="button">Entrada</button><button class="ghost small" data-supply-move="${s.id}|count" type="button">Recontar</button>`:''}</div></div>`};
  return `<main class="screen supplies"><div class="screenhead"><div><h1 class="title">Suministros</h1><p class="subtitle">${esc(tab().name)} · ${items.length} en el almacén${low.size?` · ${low.size} con poco`:''}</p></div>${canEdit()?'<button class="primary" id="newSupply" type="button">+ Suministro</button>':''}</div>
    ${items.length?items.map(row).join(''):'<div class="empty">Añade lo que guardas (cloro, lejía, bombillas…) con su mínimo, y te avisará cuando quede poco.</div>'}</main>`}
function plansView(){listenPurchases();if(generalMode()||!tab())return `<main class="screen"><h1 class="title">Planes de compra</h1>${purchaseAreaNote()}</main>`;
  if(!fullScope(tab().id))return `<main class="screen"><h1 class="title">Planes de compra</h1><div class="notice">Los planes de compra son del área entera.</div></main>`;
  const plans=liveRows('tasks.purchase_plans').filter(p=>p.tab_id===tab().id).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
  const pending=liveRows('tasks.purchase_requests').filter(r=>r.tab_id===tab().id&&r.status==='approved'&&!r.plan_stop_id).length;
  const recurring=IkisaiTasks.purchases.dueRecurring(purchasesData(),tab().id,today()).length;
  return `<main class="screen plans"><div class="screenhead"><div><h1 class="title">Planes de compra</h1><p class="subtitle">${pending} aprobadas sin plan${recurring?` · ${recurring} recurrentes que tocan`:''}</p></div>${canApprovePurchases()?'<button class="primary" id="preparePlan" type="button">Preparar plan</button>':''}</div>
    ${canApprovePurchases()?'':`<p class="small muted">Prepara los planes ${esc(approverName(tab().id))}.</p>`}
    ${plans.length?plans.map(p=>`<button type="button" class="pcard" data-plan="${p.id}"><span class="phead"><strong>${esc(p.title)}</strong><span class="pstate ${p.status==='done'?'':'pending'}">${PLAN_STATUS[p.status]}</span></span><span class="pmeta">${p.planned_for?shortDate(p.planned_for)+' · ':''}${liveRows('tasks.purchase_plan_stops').filter(s=>s.plan_id===p.id).length} proveedores</span></button>`).join(''):'<div class="empty">Un plan reúne lo aprobado por proveedor, en el orden en que vas a pasar, con casillas para marcar al comprar.</div>'}</main>`}

const mainBeforePurchases=main;
main=function(){if(state.view==='purchases')return purchasesView();if(state.view==='supplies')return suppliesView();if(state.view==='plans')return plansView();
  const html=mainBeforePurchases();
  // Aviso en Inicio: suministros bajo mínimo del área.
  if(state.view==='home'&&tab()&&Sync.core&&fullScope(tab().id)){const n=IkisaiTasks.purchases.lowStock(purchasesData(),tab().id).length;if(n)return html.replace(/(<main[^>]*>)/,`$1<div class="notice lowstock">Queda poco de ${n} ${n===1?'suministro':'suministros'}. <button class="linkbtn" data-open-supplies type="button">Ver suministros</button></div>`)}
  return html};

/* --- Hojas --------------------------------------------------------------------------------------------------------- */
function purchaseSheet(id=null,preset={}){
  const r=id?liveRows('tasks.purchase_requests').find(x=>x.id===id):{title:'',note:'',quantity:null,unit:'',estimated_amount:null,priority:'normal',needs_invoice:true,repeat_days:null,due:'',supplier_name:'',project_id:null,...preset};
  if(!r)return;const editable=canEdit()&&(!id||['requested','approved'].includes(r.status)),approve=id&&canApprovePurchases(r.tab_id);
  const projects=tab().projects.filter(p=>!p.deleted&&p.status!=='archived');
  openSheet(`<h2 class="sheettitle">${id?'Solicitud de compra':'Pedir algo'}</h2>${id?`<p class="small">${esc((PURCHASE_STATUS[r.status]||[r.status])[0])}${r.approved_at?' · aprobada '+shortDate(r.approved_at):''}${r.purchased_at?' · comprada '+shortDate(r.purchased_at):''}${r.received_at?' · recibida '+shortDate(r.received_at):''}</p>`:''}
    <div class="field"><label for="prTitle">Qué hay que comprar</label><input id="prTitle" maxlength="300" value="${esc(r.title)}" ${editable?'':'disabled'}></div>
    <div class="row"><div class="field"><label for="prQuantity">Cantidad</label><input id="prQuantity" type="number" min="0" step="any" inputmode="decimal" value="${r.quantity??''}" ${editable?'':'disabled'}></div><div class="field"><label for="prUnit">Unidad</label><input id="prUnit" maxlength="20" placeholder="ud, l, kg…" value="${esc(r.unit||'')}" ${editable?'':'disabled'}></div></div>
    <div class="field"><label for="prProject">Para</label><select id="prProject" ${editable?'':'disabled'}><option value="">El área en general</option>${projects.map(p=>`<option value="${p.id}" ${p.id===r.project_id?'selected':''}>${esc(p.title)}</option>`).join('')}</select></div>
    <div class="field"><label for="prSupplier">Proveedor</label>${supplierInput('prSupplier',r.supplier_name,r.supplier_id,!editable)}</div>
    <div class="row"><div class="field"><label for="prAmount">Importe estimado (€)</label><input id="prAmount" type="number" min="0" step="0.01" inputmode="decimal" value="${r.estimated_amount??''}" ${editable?'':'disabled'}></div><div class="field"><label for="prDue">Para cuándo</label><input id="prDue" type="date" value="${esc(r.due||'')}" ${editable?'':'disabled'}></div></div>
    <div class="row"><div class="field"><label for="prPriority">Urgencia</label><select id="prPriority" ${editable?'':'disabled'}><option value="normal">Normal</option><option value="high">Alta</option><option value="critical">Crítica</option></select></div><div class="field"><label for="prRepeat">Repetir cada (días)</label><input id="prRepeat" type="number" min="1" max="366" step="1" placeholder="No se repite" value="${r.repeat_days??''}" ${editable?'':'disabled'}></div></div>
    <label class="checkline"><input type="checkbox" id="prInvoice" ${r.needs_invoice?'checked':''} ${editable?'':'disabled'}> Llegará factura</label>
    <div class="field"><label for="prNote">Nota</label><textarea id="prNote" ${editable?'':'disabled'}>${esc(r.note||'')}</textarea></div>
    ${id?invoiceSection(r):''}
    <div class="actions" style="flex-wrap:wrap">
      ${editable?`<button class="primary" id="prSave" type="button">${id?'Guardar':'Pedir'}</button>`:''}
      ${approve&&r.status==='requested'?'<button class="primary" id="prApprove" type="button">Aprobar</button><button class="danger" id="prReject" type="button">Rechazar</button>':''}
      ${id&&canEdit()&&r.status==='approved'?'<button class="softbtn" id="prPurchased" type="button">Marcar comprada</button>':''}
      ${id&&canEdit()&&r.status==='purchased'?'<button class="softbtn" id="prReceive" type="button">Recibida</button>':''}
      ${id&&canEdit()&&r.status==='received'&&r.repeat_days?'<button class="softbtn" id="prNext" type="button">Pedir la siguiente</button>':''}
      ${id&&canEdit()&&!['purchased','received'].includes(r.status)?'<button class="ghost danger-text" id="prDelete" type="button">Papelera</button>':''}
    </div>`);
  document.getElementById('prPriority').value=r.priority||'normal';bindSupplierInput('prSupplier');
  const P=IkisaiTasks.purchases,val=()=>{const n=id=>{const v=document.getElementById(id).value.trim();return v===''?null:Number(v)};return {title:document.getElementById('prTitle').value.trim(),quantity:n('prQuantity'),unit:document.getElementById('prUnit').value.trim()||null,project_id:document.getElementById('prProject').value||null,...supplierValue('prSupplier'),estimated_amount:n('prAmount'),due:document.getElementById('prDue').value||null,priority:document.getElementById('prPriority').value,repeat_days:n('prRepeat'),needs_invoice:document.getElementById('prInvoice').checked,note:document.getElementById('prNote').value}};
  const on=(sel,fn)=>{const b=document.getElementById(sel);if(b)b.onclick=fn};
  on('prSave',()=>{const v=val();if(!v.title)return toast('Escribe qué hay que comprar.');
    if(!id){if(purchaseRun(d=>P.requestPurchaseOps(d,{tab_id:tab().id,supply_item_id:preset.supply_item_id||null,...v}),canApprovePurchases()?'Pedido.':'Pedido. Lo verá '+approverName(tab().id)+'.'))closeSheet();return}
    const fields=Object.fromEntries(Object.entries(v).filter(([k,x])=>JSON.stringify(x??null)!==JSON.stringify(r[k]??null)));
    if(!Object.keys(fields).length)return closeSheet();
    if(purchaseCommit([{op:'update',table:'tasks.purchase_requests',id,expectedRevision:r.revision,fields}],'Guardado.'))closeSheet()});
  on('prApprove',()=>{if(purchaseRun(d=>P.setPurchaseStatusOps(d,id,'approved'),'Aprobada.'))closeSheet()});
  on('prReject',()=>{if(purchaseRun(d=>P.setPurchaseStatusOps(d,id,'rejected'),'Rechazada.'))closeSheet()});
  on('prPurchased',()=>{if(purchaseRun(d=>P.setPurchaseStatusOps(d,id,'purchased'),'Marcada como comprada.'))closeSheet()});
  on('prReceive',()=>{const ok=purchaseRun(d=>P.receivePurchaseOps(d,id),r.supply_item_id?'Recibida y sumada al almacén.':'Recibida.');if(!ok)return;
    if(r.repeat_days){openSheet(`<h2 class="sheettitle">Compra recurrente</h2><p>«${esc(r.title)}» se repite cada ${r.repeat_days} días. ¿Pides ya la siguiente?</p><div class="actions"><button class="primary" id="prNextNow" type="button">Pedir la siguiente</button><button class="ghost" id="prNextLater" type="button">Ahora no</button></div>`);
      document.getElementById('prNextNow').onclick=()=>{if(purchaseRun(d=>P.nextRecurringOps(d,id),'Pedida la siguiente.'))closeSheet()};document.getElementById('prNextLater').onclick=()=>closeSheet()}else closeSheet()});
  on('prNext',()=>{if(purchaseRun(d=>P.nextRecurringOps(d,id),'Pedida la siguiente.'))closeSheet()});
  on('prDelete',()=>{if(purchaseCommit([{op:'delete',table:'tasks.purchase_requests',id,expectedRevision:r.revision}],'Enviada a la papelera.'))closeSheet()});
}
function supplySheet(id=null){
  const s=id?liveRows('tasks.supply_items').find(x=>x.id===id):{name:'',category:'other',unit:'ud',location:'',min_quantity:0,reorder_quantity:null,supplier_name:'',note:''};if(!s)return;
  const stock=id?IkisaiTasks.purchases.supplyStock(purchasesData(),id):null;
  openSheet(`<h2 class="sheettitle">${id?esc(s.name):'Nuevo suministro'}</h2>${id?`<p>En el almacén: <strong>${qty(stock,s.unit)}</strong> · mínimo ${qty(s.min_quantity,s.unit)}</p>`:''}
    <div class="field"><label for="suName">Nombre</label><input id="suName" maxlength="200" value="${esc(s.name)}"></div>
    <div class="row"><div class="field"><label for="suCategory">Tipo</label><select id="suCategory">${Object.entries(SUPPLY_CATEGORY).map(([k,v])=>`<option value="${k}" ${k===s.category?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label for="suUnit">Unidad</label><input id="suUnit" maxlength="20" value="${esc(s.unit)}"></div></div>
    <div class="field"><label for="suLocation">Dónde está</label><input id="suLocation" maxlength="200" placeholder="Almacén piscina" value="${esc(s.location||'')}"></div>
    <div class="row"><div class="field"><label for="suMin">Mínimo</label><input id="suMin" type="number" min="0" step="any" inputmode="decimal" value="${s.min_quantity??0}"></div><div class="field"><label for="suReorder">Al pedir, cuánto</label><input id="suReorder" type="number" min="0" step="any" inputmode="decimal" placeholder="Lo que falte" value="${s.reorder_quantity??''}"></div></div>
    <div class="field"><label for="suSupplier">Proveedor habitual</label>${supplierInput('suSupplier',s.supplier_name,s.supplier_id,false)}</div>
    <div class="actions"><button class="primary" id="suSave" type="button">Guardar</button>${id?'<button class="ghost danger-text" id="suDelete" type="button">Papelera</button>':''}</div>`);
  bindSupplierInput('suSupplier');
  const num=(el,blank=null)=>{const v=document.getElementById(el).value.trim();return v===''?blank:Number(v)};
  document.getElementById('suSave').onclick=()=>{const v={name:document.getElementById('suName').value.trim(),category:document.getElementById('suCategory').value,unit:document.getElementById('suUnit').value.trim()||'ud',location:document.getElementById('suLocation').value.trim(),min_quantity:num('suMin',0),reorder_quantity:num('suReorder'),...supplierValue('suSupplier')};
    if(!v.name)return toast('Pon un nombre.');
    if(!id){const items=liveRows('tasks.supply_items').filter(x=>x.tab_id===tab().id);if(purchaseCommit([{op:'insert',table:'tasks.supply_items',id:crypto.randomUUID(),fields:{tab_id:tab().id,...v,position:Math.max(0,...items.map(x=>Number(x.position)||0))+1024}}],'Suministro añadido.'))closeSheet();return}
    const fields=Object.fromEntries(Object.entries(v).filter(([k,x])=>JSON.stringify(x??null)!==JSON.stringify(s[k]??null)));if(!Object.keys(fields).length)return closeSheet();
    if(purchaseCommit([{op:'update',table:'tasks.supply_items',id,expectedRevision:s.revision,fields}],'Guardado.'))closeSheet()};
  const del=document.getElementById('suDelete');if(del)del.onclick=()=>{if(purchaseRun(d=>IkisaiTasks.purchases.deleteSupplyItemOps(d,id),'Suministro enviado a la papelera.'))closeSheet()};
}
function supplyMoveSheet(id,kind){const s=liveRows('tasks.supply_items').find(x=>x.id===id);if(!s)return;const stock=IkisaiTasks.purchases.supplyStock(purchasesData(),id);
  const title={out:'Gastar',in:'Entrada',count:'Recontar'}[kind],help={out:'¿Cuánto se ha gastado?',in:'¿Cuánto ha entrado?',count:'¿Cuánto hay ahora mismo?'}[kind];
  openSheet(`<h2 class="sheettitle">${title} · ${esc(s.name)}</h2><p class="small muted">Ahora: ${qty(stock,s.unit)}</p><div class="field"><label for="moveAmount">${help} (${esc(s.unit)})</label><input id="moveAmount" type="number" min="0" step="any" inputmode="decimal" value="${kind==='count'?stock:''}"></div><div class="field"><label for="moveNote">Nota</label><input id="moveNote" maxlength="200" placeholder="Opcional"></div><div class="actions"><button class="primary" id="moveSave" type="button">${title}</button></div>`);
  document.getElementById('moveAmount').focus();
  document.getElementById('moveSave').onclick=()=>{const amount=Number(document.getElementById('moveAmount').value);if(!Number.isFinite(amount)||amount<0||(kind!=='count'&&amount===0))return toast('Escribe una cantidad.');
    const ops=IkisaiTasks.purchases.supplyMovementOps(purchasesData(),id,{kind,amount,note:document.getElementById('moveNote').value.trim()});if(!ops.length){closeSheet();return toast('Sin cambios: coincide con lo que había.')}
    if(purchaseCommit(ops,'Apuntado.'))closeSheet()}}
function planSheet(id){const plan=liveRows('tasks.purchase_plans').find(p=>p.id===id);if(!plan)return;
  const stops=liveRows('tasks.purchase_plan_stops').filter(s=>s.plan_id===id).sort((a,b)=>(a.position||0)-(b.position||0)),requests=liveRows('tasks.purchase_requests');
  const editable=plan.status!=='done'&&canEdit();
  openSheet(`<h2 class="sheettitle">${esc(plan.title)}</h2><p class="purchasearea"><span class="pstate ${plan.status==='done'?'':'pending'}">${PLAN_STATUS[plan.status]}</span>${plan.planned_for?' · '+shortDate(plan.planned_for):''} · hoja de ruta en el orden de visita</p>
    <ol class="routelist">${stops.map((s,i)=>{const items=requests.filter(r=>r.plan_stop_id===s.id);return `<li class="pcard" data-stop="${s.id}"><div class="phead"><strong>${i+1}. ${esc(s.supplier_name)}</strong>${editable?`<button class="iconbtn small" data-stop-move="${s.id}|-1" aria-label="Antes" type="button" ${i===0?'disabled':''}>↑</button><button class="iconbtn small" data-stop-move="${s.id}|1" aria-label="Después" type="button" ${i===stops.length-1?'disabled':''}>↓</button>`:''}</div>
      ${items.map(r=>`<label class="pline"><input type="checkbox" data-route-item="${r.id}" ${['purchased','received'].includes(r.status)?'checked':''} ${editable&&r.status!=='received'?'':'disabled'}><span>${esc(r.title)}</span><span class="pqty">${qty(r.quantity,r.unit)}</span></label>`).join('')||'<p class="small muted">Sin nada que comprar aquí.</p>'}</li>`}).join('')}</ol>
    <div class="actions" style="flex-wrap:wrap"><button class="softbtn" id="planPrint" type="button">Imprimir</button>${editable&&plan.status==='draft'?'<button class="primary" id="planShop" type="button">Salir de compras</button>':''}${editable?'<button class="primary" id="planDone" type="button">Terminar</button>':''}${editable?'<button class="ghost danger-text" id="planDelete" type="button">Quitar plan</button>':''}</div>`);
  const commitPlan=(fields,msg)=>purchaseCommit([{op:'update',table:'tasks.purchase_plans',id,expectedRevision:plan.revision,fields}],msg);
  document.querySelectorAll('[data-route-item]').forEach(box=>box.onchange=()=>{const ok=purchaseRun(d=>IkisaiTasks.purchases.setPurchaseStatusOps(d,box.dataset.routeItem,box.checked?'purchased':'approved'));if(ok)planSheet(id)});
  document.querySelectorAll('[data-stop-move]').forEach(b=>b.onclick=()=>{const [stopId,dir]=b.dataset.stopMove.split('|'),i=stops.findIndex(s=>s.id===stopId),j=i+Number(dir);if(j<0||j>=stops.length)return;
    const a=stops[i],c=stops[j];if(purchaseCommit([{op:'update',table:'tasks.purchase_plan_stops',id:a.id,expectedRevision:a.revision,fields:{position:c.position}},{op:'update',table:'tasks.purchase_plan_stops',id:c.id,expectedRevision:c.revision,fields:{position:a.position}}]))planSheet(id)});
  const on=(sel,fn)=>{const b=document.getElementById(sel);if(b)b.onclick=fn};
  on('planShop',()=>{if(commitPlan({status:'shopping'},'¡A comprar!'))planSheet(id)});
  on('planDone',()=>{if(commitPlan({status:'done'},'Plan terminado.'))closeSheet()});
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
  actions.insertAdjacentHTML('beforebegin',`<div class="field"><label for="tabApprover">Responsable de compras</label><select id="tabApprover"><option value="">La propietaria</option>${people.map(m=>`<option value="${m.userId}" ${m.userId===row.purchase_approver_id?'selected':''}>${esc(m.displayName||'Sin nombre')}</option>`).join('')}</select><p class="small muted">Aprueba o rechaza las solicitudes de compra de esta área.</p></div>`);
  document.getElementById('tabApprover').onchange=e=>{const value=e.target.value||null,current=purchasesData()['tasks.tabs'].find(t=>t.id===id);if(!current||value===(current.purchase_approver_id||null))return;
    purchaseCommit([{op:'update',table:'tasks.tabs',id,expectedRevision:current.revision,fields:{purchase_approver_id:value}}],'Responsable de compras guardado.')}};

/* --- Enlaces ------------------------------------------------------------------------------------------------------- */
const bindBeforePurchases=bind;
bind=function(){bindBeforePurchases();
  const on=(sel,fn)=>document.querySelectorAll(sel).forEach(fn);
  const np=document.getElementById('newPurchase');if(np)np.onclick=()=>purchaseSheet();
  const ns=document.getElementById('newSupply');if(ns)ns.onclick=()=>supplySheet();
  const pp=document.getElementById('preparePlan');if(pp)pp.onclick=()=>{const title='Compra del '+new Date().toLocaleDateString('es-ES',{day:'numeric',month:'long'});purchaseRun(d=>IkisaiTasks.purchases.preparePlanOps(d,{tab_id:tab().id,title,today:today()}),'Plan preparado.')};
  const tr=document.getElementById('toggleRejectedPurchases');if(tr)tr.onclick=()=>{showRejectedPurchases=!showRejectedPurchases;render()};
  on('[data-purchase]',b=>b.onclick=()=>purchaseSheet(b.dataset.purchase));
  on('[data-supply]',b=>b.onclick=()=>supplySheet(b.dataset.supply));
  on('[data-supply-move]',b=>b.onclick=()=>{const [id,kind]=b.dataset.supplyMove.split('|');supplyMoveSheet(id,kind)});
  on('[data-reorder]',b=>b.onclick=()=>{const id=b.dataset.reorder,s=liveRows('tasks.supply_items').find(x=>x.id===id),ops=IkisaiTasks.purchases.reorderSupplyOps(purchasesData(),id);purchaseSheet(null,{...ops[0].fields,supply_item_id:id,title:s?.name||ops[0].fields.title})});
  on('[data-plan]',b=>b.onclick=()=>planSheet(b.dataset.plan));
  on('[data-open-supplies]',b=>b.onclick=()=>navigateView('supplies'));
};
