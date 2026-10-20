/* Cáscara con el kit común, con estado (docs/tasks/UI_KIT.md §6 y ciclo de pintado acordado en la ronda 19), con el menú
   común del kit (MUELA-083 §4, tanda 31).
   La cáscara (barra con áreas y vistas guardadas, menú común y navegación inferior) se monta UNA vez dentro de #app y
   render() solo repinta #view (main() + fab()). shellUpdate(), llamada al principio de cada render():
   - monta la cáscara si no existe (#app lo sustituyen el arranque de boot(), «Primera área», la de «sin áreas compartidas» de
     enterSession y la entrada al cerrar sesión);
   - reconcilia la tira de áreas (crear, renombrar, recolorear, borrar o restaurar llega por refreshModel() → render()) y la de
     vistas guardadas, conservando su desplazamiento horizontal;
   - vuelve a pintar el menú solo si cambian navigationGroups(), el actor, sus permisos, el alias, el tema o el área (la pista
     «Área actual»); si no, lo deja como está (abierto, con su sección desplegada y su desplazamiento);
   - marca la vista activa en la navegación inferior.
   Menú común (createAppMenu del kit): la marca (#appLauncher) lo abre; ya no hay ☰ (#moreBtn) ni menú propio (#kebab).
   - Perfil (alias o nombre y rol; tocarlo abre «¿Quién eres?»), tema, línea de sincronización, recientes (las tres últimas
     tareas o proyectos abiertos), secciones = navigationGroups() sin «Organización» y sin lo que ya va en la barra de abajo
     (Inicio, Hoy, Proyectos, Tareas y Filtros; Etiquetas va en el menú desde MUELA-095), la pista «Área actual», las apps de Ikisai y «Sugerencias y QA» del
     lanzador, y «Cerrar sesión». Cada fila hace lo mismo que su botón de antes (navigateView o handleTopAction).
   - En el ordenador (≥ 1024 px), además, la columna fija de 316 px a la izquierda; la barra de pestañas va abajo también.
   - Se cierra con Escape, el fondo, «atrás» (el kit lo apila en la historia) y al navegar (closeNavigation).
   «‹ Volver a…» (K9): si se llegó desde otra app con ?volver=…, el enlace sale arriba del contenido.
   Ganchos conservados: .brandrow con .spacer (#syncBadge y #appUpdate se colocan ahí), .tabstrip con button.tabpill[data-tab]
   (.active, .colored), [data-general-area], .tabcount, .viewstrip con [data-quick-view], [data-quick-mine] (.viewpill.mine),
   nav.bottomnav(.five) con button.navbtn[data-nav] y #filterNav.
   Los manejadores siguen en bind() de cada módulo: los de la cáscara se asignan con onclick, así que repetir bind() no los
   acumula sobre los elementos que se conservan. */
function shellIcon(name){const t=document.createElement('template');t.innerHTML=menuIcon(name).trim();return t.content.firstElementChild}
function shellNode(html){const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstElementChild}
function shellViewMatches(v){return state.view==='tasks'&&(state.search||'')===(v.search||'')&&JSON.stringify(state.filters||{})===JSON.stringify(v.filters||{})&&(state.groupBy||'project')===(v.groupBy||'project')}
function shellGroups(){return navigationGroups().map(g=>({...g,items:g.items.filter(i=>i[4]!==false)})).filter(g=>g.items.length)}
function shellItemActive(id,type){return type==='view'&&(state.view===id||id==='projects'&&state.view==='project')}

function shellTabs(){
  const K=IkisaiKit,general=state.taskScope==='all';
  /* Sin el lápiz de «Áreas de trabajo» (FB_2026_020): está en el menú, en Trabajo. */
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
  /* Sin el ojo de «Guardar o abrir vistas» (FB_2026_020): «Vistas guardadas» está en el menú, en Trabajo. */
  const items=[...mine,...(tab().views||[]).filter(v=>!v.deleted).map(v=>({label:v.name,active:shellViewMatches(v),attrs:{'data-quick-view':v.id,title:'Aplicar la vista guardada'}}))];
  return items.length?K.renderQuickViews({label:'Vistas guardadas',items}):null;
}
function shellHint(){const K=IkisaiKit;return state.taskScope==='all'?K.el('span',null,'Vista ',K.el('strong',null,'General'),' · todas las áreas'):K.el('span',null,'Área actual: ',K.el('strong',null,tab()?.name||''))}

/* --- Menú común ------------------------------------------------------------------------------------------------------ */
/* Lo que ya está en la barra de pestañas de abajo no se repite en el menú. */
/* «Hoy» (MUELA-095) entra después de Inicio. Con seis pestañas, a 360 px «Proyectos» y «Etiquetas» se cortaban (54 y 51 px de
   texto en 50 px de hueco): «Etiquetas» pasa al menú, en Trabajo, donde sigue a un toque. El outsider sigue con su barra. */
const TASKS_TABBAR=new Set(['home','today','projects','tasks','filters']);
/* Iconos del menú de Tasks → iconos del kit (los que no tienen equivalente van sin icono). */
const MENU_KIT_ICONS={tasks:'tasks',grid:'grid',filter:'filter',view:'eye',archive:'list',trash:'trash',tag:'tag',areas:'grid',data:'download',upload:'upload',download:'download',file:'list',copy:'copy',people:'people',key:'lock',agent:'bot',settings:'settings',sync:'sync',history:'history',help:'help',user:'user',cart:'cart',space:'pin',trade:'briefcase',home:'home',proposal:'edit',triage:'list',box:'list',route:'list'};
function shellRowMark(id){return (typeof MENU_MARKS!=='undefined'&&MENU_MARKS[id]?.feedbackId)||'tasks.menu.fila'}
function shellMenuAct(id,type){if(type==='view')return navigateView(id);return handleTopAction(id)}
function shellMenuSections(){
  return shellGroups().filter(g=>g.id!=='organize').map(g=>({key:g.id,label:g.name,icon:MENU_KIT_ICONS[g.icon]||null,
    rows:g.items.filter(i=>!TASKS_TABBAR.has(i[0])).map(([id,name,icon,type])=>({label:name,icon:MENU_KIT_ICONS[icon]||null,feedbackId:shellRowMark(id),onClick:()=>shellMenuAct(id,type)}))}))
    .filter(s=>s.rows.length)}
function shellRole(){const a=Sync.actor;if(!a)return '';if(a.outsider)return 'Acceso de fuera';if(a.kind==='agent')return 'Agente';return a.role==='owner'?(a.scopes==='*'?'Propietaria':'Propietaria de lo suyo'):a.role==='editor'?'Edición':'Solo lectura'}
/* Recientes: las tareas y proyectos abiertos en este dispositivo, los tres últimos que se siguen viendo. */
const RECENTS_KEY='ikisai-tasks-recientes';
function shellRecentList(){try{const v=JSON.parse(localStorage.getItem(RECENTS_KEY)||'[]');return Array.isArray(v)?v:[]}catch{return []}}
function rememberRecent(kind,id,area){if(!id||!area)return;const list=shellRecentList().filter(r=>!(r.kind===kind&&r.id===id));list.unshift({kind,id,area});try{localStorage.setItem(RECENTS_KEY,JSON.stringify(list.slice(0,8)))}catch{}}
function shellRecents(){const out=[];
  for(const r of shellRecentList()){if(out.length>=3)break;const area=state.tabs.find(t=>t.id===r.area&&!t.deleted);if(!area)continue;
    if(r.kind==='task'){const hit=withArea(area.id,()=>taskLocation(r.id));if(!hit||hit.t.deleted||hit.p.deleted)continue;
      out.push({label:hit.t.text,sub:`${hit.p.title} · ${area.name}`,icon:'tasks',feedbackId:'tasks.menu.recientes.tarea',onClick:()=>{state.activeTab=area.id;state.currentProject=hit.p.id;openTaskEditor(r.id)}})}
    else{const p=area.projects.find(x=>x.id===r.id&&!x.deleted&&x.status!=='archived');if(!p)continue;
      out.push({label:p.title,sub:area.name,icon:'grid',feedbackId:'tasks.menu.recientes.proyecto',onClick:()=>{closeSheet();state.activeTab=area.id;state.taskScope='area';state.view='project';state.currentProject=p.id;persistUI();render()}})}}
  return out}
/* Lo que obliga a volver a pintar el menú: sus secciones y filas, quién es el actor y con qué permisos, el alias, el tema y
   el área (la pista). */
function shellMenuKey(){return JSON.stringify([shellGroups().map(g=>[g.id,g.name,g.items.map(i=>[i[0],i[1],i[3]])]),Sync.actor?.id,Sync.actor?.role,Sync.actor?.scopes,typeof isAdministrator==='function'&&isAdministrator(),tab()?.restricted,myAlias(),isDarkTheme(),state.taskScope,tab()?.id,tab()?.name])}
let tasksMenu=null,shellMenuStamp='';
/* Las apps y «Sugerencias y QA» del lanzador real (feedback-ui.js), creado cuando ya hay núcleo. */
const shellLauncherInMenu={open:()=>tasksRealLauncher().open(),mount:(host,options)=>tasksRealLauncher().mount(host,options),attach(){}};
function shellMenu(){
  if(tasksMenu)return tasksMenu;
  const K=IkisaiKit;
  tasksMenu=K.createAppMenu({label:'Menú de Tasks',theme:true,column:true,feedbackId:'tasks.menu',
    // El kit lee el perfil en cada pintado: alias o nombre y rol del actor de ese momento.
    get profile(){return Sync.actor?shellProfile():null},recents:shellRecents,sections:shellMenuSections,
    blocks:()=>[K.el('p',{class:'hint tasks-menuhint'},shellHint())],
    launcher:shellLauncherInMenu,
    onSyncLine:()=>handleTopAction('sync')},
    {appName:'Tasks',navigate:hash=>{location.hash=hash},onSync:()=>syncNow(),onLogout:()=>logoutAccount()});
  return tasksMenu}
/* El perfil depende del actor y del alias: se recalcula en cada pintado del menú (las opciones son del objeto que guarda el kit). */
function shellProfile(){const name=myAlias()||Sync.actor?.name||'Yo';return {name,role:shellRole(),href:'#quien',onOpen:()=>aliasSheet()}}
function shellMenuRefresh(){shellMenuStamp=shellMenuKey();shellMenu().refresh()}
function closeShellMenu(){tasksMenu?.close()}

function shellReturnLink(){
  const K=IkisaiKit,origin=K.readReturnTo?.();if(!origin)return null;
  return K.el('a',{class:'return-link',href:origin.url,'data-feedback-id':'tasks.cabecera.volver','data-feedback-label':'Volver a la otra app',onclick:()=>K.clearReturnTo()},
    K.icon('chevronLeft',18),K.el('span',null,`Volver a ${origin.title||origin.from||'la app anterior'}`))}

let tasksLauncher=null;
function shellLauncher(){return tasksLauncher||=IkisaiKit.createAppLauncher({current:'tasks',fetchApps:()=>Sync.core.api('/apps')})}
function shellMount(){
  const K=IkisaiKit,app=document.getElementById('app');
  // La marca lleva el icono de Tasks del kit, como el resto de apps (Booking la cama, Central la cuadrícula…), y abre el menú.
  const bar=K.renderWorkspaceBar({name:'Ikisai Tasks',rowClass:'brandrow',markButton:true,markIcon:'tasks',tools:[],rows:[shellTabs(),shellViews()]});
  const menu=shellMenu();menu.attach(bar.querySelector('#appLauncher'));
  shellMenuStamp=shellMenuKey();menu.refresh();
  const v=state.view,item=(id,label,icon)=>({label,icon,active:v===id||id==='projects'&&v==='project',attrs:{'data-nav':id}});
  /* «Hoy» (MUELA-095, hoy-ui.js), después de Inicio; el outsider no tiene plan y conserva su barra de siempre. */
  const outsider=!!Sync.actor?.outsider;
  const nav=K.renderTabBar({label:'Vistas',className:'bottomnav five',items:[item('home','Inicio','home'),...(outsider?[]:[item('today','Hoy','sun')]),item('projects','Proyectos','grid'),item('tasks','Tareas','tasks'),...(outsider?[item('labels','Etiquetas','tag')]:[]),{label:'Filtros',icon:'filter',attrs:{id:'filterNav'}}]});
  app.replaceChildren(
    K.el('div',{class:'ikisai-kit shellkit',id:'shellTop',style:'display:contents'},shellWide.matches?menu.column:null,bar,shellReturnLink()),
    K.el('div',{id:'view',style:'display:contents'}),
    K.el('div',{class:'ikisai-kit shellkit',id:'shellBottom',style:'display:contents'},nav));
}
/* La columna del menú solo está en la página en el ordenador: en el móvil, el cajón es el único menú (sin filas repetidas). */
const shellWide=matchMedia('(min-width:1024px)');
shellWide.addEventListener('change',()=>{const top=document.getElementById('shellTop'),column=tasksMenu?.column;if(!top||!column)return;
  if(shellWide.matches){top.prepend(column);tasksMenu.refresh()}else column.remove()});
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
  if(shellMenuKey()!==shellMenuStamp)shellMenuRefresh();
  const v=state.view;
  document.querySelectorAll('#shellBottom .navbtn[data-nav]').forEach(b=>{const id=b.dataset.nav,on=v===id||id==='projects'&&v==='project';b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
}
/* La línea de sincronización del menú sigue al estado de siempre (la insignia #syncBadge). */
const setModeBeforeShell=setMode;
setMode=function(...args){const out=setModeBeforeShell(...args);try{if(tasksMenu&&Sync.core)tasksMenu.setStatus(Sync.core.status())}catch{}return out};
/* Recientes: cada tarea o proyecto que se abre. */
const openTaskEditorBeforeShell=openTaskEditor;
openTaskEditor=function(id,...rest){const out=openTaskEditorBeforeShell(id,...rest);if(id&&taskLocation(id))rememberRecent('task',id,state.activeTab);return out};
let shellLastProject='';
/* Sin sesión o sin ningún área no hay cáscara que pintar: render() no hace nada y deja intactas la entrada y las pantallas que
   sustituyen #app (arranque, «Primera área», «sin áreas compartidas»). Antes ocurría lo mismo de rebote (topbar() fallaba sin
   áreas y abortaba el render()); ahora es explícito. */
const renderBeforeShell=render;
render=function(){if(!Sync.actor||!state.tabs?.some(t=>!t.deleted))return;
  const out=renderBeforeShell();
  const key=state.view==='project'?`${state.activeTab}|${state.currentProject}`:'';
  if(key&&key!==shellLastProject)rememberRecent('project',state.currentProject,state.activeTab);shellLastProject=key;
  return out};
