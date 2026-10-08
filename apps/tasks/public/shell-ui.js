/* Cáscara con el kit común, con estado (docs/tasks/UI_KIT.md §6 y ciclo de pintado acordado en la ronda 19).
   La cáscara (barra con áreas y vistas guardadas, menú agrupado y navegación inferior) se monta UNA vez dentro de #app y
   render() solo repinta #view (main() + fab()). shellUpdate(), llamada al principio de cada render():
   - monta la cáscara si no existe (#app lo sustituyen el arranque de boot(), «Primera área», la de «sin áreas compartidas» de
     enterSession y la entrada al cerrar sesión);
   - reconcilia la tira de áreas (crear, renombrar, recolorear, borrar o restaurar llega por refreshModel() → render()) y la de
     vistas guardadas, conservando su desplazamiento horizontal;
   - reconstruye los grupos del menú solo si cambian navigationGroups(), el actor o sus permisos (cambio de rol en caliente,
     también los elementos de agentes que dependen de isAdministrator()); si no, solo marca el elemento activo y la nota.
     El menú abierto, los grupos plegados (expandedMenuGroups), #syncBadge y #appUpdate en .brandrow se conservan;
   - marca la vista activa en la navegación inferior.
   navigateView() sigue cerrando el menú al navegar (closeNavigation); en escritorio el menú lateral siempre está visible.
   Ganchos conservados del paso 1: .brandrow con .spacer, #moreBtn (aria-controls="kebab", aria-expanded), .tabstrip con
   button.tabpill[data-tab] (.active, .colored), [data-general-area], [data-areas-tool], .tabcount, .viewstrip con #savedViews,
   [data-quick-view], [data-quick-mine] (.viewpill.mine), nav#kebab (.show), #menuBackdrop (.show), #closeMenu, .menuheader con
   #aliasBtn y #themeToggle, details.menugroup[data-menu-group], button.menuitem[data-menu-view|data-action] con .menuicon,
   nav.bottomnav(.five) con button.navbtn[data-nav] y #filterNav. «Organización» se pinta oculto (hidden), como antes.
   Los manejadores siguen en bind() de cada módulo: los de la cáscara se asignan con onclick, así que repetir bind() no los
   acumula sobre los elementos que se conservan. */
function shellIcon(name){const t=document.createElement('template');t.innerHTML=menuIcon(name).trim();return t.content.firstElementChild}
function shellNode(html){const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstElementChild}
function shellViewMatches(v){return state.view==='tasks'&&(state.search||'')===(v.search||'')&&JSON.stringify(state.filters||{})===JSON.stringify(v.filters||{})&&(state.groupBy||'project')===(v.groupBy||'project')}
function shellGroups(){return navigationGroups().map(g=>({...g,items:g.items.filter(i=>i[4]!==false)})).filter(g=>g.items.length)}
function shellItemActive(id,type){return type==='view'&&(state.view===id||id==='projects'&&state.view==='project')}

function shellTabs(){
  const K=IkisaiKit,general=state.taskScope==='all';
  /* Sin el lápiz de «Áreas de trabajo» (FB_2026_020): está en el menú lateral, en Trabajo. */
  const strip=K.renderAreaTabs({label:'Áreas de trabajo',
    items:[
      {label:'General',general:true,active:general,attrs:{'data-general-area':'',title:'Todas las áreas a la vez'}},
      ...activeAreas().map(t=>({label:t.name,active:!general&&t.id===state.activeTab,color:t.color||null,count:areaPending(t),attrs:{'data-tab':t.id}})),
    ]});
  /* «General», con un icono de «todas las áreas» en vez de la palabra (FB_2026_019); el nombre queda para lectores de pantalla. */
  const all=strip.querySelector('[data-general-area]');
  if(all){all.replaceChildren(shellIcon('allAreas'));all.classList.add('generalicon');all.setAttribute('aria-label','General: todas las áreas');all.dataset.tip='General · todas las áreas'}
  return strip;
}
function shellViews(){
  if(!tab())return null;
  const K=IkisaiKit,mine=myTaskFilters()?[{label:'Mis tareas',icon:shellIcon('user'),className:'mine',active:isMyTasksView(),attrs:{'data-quick-mine':'',title:'Tareas con mi etiqueta en todas las áreas'}}]:[];
  /* Sin el ojo de «Guardar o abrir vistas» (FB_2026_020): «Vistas guardadas» está en el menú lateral, en Trabajo. */
  const items=[...mine,...(tab().views||[]).filter(v=>!v.deleted).map(v=>({label:v.name,active:shellViewMatches(v),attrs:{'data-quick-view':v.id,title:'Aplicar la vista guardada'}}))];
  return items.length?K.renderQuickViews({label:'Vistas guardadas',items}):null;
}
function shellMenuParts(){
  const K=IkisaiKit,alias=myAlias();
  const aliasBtn=K.el('button',{type:'button',class:'softbtn small aliasbtn',id:'aliasBtn','data-tip':alias?'Yo: '+alias:'¿Quién eres?','aria-label':alias?'Alias: '+alias:'Elegir quién eres'},shellIcon('user'),K.el('span',null,alias||'Yo'));
  const theme=shellNode(themeToggleButton());theme.className=`tabtool themetoggle${isDarkTheme()?' dark':''}`;
  return K.renderNavMenu({label:'Navegación principal',headerClass:'menuheader',groupClass:'menugroup',itemClass:'menuitem',closeAttrs:{id:'closeMenu'},
    header:[aliasBtn,theme],
    groups:shellGroups().map(g=>({label:g.name,icon:shellIcon(g.icon),open:expandedMenuGroups.has(g.id),attrs:{'data-menu-group':g.id,hidden:g.id==='organize'},
      items:g.items.map(([id,name,icon,type])=>({label:name,icon:shellIcon(icon),active:shellItemActive(id,type),attrs:type==='view'?{'data-menu-view':id}:{'data-action':id}}))})),
    hint:shellHint()});
}
function shellHint(){const K=IkisaiKit;return state.taskScope==='all'?K.el('span',null,'Vista ',K.el('strong',null,'General'),' · todas las áreas'):K.el('span',null,'Área actual: ',K.el('strong',null,tab()?.name||''))}
/* Lo que obliga a reconstruir el menú: sus grupos y elementos, quién es el actor y con qué permisos, el alias y el tema. */
function shellMenuKey(){return JSON.stringify([shellGroups().map(g=>[g.id,g.name,g.items.map(i=>[i[0],i[1],i[3]])]),Sync.actor?.id,Sync.actor?.role,Sync.actor?.scopes,typeof isAdministrator==='function'&&isAdministrator(),tab()?.restricted,myAlias(),isDarkTheme()])}

let shellMenuStamp='';
let tasksLauncher=null;
function shellLauncher(){return tasksLauncher||=IkisaiKit.createAppLauncher({current:'tasks',fetchApps:()=>Sync.core.api('/apps')})}
function shellMount(){
  const K=IkisaiKit,app=document.getElementById('app');
  const more=K.el('button',{type:'button',class:'iconbtn mobile-only',id:'moreBtn','aria-label':'Menú principal','aria-controls':'kebab','aria-expanded':'false'},shellIcon('menu'));
  // La marca lleva el icono de Tasks del kit, como el resto de apps (Booking la cama, Central la cuadrícula…).
  const bar=K.renderWorkspaceBar({name:'Ikisai Tasks',rowClass:'brandrow',markButton:true,markIcon:'tasks',tools:[more],rows:[shellTabs(),shellViews()]});
  // La marca abre el lanzador común: las apps de Ikisai a las que tiene acceso esta cuenta.
  shellLauncher().attach(bar.querySelector('#appLauncher'));
  const menu=shellMenuParts();menu.id='kebab';shellMenuStamp=shellMenuKey();
  const v=state.view,item=(id,label,icon)=>({label,icon,active:v===id||id==='projects'&&v==='project',attrs:{'data-nav':id}});
  const nav=K.renderTabBar({label:'Vistas',className:'bottomnav five',items:[item('home','Inicio','home'),item('projects','Proyectos','grid'),item('tasks','Tareas','tasks'),item('labels','Etiquetas','tag'),{label:'Filtros',icon:'filter',attrs:{id:'filterNav'}}]});
  app.replaceChildren(
    K.el('div',{class:'ikisai-kit shellkit',id:'shellTop',style:'display:contents'},bar,K.renderNavBackdrop({id:'menuBackdrop'}),menu),
    K.el('div',{id:'view',style:'display:contents'}),
    K.el('div',{class:'ikisai-kit shellkit',id:'shellBottom',style:'display:contents'},nav));
}
function shellSwap(selector,next){
  const old=document.querySelector(`#shellTop ${selector}`);
  if(!next){old?.remove();return}
  if(old){next.scrollLeft=old.scrollLeft;old.replaceWith(next);next.scrollLeft=old.scrollLeft}
  else document.querySelector('#shellTop .topbar.workspace')?.append(next);
}
function shellUpdate(){
  if(!document.getElementById('shellTop')||!document.getElementById('view')){shellMount();return}
  shellSwap('.tabstrip',shellTabs());
  shellSwap('.viewstrip',shellViews());
  const menu=document.getElementById('kebab'),key=shellMenuKey();
  if(menu&&key!==shellMenuStamp){
    // Mismo nav#kebab (conserva .show y el desplazamiento): solo cambia su contenido.
    const scroll=menu.scrollTop;menu.replaceChildren(...shellMenuParts().childNodes);menu.scrollTop=scroll;shellMenuStamp=key;
  }else if(menu){
    menu.querySelectorAll('.menuitem').forEach(b=>{const id=b.dataset.menuView;const on=!!id&&shellItemActive(id,'view');b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
    menu.querySelector('.navmenu-hint')?.replaceChildren(shellHint());
  }
  const v=state.view;
  document.querySelectorAll('#shellBottom .navbtn[data-nav]').forEach(b=>{const id=b.dataset.nav,on=v===id||id==='projects'&&v==='project';b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
}
/* Sin sesión o sin ningún área no hay cáscara que pintar: render() no hace nada y deja intactas la entrada y las pantallas que
   sustituyen #app (arranque, «Primera área», «sin áreas compartidas»). Antes ocurría lo mismo de rebote (topbar() fallaba sin
   áreas y abortaba el render()); ahora es explícito. */
const renderBeforeShell=render;
render=function(){if(!Sync.actor||!state.tabs?.some(t=>!t.deleted))return;return renderBeforeShell()};
