/* Compras R6 «Estantería» (MUELA-094, tanda 40; docs/tasks/API.md §18.10). Capa sobre purchases-ui.js: quitarla devuelve
   las pantallas de hoy, que no se borran (purchasesView, suppliesView, plansView y la hoja de siempre).
   - Solicitudes: una estantería por tienda (createShelves del kit) con baldosas de varios mandos (renderTile): tocar = lo
     siguiente (aprobar → comprada → ha llegado), «⋯» o pulsación larga = más, el envase dibujado (Envase del kit) y el
     cuadre con Finance. Recibir desde la baldosa pide una confirmación corta (decisión de VG: una entrada no se borra).
   - Suministros: una estantería por sitio con el nivel dentro; tocar = −1 con «Deshacer» (el movimiento contrario).
   - Planes: «Lo que entrará al preparar» (con las recurrentes que tocan) y cada plan plegable con sus paradas.
   - Recibir: entra el envase entero (lo calcula el dominio, receiptPlan) y el aviso lo dice. El cuadre con Finance se ve
     en la baldosa, en «En casa», en el aviso y en la hoja; si falla o no hay red, se apunta en una cola del dispositivo y se
     reintenta al volver la red («Reintentar», a mano).
   Prefijo de clases e identificadores: tcr-. */
const TCR_KEEP='al almacén',TCR_WHERE='en el inventario',TCR_QUEUE_KEY='tasks.compras.cuadre_pendiente';
const tcrKit=()=>IkisaiKit,tcrEnv=()=>IkisaiKit.Envase,tcrP=()=>IkisaiTasks.purchases;
const tcrEuro=n=>n==null?'':Number(n).toLocaleString('es-ES',{style:'currency',currency:'EUR'});
const tcrPlural=(n,one,many)=>`${Number(n).toLocaleString('es-ES')} ${n===1?one:many}`;
const tcrNum=n=>Number(n).toLocaleString('es-ES',{maximumFractionDigits:3});
function tcrMoney(){return typeof canSeeCosts==='function'&&!!tab()&&canSeeCosts(tab().id)}
function tcrInv(){return Sync.core?.inventory||{items:[],movements:[],units:[]}}
function tcrItem(id){return id?tcrInv().items.find(i=>i.id===id)||null:null}
function tcrStock(id){return tcrP().itemStock(tcrInv().movements,id)}
function tcrFormats(itemId){return (tcrInv().units||[]).filter(u=>u.item_id===itemId&&!u.deleted_at&&Number(u.factor)>0)}
const tcrEnvUnit=u=>({ud:'unidad',u:'unidad',uds:'unidad',unidades:'unidad'}[String(u||'').trim().toLowerCase()]||u||'unidad');
const tcrRequests=()=>liveRows('tasks.purchase_requests').filter(r=>r.tab_id===tab()?.id);
const tcrRow=id=>liveRows('tasks.purchase_requests').find(r=>r.id===id)||null;
function tcrSupplierOf(r){return r.supplier_name?.trim()||supplierNameOf(r.supplier_id)||'Sin tienda'}

/* --- El envase de una solicitud: el mismo cálculo que hace el dominio al recibir ------------------------------------ */
function tcrPack(r){const it=tcrItem(r.item_id),E=tcrEnv();let rp=null;
  try{rp=it?tcrP().receiptPlan(r,it,tcrFormats(r.item_id)):null}catch{rp=null}
  const unit=tcrEnvUnit(it?.base_unit||r.unit);
  if(!rp)return {plan:E.plan({need:Number(r.quantity)||0,unit}),rp:null,unit};
  const plan=E.plan({need:rp.need,unit,formats:rp.pack?[{label:rp.pack.unit,size:rp.pack.factor,price:rp.pack.price,usual:true}]:[]});
  if(rp.pack){plan.count=rp.packs;plan.buy=rp.bought;plan.extra=Math.max(rp.bought-rp.need,0);plan.cost=rp.amount}
  return {plan,rp,unit}}
function tcrAmount(r){if(r.estimated_amount!=null&&Number(r.estimated_amount)>0)return Number(r.estimated_amount);return tcrPack(r).rp?.amount??null}
function tcrBuyText(r){const {plan,rp}=tcrPack(r);if(!rp)return r.quantity!=null?qty(r.quantity,r.unit):'';return tcrEnv().buyText(plan)}
function tcrNeedText(r){const {plan,rp}=tcrPack(r);if(!rp)return '';const x=tcrEnv().extraText(plan);
  return `hace falta ${tcrEnv().legible(rp.need,plan.unit)}${x?` · ${x} ${TCR_KEEP}`:''}`}
function tcrDraw(r,scale){const {plan,rp}=tcrPack(r);if(!rp)return null;return tcrEnv().draw(plan,{kit:tcrKit(),scale,keep:TCR_KEEP})}

/* --- El cuadre con Finance (#594): resultado, cola del dispositivo y reintento ---------------------------------------- */
const tcrCuadre=new Map();
function tcrQueue(){try{const v=JSON.parse(localStorage.getItem(TCR_QUEUE_KEY)||'[]');return Array.isArray(v)?v:[]}catch{return []}}
function tcrQueueSet(ids){try{if(ids.length)localStorage.setItem(TCR_QUEUE_KEY,JSON.stringify([...new Set(ids)].slice(-100)));else localStorage.removeItem(TCR_QUEUE_KEY)}catch{}}
let tcrInFlight=null;
/* Pide el cuadre de unas solicitudes. Sin red o con fallo, quedan en la cola y en «no se pudo»: nunca solo en la consola. */
async function tcrReconcile(ids){ids=[...new Set(ids)].filter(Boolean);if(!ids.length||!Sync.core)return [];
  const fail=()=>{tcrQueueSet([...tcrQueue(),...ids]);for(const id of ids)tcrCuadre.set(id,{id,state:'error'});return ids.map(id=>({id,state:'error'}))};
  if(!navigator.onLine)return fail();
  let out;
  try{await Sync.chain;await Sync.core.settle?.();out=await api('purchases/reconcile',{method:'POST',body:JSON.stringify({requestIds:ids})})}catch(e){console.warn('Cuadre con Finance pendiente',e);return fail()}
  const results=Array.isArray(out?.results)?out.results:ids.map(id=>({id,state:'none'}));
  const left=new Set(tcrQueue());
  for(const r of results){tcrCuadre.set(r.id,r);if(r.state==='error')left.add(r.id);else left.delete(r.id)}
  tcrQueueSet([...left]);
  try{await Sync.core.resources?.sync()}catch{}
  return results}
/* Al volver la red (o al abrir Compras con algo en la cola), se reintenta solo. */
/* Como mucho un intento cada 30 s al abrir Compras (si el servicio falla, no se insiste en bucle); al volver la red, ya. */
let tcrLastFlush=0;
function tcrFlush(force=false){const q=tcrQueue();if(!q.length||!navigator.onLine||!Sync.core||!Sync.ready||tcrInFlight)return;
  if(!force&&Date.now()-tcrLastFlush<30000)return;tcrLastFlush=Date.now();
  tcrInFlight=tcrReconcile(q).then(res=>{if(res.some(r=>r.state!=='error')&&PURCHASE_VIEWS.includes(state.view)&&!document.getElementById('sheetBack')?.classList.contains('show'))render()}).finally(()=>{tcrInFlight=null})}
window.addEventListener('online',()=>setTimeout(()=>tcrFlush(true),800));
reconcileReceipt=async function(id){return tcrReconcile([id])};

/* Lo que dice el cuadre de una solicitud. Las cifras solo salen con la lectura de Finance (facturas o resultado del cuadre). */
function tcrCuadreOf(r){if(!r.needs_invoice||!['approved','purchased','received'].includes(r.status))return null;
  const c=tcrCuadre.get(r.id);
  if(c?.state==='error'||(tcrQueue().includes(r.id)&&!c))return {state:'error',text:'El cuadre con Finance no se pudo hacer · se reintenta'};
  const rows=purchaseInvoices.get(r.id)||[];
  let amount=null,codes=[];
  if(rows.length){amount=Math.round(rows.reduce((n,x)=>n+Number(x.allocated_amount||0),0)*100)/100;codes=[...new Set(rows.map(x=>x.invoice_code).filter(Boolean))]}
  else if(c&&['ok','diff'].includes(c.state)&&c.invoiced!=null){amount=Number(c.invoiced);codes=c.codes||[]}
  if(amount!=null){const est=tcrAmount(r),diff=est==null?null:Math.round((amount-est)*100)/100,bad=diff!=null&&Math.abs(diff)>0.005;
    const tail=bad?` · ${diff>0?'+':'−'}${tcrEuro(Math.abs(diff))} sobre lo previsto`:est!=null?' · cuadra con lo previsto':'';
    return {state:bad?'diff':'ok',text:`${r.status==='received'?'Cuadrada con':'Factura'} ${codes.join(', ')}: ${tcrEuro(amount)}${tail}`}}
  if(r.status==='received')return purchaseInvoices.has(r.id)||c?{state:'none',text:'Sin factura en Finance todavía: se cuadra cuando llegue'}:null;
  return {state:'none',text:'Llegará factura'}}
const TCR_CUADRE_LABEL={ok:'Cuadrada',diff:'Con diferencia',none:'Sin factura todavía',error:'No se pudo cuadrar'};

async function tcrRetry(id){IkisaiKit.hideToast();const res=(await tcrReconcile([id]))[0];const r=tcrRow(id);
  if(document.getElementById('prTitle')&&document.getElementById('tcrPack')?.dataset.request===id){purchaseSheet(id);const c=document.querySelector('.tcr-cuadre');if(c){c.tabIndex=-1;c.focus()}}
  else render();
  const cu=r?tcrCuadreOf(r):null;
  if(res?.state==='error')IkisaiKit.toastWithAction('El cuadre con Finance sigue sin poder hacerse; se reintenta al volver la red.',{label:'Reintentar',onClick:()=>tcrRetry(id)});
  else toast(cu?.text?cu.text+'.':'Cuadre hecho.')}

/* --- Pasos de una solicitud: aprobar y comprar con «Deshacer»; recibir con confirmación corta -------------------------- */
function tcrNext(r){if(!canEdit())return null;
  if(r.status==='requested')return canApprovePurchases()?{to:'approved',label:'Aprobar'}:null;
  if(r.status==='approved')return {to:'purchased',label:'Comprada'};
  if(r.status==='purchased')return {to:'received',label:'Ha llegado'};
  return null}
function tcrStep(r){const n=tcrNext(r);if(!n)return false;
  if(n.to==='received'){tcrReceiveConfirm(r);return true}
  if(!purchaseRun(d=>tcrP().setPurchaseStatusOps(d,r.id,n.to),null))return false;
  usage.track(n.to==='approved'?'tasks.compras.aprobar':'tasks.compras.comprada');
  if(n.to==='approved')offerLocalUndo(`«${r.title}» aprobada.`,()=>{const now=tcrRow(r.id);if(now?.status==='approved')purchaseRun(d=>tcrP().setPurchaseStatusOps(d,r.id,'requested'),'Vuelve a estar pedida.')});
  // Con factura conocida no se ofrece «Deshacer» (PURCHASE_INVOICED): se corrige en Finance.
  else if(purchaseInvoiced(r.id)){IkisaiKit.hideToast();toast(`«${r.title}» comprada.`)}
  else offerLocalUndo(`«${r.title}» comprada.`,()=>{const now=tcrRow(r.id);if(now?.status==='purchased')purchaseRun(d=>tcrP().undoPurchaseOps(d,r.id,{invoiced:purchaseInvoiced(r.id)}),'Vuelve a estar aprobada.')});
  return true}
/* «Aprobar las N»: un solo lote y un solo «Deshacer» que las devuelve todas a pedidas. */
function tcrApproveAll(list){const ids=list.map(r=>r.id);
  if(!purchaseRun(d=>ids.flatMap(id=>tcrP().setPurchaseStatusOps(d,id,'approved')),null))return;usage.track('tasks.compras.aprobar_todas');
  offerLocalUndo(`Aprobadas ${ids.length}.`,()=>purchaseRun(d=>ids.filter(id=>d['tasks.purchase_requests'].find(x=>x.id===id&&x.status==='approved')).flatMap(id=>tcrP().setPurchaseStatusOps(d,id,'requested')),'Vuelven a estar pedidas.'))}

/* Lo que entra, en palabras: «Entran 4 garrafas de 5 l (20 l) en Albergue › Almacén · 1 l más de lo que hacía falta.» */
function tcrEntryText(r,spaceId){const it=tcrItem(r.item_id),{plan,rp}=tcrPack(r),E=tcrEnv();
  if(!rp)return `«${r.title}» recibida.`;
  const where=spaceShort(spaceId||it?.default_space_id)||'el almacén';
  if(rp.pack)return `${rp.packs===1?'Entra':'Entran'} ${E.buyText(plan)}${rp.pack.factor!==1?` (${E.legible(rp.bought,plan.unit)})`:''} en ${where}${rp.extra>0?` · ${E.legible(rp.extra,plan.unit)} más de lo que hacía falta`:''}.`;
  return `Entra ${E.legible(rp.bought,plan.unit)} en ${where}.`}
/* Confirmación corta al recibir desde la baldosa (decisión de VG): la frase del aviso y «Recibida»; el sitio, si hace falta. */
async function tcrReceiveConfirm(r){let it=tcrItem(r.item_id);const entry=!!r.item_id&&Number(r.quantity)>0;
  if(entry&&!it&&Sync.core?.resources&&navigator.onLine){try{await Sync.core.resources.sync();it=(await Sync.core.resources.list('resources.items')).find(i=>i.id===r.item_id)}catch{}}
  const needSpace=entry&&!it?.default_space_id,rows=needSpace&&typeof spaceRows==='function'?spaceRows().filter(s=>s.active!==false):[];
  let problem='';try{if(entry&&it)tcrP().receiptPlan(r,it,tcrFormats(r.item_id))}catch(e){problem=e.message}
  IkisaiKit.hideToast();
  openSheet(`<h2 class="sheettitle">¿Ha llegado «${esc(r.title)}»?</h2><p class="tcr-entry" id="tcrEntryText">${esc(problem||(needSpace?tcrEntryText(r,null).replace(' en el almacén','').replace(/\.$/,'')+'.':tcrEntryText(r,null)))}</p>
    ${needSpace?`<div class="field"><label for="receiptSpace">¿Dónde se guarda?</label><select id="receiptSpace" data-feedback-id="tasks.compras.recibir.sitio" data-feedback-label="Dónde se guarda"><option value="">Elige un sitio…</option>${rows.map(s=>`<option value="${esc(s.id)}">${esc(spaceShort(s.id)||s.name)}</option>`).join('')}</select></div>`:''}
    <div class="actions"><button class="primary" id="tcrReceiveOk" type="button" ${problem?'disabled':''} data-feedback-id="tasks.compras.recibir.confirmar" data-feedback-label="Recibida">Recibida</button><button class="ghost" id="tcrReceiveCancel" type="button" data-feedback-id="tasks.compras.recibir.cancelar" data-feedback-label="Cancelar">Cancelar</button></div>`);
  document.getElementById('tcrReceiveCancel').onclick=()=>closeSheet();
  document.getElementById('tcrReceiveOk').onclick=()=>{const space=needSpace?document.getElementById('receiptSpace').value:(entry?it.default_space_id:null);
    if(needSpace&&!space)return toast('Elige dónde se guarda.');finishReceive(r,space)}}

/* Recibir (desde la hoja o la baldosa): la entrada (el envase entero) va primero; después, recibida. El aviso dice lo que
   entra y el cuadre, y sustituye al anterior. Con repetición, la pregunta lleva el aviso arriba y no lo tapa. */
finishReceive=async function(r,spaceId){let entered=false;
  try{entered=await Sync.core.recordReceipt(r.id,spaceId)}catch(e){return toast(e.message||'No se pudo apuntar la entrada en el inventario.')}
  const P=tcrP();if(!purchaseRun(d=>P.receivePurchaseOps(d,r.id),null))return;usage.track('tasks.compras.recibir');
  const what=entered?tcrEntryText(tcrRow(r.id)||r,spaceId):`«${r.title}» recibida.`;
  const say=()=>{const now=tcrRow(r.id)||r,cu=tcrCuadreOf(now);IkisaiKit.hideToast();
    if(cu?.state==='error')return IkisaiKit.toastWithAction(`${what} El cuadre con Finance no se pudo hacer; se reintenta.`,{label:'Reintentar',onClick:()=>tcrRetry(r.id)});
    IkisaiKit.toastWithAction(cu&&cu.state!=='none'?`${what} ${cu.text}.`:what,{label:'Ver',onClick:()=>purchaseSheet(r.id)})};
  const done=tcrReconcile([r.id]);
  if(!r.repeat_days){closeSheet();say();done.then(()=>{if(!document.getElementById('sheetBack')?.classList.contains('show'))say()});return}
  const ask=()=>{const cu=tcrCuadreOf(tcrRow(r.id)||r);openSheet(`<h2 class="sheettitle">Compra recurrente</h2><p class="tcr-entry" role="status">${esc(what)}${cu&&cu.state!=='none'?' '+esc(cu.text)+'.':''}</p><p>«${esc(r.title)}» se repite cada ${r.repeat_days} días. ¿Pides ya la siguiente?</p><div class="actions"><button class="primary" id="prNextNow" type="button" data-feedback-id="tasks.solicitud.recurrente.pedir_siguiente" data-feedback-label="Pedir la siguiente">Pedir la siguiente</button><button class="ghost" id="prNextLater" type="button" data-feedback-id="tasks.solicitud.recurrente.ahora_no" data-feedback-label="Ahora no">Ahora no</button></div>`);
    document.getElementById('prNextNow').onclick=()=>{if(purchaseRun(d=>P.nextRecurringOps(d,r.id),'Pedida la siguiente.'))closeSheet()};document.getElementById('prNextLater').onclick=()=>closeSheet()};
  IkisaiKit.hideToast();ask()};

/* PURCHASE_INVOICED sin red: el servidor rechaza «No se compró» o la casilla de una compra con factura. Se descarta ese
   lote (la compra vuelve a «comprada», como en el servidor) y se dice dónde corregirlo. Nunca un «hecho» falso. */
let tcrInvoicedSeen='';
const refreshStatusBeforeCompras=refreshStatus;
refreshStatus=async function(...a){const out=await refreshStatusBeforeCompras.apply(this,a);const f=Sync.record?.failure;
  if(f?.code==='PURCHASE_INVOICED'&&f.requestId&&f.requestId!==tcrInvoicedSeen&&!Sync.secondary){tcrInvoicedSeen=f.requestId;
    try{await Sync.core.discardRejected(f.requestId)}catch(e){console.error(e)}
    IkisaiKit.hideToast();toast('Ya está ligada a una factura: corrígelo en Finance.');await refreshStatusBeforeCompras();render();syncNow?.()}
  return out};

/* --- La hoja de la solicitud: el envase y el cuadre arriba (lo demás no cambia) --------------------------------------- */
const purchaseSheetBeforeCompras=purchaseSheet;
purchaseSheet=function(id=null,preset={}){purchaseSheetBeforeCompras(id,preset);const r=id?tcrRow(id):null,first=document.getElementById('prTitle')?.closest('.field');if(!r||!first)return;
  const {plan,rp}=tcrPack(r),cu=tcrCuadreOf(r);if(!rp&&!cu)return;
  const box=document.createElement('section');box.className='ikisai-kit tcr-pack';box.id='tcrPack';box.dataset.request=r.id;box.setAttribute('aria-label','Envase y cuadre con Finance');
  const x=rp?tcrEnv().extraText(plan):null;
  box.innerHTML=`${rp?`<div class="tcr-packrow"><span class="tcr-draw"></span><span class="tcr-packwords">${rp.pack?`<b>Se compra ${esc(tcrEnv().buyText(plan))}</b><span>Hace falta ${esc(tcrEnv().legible(rp.need,plan.unit))}${x?` · ${esc(x)} ${TCR_KEEP}`:' · sin sobra'}</span>`:`<b>${esc(tcrEnv().legible(rp.bought,plan.unit))}</b><span>Sin envase en la ficha: se compra lo justo.</span>`}<span>${r.status==='received'?'Entró el envase entero en el almacén.':'Al recibirla entra el envase entero en el almacén.'}</span></span></div>`:''}
    ${cu?`<div class="tcr-cuadre" data-tone="${{ok:'ok',diff:'warn',none:'none',error:'alert'}[cu.state]}" role="status"><span class="tcr-cuadrek">Cuadre con Finance · ${esc(TCR_CUADRE_LABEL[cu.state])}</span><span>${esc(cu.state==='none'&&r.status!=='received'?'Se cuadra al recibirla, con la factura de Finance.':cu.text)}</span>${cu.state==='error'&&canEdit()?'<button class="softbtn" type="button" id="tcrRetry" data-feedback-id="tasks.solicitud.cuadre.reintentar" data-feedback-label="Reintentar el cuadre">Reintentar</button>':''}</div>`:''}`;
  if(rp){const d=tcrDraw(r,0.8);if(d)box.querySelector('.tcr-draw').append(d)}
  first.before(box);
  const rt=document.getElementById('tcrRetry');if(rt)rt.onclick=()=>tcrRetry(r.id)};

/* --- El envase del artículo (formatSheet del kit): se guarda en resources.item_units -------------------------------- */
function tcrFormatSheet(itemId,need,back){const it=tcrItem(itemId);if(!it)return;const res=Sync.core?.resources;if(!res||!canEdit())return;
  const unit=tcrEnvUnit(it.base_unit),plan=tcrEnv().plan({need:Math.max(Number(need)||Number(it.min_quantity)||1,0),unit,formats:tcrFormats(itemId)});
  closeSheet();
  tcrEnv().formatSheet({name:it.name,r:plan,kit:tcrKit(),keep:TCR_KEEP,where:TCR_WHERE,feedbackId:'tasks.compras.envase',returnFocus:back||null,onSave:async(chosen,all)=>{
    // Un habitual como mucho (#695): el nuevo se marca y el anterior se desmarca en el mismo lote. Nunca cambia el tamaño de uno que ya existe.
    const ops=[];for(const f of all){const row=f.source?.id?f.source:null;
      if(row){const fields={};if(!!row.usual!==!!f.usual)fields.usual=!!f.usual;const p=f.price==null?null:Math.round(f.price*100)/100;if((row.price==null?null:Number(row.price))!==p)fields.price=p;
        if(Object.keys(fields).length)ops.push({op:'update',table:'resources.item_units',id:row.id,expectedRevision:row.revision??0,fields})}
      else if(f.isNew)ops.push({op:'insert',table:'resources.item_units',id:crypto.randomUUID(),fields:{item_id:itemId,unit:f.label.slice(0,40),factor:f.size,supplier_id:null,usual:true,price:f.price==null?null:Math.round(f.price*100)/100}})}
    // Primero se desmarca el habitual de antes (el núcleo lo comprueba al final del lote, pero así se lee mejor).
    ops.sort((a,b)=>(a.fields?.usual===false?0:1)-(b.fields?.usual===false?0:1));
    if(!ops.length)return;
    try{await res.commit(ops);toast(`Guardado en la ficha de ${it.name.toLowerCase()}.`)}catch(e){toast(e.message||'No se pudo guardar el envase.')}}})}

/* ===================================================================================================================== */
/* Solicitudes · estantería por tienda                                                                                   */
/* ===================================================================================================================== */
let tcrShelvesBox=null,tcrShowDone=false;
/* FB_2026_069: las cifras de arriba filtran la estantería (otro toque, o «Quitar filtro», lo quita). */
let tcrFilter=null;
const TCR_FILTERS={requested:'por aprobar',approved:'por comprar',purchased:'por recibir',keep:'dejan sobra'};
function tcrDestroyShelves(){try{tcrShelvesBox?.destroy()}catch{}tcrShelvesBox=null}
function tcrRequestTile(r){const n=tcrNext(r),{rp}=tcrPack(r),cu=tcrCuadreOf(r),money=tcrMoney(),amount=money?tcrAmount(r):null;
  const [label]=PURCHASE_STATUS[r.status]||[r.status];
  const project=r.project_id?purchaseAreaOf(r)?.projects.find(p=>p.id===r.project_id)?.title:'';
  const meta=[project,r.due?'para el '+shortDate(r.due):'',r.repeat_days?`cada ${r.repeat_days} días`:''].filter(Boolean).join(' · ');
  const actions=[{slot:'more',label:`Más: ${r.title}`,feedbackId:'tasks.compras.baldosa.mas',onClick:()=>tcrMoreSheet(r.id)}];
  const draw=tcrDraw(r,0.62);
  if(draw&&r.item_id&&canEdit())actions.push({slot:'media',label:`${rp?.pack?'Cambiar el envase':'¿Cómo se vende?'}: ${r.title}`,feedbackId:'tasks.compras.baldosa.envase',onClick:()=>tcrFormatSheet(r.item_id,rp?.need)});
  const node=tcrKit().renderTile({title:r.title,value:tcrBuyText(r),levelText:rp?(rp.pack?tcrNeedText(r):(rp?'sin envase: lo justo':'')):'a mano',media:draw,actions,
    onClick:n?()=>{closeSheet();tcrStep(tcrRow(r.id)||r)}:()=>purchaseSheet(r.id),mainLabel:n?`${n.label}: ${r.title}`:`Ver la solicitud: ${r.title}`,feedbackId:'tasks.compras.baldosa'});
  node.dataset.purchase=r.id;node.dataset.status=r.status;node.classList.add('tcr-tile');
  const main=node.querySelector('.tile-main');if(main){main.dataset.feedbackId=n?'tasks.compras.baldosa.siguiente':'tasks.compras.baldosa.abrir';main.dataset.feedbackLabel=n?n.label:'Ver la solicitud'}
  const extra=document.createElement('span');extra.className='tcr-tileextra';
  extra.innerHTML=`<span class="tcr-chip" data-s="${esc(r.status)}">${r.priority&&r.priority!=='normal'?priorityStar(r.priority):''}${esc(label)}${amount!=null?' · '+esc(tcrEuro(amount)):''}</span>${meta?`<small class="tcr-meta">${esc(meta)}</small>`:''}${cu?`<small class="tcr-cuadreline" data-tone="${cu.state}">${esc(cu.text)}</small>`:''}`;
  node.append(extra);return node}
function tcrSum(list){if(!tcrMoney())return null;return list.reduce((n,r)=>n+(tcrAmount(r)||0),0)}
const purchasesViewBeforeCompras=purchasesView;
purchasesView=function(){listenPurchases();if(generalMode()||!tab())return purchasesViewBeforeCompras();
  const all=tcrRequests(),open=all.filter(r=>['requested','approved','purchased'].includes(r.status)).length;
  loadPurchaseInvoices(all.filter(r=>r.needs_invoice&&['approved','purchased','received'].includes(r.status)).map(r=>r.id));tcrFlush();
  return `<main class="screen purchases tcr-screen"><div class="screenhead"><div><h1 class="title">Solicitudes de compra</h1><p class="subtitle">${esc(tab().name)} · ${open} abiertas · ${purchaseApprover(tab().id)&&purchaseApprover(tab().id)===Sync.actor?.id?'apruebas tú':'aprueba '+esc(approverName(tab().id))}</p></div>${canEdit()?'<button class="primary" id="newPurchase" type="button" data-feedback-id="tasks.compras.cabecera.pedir" data-feedback-label="Pedir algo">+ Pedir algo</button>':''}</div>
    ${all.length?'<div class="ikisai-kit tcr-host" id="tcrPurchases"></div>':'<div class="empty">Todavía no hay solicitudes. Pide aquí lo que haga falta comprar; quien aprueba lo verá.</div>'}</main>`};
function tcrMountPurchases(){const host=document.getElementById('tcrPurchases');tcrDestroyShelves();if(!host)return;
  const all=tcrRequests().sort((a,b)=>(a.position||0)-(b.position||0)),open=all.filter(r=>['requested','approved','purchased'].includes(r.status)),by=s=>open.filter(r=>r.status===s);
  const req=by('requested'),app=by('approved'),pur=by('purchased'),done=all.filter(r=>r.status==='received').sort((a,b)=>(b.received_at||'').localeCompare(a.received_at||'')).slice(0,20),rej=all.filter(r=>r.status==='rejected');
  const keep=open.filter(r=>{const p=tcrPack(r);return p.rp&&p.rp.extra>0}).length;
  const hint=list=>{const s=tcrSum(list);return s?tcrEuro(s):null};
  const pick=k=>()=>{tcrFilter=tcrFilter===k?null:k;render()};
  const stats=tcrKit().renderStats([{value:req.length,label:'por aprobar',hint:hint(req),tone:req.length?'warn':null,onClick:pick('requested'),feedbackId:'tasks.compras.cifras.por_aprobar'},{value:app.length,label:'por comprar',hint:hint(app),onClick:pick('approved'),feedbackId:'tasks.compras.cifras.por_comprar'},{value:pur.length,label:'por recibir',hint:hint(pur),onClick:pick('purchased'),feedbackId:'tasks.compras.cifras.por_recibir'},{value:keep,label:'dejan sobra',hint:TCR_KEEP,onClick:pick('keep'),feedbackId:'tasks.compras.cifras.sobra'}],{label:'Compras abiertas · toca una cifra para filtrar'});
  // Cuál filtra: aria-pressed en su botón (el kit aún no tiene `selected` en renderStats; pedido al UI-kit).
  stats.querySelectorAll('button.stat-item').forEach((b,i)=>{const k=['requested','approved','purchased','keep'][i];b.setAttribute('aria-pressed',String(tcrFilter===k));if(tcrFilter===k)b.classList.add('tcr-statpick')});
  const shown=tcrFilter==='keep'?open.filter(r=>{const p=tcrPack(r);return p.rp&&p.rp.extra>0}):tcrFilter?open.filter(r=>r.status===tcrFilter):open;
  const ORDER={requested:0,approved:1,purchased:2};
  const sups=[...new Set(shown.map(tcrSupplierOf))].sort((a,b)=>(a==='Sin tienda')-(b==='Sin tienda')||shown.filter(r=>tcrSupplierOf(r)===b).length-shown.filter(r=>tcrSupplierOf(r)===a).length||a.localeCompare(b,'es'));
  const rows=sups.map(s=>{const list=shown.filter(r=>tcrSupplierOf(r)===s).sort((a,b)=>ORDER[a.status]-ORDER[b.status]),n=list.filter(r=>r.status==='requested').length,sum=tcrSum(list);
    return {key:s,label:s,medal:s==='Sin tienda'?{icon:'cart'}:{},sub:`${tcrPlural(list.length,'cosa','cosas')}${sum?' · '+tcrEuro(sum):''}${n?` · ${n} por aprobar`:''}`,items:list}});
  host.innerHTML=`<div class="tcr-top"></div>
    ${tcrFilter?`<p class="tcr-filtering" role="status">Solo ${esc(TCR_FILTERS[tcrFilter])} · ${tcrPlural(shown.length,'cosa','cosas')} <button type="button" class="ghost small" id="tcrClearFilter" data-feedback-id="tasks.compras.cifras.quitar_filtro" data-feedback-label="Quitar filtro">Quitar filtro</button></p>`:''}
    ${canApprovePurchases()&&canEdit()&&req.length?`<div class="tcr-banner" role="region" aria-label="Te toca aprobar"><span><b>Te toca aprobar · ${req.length}</b>${hint(req)?' · '+esc(hint(req)):''}</span><button class="primary" type="button" id="tcrApproveAll" data-feedback-id="tasks.compras.aprobar_todas" data-feedback-label="Aprobar todas">✓ Aprobar ${req.length===1?'la 1':'las '+req.length}</button></div>`:''}
    ${!canApprovePurchases()&&canEdit()&&req.length?`<p class="tcr-howto">Aprueba ${esc(approverName(tab().id))}.</p>`:''}
    <div class="tcr-legend"></div><div class="tcr-shelves"></div>
    ${done.length?`<details class="tcr-done" ${tcrShowDone?'open':''}><summary data-feedback-id="tasks.compras.en_casa" data-feedback-label="En casa">En casa · ${done.length}</summary><ul class="tcr-donelist">${done.map(r=>{const cu=tcrCuadreOf(r),a=tcrMoney()?tcrAmount(r):null;return `<li><button type="button" class="tcr-doneitem" data-purchase="${r.id}" data-feedback-id="tasks.compras.en_casa.abrir" data-feedback-label="Ver la solicitud"><b>${esc(r.title)}</b><span>${esc(tcrSupplierOf(r))}${r.repeat_days?` · cada ${r.repeat_days} días`:''} · Recibida${cu?` · <span class="tcr-cuadreline" data-tone="${cu.state}">${esc(cu.text)}</span>`:a!=null?' · '+esc(tcrEuro(a)):''}</span></button></li>`}).join('')}</ul></details>`:''}
    ${rej.length?`<button class="ghost" id="toggleRejectedPurchases" type="button" data-feedback-id="tasks.compras.lista.ver_rechazadas" data-feedback-label="Ver rechazadas">${showRejectedPurchases?'Ocultar rechazadas':`Ver rechazadas (${rej.length})`}</button>${showRejectedPurchases?`<ul class="tcr-donelist">${rej.map(r=>`<li><button type="button" class="tcr-doneitem" data-purchase="${r.id}" data-feedback-id="tasks.compras.rechazada.abrir" data-feedback-label="Ver la solicitud"><b>${esc(r.title)}</b><span>Rechazada</span></button></li>`).join('')}</ul>`:''}`:''}`;
  host.querySelector('.tcr-top').append(stats);
  if(open.some(r=>tcrPack(r).rp?.pack))host.querySelector('.tcr-legend').append(tcrEnv().legend({kit:tcrKit(),keep:TCR_KEEP,used:'Lo que hace falta'}));
  if(shown.length){tcrShelvesBox=tcrKit().createShelves({rows,key:r=>r.id,name:r=>r.title,tile:r=>tcrRequestTile(r),label:'Estanterías por tienda',noun:'tienda',feedbackId:'tasks.compras.estanterias',
      canMove:r=>canEdit()&&['requested','approved'].includes(r.status)&&!tcrP().planOf(purchasesData(),tcrRow(r.id)||r),
      onMove:(r,from,to)=>tcrMoveSupplier(r.id,to)});
    host.querySelector('.tcr-shelves').append(tcrShelvesBox.element)}
  else host.querySelector('.tcr-shelves').innerHTML=tcrFilter?'<p class="small muted">Nada con este filtro.</p>':'<p class="small muted">Nada pendiente.</p>';
  const cf=document.getElementById('tcrClearFilter');if(cf)cf.onclick=()=>{tcrFilter=null;render()};
  host.querySelector('.tcr-done')?.addEventListener('toggle',e=>{tcrShowDone=e.target.open});
  const aa=document.getElementById('tcrApproveAll');if(aa)aa.onclick=()=>tcrApproveAll(req)}
/* Arrastrar a otra tienda: con «Deshacer». Lo que está en un plan o comprado no se mueve (lo dice el «⋯»). */
function tcrMoveSupplier(id,row){const r=tcrRow(id);if(!r)return render();const before={supplier_name:r.supplier_name,supplier_id:r.supplier_id};
  const mate=row.key==='Sin tienda'?null:row.items.find(x=>x.id!==id&&x.supplier_id);
  const to={supplier_name:row.key==='Sin tienda'?null:row.label,supplier_id:mate?.supplier_id||null};
  if(!purchaseRun(d=>tcrP().moveToSupplierOps(d,id,to),null))return render();usage.track('tasks.compras.otra_tienda');
  offerLocalUndo(`«${r.title}» pasa a ${row.label}.`,()=>{const now=tcrRow(id);if(now)purchaseCommit([{op:'update',table:'tasks.purchase_requests',id,expectedRevision:now.revision,fields:before}],'Vuelve a su tienda.')})}
/* «⋯» de la baldosa: lo siguiente, rechazar, el envase, otra tienda y Detalles (la hoja de siempre). */
function tcrMoreSheet(id){const r=tcrRow(id);if(!r)return;const n=tcrNext(r),inPlan=tcrP().planOf(purchasesData(),r),{rp}=tcrPack(r);
  const why=['purchased','received'].includes(r.status)?'Ya está comprada: la tienda no cambia.':inPlan?`Está en el plan «${inPlan.plan.title}»: sácala del plan para cambiar de tienda.`:'';
  const canMove=canEdit()&&!why&&(tcrShelvesBox?.moveTargets(r).length||0)>0;
  openSheet(`<h2 class="sheettitle">${esc(r.title)}</h2><p class="small">${esc((PURCHASE_STATUS[r.status]||[r.status])[0])} · ${esc(tcrSupplierOf(r))}${rp?' · '+esc(tcrBuyText(r)):''}</p>
    <div class="menulist tcr-menu">${n?`<button type="button" id="tcrMoreNext" data-feedback-id="tasks.compras.mas.siguiente" data-feedback-label="${esc(n.label)}">${esc(n.label)}</button>`:''}
    ${r.status==='requested'&&canApprovePurchases()&&canEdit()?'<button type="button" id="tcrMoreReject" data-feedback-id="tasks.compras.mas.rechazar" data-feedback-label="Rechazar">Rechazar</button>':''}
    ${r.item_id&&canEdit()?`<button type="button" id="tcrMoreFormat" data-feedback-id="tasks.compras.mas.envase" data-feedback-label="Envase">${rp?.pack?'Cambiar el envase':'¿Cómo se vende?'}</button>`:''}
    ${canMove?'<button type="button" id="tcrMoreMove" data-feedback-id="tasks.compras.mas.otra_tienda" data-feedback-label="Mover a otra tienda">Mover a otra tienda</button>':''}
    <button type="button" id="tcrDetails" data-feedback-id="tasks.compras.mas.detalles" data-feedback-label="Detalles">Detalles</button></div>
    ${canEdit()&&why&&['requested','approved','purchased'].includes(r.status)?`<p class="small muted" id="tcrMoreWhy">${esc(why)}</p>`:''}`);
  const on=(sel,fn)=>{const b=document.getElementById(sel);if(b)b.onclick=fn};
  on('tcrMoreNext',()=>{closeSheet();tcrStep(tcrRow(id)||r)});
  on('tcrMoreReject',()=>{closeSheet();if(purchaseRun(d=>tcrP().setPurchaseStatusOps(d,id,'rejected'),null))offerLocalUndo(`«${r.title}» rechazada.`,()=>{const now=tcrRow(id);if(now?.status==='rejected')purchaseRun(d=>tcrP().setPurchaseStatusOps(d,id,'requested'),'Vuelve a estar pedida.')})});
  on('tcrMoreFormat',()=>tcrFormatSheet(r.item_id,rp?.need));
  on('tcrMoreMove',()=>{closeSheet();tcrShelvesBox?.moveSheet(r)});
  on('tcrDetails',()=>purchaseSheet(id))}

/* ===================================================================================================================== */
/* Suministros · estantería por sitio, con el nivel                                                                      */
/* ===================================================================================================================== */
let tcrSupplyShelves=null;
const TCR_OUT=new Set(['traslado']);
/* «te dura ~N días»: las salidas y consumos de las últimas 5 semanas (sin traslados). */
function tcrDaysLeft(itemId,stock){const since=Date.now()-35*86400000;
  const out=tcrInv().movements.filter(m=>m.item_id===itemId&&!m.deleted_at&&Number(m.quantity)<0&&!TCR_OUT.has(m.kind)&&Date.parse(m.at||m.created_at||0)>=since).reduce((n,m)=>n-Number(m.quantity),0);
  return out>0?Math.floor(stock/(out/35)):null}
function tcrStockBySpace(itemId){const by=new Map();for(const m of tcrInv().movements)if(m.item_id===itemId&&!m.deleted_at){const k=m.space_id||'';by.set(k,(by.get(k)||0)+Number(m.quantity))}return by}
function tcrSupplyInfo(it){const stock=tcrStock(it.id),min=Number(it.min_quantity)||0,low=min>0&&stock<min;
  const need=low?Math.max(Number(it.reorder_quantity)||0,Math.round((min-stock)*1000)/1000):0;
  const plan=need?tcrEnv().plan({need,unit:tcrEnvUnit(it.base_unit),formats:tcrFormats(it.id)}):null;
  return {item:it,stock,min,low,need,plan,open:tcrP().openRequestFor(purchasesData(),it.id),days:tcrDaysLeft(it.id,stock)}}
function tcrSupplyItems(){return tcrInv().items.filter(i=>!i.deleted_at&&i.active!==false&&tcrP().isSupplyKind(i.kind))}
const suppliesViewBeforeCompras=suppliesView;
suppliesView=function(){const html=suppliesViewBeforeCompras();if(generalMode()||!tab()||!fullScope(tab().id)||!Sync.core?.resources)return html;
  return html.replace('<div class="ikisai-kit" id="suppliesCatalog"></div>','<div class="ikisai-kit tcr-host" id="tcrSupplies"></div><section class="tcr-catalog" aria-labelledby="tcrCatalogTitle"><h2 class="sectionlabel" id="tcrCatalogTitle">Todo el inventario: buscar, filtrar y dar de alta</h2><div class="ikisai-kit" id="suppliesCatalog"></div></section>')};
/* Icono de la baldosa según el tipo del artículo (FB_2026_055, opción a); los iconos son los del kit. */
const TCR_KIND_ICON={ingrediente:'chef',bebida:'chef',menaje:'chef',material:'briefcase',limpieza:'sync',higiene:'user',consumible:'cart',textil:'bed',herramienta:'settings',maquina:'bot'};
function tcrKindIcon(kind){return TCR_KIND_ICON[kind]||'grid'}
/* Máquinas, herramientas y lo que no se gasta (FB_2026_053): tocar abre la ficha, no resta 1. Con 1 y mínimo 1 está bien
   (sin la franja de «va justo») y no se calcula «te dura». */
function tcrSupplyTile(x){const it=x.item,u=it.base_unit||'',equip=!isConsumable(it.id),tone=x.min&&x.stock<x.min?'alert':!equip&&x.min&&x.stock<x.min*1.25?'warn':'ok';
  const days=!equip&&x.days!=null&&x.days<60?`te dura ~${x.days} ${x.days===1?'día':'días'}`:'';
  const hint=x.open?`Pedido · ${(PURCHASE_STATUS[x.open.status]||[''])[0].toLowerCase()}`:x.low&&x.plan?`Pedir ${tcrEnv().buyText(x.plan)}`:'';
  const level=[x.min?`mín. ${tcrNum(x.min)}`:'sin mínimo',days,tone==='alert'?'queda poco':tone==='warn'?'va justo':''].filter(Boolean).join(' · ');
  const edit=canEdit();
  const node=tcrKit().renderTile({title:it.name,value:`${tcrNum(x.stock)} ${u}`,levelText:level,level:{pct:x.min?Math.max(0,Math.min(100,x.stock/(2*x.min)*100)):60,min:x.min?50:null,tone},icon:tcrKindIcon(it.kind),
    ...(edit?{onClick:equip?()=>openSupply(IkisaiKit.itemFromRow(it)):()=>tcrSupplyMinus(it.id),mainLabel:equip?`Ver la ficha: ${it.name}`:`Gastar 1: ${it.name}`,actions:[{slot:'more',label:`Más: ${it.name}`,feedbackId:'tasks.suministros.baldosa.mas',onClick:()=>tcrSupplyMore(it.id)}]}:{}),
    feedbackId:'tasks.suministros.baldosa'});
  node.dataset.supplyItem=it.id;node.classList.add('tcr-tile');if(equip)node.classList.add('tcr-equip');
  const main=node.querySelector('.tile-main');if(main){main.dataset.feedbackId=equip?'tasks.suministros.baldosa.ficha':'tasks.suministros.baldosa.menos1';main.dataset.feedbackLabel=equip?'Ver la ficha':'Gastar 1'}
  if(hint){const s=document.createElement('span');s.className='tcr-supplyhint';s.textContent=hint;node.append(s)}
  return node}
function tcrMountSupplies(){const host=document.getElementById('tcrSupplies');try{tcrSupplyShelves?.destroy()}catch{}tcrSupplyShelves=null;if(!host)return;
  const all=tcrSupplyItems().map(tcrSupplyInfo),low=all.filter(x=>x.low),toOrder=low.filter(x=>x.need&&!x.open),soon=all.filter(x=>x.days!=null&&x.days<7);
  const cost=tcrMoney()?toOrder.reduce((n,x)=>n+(x.plan?.cost||0),0):0;
  const by=new Map();for(const x of all){const k=x.item.default_space_id||'';if(!by.has(k))by.set(k,[]);by.get(k).push(x)}
  const rows=[...by.entries()].map(([k,xs])=>({key:k,label:k?spaceShort(k)||'Sitio':'Sin sitio',medal:{icon:'home'},items:xs.sort((a,b)=>(b.low-a.low)||a.item.name.localeCompare(b.item.name,'es')),
    sub:`${tcrPlural(xs.length,'cosa','cosas')}${xs.some(x=>x.low)?` · ${xs.filter(x=>x.low).length} con poco`:''}`}))
    .sort((a,b)=>(a.key==='')-(b.key==='')||b.items.filter(x=>x.low).length-a.items.filter(x=>x.low).length||a.label.localeCompare(b.label,'es'));
  host.innerHTML=`<div class="tcr-top"></div>
    ${canEdit()&&toOrder.length?`<div class="tcr-banner" role="region" aria-label="Queda poco"><span><b>Queda poco de ${toOrder.length}</b>${cost?' · '+esc(tcrEuro(cost)):''}</span><button class="primary" type="button" id="tcrOrderAll" data-feedback-id="tasks.suministros.pedir_todo" data-feedback-label="Pedir lo que falta">Pedir lo que falta (${toOrder.length})</button></div>`:''}
    ${all.length&&canEdit()?`<p class="tcr-howto">${all.some(x=>isConsumable(x.item.id))?'Tocar una baldosa gasta 1; en máquinas y herramientas, abre su ficha.':'Tocar una baldosa abre su ficha.'} Mantén pulsado o toca «⋯» para más.</p>`:''}<div class="tcr-shelves"></div>`;
  host.querySelector('.tcr-top').append(tcrKit().renderStats([{value:low.length,label:'con poco',tone:low.length?'alert':null},{value:all.filter(x=>x.open).length,label:'pedidas'},{value:soon.length,label:'duran < 1 semana',tone:soon.length?'warn':null}],{label:'Suministros'}));
  if(all.length){tcrSupplyShelves=tcrKit().createShelves({rows,key:x=>x.item.id,name:x=>x.item.name,tile:x=>tcrSupplyTile(x),label:'Estanterías por sitio',noun:'sitio',feedbackId:'tasks.suministros.estanterias',
      canMove:()=>canEdit(),onMove:(x,from,to)=>tcrSupplyMove(x.item.id,from.key,to)});
    host.querySelector('.tcr-shelves').append(tcrSupplyShelves.element)}
  const oa=document.getElementById('tcrOrderAll');if(oa)oa.onclick=()=>tcrOrder(toOrder)}
/* −1 con un toque: una salida «uso» del sitio con stock (el habitual primero). Su «Deshacer» apunta el movimiento contrario:
   los movimientos no se borran. Con lotes, el formulario de gastar (elige el lote). */
function tcrSupplyMinus(itemId){const it=tcrItem(itemId),src=inventorySources();if(!it||!src||!canEdit())return;
  if(it.tracks_lots)return supplyAct('spend',IkisaiKit.itemFromRow(it));
  const by=tcrStockBySpace(itemId),def=it.default_space_id||'';
  const space=(by.get(def)||0)>=1?def:[...by.entries()].filter(([,q])=>q>=1).sort((a,b)=>b[1]-a[1])[0]?.[0];
  if(space==null)return toast(`No queda ${it.name.toLowerCase()}: no se puede gastar.`);
  const move=(q,kind,reason,note)=>({id:crypto.randomUUID(),itemId,spaceId:space||null,lotId:null,quantity:q,kind,reason,unitCost:null,transferId:null,sourceApp:'tasks',sourceRef:null,note});
  src.items.record({movements:[move(-1,'salida_manual','uso',null)]}).then(()=>{usage.track('tasks.suministros.menos1');
    offerLocalUndo(`${it.name}: −1 ${it.base_unit}. Quedan ${tcrNum(tcrStock(itemId))}.`,()=>src.items.record({movements:[move(1,'entrada_manual',null,'Deshacer «−1»')]}).then(()=>toast('Deshecho: vuelve a estar.')).catch(e=>toast(e.message||'No se pudo deshacer.')))})
    .catch(e=>toast(e.message||'No se pudo apuntar.'))}
/* Arrastrar a otro sitio: el artículo pasa a guardarse allí (con «Deshacer») y, si había stock en el sitio de antes, se
   abre el traslado del kit (createMovementForm en modo traslado), que mueve lo de cada sitio y lote. */
async function tcrSupplyMove(itemId,fromKey,row){const it=tcrItem(itemId),res=Sync.core?.resources,src=inventorySources();if(!it||!res||!src)return render();
  const to=row.key||null,before=it.default_space_id||null;
  try{await res.commit([{op:'update',table:'resources.items',id:itemId,expectedRevision:it.revision??0,fields:{default_space_id:to}}])}catch(e){toast(e.message||'No se pudo cambiar de sitio.');return render()}
  usage.track('tasks.suministros.otro_sitio');
  offerLocalUndo(`${it.name} se guarda ahora en ${row.label}.`,async()=>{const now=(await res.list('resources.items')).find(i=>i.id===itemId);if(now)res.commit([{op:'update',table:'resources.items',id:itemId,expectedRevision:now.revision??0,fields:{default_space_id:before}}]).catch(e=>toast(e.message))});
  const left=fromKey?tcrStockBySpace(itemId).get(fromKey)||0:0;
  if(left>0&&to)inventorySheet(`Trasladar · ${it.name}`,done=>IkisaiKit.createMovementForm({source:src.items,spaces:src.spaces,itemId,spaceId:fromKey,mode:'transfer',modes:['transfer'],quickSpaces:[to],sourceApp:'tasks',feedbackId:'tasks.suministros.traslado',onDone:done,onCancel:done}))}
/* Pedir lo que falta: una solicitud por artículo con lo que hace falta (el envase lo redondea al recibir), con «Deshacer». */
function tcrOrder(list){const made=[];
  for(const x of list){if(!x?.need||x.open)continue;const id=crypto.randomUUID(),it=x.item;
    if(purchaseRun(d=>tcrP().requestPurchaseOps(d,{id,tab_id:tab().id,item_id:it.id,title:it.name,quantity:x.need,unit:it.base_unit,need_quantity:x.need,supplier_id:it.default_supplier_id||null,supplier_name:supplierNameOf(it.default_supplier_id)||null}),null))made.push(id)}
  if(!made.length)return;usage.track('tasks.suministros.pedir');
  offerLocalUndo(made.length===1?`Pedido: ${list.find(x=>x.need&&!x.open)?.item.name}.`:`Pedidas ${made.length} cosas.`,()=>{const rows=liveRows('tasks.purchase_requests').filter(r=>made.includes(r.id)&&r.status==='requested');
    purchaseCommit(rows.map(r=>({op:'delete',table:'tasks.purchase_requests',id:r.id,expectedRevision:r.revision})),'Pedido deshecho.')})}
function tcrSupplyMore(itemId){const it=tcrItem(itemId);if(!it)return;const x=tcrSupplyInfo(it),kitItem=IkisaiKit.itemFromRow(it);
  const shelved=tcrSupplyShelves?.getRows().flatMap(r=>r.items).find(y=>y.item.id===itemId)||null,canMove=!!shelved&&(tcrSupplyShelves.moveTargets(shelved).length>0);
  openSheet(`<h2 class="sheettitle">${esc(it.name)}</h2><p class="small">Quedan ${esc(tcrNum(x.stock))} ${esc(it.base_unit||'')}${x.min?` · mín. ${esc(tcrNum(x.min))}`:''}</p>
    <div class="menulist tcr-menu"><button type="button" data-tcr-supply="plus" data-feedback-id="tasks.suministros.mas.mas1" data-feedback-label="+1">+1</button>
    <button type="button" data-tcr-supply="spend" data-feedback-id="tasks.suministros.mas.gastar" data-feedback-label="Gastar">Gastar…</button>
    <button type="button" data-tcr-supply="entry" data-feedback-id="tasks.suministros.mas.entrada" data-feedback-label="Entrada">Entrada…</button>
    <button type="button" data-tcr-supply="transfer" data-feedback-id="tasks.suministros.mas.trasladar" data-feedback-label="Trasladar">Trasladar…</button>
    <button type="button" data-tcr-supply="count" data-feedback-id="tasks.suministros.mas.contar" data-feedback-label="Contar">Contar</button>
    ${x.need&&!x.open?`<button type="button" data-tcr-supply="order" data-feedback-id="tasks.suministros.mas.pedir" data-feedback-label="Pedir">Pedir ${esc(tcrEnv().buyText(x.plan))}</button>`:x.open?`<button type="button" data-tcr-supply="request" data-feedback-id="tasks.suministros.mas.pedido" data-feedback-label="Pedido">Pedido · ${esc((PURCHASE_STATUS[x.open.status]||[''])[0].toLowerCase())}</button>`:''}
    ${canMove?'<button type="button" data-tcr-supply="move" data-feedback-id="tasks.suministros.mas.otro_sitio" data-feedback-label="Guardar en otro sitio">Guardar en otro sitio</button>':''}
    <button type="button" data-tcr-supply="format" data-feedback-id="tasks.suministros.mas.envase" data-feedback-label="Envase">Envase</button>
    <button type="button" data-tcr-supply="sheet" data-feedback-id="tasks.suministros.mas.ficha" data-feedback-label="Ficha">Ficha</button></div>`);
  document.querySelectorAll('[data-tcr-supply]').forEach(b=>b.onclick=()=>{const a=b.dataset.tcrSupply;closeSheet();
    if(a==='plus'){const src=inventorySources();const sp=it.default_space_id||null;src?.items.record({movements:[{id:crypto.randomUUID(),itemId,spaceId:sp,lotId:null,quantity:1,kind:'entrada_manual',reason:null,unitCost:null,transferId:null,sourceApp:'tasks',sourceRef:null,note:null}]}).then(()=>toast(`${it.name}: +1 ${it.base_unit}.`)).catch(e=>toast(e.message||'No se pudo apuntar.'));return}
    if(['spend','entry','transfer','count'].includes(a))return supplyAct(a,kitItem);
    if(a==='order')return tcrOrder([x]);
    if(a==='request')return purchaseSheet(x.open.id);
    if(a==='move')return tcrSupplyShelves?.moveSheet(shelved);
    if(a==='format')return tcrFormatSheet(itemId,x.need||x.min);
    if(a==='sheet')return openSupply(kitItem)})}

/* ===================================================================================================================== */
/* Planes · «Lo que entrará al preparar» y la hoja de ruta plegable                                                       */
/* ===================================================================================================================== */
const tcrSkip=new Set(),tcrOpenPlans=new Set();
const plansViewBeforeCompras=plansView;
plansView=function(){if(generalMode()||!tab()||!fullScope(tab().id))return plansViewBeforeCompras();listenPurchases();
  const pending=tcrRequests().filter(r=>r.status==='approved'&&!r.plan_stop_id).length,recurring=tcrP().dueRecurring(purchasesData(),tab().id,today()).length;
  return `<main class="screen plans tcr-screen"><div class="screenhead"><div><h1 class="title">Planes de compra</h1><p class="subtitle">${pending} aprobadas sin plan${recurring?` · ${recurring} recurrentes que tocan`:''}</p></div></div>
    ${canApprovePurchases()?'':`<p class="small muted">Prepara los planes ${esc(approverName(tab().id))}.</p>`}<div class="ikisai-kit tcr-host" id="tcrPlans"></div></main>`};
function tcrPlanStops(planId){const stops=liveRows('tasks.purchase_plan_stops').filter(s=>s.plan_id===planId).sort((a,b)=>(a.position||0)-(b.position||0));
  return stops.map(s=>({s,items:liveRows('tasks.purchase_requests').filter(r=>r.plan_stop_id===s.id&&r.status!=='rejected')})).filter(x=>x.items.length)}
function tcrMountPlans(){const host=document.getElementById('tcrPlans');if(!host)return;
  const loose=tcrRequests().filter(r=>r.status==='approved'&&!r.plan_stop_id),due=tcrP().dueRecurring(purchasesData(),tab().id,today());
  const ids=new Set([...loose,...due].map(r=>r.id));for(const id of [...tcrSkip])if(!ids.has(id))tcrSkip.delete(id);
  const pick=[...loose,...due].filter(r=>!tcrSkip.has(r.id)),money=tcrMoney(),edit=canApprovePurchases()&&canEdit();
  const plans=liveRows('tasks.purchase_plans').filter(p=>p.tab_id===tab().id).sort((a,b)=>({shopping:0,draft:1,done:2}[a.status||'draft']-{shopping:0,draft:1,done:2}[b.status||'draft'])||(b.created_at||'').localeCompare(a.created_at||''));
  const sum=list=>{if(!money)return '';const t=list.reduce((n,r)=>n+(tcrAmount(r)||0),0);return t?' · '+tcrEuro(t):''};
  const pill=(r,rec)=>`<li><span class="tcr-pill ${tcrSkip.has(r.id)?'is-off':''}">${esc(r.title)} · ${esc(tcrSupplierOf(r))}${rec?' · recurrente':''}<button type="button" class="iconbtn" data-tcr-skip="${r.id}" aria-pressed="${tcrSkip.has(r.id)}" aria-label="${tcrSkip.has(r.id)?'Volver a meter':'Quitar'}: ${esc(r.title)}" data-feedback-id="tasks.planes.preparar.quitar" data-feedback-label="Quitar de lo que entrará">${tcrSkip.has(r.id)?'+':'×'}</button></span></li>`;
  const card=(p,i)=>{const stops=tcrPlanStops(p.id),items=stops.flatMap(x=>x.items),got=items.filter(r=>['purchased','received'].includes(r.status)).length,editable=p.status!=='done'&&canEdit();
    const shops=stops.filter(x=>x.s.supplier_name!=='Sin proveedor').length,open=tcrOpenPlans.has(p.id)||(!tcrOpenPlans.size&&p.status!=='done'&&(i===0||p.status==='shopping'));
    return `<details class="tcr-plan" data-plan-card="${p.id}" data-status="${p.status||'draft'}" ${open?'open':''}><summary data-feedback-id="tasks.planes.plan" data-feedback-label="Plan de compra"><span class="tcr-plantitle"><b>${esc(p.title)}</b><small>${p.planned_for?esc(shortDate(p.planned_for))+' · ':''}${got} de ${items.length} ${items.length===1?'comprada':'compradas'}${sum(items)}${shops?' · '+tcrPlural(shops,'tienda','tiendas'):''}</small></span><span class="pstate ${p.status==='done'?'':'pending'}">${esc(PLAN_STATUS[p.status||'draft']||'Preparando')}</span></summary>
      <div class="tcr-planbody"><div class="tcr-progress" role="img" aria-label="${got} de ${items.length} compradas"><span style="width:${items.length?Math.round(got/items.length*100):0}%"></span></div>
      ${stops.map((x,j)=>`<section class="tcr-stop" aria-label="${esc(x.s.supplier_name)}"><header class="tcr-stophead"><span class="tcr-stopn" aria-hidden="true">${j+1}</span><b>${esc(x.s.supplier_name)}</b><small>${x.items.length}${sum(x.items)}</small></header><ul class="tcr-lines">${x.items.map(r=>{const bought=['purchased','received'].includes(r.status),lock=r.status==='received'||(r.status==='purchased'&&purchaseInvoiced(r.id)),a=money?tcrAmount(r):null;
        return `<li class="tcr-line ${bought?'is-got':''}" data-tcr-line="${r.id}"><button type="button" class="tcr-check" ${editable&&!lock?'':'disabled'} data-tcr-got="${r.id}" aria-pressed="${bought}" aria-label="${bought?'Comprada':'Marcar comprada'}: ${esc(r.title)}" ${lock&&r.status==='purchased'?'title="Ya está ligada a una factura: corrígelo en Finance."':''} data-feedback-id="tasks.plan.paradas.comprado" data-feedback-label="Comprado">${bought?'✓':''}</button><span class="tcr-draw sm" data-tcr-draw="${r.id}"></span><span class="tcr-linemain"><b>${esc(r.title)}</b><small>${esc(tcrBuyText(r))}${(()=>{const p=tcrPack(r);const xt=p.rp?tcrEnv().extraText(p.plan):null;return xt?' · sobran '+esc(xt):''})()}</small></span>${a!=null?`<span class="tcr-amount">${esc(tcrEuro(a))}</span>`:''}${editable&&!bought?`<button type="button" class="iconbtn" data-tcr-out="${r.id}" aria-label="Quitar del plan: ${esc(r.title)}" data-feedback-id="tasks.plan.sacar" data-feedback-label="Quitar del plan">×</button>`:''}</li>`}).join('')}</ul></section>`).join('')||'<p class="small muted">Este plan no lleva nada.</p>'}
      <div class="tcr-planactions">${editable&&loose.length?`<button class="softbtn" type="button" data-tcr-addto="${p.id}" data-feedback-id="tasks.plan.anadir" data-feedback-label="Añadir al plan">+ Añadir al plan (${loose.length})</button>`:''}<button class="ghost" type="button" data-plan="${p.id}" data-feedback-id="tasks.planes.lista.plan" data-feedback-label="Ordenar, imprimir o terminar">Ordenar, imprimir o terminar</button></div></div></details>`};
  host.innerHTML=`${edit&&(loose.length||due.length)?`<section class="tcr-prepare" aria-labelledby="tcrPrepTitle"><h2 id="tcrPrepTitle" class="tcr-h2">Lo que entrará al preparar</h2><ul class="tcr-pills">${loose.map(r=>pill(r,false)).join('')}${due.map(r=>pill(r,true)).join('')}</ul>
      <button class="primary" type="button" id="preparePlan" ${pick.length?'':'disabled'} data-feedback-id="tasks.planes.cabecera.preparar" data-feedback-label="Crear el plan">Crear el plan con ${tcrPlural(pick.length,'cosa','cosas')}${sum(pick)}</button></section>`:''}
    ${plans.length?plans.map(card).join(''):'<div class="empty">Un plan reúne lo aprobado por tienda, en el orden en que vas a pasar, con casillas para marcar al comprar.</div>'}`;
  host.querySelectorAll('[data-tcr-draw]').forEach(s=>{const r=tcrRow(s.dataset.tcrDraw),d=r?tcrDraw(r,0.42):null;if(d)s.append(d);else s.remove()});
  host.querySelectorAll('details.tcr-plan').forEach(d=>d.addEventListener('toggle',()=>{if(d.open)tcrOpenPlans.add(d.dataset.planCard);else tcrOpenPlans.delete(d.dataset.planCard)}));
  host.querySelectorAll('[data-tcr-skip]').forEach(b=>b.onclick=()=>{const id=b.dataset.tcrSkip;if(tcrSkip.has(id))tcrSkip.delete(id);else tcrSkip.add(id);render()});
  host.querySelectorAll('[data-tcr-got]').forEach(b=>b.onclick=()=>{const r=tcrRow(b.dataset.tcrGot);if(!r)return;
    if(r.status==='approved'){if(purchaseRun(d=>tcrP().setPurchaseStatusOps(d,r.id,'purchased'),null))usage.track('tasks.compras.comprada')}
    else if(r.status==='purchased')purchaseRun(d=>tcrP().undoPurchaseOps(d,r.id,{invoiced:purchaseInvoiced(r.id)}),'Vuelve a estar aprobada.')});
  host.querySelectorAll('[data-tcr-out]').forEach(b=>b.onclick=()=>{const r=tcrRow(b.dataset.tcrOut);if(!r)return;const stop=r.plan_stop_id;
    if(purchaseRun(d=>tcrP().removeFromPlanOps(d,r.id),null))offerLocalUndo(`«${r.title}» sale del plan.`,()=>{const now=tcrRow(r.id);if(now&&!now.plan_stop_id&&now.status==='approved')purchaseCommit([{op:'update',table:'tasks.purchase_requests',id:r.id,expectedRevision:now.revision,fields:{plan_stop_id:stop}}],'Vuelve al plan.')})});
  host.querySelectorAll('[data-tcr-addto]').forEach(b=>b.onclick=()=>tcrAddSheet(b.dataset.tcrAddto));
  const prep=document.getElementById('preparePlan');if(prep)prep.onclick=()=>tcrPrepare()}
/* Crear el plan solo con lo que queda (lo quitado no entra), «Preparando» al momento; su «Deshacer» borra también las
   recurrentes que acaba de crear. */
function tcrPrepare(){const title='Compra del '+new Date().toLocaleDateString('es-ES',{day:'numeric',month:'long'});let ops;
  try{ops=tcrP().preparePlanOps(purchasesData(),{tab_id:tab().id,title,today:today(),exclude:[...tcrSkip]})}catch(e){return toast(e.message||'No se pudo preparar.')}
  const planId=ops[0].id,created=tcrP().createdRequestIds(ops),n=ops.filter(o=>o.table==='tasks.purchase_requests').length;
  if(!purchaseCommit(ops,null))return;usage.track('tasks.planes.preparar');tcrSkip.clear();tcrOpenPlans.add(planId);
  offerLocalUndo(`Plan creado con ${tcrPlural(n,'cosa','cosas')}.`,()=>purchaseRun(d=>tcrP().deletePlanOps(d,planId,{created}),'Plan quitado.'))}
function tcrAddSheet(planId){const loose=tcrRequests().filter(r=>r.status==='approved'&&!r.plan_stop_id),money=tcrMoney();
  openSheet(`<h2 class="sheettitle">Añadir al plan</h2><p class="small">Va a la parada de su tienda o a una nueva al final.</p><div class="menulist">${loose.map(r=>`<button type="button" data-tcr-add="${r.id}" data-feedback-id="tasks.plan.anadir.una" data-feedback-label="Añadir al plan">${esc(r.title)} · ${esc(tcrSupplierOf(r))}${money&&tcrAmount(r)!=null?' · '+esc(tcrEuro(tcrAmount(r))):''}</button>`).join('')}</div>`);
  document.querySelectorAll('[data-tcr-add]').forEach(b=>b.onclick=()=>{const r=tcrRow(b.dataset.tcrAdd);closeSheet();if(!r)return;
    if(purchaseRun(d=>tcrP().addToPlanOps(d,planId,r.id),null))offerLocalUndo(`«${r.title}» va en el plan.`,()=>purchaseRun(d=>tcrP().removeFromPlanOps(d,r.id),'Fuera del plan.'))})}

/* ===================================================================================================================== */
/* Fichas · materiales con «en casa» y «Pedir …», y «Confirmar consumo» con − y +                                        */
/* ===================================================================================================================== */
const materialRowBeforeCompras=materialRow;
materialRow=function(m,editable){const html=materialRowBeforeCompras(m,editable);const it=inventoryItem(m.item_id);if(!it||m.consumed!=null)return html;
  const s=tcrStock(m.item_id),where=spaceShort(it.default_space_id),equip=!isConsumable(m.item_id);
  let line='',ask='';
  if(equip)line=s>0?`Hay ${tcrNum(s)}${where?' · '+where:''}`:'No hay en casa';
  else{const q=Number(m.quantity)||0,short=q>s;line=short?`En casa ${materialQty(s,it)}: faltan ${materialQty(Math.round((q-s)*1000)/1000,it)}`:`En casa ${materialQty(s,it)}${where?' · '+where:''}`;
    if(short){const open=tcrP().openRequestFor(purchasesData(),m.item_id);
      if(open)ask=`<span class="tcr-asked">Pedido: ${esc((PURCHASE_STATUS[open.status]||[''])[0].toLowerCase())}</span>`;
      else if(editable){const plan=tcrEnv().plan({need:Math.round((q-s)*1000)/1000,unit:tcrEnvUnit(it.base_unit),formats:tcrFormats(it.id)});
        // Sin precio: el botón no lleva importes (quien no ve costes tampoco los ve aquí).
        ask=`<button class="softbtn small tcr-ask" type="button" data-tcr-ask="${m.id}" data-feedback-id="tasks.tarea.materiales.pedir" data-feedback-label="Pedir lo que falta">Pedir ${esc(tcrEnv().buyText(plan))}</button>`}}}
  return html.replace(/<\/li>$/,`<span class="tcr-home ${line.startsWith('En casa')&&line.includes('faltan')?'is-short':''}">${esc(line)}${ask?' ':''}${ask}</span></li>`)};
const bindMaterialsBeforeCompras=bindMaterials;
bindMaterials=function(taskId){bindMaterialsBeforeCompras(taskId);
  document.querySelectorAll('[data-tcr-ask]').forEach(b=>b.onclick=()=>{const m=materialRows(taskId).find(x=>x.id===b.dataset.tcrAsk);if(!m)return;const it=inventoryItem(m.item_id),loc=taskLocation(taskId);
    const need=Math.round((Number(m.quantity)-tcrStock(m.item_id))*1000)/1000;if(!(need>0))return;
    if(purchaseRun(d=>tcrP().requestPurchaseOps(d,{tab_id:loc?.p?.tab_id||tab().id,item_id:m.item_id,task_id:taskId,title:it?.name||'Material',quantity:need,unit:it?.base_unit||null,need_quantity:need,supplier_id:it?.default_supplier_id||null,supplier_name:supplierNameOf(it?.default_supplier_id)||null}),canApprovePurchases()?'Pedido.':'Pedido. Lo verá '+approverName(tab().id)+'.')){usage.track('tasks.tarea.materiales.pedir');drawMaterials(taskId)}})};
/* − y + suman o restan 1 a la cifra escrita (no la sustituyen: hay decimales, 2,5 l). */
const consumptionSheetBeforeCompras=consumptionSheet;
consumptionSheet=function(taskIds,onlyId=null){consumptionSheetBeforeCompras(taskIds,onlyId);
  document.querySelectorAll('#sheet [data-consume-qty]').forEach(i=>{const name=i.getAttribute('aria-label')?.replace(/^Gastado de /,'')||'';
    const b=(step,sign)=>{const x=document.createElement('button');x.type='button';x.className='iconbtn tcr-step';x.textContent=sign;x.setAttribute('aria-label',`${step<0?'Menos':'Más'} ${name}`.trim());x.dataset.feedbackId=step<0?'tasks.consumo.menos':'tasks.consumo.mas';x.dataset.feedbackLabel=step<0?'Menos':'Más';
      x.onclick=()=>{if(i.disabled)return;const v=Number(String(i.value).replace(',','.'))||0;i.value=String(Math.max(0,Math.round((v+step)*1000)/1000));i.dispatchEvent(new Event('input',{bubbles:true}))};return x};
    i.before(b(-1,'−'));(i.nextElementSibling?.classList.contains('materialunit')?i.nextElementSibling:i).after(b(1,'+'))})};
/* Coste: arriba, las cifras del kit (materiales, a mano y total); debajo, las líneas de hoy. Solo para quien ve importes
   (la sección entera ya pasa por canSeeCosts en drawCosts). */
const costSectionHtmlBeforeCompras=costSectionHtml;
costSectionHtml=function(taskId){const html=costSectionHtmlBeforeCompras(taskId);let c;try{c=IkisaiTasks.costs.taskCost(purchasesData(),taskId,costInventory())}catch{return html}
  const loc=taskLocation(taskId);if(!loc||!canSeeCosts(areaIdOf(loc.p)))return html;
  const stats=tcrKit().renderStats([{value:tcrEuro(c.materialsAmount??0),label:'materiales'},{value:tcrEuro((c.manualAmount??0)+(c.legacy||0)),label:'a mano'},{value:tcrEuro(c.total),label:'total',tone:'ok'}],{label:'Coste de la tarea'});
  return html.replace('<h3 class="sectionlabel" id="taskCostsTitle">Coste</h3>',`<h3 class="sectionlabel" id="taskCostsTitle">Coste</h3><div class="ikisai-kit tcr-coststats">${stats.outerHTML}</div>`)};

/* --- Enlaces --------------------------------------------------------------------------------------------------------- */
const bindBeforeCompras=bind;
bind=function(){bindBeforeCompras();
  if(state.view==='purchases')tcrMountPurchases();else tcrDestroyShelves();
  if(state.view==='supplies')tcrMountSupplies();else{try{tcrSupplyShelves?.destroy()}catch{}tcrSupplyShelves=null}
  if(state.view==='plans')tcrMountPlans();
  document.querySelectorAll('.tcr-host [data-purchase]').forEach(b=>{if(b.tagName==='BUTTON')b.onclick=()=>purchaseSheet(b.dataset.purchase)});
  const tr=document.getElementById('toggleRejectedPurchases');if(tr)tr.onclick=()=>{showRejectedPurchases=!showRejectedPurchases;render()};
  document.querySelectorAll('.tcr-host [data-plan]').forEach(b=>b.onclick=()=>planSheet(b.dataset.plan))};
