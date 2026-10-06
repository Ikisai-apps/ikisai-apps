/* Cáscara con el kit común, paso 1 (docs/tasks/UI_KIT.md §6): barra, áreas, vistas guardadas, menú agrupado y navegación
   inferior se siguen pintando como HTML en cada render(), ahora con las piezas sin estado del kit (IkisaiKit.renderWorkspaceBar,
   renderAreaTabs, renderQuickViews, renderNavMenu, renderTabBar) dentro de un envoltorio `.ikisai-kit` con `display:contents`
   (no crea caja: la barra sigue siendo pegajosa respecto a #app). Sustituye a la cadena de envoltorios de `topbar` y
   `bottomnav` (index.html, navigation-ui.js, scope-ui.js, filters-ui.js, cards-ui.js, extras-ui.js, theme-ui.js, home-ui.js y
   los inertes de access-ui.js, accounts-ui.js, csv-ui.js, features.js, history-ui.js), que se retiran.
   Ganchos conservados: .brandrow con .spacer (setMode inserta #syncBadge antes; updates.js añade #appUpdate al final),
   #moreBtn (aria-controls="kebab", aria-expanded), .tabstrip con button.tabpill[data-tab] (.active, .colored), [data-general-area],
   [data-areas-tool], .tabcount, .viewstrip con #savedViews, [data-quick-view], [data-quick-mine] (.viewpill.mine), nav#kebab
   (.show), #menuBackdrop (.show), #closeMenu, .menuheader con #aliasBtn y #themeToggle, details.menugroup[data-menu-group],
   button.menuitem[data-menu-view|data-action] con .menuicon, nav.bottomnav(.five) con button.navbtn[data-nav] y #filterNav.
   El grupo «Organización» se pinta oculto (`hidden`): sus etiquetas ya están en Trabajo (theme-ui.js) y las pruebas lo esperan.
   Los manejadores siguen en bind() de cada módulo. */
function shellIcon(name){const t=document.createElement('template');t.innerHTML=menuIcon(name).trim();return t.content.firstElementChild}
function shellNode(html){const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstElementChild}
function shellWrap(...children){return IkisaiKit.el('div',{class:'ikisai-kit shellkit',style:'display:contents'},...children).outerHTML}
function shellViewMatches(v){return state.view==='tasks'&&(state.search||'')===(v.search||'')&&JSON.stringify(state.filters||{})===JSON.stringify(v.filters||{})&&(state.groupBy||'project')===(v.groupBy||'project')}

function topbar(){
  const K=IkisaiKit,general=state.taskScope==='all',alias=myAlias();
  const tabs=K.renderAreaTabs({label:'Áreas de trabajo',
    leading:[K.renderStripTool({label:'Áreas de trabajo',icon:shellIcon('areasEdit'),attrs:{'data-areas-tool':'','data-tip':'Áreas de trabajo',title:null}})],
    items:[
      {label:'General',general:true,active:general,attrs:{'data-general-area':'',title:'Todas las áreas a la vez'}},
      ...activeAreas().map(t=>({label:t.name,active:!general&&t.id===state.activeTab,color:t.color||null,count:areaPending(t),attrs:{'data-tab':t.id}})),
    ]});
  let views=null;
  if(tab()){
    const mine=myTaskFilters()?[{label:'Mis tareas',icon:shellIcon('user'),className:'mine',active:isMyTasksView(),attrs:{'data-quick-mine':'',title:'Tareas con mi etiqueta en todas las áreas'}}]:[];
    views=K.renderQuickViews({label:'Vistas guardadas',
      leading:[K.renderStripTool({label:'Guardar o abrir vistas',icon:shellIcon('view'),className:'viewsave',attrs:{id:'savedViews','data-tip':'Guardar vista',title:null}})],
      items:[...mine,...(tab().views||[]).filter(v=>!v.deleted).map(v=>({label:v.name,active:shellViewMatches(v),attrs:{'data-quick-view':v.id,title:'Aplicar la vista guardada'}}))]});
  }
  const more=K.el('button',{type:'button',class:'iconbtn mobile-only',id:'moreBtn','aria-label':'Menú principal','aria-controls':'kebab','aria-expanded':'false'},shellIcon('menu'));
  const bar=K.renderWorkspaceBar({name:'Ikisai',rowClass:'brandrow',tools:[more],rows:[tabs,views]});
  // La marca de Tasks es su glifo de siempre, no el icono genérico del kit.
  const mark=bar.querySelector('.mark');mark.replaceChildren('•||•');mark.style.cssText='font-weight:800;letter-spacing:-2px;font-size:14px';
  const aliasBtn=K.el('button',{type:'button',class:'softbtn small aliasbtn',id:'aliasBtn','data-tip':alias?'Yo: '+alias:'¿Quién eres?','aria-label':alias?'Alias: '+alias:'Elegir quién eres'},shellIcon('user'),K.el('span',null,alias||'Yo'));
  const theme=shellNode(themeToggleButton());theme.className=`tabtool themetoggle${isDarkTheme()?' dark':''}`;
  const groups=navigationGroups().map(g=>({...g,items:g.items.filter(i=>i[4]!==false)})).filter(g=>g.items.length);
  const menu=K.renderNavMenu({label:'Navegación principal',attrs:{id:'kebab'},headerClass:'menuheader',groupClass:'menugroup',itemClass:'menuitem',closeAttrs:{id:'closeMenu'},
    header:[aliasBtn,theme],
    groups:groups.map(g=>({label:g.name,icon:shellIcon(g.icon),open:expandedMenuGroups.has(g.id),attrs:{'data-menu-group':g.id,hidden:g.id==='organize'},
      items:g.items.map(([id,name,icon,type])=>({label:name,icon:shellIcon(icon),active:type==='view'&&(state.view===id||id==='projects'&&state.view==='project'),attrs:type==='view'?{'data-menu-view':id}:{'data-action':id}}))})),
    hint:general?K.el('span',null,'Vista ',K.el('strong',null,'General'),' · todas las áreas'):K.el('span',null,'Área actual: ',K.el('strong',null,tab().name))});
  return shellWrap(bar,K.renderNavBackdrop({id:'menuBackdrop'}),menu);
}

function bottomnav(){
  const v=state.view,item=(id,label,icon)=>({label,icon,active:v===id||id==='projects'&&v==='project',attrs:{'data-nav':id}});
  return shellWrap(IkisaiKit.renderTabBar({label:'Vistas',className:'bottomnav five',items:[item('home','Inicio','home'),item('projects','Proyectos','grid'),item('tasks','Tareas','tasks'),item('labels','Etiquetas','tag'),{label:'Filtros',icon:'filter',attrs:{id:'filterNav'}}]}));
}
