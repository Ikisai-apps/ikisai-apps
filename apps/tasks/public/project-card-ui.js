/* Tarjeta de proyecto del kit común (IkisaiKit.renderProjectCard, /kit.js). Sustituye a la antigua cadena de `projectCard`
   (index.html → features.js → extras-ui.js → cards-ui.js → taller-ui.js), ya retirada. Conserva los ganchos que usan
   cards-ui.js, features.js, scope-ui.js y las pruebas: `data-open-project`, `data-drop-project`, `data-project-drag`
   (`.draghandle`), `data-project-pin` (`.pinbtn`, `.pinned`, mismo `aria-label` y `data-tip` que `pinButton`) y
   `data-project-order` (`.ghostcontrol`), y las clases `.project.colored[style*="--item-ink"]`, `.projecttitle .star`,
   `.money .moneybar` y `.chip[data-pastel]`. Los manejadores siguen en `bind()`: aquí solo se pinta HTML. */
projectCard=function(p){
  const K=IkisaiKit,pr=progress(p),count=pending(p),urgency=projectPriority(p),pinned=!p.system&&activeProjects()[0]?.id===p.id;
  const chips=aggregatedLabels(p).map(id=>{const l=label(id);if(!l||l.archived)return null;return K.el('span',{class:'chip',style:`--chip:${familyColorByLabel(id)}`,dataset:{label:id,pastel:'1'}},K.el('span',null,labelName(l)))}).filter(Boolean);
  const cost=projectCost(p),budget=Number(p.budget)||0;
  // Mismo orden que antes: asa, fijar y el control invisible de ordenar por menú.
  const actions=[];
  if(!p.system){
    actions.push(K.el('button',{class:'draghandle',type:'button',dataset:{projectDrag:p.id},'aria-label':`Arrastrar proyecto ${p.title}`,style:'touch-action:none'},'⠿'));
    actions.push(K.el('button',{class:`iconbtn small pinbtn${pinned?' pinned':''}`,type:'button',dataset:{projectPin:p.id,tip:pinned?'Fijado arriba':'Fijar arriba'},'aria-pressed':String(pinned),'aria-label':pinned?`${p.title} está fijado en primera posición`:`Fijar ${p.title} en primera posición`},K.icon('pin',16)));
  }
  actions.push(K.el('button',{class:'ghostcontrol',type:'button',dataset:{projectOrder:p.id},'aria-label':`Ordenar proyecto ${p.title}`,tabindex:'-1'},'↕'));
  const card=K.renderProjectCard({
    id:p.id,title:p.title,
    meta:`${count} pendientes · ${pr}%${p.status==='paused'?' · pausado':''}`,
    progress:pr,ring:!p.system,
    color:p.color||null,system:!!p.system,pinned,
    urgency:urgency==='normal'?undefined:urgency,
    chips,
    budget:cost||budget?{spent:cost,total:budget,format:money}:null,
    attrs:{'data-drop-project':p.id},
    actions,
  });
  // El CSS del kit está acotado a `.ikisai-kit`; el envoltorio es el elemento de la rejilla y la tarjeta lo llena (misma altura por fila).
  return K.el('div',{class:'ikisai-kit projectcard',style:'display:grid'},card).outerHTML;
};
