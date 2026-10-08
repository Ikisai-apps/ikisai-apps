/* «Sugerencias y QA» y uso de funciones en Tasks (coordinacion/ampliacion/FEEDBACK.md y USO.md; referencia: Booking #227).
   - Kit 0.17: createFeedback (señalar para comentar, borradores y bandeja sin red), createFeedbackReview (modo revisor),
     createUsage (exposición, activación, éxito y error por función) y el lanzador con los dos interruptores. Se crean una
     vez, cuando ya hay núcleo (Sync.core), y se limpian al terminar la sesión de una cuenta (onSessionEnd).
   - «Sugerencias y QA» en el menú (grupo Sistema) abre el centro de reportes del kit.
   - Marcas `data-feedback-id` (`tasks.<pantalla>.<sección>.<elemento>`, sin ids de negocio) y `data-feedback-label`: aquí
     las de la cáscara y la pantalla actual, que crea el kit o se pintan por datos; el resto va escrito en cada plantilla.
     También son el catálogo de «Uso»: por eso los ids van escritos tal cual en los mapas, nunca construidos.
   - `usage.run` / `usage.track` en las operaciones importantes (crear, completar y borrar tareas; compras; entradas;
     importar y exportar). */
let tasksFeedbackParts=null;
function tasksFeedback(){
  if(tasksFeedbackParts||!Sync.core)return tasksFeedbackParts;
  const K=IkisaiKit,api=(path,init)=>Sync.core.api(path,init),userId=()=>Sync.core.bootstrap()?.profile.userId??null;
  // La hoja del kit va acotada a .ikisai-kit (vite.config.ts): sus capas (formulario, marcas) cuelgan de un contenedor
  // con esa clase en lugar de body, o quedarían sin estilo y debajo del menú heredado.
  const container=()=>document.getElementById('feedbackHost')||document.body.appendChild(K.el('div',{class:'ikisai-kit',id:'feedbackHost',style:'display:contents'}));
  const feedback=K.createFeedback({app:'tasks',api,userId,container,role:()=>Sync.core.bootstrap()?.membership.role??null,
    syncSummary:()=>{const s=Sync.core.status();return {pending:s.pendingCommands+s.pendingBlobs,conflicts:s.conflicts,lastSyncAt:s.lastPullAt,cursor:s.cursor}},
    fallbackNode:()=>{const s=screenMark();return {id:s.feedbackId,path:[s.label]}}});
  let catalog=null;
  const review=K.createFeedbackReview({api,app:'tasks',container,appDomain:id=>catalog?.items?.find(a=>a.id===id)?.domain});
  const tracker=K.createUsage({app:'tasks',api,userId});
  Sync.core.onSessionEnd(id=>{void feedback.clear(id);void tracker.clear(id)});
  return tasksFeedbackParts={feedback,review,usage:tracker,setCatalog:c=>{catalog=c}};
}
/* Uso: nunca bloquea ni falla. Sin núcleo todavía, la operación se ejecuta sin contar. */
const usage={
  run:(id,fn)=>{const u=tasksFeedback()?.usage;return u?u.run(id,fn):Promise.resolve().then(fn)},
  track:(id,outcome='success')=>{try{const counter=tasksFeedback()?.usage;if(counter)counter.track(id,outcome)}catch{}},
};

/* Lanzador con los interruptores «Señalar para comentar» y «Revisor de QA», y la entrada «Sugerencias y QA», en #kitLayer
   (CSS del kit acotado). La cáscara puede montarse antes de que haya núcleo: engancha un envoltorio ligero y el lanzador
   del kit se crea al primer toque, ya con el feedback; así nunca queda guardado uno sin interruptores. */
function tasksRealLauncher(){
  if(tasksLauncher)return tasksLauncher;const p=tasksFeedback();
  const launcher=IkisaiKit.createAppLauncher({current:'tasks',container:sheetKitLayer,fetchApps:async()=>{const c=await Sync.core.api('/apps');p?.setCatalog(c);return c},
    ...(p?{feedback:p.feedback.mode,review:{get:()=>p.review.mode.get(),set:on=>p.review.mode.set(on),available:()=>p.review.available()},center:openTasksFeedbackCenter}:{})});
  if(p)tasksLauncher=launcher;return launcher}
shellLauncher=function(){return {attach(trigger){if(!trigger)return;trigger.setAttribute('aria-haspopup','dialog');trigger.onclick=()=>{void tasksRealLauncher().open()}}}};

/* «Sugerencias y QA» en el menú. */
Object.assign(menuPaths,{help:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14 M12 17.5v.01'});
const navigationBeforeFeedback=navigationGroups;
navigationGroups=function(){const groups=navigationBeforeFeedback(),system=groups.find(g=>g.id==='system');
  if(system&&Sync.core)system.items.unshift(['feedbackCenter','Sugerencias y QA','help','action']);return groups};
function openTasksFeedbackCenter(){const p=tasksFeedback();if(!p)return toast('Aún no hay conexión con la cuenta.');
  // Como las hojas heredadas (index.html): dentro de #kitLayer, que lleva .ikisai-kit, para que el CSS acotado del kit la pinte.
  closeNavigation?.();IkisaiKit.openFeedbackCenter({api:(path,init)=>Sync.core.api(path,init),app:'tasks',canEdit:()=>canEdit(),feedback:p.feedback,container:sheetKitLayer})}
const actionBeforeFeedback=handleTopAction;
handleTopAction=function(action){if(action==='feedbackCenter')return openTasksFeedbackCenter();return actionBeforeFeedback(action)};

/* --- Marcas -------------------------------------------------------------------------------------------------------- */
function fbMark(node,mark){if(node&&mark){node.setAttribute('data-feedback-id',mark.feedbackId);node.setAttribute('data-feedback-label',mark.label)}return node}
const SCREEN_MARKS={
  home:{feedbackId:'tasks.inicio',label:'Inicio'},projects:{feedbackId:'tasks.proyectos',label:'Proyectos'},project:{feedbackId:'tasks.proyecto',label:'Proyecto'},
  tasks:{feedbackId:'tasks.tareas',label:'Todas las tareas'},labels:{feedbackId:'tasks.etiquetas',label:'Etiquetas'},archive:{feedbackId:'tasks.archivados',label:'Archivados'},
  trash:{feedbackId:'tasks.papelera',label:'Papelera'},inbox:{feedbackId:'tasks.entrada',label:'Entrada'},purchases:{feedbackId:'tasks.compras',label:'Solicitudes de compra'},
  supplies:{feedbackId:'tasks.suministros',label:'Suministros'},plans:{feedbackId:'tasks.planes',label:'Planes de compra'},triage:{feedbackId:'tasks.por_clasificar',label:'Por clasificar'},
  feedback:{feedbackId:'tasks.reporte',label:'Reporte de Feedback'},board:{feedbackId:'tasks.tablero',label:'Tablero'},calendar:{feedbackId:'tasks.calendario',label:'Calendario'},
};
const OTHER_SCREEN={feedbackId:'tasks.pantalla',label:'Pantalla'};
function screenMark(){return SCREEN_MARKS[state.view]||OTHER_SCREEN}
const MENU_MARKS={
  projects:{feedbackId:'tasks.menu.proyectos',label:'Proyectos'},tasks:{feedbackId:'tasks.menu.tareas',label:'Todas las tareas'},filters:{feedbackId:'tasks.menu.filtros',label:'Filtros'},
  views:{feedbackId:'tasks.menu.vistas',label:'Vistas guardadas'},archive:{feedbackId:'tasks.menu.archivados',label:'Archivados'},trash:{feedbackId:'tasks.menu.papelera',label:'Papelera'},
  home:{feedbackId:'tasks.menu.inicio',label:'Inicio'},mine:{feedbackId:'tasks.menu.mis_tareas',label:'Mis tareas'},labels:{feedbackId:'tasks.menu.etiquetas',label:'Etiquetas'},
  areas:{feedbackId:'tasks.menu.areas',label:'Áreas de trabajo'},triage:{feedbackId:'tasks.menu.por_clasificar',label:'Por clasificar'},
  purchases:{feedbackId:'tasks.menu.compras',label:'Solicitudes de compra'},supplies:{feedbackId:'tasks.menu.suministros',label:'Suministros'},plans:{feedbackId:'tasks.menu.planes',label:'Planes de compra'},
  import:{feedbackId:'tasks.menu.importar_json',label:'Importar JSON'},export:{feedbackId:'tasks.menu.exportar_json',label:'Exportar JSON'},csvImport:{feedbackId:'tasks.menu.importar_csv',label:'Importar CSV'},
  csvExport:{feedbackId:'tasks.menu.exportar_csv',label:'Exportar CSV'},keep:{feedbackId:'tasks.menu.importar_keep',label:'Importar texto de Keep'},readable:{feedbackId:'tasks.menu.exportar_texto',label:'Exportar texto legible'},
  portableImport:{feedbackId:'tasks.menu.importar_portable',label:'Importar con adjuntos'},portableExport:{feedbackId:'tasks.menu.exportar_portable',label:'Exportar con adjuntos'},
  backup:{feedbackId:'tasks.menu.respaldo',label:'Respaldo completo'},users:{feedbackId:'tasks.menu.cuentas',label:'Cuentas de personas'},accesses:{feedbackId:'tasks.menu.accesos',label:'Accesos y agentes'},
  proposals:{feedbackId:'tasks.menu.propuestas',label:'Propuestas de agentes'},sessions:{feedbackId:'tasks.menu.mi_cuenta',label:'Mi cuenta'},sync:{feedbackId:'tasks.menu.sincronizacion',label:'Sincronización'},
  history:{feedbackId:'tasks.menu.historial',label:'Historial de cambios'},accessLog:{feedbackId:'tasks.menu.registro_accesos',label:'Registro de accesos'},
  feedbackCenter:{feedbackId:'tasks.menu.sugerencias',label:'Sugerencias y QA'},
};
const NAV_MARKS={home:{feedbackId:'tasks.navegacion.inicio',label:'Inicio'},projects:{feedbackId:'tasks.navegacion.proyectos',label:'Proyectos'},
  tasks:{feedbackId:'tasks.navegacion.tareas',label:'Tareas'},labels:{feedbackId:'tasks.navegacion.etiquetas',label:'Etiquetas'}};
const SHELL_MARKS=[
  ['#shellTop .topbar',{feedbackId:'tasks.cabecera',label:'Cabecera'}],['#appLauncher',{feedbackId:'tasks.cabecera.lanzador',label:'Lanzador de apps'}],
  ['#moreBtn',{feedbackId:'tasks.cabecera.menu',label:'Menú'}],['#syncBadge',{feedbackId:'tasks.cabecera.estado',label:'Estado de sincronización'}],
  ['#appUpdate',{feedbackId:'tasks.cabecera.actualizar',label:'Actualizar la app'}],
  ['[data-general-area]',{feedbackId:'tasks.cabecera.areas.general',label:'General'}],['[data-areas-tool]',{feedbackId:'tasks.cabecera.areas.gestionar',label:'Áreas de trabajo'}],
  ['#shellTop #savedViews',{feedbackId:'tasks.cabecera.vistas.guardar',label:'Guardar vista'}],['[data-quick-mine]',{feedbackId:'tasks.cabecera.vistas.mis_tareas',label:'Mis tareas'}],
  ['#kebab',{feedbackId:'tasks.menu',label:'Menú'}],['#closeMenu',{feedbackId:'tasks.menu.cerrar',label:'Cerrar el menú'}],
  ['#aliasBtn',{feedbackId:'tasks.menu.alias',label:'Mi alias'}],['#themeToggle',{feedbackId:'tasks.menu.tema',label:'Tema claro u oscuro'}],
  ['#shellBottom .bottomnav',{feedbackId:'tasks.navegacion',label:'Navegación'}],['#filterNav',{feedbackId:'tasks.navegacion.filtros',label:'Filtros'}],
  ['.fab',{feedbackId:'tasks.nueva',label:'Añadir'}],
];
function markShell(){
  for(const [selector,mark] of SHELL_MARKS)document.querySelectorAll(selector).forEach(n=>fbMark(n,mark));
  // Áreas y vistas guardadas: una marca por clase de elemento, nunca con su id.
  document.querySelectorAll('#shellTop [data-tab]').forEach(n=>fbMark(n,{feedbackId:'tasks.cabecera.areas.area',label:'Área'}));
  document.querySelectorAll('#shellTop [data-quick-view]').forEach(n=>fbMark(n,{feedbackId:'tasks.cabecera.vistas.vista',label:'Vista guardada'}));
  document.querySelectorAll('#kebab [data-menu-view],#kebab [data-action]').forEach(n=>fbMark(n,MENU_MARKS[n.dataset.menuView||n.dataset.action]));
  document.querySelectorAll('#kebab details.menugroup > summary').forEach(n=>fbMark(n,{feedbackId:'tasks.menu.grupo',label:'Grupo del menú'}));
  document.querySelectorAll('#shellBottom [data-nav]').forEach(n=>fbMark(n,NAV_MARKS[n.dataset.nav]));
  const main=document.querySelector('#view main');if(main)fbMark(main,screenMark());
}
const renderBeforeFeedback=render;
render=function(...args){const out=renderBeforeFeedback(...args);try{markShell()}catch(e){console.warn('Marcas de feedback',e)}return out};

/* --- Uso: operaciones importantes ------------------------------------------------------------------------------------ */
const recordBeforeUsage=record;
record=function(action,ids){recordBeforeUsage(action,ids);
  if(action==='create')usage.track('tasks.tarea.crear');
  else if(action==='complete')usage.track('tasks.tarea.completar');
  else if(action==='reopen')usage.track('tasks.tarea.reabrir');
  else if(action==='delete')usage.track('tasks.tarea.borrar');
  else if(action==='restore')usage.track('tasks.tarea.restaurar');
  else if(action==='move')usage.track('tasks.tarea.mover')};

const portableExportBeforeUsage=portableExport;
portableExport=function(...args){return usage.run('tasks.datos.exportar_portable',()=>portableExportBeforeUsage(...args))};
const backupBeforeUsage=downloadServerBackup;
downloadServerBackup=function(...args){return usage.run('tasks.datos.respaldo',()=>backupBeforeUsage(...args))};

/* Red de seguridad: las hojas y diálogos del kit que aún se monten en body sin contenedor se pasan a #kitLayer,
   que lleva .ikisai-kit: con el CSS del kit acotado (vite.config.ts), fuera de ahí salen sin estilo y debajo de la cáscara. */
new MutationObserver(changes=>{for(const change of changes)for(const node of change.addedNodes){
  if(node.nodeType===1&&node.parentNode===document.body&&node.matches('.sheetback,.dialogback'))sheetKitLayer().appendChild(node)}})
  .observe(document.body,{childList:true});
