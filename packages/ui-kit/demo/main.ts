/* Muestra de @ikisai/ui-kit: tokens, componentes, barra de estado, login y shell. Sin red ni cliente real. */
import '../src/styles/ui-kit.css';
import './demo.css';
import type { PendingConflict, RejectedBatch, SyncStatus } from '@ikisai/sync-client';
import {
  createFeedback,
  createFeedbackProgressiveForm,
  openFeedbackCenter,
  createFeedbackReview,
  createUsage,
  showUsageNotice,
  type FeedbackApi,
  createAppLauncher,
  renderProposalReview,
  createColorField,
  addDays,
  alertDialog,
  closeSheet,
  compressImage,
  createCalendar,
  createDateField,
  createLabelPicker,
  labelChips,
  renderMoneyBreakdown,
  openProposalReview,
  renderSecretOnce,
  renderRiskSummary,
  renderProposalRow,
  renderChangeList,
  renderAccessLog,
  createScopePicker,
  type ChangeItem,
  type ProposalSummary,
  renderWorkspaceBar,
  renderAreaTabs,
  renderStripTool,
  renderQuickViews,
  renderNavMenu,
  renderTabBar,
  renderProjectCard,
  createPrintView,
  createQuantityField,
  createSortableList,
  positionBetween,
  todayKey,
  applyAccent,
  applyTheme,
  confirmDialog,
  createAppShell,
  createCommandPalette,
  createStatusBar,
  createThemeSelect,
  createThemeToggle,
  el,
  icon,
  itemColorStyle,
  openImportSheet,
  openSheet,
  renderConflicts,
  renderLogin,
  renderList,
  renderRejectedList,
  replace,
  statusBanners,
  toast,
  toastWithAction,
  toggleTheme,
} from '../src/index.ts';

applyTheme();

const base: SyncStatus = { network: 'online', cursor: 42, pendingCommands: 0, pendingBlobs: 0, conflicts: 0, lastPullAt: new Date().toISOString(), lastError: null, autoMerged: 0, rejected: 0 };
const STATES: Array<{ name: string; status: SyncStatus }> = [
  { name: 'En línea, todo sincronizado', status: base },
  { name: 'Sincronizando', status: { ...base, network: 'syncing', pendingCommands: 2 } },
  { name: 'Sin conexión con pendientes', status: { ...base, network: 'offline', pendingCommands: 3, pendingBlobs: 1 } },
  { name: 'Conflictos', status: { ...base, conflicts: 2, pendingCommands: 1 } },
  { name: 'Error de red', status: { ...base, network: 'error', pendingCommands: 1, lastError: { status: 503, code: 'BACKEND_UNAVAILABLE', message: 'El servidor no responde.', details: null } } },
  { name: 'Rechazados', status: { ...base, rejected: 2 } },
  { name: 'Cambio de persona', status: { ...base, lastError: { status: 0, code: 'USER_CHANGED', message: 'Otra persona ha entrado.', details: null } } },
];
const BANNER_ACTIONS = { onResolveConflicts: () => toast('Ir a conflictos'), onRetry: () => toast('Reintentando…'), describeError: (e: SyncStatus['lastError']) => e?.message ?? '', onShowRejected: () => toast('Ver rechazados'), onRetryRejected: () => toast('Reintentar rechazados'), onDiscardRejected: () => toast('Descartar rechazados') };

function section(id: string, title: string, intro: string, ...children: Parameters<typeof el>[2][]): HTMLElement {
  return el('section', { class: 'demo-section', id }, el('h2', null, title), el('p', { class: 'muted demo-intro' }, intro), ...children);
}

function swatch(name: string): HTMLElement {
  return el('div', { class: 'swatch' }, el('span', { class: 'swatch-color', style: `background:var(${name})` }), el('code', null, name));
}

// --- Tokens -----------------------------------------------------------------
const accentInput = el('input', { type: 'color', id: 'accentPicker', value: '#3f6d8e', 'aria-label': 'Color de acento de prueba', oninput: () => applyAccent(accentInput.value) });
const tokens = section('tokens', 'Tokens', 'Superficies, tinta, acento derivado y semánticos. El acento lo puede fijar la app con el color que elija la persona; prueba uno:',
  el('div', { class: 'demo-row' },
    el('label', { class: 'field inline' }, el('span', null, 'Acento'), accentInput),
    el('button', { class: 'ghost small', type: 'button', id: 'accentReset', onclick: () => applyAccent(null) }, 'Acento neutro'),
    el('button', { class: 'ghost small', type: 'button', id: 'themeToggle', onclick: () => { const next = toggleTheme(); toast(`Tema ${next === 'dark' ? 'oscuro' : 'claro'}`); } }, icon('moon', 16), 'Claro / oscuro'),
  ),
  el('div', { class: 'swatches' }, ...['--bg', '--paper', '--paper-2', '--ink', '--muted', '--line', '--accent', '--accent-deep', '--accent-soft', '--warn', '--warn-soft', '--alert', '--alert-soft', '--ok', '--ok-soft'].map(swatch)),
  el('div', { class: 'type-sample' },
    el('h1', null, 'Fraunces para títulos y cifras'),
    el('p', null, 'Inter para todo lo demás: texto, botones, formularios. Ambas alojadas por la app en /fonts.'),
    el('p', { class: 'serif demo-num' }, '1 234,56 €'),
  ),
);

// --- Botones, campos, chips ---------------------------------------------------
const controls = section('controls', 'Botones, campos y chips', 'Objetivo táctil de 46 px; variantes pequeñas de 36 px. Los select e input sueltos (fuera de .field) llevan la misma piel; .compact los deja en 36 px para filtros y filas.',
  el('div', { class: 'demo-row', id: 'looseControls' },
    el('select', { id: 'looseSelect', 'aria-label': 'Estado' }, el('option', null, 'Todos los estados'), el('option', null, 'Borrador'), el('option', null, 'Validado')),
    el('input', { type: 'search', placeholder: 'Buscar…', 'aria-label': 'Buscar' }),
    el('select', { class: 'compact', 'aria-label': 'Servicio' }, el('option', null, 'Comida'), el('option', null, 'Cena')),
    el('input', { type: 'time', class: 'compact', id: 'looseTime', value: '13:30', 'aria-label': 'Hora' }),
    el('input', { type: 'number', class: 'compact', value: '2', min: '0', 'aria-label': 'Raciones' }),
  ),
  el('div', { class: 'demo-row' },
    el('button', { class: 'primary', type: 'button' }, 'Primario'),
    el('button', { class: 'ghost', type: 'button' }, 'Secundario'),
    el('button', { class: 'danger', type: 'button' }, icon('trash', 18), 'Papelera'),
    el('button', { class: 'softbtn', type: 'button' }, icon('filter', 18), 'Filtros'),
    el('button', { class: 'softbtn active', type: 'button' }, 'Activo'),
    el('button', { class: 'linkbtn', type: 'button' }, 'Enlace'),
    el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Más' }, icon('more')),
    el('button', { class: 'primary', type: 'button', disabled: true }, 'Deshabilitado'),
  ),
  el('div', { class: 'demo-row' },
    el('button', { class: 'primary small', type: 'button' }, 'Pequeño'),
    el('button', { class: 'ghost small', type: 'button' }, 'Pequeño'),
    el('button', { class: 'iconbtn small', type: 'button', 'aria-label': 'Editar' }, icon('edit')),
  ),
  el('form', { class: 'demo-form', onsubmit: (e: Event) => e.preventDefault() },
    el('label', { class: 'field' }, el('span', null, 'Nombre'), el('input', { type: 'text', placeholder: 'Proveedor' })),
    el('div', { class: 'row2' },
      el('label', { class: 'field' }, el('span', null, 'Fecha'), el('input', { type: 'date' })),
      el('label', { class: 'field' }, el('span', null, 'Categoría'), el('select', null, el('option', null, 'Suministros'), el('option', null, 'Obra'))),
    ),
    el('label', { class: 'field invalid' }, el('span', null, 'NIF'), el('input', { type: 'text', value: 'X' }), el('span', { class: 'fielderror' }, 'El NIF no es válido.')),
    el('label', { class: 'field check' }, el('input', { type: 'checkbox', checked: true }), el('span', null, 'Es inversión')),
    el('p', { class: 'formerror' }, 'Error general del formulario.'),
  ),
  el('div', { class: 'chips' },
    el('span', { class: 'chip' }, el('span', null, 'Normal')),
    el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')),
    el('span', { class: 'chip trash' }, el('span', null, 'En papelera')),
    el('span', { class: 'chip ok' }, el('span', null, 'Guardado')),
    el('span', { class: 'chip alert' }, el('span', null, 'Vencida')),
    ...[['Carpintería', '#b76b3d'], ['Juan', '#6f5a8f'], ['Centro', '#4e6f72'], ['Apertura', '#6b7b54']].map(([text, color]) =>
      el('span', { class: 'chip', style: `--chip:${color}` }, el('span', null, text), el('button', { class: 'x', type: 'button', 'aria-label': `Quitar ${text}` }, '×')),
    ),
  ),
);

// --- Tarjetas y listas --------------------------------------------------------
const cards = section('cards', 'Tarjetas y listas', 'Tres niveles de elevación. Una fila «pendiente» lleva filete ámbar y chip; una tarjeta con color propio se tiñe entera.',
  el('div', { class: 'cardgrid' },
    el('article', { class: 'card' }, el('h3', null, 'Tarjeta'), el('p', null, 'Superficie base con sombra 1.'), el('dl', { class: 'kv' }, el('dt', null, 'Activos'), el('dd', null, '12'), el('dt', null, 'Pendientes'), el('dd', null, '3'))),
    el('a', { class: 'card cardlink', href: '#cards' }, el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'), el('h3', null, 'Tarjeta enlace'), el('p', null, 'Se eleva al pasar el puntero.')),
    el('article', { class: 'card colored', style: itemColorStyle('#6f5a8f') }, el('h3', null, 'Edificio inferior'), el('p', null, 'Color elegido por la persona; la tinta se calcula.')),
  ),
  el('ul', { class: 'list', 'aria-label': 'Ejemplo de lista' },
    el('li', { class: 'row' }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, 'Ferretería Sierra')), el('div', { class: 'row-meta' }, el('span', null, 'B12345678'), el('span', null, 'Suministros')), el('div', { class: 'row-actions' }, el('button', { class: 'iconbtn small', type: 'button', 'aria-label': 'Editar' }, icon('edit')))),
    el('li', { class: 'row', dataset: { pending: 'true' } }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, 'Maderas del Valle'), el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar'))), el('div', { class: 'row-meta' }, 'Guardado en este dispositivo'), el('div', { class: 'row-actions' }, el('button', { class: 'iconbtn small', type: 'button', 'aria-label': 'Editar' }, icon('edit')))),
    el('li', { class: 'row deleted' }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, 'Proveedor antiguo'), el('span', { class: 'chip trash' }, el('span', null, 'En papelera'))), el('div', { class: 'row-meta' }, 'Borrado hace 2 días'), el('div', { class: 'row-actions' }, el('button', { class: 'iconbtn small', type: 'button', 'aria-label': 'Restaurar' }, icon('restore')))),
  ),
  el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay facturas'), 'Crea la primera con «Nueva factura». Funciona también sin conexión.'),
  el('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Cargando' }, el('span'), el('span'), el('span')),
);

// --- Estado de sincronización -------------------------------------------------
const statusHost = el('div', { class: 'demo-row', id: 'statusStates' });
const bannersHost = el('div', { class: 'banners', id: 'bannerStates' });
const stateButtons = el('div', { class: 'demo-row' });
const liveBar = createStatusBar({ status: base, onSync: () => toast('Sincronizando (simulado)…'), onClick: (s) => toast(`Cursor ${s.cursor}`), describeError: (e) => e?.message ?? '' });
for (const { name, status } of STATES) {
  const bar = createStatusBar({ status, describeError: (e) => e?.message ?? '' });
  statusHost.append(el('div', { class: 'demo-state' }, el('span', { class: 'small muted' }, name), bar.element));
  stateButtons.append(el('button', { class: 'ghost small', type: 'button', dataset: { state: status.network + (status.conflicts ? '-conflicts' : '') }, onclick: () => { liveBar.update(status); replace(bannersHost, ...statusBanners(status, BANNER_ACTIONS)); } }, name));
}
const status = section('status', 'Estado de sincronización', 'Contrato §6.4: red, cambios pendientes, conflictos; «guardado» solo cuando el servidor confirmó. Pastilla corta en móvil, larga en escritorio.',
  statusHost,
  el('h3', { class: 'demo-sub' }, 'Barra viva con banners'),
  el('div', { class: 'demo-row' }, liveBar.element),
  stateButtons,
  bannersHost,
  el('div', { class: 'demo-row' },
    el('button', { class: 'ghost small', type: 'button', onclick: () => toast('Proveedor guardado') }, 'Toast'),
    el('button', { class: 'ghost small', type: 'button', onclick: () => toastWithAction('Tarea completada', { label: 'Deshacer', onClick: () => toast('Deshecho') }) }, 'Toast con acción'),
  ),
);

// --- Login y shell ------------------------------------------------------------
const loginHost = el('div', { class: 'demo-frame', id: 'loginFrame' });
renderLogin(loginHost, {
  appName: 'Invoices',
  tagline: 'Facturas, compras y gestoría',
  async onLogin(email) {
    await new Promise((r) => setTimeout(r, 400));
    if (!email.endsWith('@ikisai.com')) throw Object.assign(new Error('Correo o contraseña incorrectos.'), { code: 'UNAUTHORIZED' });
    toast(`Bienvenida, ${email}`);
  },
  describeError: (e) => (e as Error).message,
  footnote: 'Muestra: cualquier correo @ikisai.com entra.',
});
document.title = 'Ikisai UI kit';

const shellHost = el('div', { class: 'demo-frame shell-frame', id: 'shellFrame' });
const shell = createAppShell(shellHost, {
  appName: 'Invoices',
  subtitle: 'Víctor',
  nav: [
    { hash: '#/', label: 'Inicio', icon: 'home' },
    { hash: '#/facturas', label: 'Facturas', icon: 'invoice', badge: 2 },
    { hash: '#/compras', label: 'Compras', icon: 'cart', soon: true },
    { hash: '#/gestoria', label: 'Gestoría', icon: 'briefcase', soon: true },
  ],
  status: { status: STATES[4]!.status, onSync: () => toast('Sincronizar'), describeError: (e) => e?.message ?? '' },
  onLogout: () => toast('Cerrar sesión'),
  tools: [createThemeToggle()],
  navFoot: 'Ctrl K abrirá la paleta cuando exista.',
  navigate: (hash) => { shell.setRoute(hash); toast(`Ruta ${hash}`); },
});
shell.setRoute('#/');
shell.setBanners(STATES[4]!.status, { onRetry: () => toast('Reintentar'), describeError: (e) => e?.message ?? '' });
replace(shell.main, el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Inicio'), el('p', null, 'Contenido de ejemplo dentro del shell.'))), el('div', { class: 'empty plain' }, 'Aquí va la vista de la app.'));

const shells = section('shell', 'Login y shell', 'El shell de login y la cabecera con navegación son comunes a las cuatro apps; cada una pone su nombre, su subtítulo y sus secciones.',
  el('h3', { class: 'demo-sub' }, 'Login'), loginHost,
  el('h3', { class: 'demo-sub' }, 'Shell (cabecera, estado, navegación)'), shellHost,
);


// --- Hoja inferior y diálogo ---------------------------------------------------
function demoSheet(): void {
  const name = el('input', { id: 'sheetName', type: 'text', value: 'Ferretería Sierra', maxlength: '200' });
  const initial = name.value;
  const save = el('button', { class: 'primary', type: 'submit', form: 'sheetForm', id: 'sheetSave' }, 'Guardar');
  const sheet = openSheet({
    title: 'Editar proveedor',
    meta: 'Revisión 3 · actualizado hoy',
    body: el('form', { id: 'sheetForm', oninput: () => sheet.setFootHidden(name.value === initial), onsubmit: (e: Event) => { e.preventDefault(); toast(`Guardado «${name.value}»`); void sheet.close(true); } },
      el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
      el('label', { class: 'field' }, el('span', null, 'Notas'), el('textarea', { rows: '2' })),
      el('button', { class: 'ghost small', type: 'button', id: 'sheetToast', onclick: () => toast('Aviso mientras la hoja está abierta') }, 'Probar aviso'),
    ),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar'), save],
    footHidden: true,
    beforeClose: async () => name.value === initial || confirmDialog({ title: '¿Descartar los cambios?', text: 'El nombre ha cambiado y no se ha guardado.', confirmLabel: 'Descartar', danger: true }),
  });
}
const overlays = section('overlays', 'Hoja inferior y diálogo', 'Una sola hoja abierta; foco atrapado, Escape y fondo cierran, el foco vuelve al botón. El pie aparece cuando el formulario cambia; cerrar con cambios pide confirmación en un diálogo.',
  el('div', { class: 'demo-row' },
    el('button', { class: 'primary', type: 'button', id: 'openSheet', onclick: demoSheet }, icon('edit', 18), 'Abrir hoja'),
    el('button', { class: 'danger', type: 'button', id: 'openDialog', onclick: async () => { const ok = await confirmDialog({ title: 'Enviar a papelera', text: 'Se puede restaurar desde la papelera.', confirmLabel: 'Enviar a papelera', danger: true }); toast(ok ? 'Enviado a papelera' : 'Cancelado'); } }, icon('trash', 18), 'Diálogo de confirmación'),
    el('button', { class: 'ghost', type: 'button', id: 'openAlert', onclick: () => void alertDialog('Sin conexión', 'Los cambios se enviarán cuando vuelva la red.') }, 'Aviso'),
  ),
);

// --- Conflictos y rechazados ------------------------------------------------------
const conflictSample: PendingConflict = {
  requestId: 'req-1',
  operation: { op: 'update', table: 'invoices.suppliers', id: 'sup-1', expectedRevision: 3, fields: { name: 'Ferretería Sierra S.L.', notes: 'Pedir siempre con albarán.' } },
  base: { id: 'sup-1', revision: 3, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-05T10:00:00Z', updated_by: 'u1', deleted_at: null, name: 'Ferretería Sierra', tax_id: 'B12345678', notes: '' },
  current: { id: 'sup-1', revision: 4, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-06T08:00:00Z', updated_by: 'u2', deleted_at: null, name: 'Ferretería Sierra', tax_id: 'B87654321', notes: 'Horario de tarde.' },
  overlapping: ['notes'],
  detectedAt: new Date().toISOString(),
};
const deleteConflict: PendingConflict = { ...conflictSample, requestId: 'req-2', operation: { op: 'delete', table: 'invoices.suppliers', id: 'sup-1', expectedRevision: 3 }, overlapping: [] };
const rejectedSample: RejectedBatch = {
  requestId: 'req-3',
  operations: [{ op: 'update', table: 'invoices.suppliers', id: 'sup-2', expectedRevision: 1, fields: { tax_id: 'XXX' } }],
  error: { status: 422, code: 'INVALID_VALUE', message: 'El NIF no tiene un formato válido.', details: null },
  baseRows: { 'invoices.suppliers|sup-2': { id: 'sup-2', revision: 1, created_at: '', updated_at: '', updated_by: null, deleted_at: null, name: 'Maderas del Valle' } },
  rejectedAt: new Date().toISOString(),
};
const conflictHost = el('div', { id: 'conflictHost' }, ...renderConflicts([conflictSample, deleteConflict], {
  fieldLabels: { name: 'Nombre', tax_id: 'NIF', notes: 'Notas', deleted_at: 'Borrado' },
  onResolve: (conflict, decision) => { toast(`Conflicto ${conflict.requestId}: ${decision.choice}${decision.choice === 'merge' ? ' ' + JSON.stringify(decision.fields) : ''}`); conflictHost.querySelector(`[data-request-id="${conflict.requestId}"]`)?.remove(); },
}));
const rejectedHost = el('div', { id: 'rejectedHost' });
const rejectedOptions = { onRetry: (b: RejectedBatch) => toast(`Reintentar ${b.requestId}`), onDiscard: (b: RejectedBatch) => { toast(`Descartado ${b.requestId}`); replace(rejectedHost, ...renderRejectedList([], rejectedOptions)); } };
replace(rejectedHost, ...renderRejectedList([rejectedSample], rejectedOptions));
const conflicts = section('conflicts', 'Conflictos y rechazados', 'Contrato §6.3: ambas versiones campo a campo y tres decisiones (mantener la mía, tomar la del servidor, combinar). Los lotes rechazados por el servidor se reintentan o se descartan.',
  conflictHost,
  el('h3', { class: 'demo-sub' }, 'Rechazado por el servidor'), rejectedHost,
);

// --- Lista con estado --------------------------------------------------------------
const listDemo = section('list', 'Lista con estado de sincronización', 'renderList pinta filas con chip y filete cuando están pendientes, tachadas en papelera y pulsables si llevan onClick.',
  renderList({
    label: 'Proveedores de ejemplo', id: 'demoList',
    rows: [
      { id: 'a', title: 'Ferretería Sierra', meta: ['B12345678', 'Suministros'], actions: [el('button', { class: 'iconbtn small', type: 'button', 'aria-label': 'Editar Ferretería Sierra' }, icon('edit'))], onClick: () => toast('Abrir Ferretería Sierra'), label: 'Abrir Ferretería Sierra' },
      { id: 'b', title: 'Maderas del Valle', meta: ['Guardado en este dispositivo'], pending: true, chips: [el('span', { class: 'chip', style: '--chip:#b76b3d' }, el('span', null, 'Carpintería'))], onClick: () => toast('Abrir Maderas del Valle') },
      { id: 'c', title: 'Proveedor antiguo', meta: ['Borrado hace 2 días'], deleted: true, actions: [el('button', { class: 'iconbtn small', type: 'button', 'aria-label': 'Restaurar' }, icon('restore'))] },
    ],
    empty: { title: 'Sin proveedores', text: 'Crea el primero.' },
  }),
  el('h3', { class: 'demo-sub' }, 'Vacía'),
  renderList({ label: 'Lista vacía', rows: [], empty: { title: 'Sin proveedores', text: 'Crea el primero con «Nuevo proveedor».' } }),
);

// --- Tema y paleta ---------------------------------------------------------------
const palette = createCommandPalette({
  placeholder: 'Buscar o saltar: secciones, proveedores, acciones…',
  hiddenWhenEmpty: ['Proveedores'],
  items: () => [
    { group: 'Acciones', text: 'Nuevo proveedor', hint: 'N', run: () => toast('Nuevo proveedor') },
    { group: 'Ir a', text: 'Inicio', run: () => toast('Inicio') },
    { group: 'Ir a', text: 'Facturas', run: () => toast('Facturas') },
    { group: 'Ir a', text: 'Gestoría', run: () => toast('Gestoría') },
    { group: 'Áreas', text: 'Ikisai', color: '#3f6d8e', run: () => toast('Área Ikisai') },
    { group: 'Áreas', text: 'Personal', color: '#d9b25a', run: () => toast('Área Personal') },
    { group: 'Proveedores', text: 'Ferretería Sierra', sub: 'B12345678', run: () => toast('Ferretería Sierra') },
    { group: 'Proveedores', text: 'Maderas del Valle', sub: 'Carpintería', run: () => toast('Maderas del Valle') },
    { group: 'Tema', text: 'Tema oscuro', run: () => { toggleTheme(); toast('Tema cambiado'); } },
  ],
});
const themeAndPalette = section('theme', 'Tema y paleta de comandos', 'Botón sol/luna para la cabecera, selector de tres opciones para ajustes y paleta Ctrl K con grupos, búsqueda sin acentos y teclado.',
  el('div', { class: 'demo-row' }, createThemeToggle(), createThemeSelect(), el('button', { class: 'ghost small', type: 'button', id: 'openPalette', onclick: () => palette.open() }, icon('search', 16), 'Abrir paleta', el('kbd', { class: 'phint' }, 'Ctrl K'))),
);


// --- Imágenes: recompresión en cliente --------------------------------------------
const imagePreview = el('div', { class: 'imagepreview', id: 'imagePreview' });
const imageInfo = el('p', { class: 'small muted', id: 'imageInfo' }, 'Elige una foto o genera una de prueba.');
async function showCompressed(file: Blob): Promise<void> {
  imageInfo.textContent = 'Recomprimiendo…';
  try {
    const out = await compressImage(file, { maxSide: 1600, thumbSide: 480 });
    const full = el('img', { class: 'full', alt: 'Imagen recomprimida', src: URL.createObjectURL(out.full) });
    const thumb = out.thumb ? el('img', { class: 'thumb', alt: 'Miniatura', src: URL.createObjectURL(out.thumb) }) : null;
    replace(imagePreview,
      el('figure', null, full, el('figcaption', null, `Principal ${out.width}×${out.height} · ${Math.round(out.full.size / 1024)} KB`)),
      thumb ? el('figure', null, thumb, el('figcaption', null, `Miniatura ${out.thumbWidth}×${out.thumbHeight} · ${Math.round((out.thumb?.size ?? 0) / 1024)} KB`)) : null,
    );
    imageInfo.textContent = `Original ${out.originalWidth}×${out.originalHeight} (${Math.round(file.size / 1024)} KB) → ${out.mime}`;
    Object.assign(imageInfo.dataset, { width: String(out.width), height: String(out.height), thumbWidth: String(out.thumbWidth), thumbHeight: String(out.thumbHeight), mime: out.mime, fullSize: String(out.full.size), thumbSize: String(out.thumb?.size ?? 0), originalSize: String(file.size) });
  } catch (error) {
    imageInfo.textContent = (error as Error).message;
  }
}
async function sampleImage(): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 3200; canvas.height = 2400;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 3200, 2400); g.addColorStop(0, '#3f6d8e'); g.addColorStop(1, '#c4712f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 3200, 2400);
  for (let i = 0; i < 400; i += 1) { ctx.fillStyle = `hsl(${(i * 37) % 360} 60% 60%)`; ctx.beginPath(); ctx.arc((i * 353) % 3200, (i * 211) % 2400, 20 + (i % 90), 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#fff'; ctx.font = '160px Inter'; ctx.fillText('Ikisai', 200, 400);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}
const fileInput = el('input', { type: 'file', accept: 'image/*', id: 'imageFile', 'aria-label': 'Elegir una foto', onchange: () => { const f = fileInput.files?.[0]; if (f) void showCompressed(f); } });
const images = section('images', 'Fotos recomprimidas', 'compressImage: lado mayor 1600 px en WebP de calidad media y miniatura de 480 px, sin conservar el original (contrato §11.3). Para recetas, firmas y justificantes.',
  el('div', { class: 'imagepick' },
    fileInput,
    el('div', { class: 'demo-row' }, el('button', { class: 'ghost small', type: 'button', id: 'sampleImage', onclick: async () => showCompressed(await sampleImage()) }, icon('image', 16), 'Generar imagen de prueba (3200×2400)'), imageInfo),
    imagePreview,
  ),
);

// --- Calendario ------------------------------------------------------------------
const t0 = todayKey();
const demoEvents = [
  { id: 'r1', title: 'Familia Ortega', abbr: 'Ortega', start: addDays(t0, -2), end: addDays(t0, 2), color: '#4f7a3a', status: 'confirmada' },
  { id: 'r2', title: 'Retiro de yoga', abbr: 'Yoga', start: addDays(t0, 4), end: addDays(t0, 9), color: '#3a6ea5', status: 'en_ejecucion', badge: '[PRE]' },
  { id: 'r3', title: 'Pareja Martín', start: addDays(t0, 1), end: addDays(t0, 1), color: '#c9a227', status: 'pre_reservada' },
  { id: 'r4', title: 'Colegio Sierra', start: addDays(t0, 12), end: addDays(t0, 14) },
  { id: 'r5', title: 'Visita técnica', start: t0, end: t0, color: '#8a8a8a' },
  { id: 'r6', title: 'Mantenimiento piscina', start: t0, end: t0, color: '#8a8a8a' },
];
const calendar = createCalendar({
  events: () => demoEvents,
  onSelectDay: (day, events) => toast(`${day}: ${events.length} evento(s)`),
  onSelectEvent: (event) => toast(`Abrir ${event.title}`),
});
const calendars = section('calendar', 'Calendario', 'Mes y semana de días completos, sin librerías y con teclado: flechas, Inicio (hoy), AvPág/RePág (mes o semana), Enter (seleccionar día). Las barras toman el color del estado.',
  el('div', { id: 'calendarHost' }, calendar.element),
);

// --- Cantidad con unidad --------------------------------------------------------------
const qtyOut = el('code', { id: 'qtyOut' }, '—');
const qtyWeight = createQuantityField({ label: 'Cantidad', name: 'amount', value: 250, unit: 'g', units: [{ value: 'g', label: 'g' }, { value: 'kg', label: 'kg' }, { value: 'ud', label: 'ud' }, { value: 'l', label: 'l' }], step: 50, min: 0, decimals: 1, hint: 'Decimales con coma; + y − suman 50.', onChange: (v) => { qtyOut.textContent = JSON.stringify(v); } });
const qtyMoney = createQuantityField({ label: 'Importe', name: 'total', value: 1234.5, unit: '€', decimals: 2, fixedDecimals: true, min: 0, required: true, onChange: (v) => { qtyOut.textContent = JSON.stringify(v); } });
const qtyCount = createQuantityField({ label: 'Comensales', name: 'guests', value: 12, unit: 'personas', decimals: 0, min: 1, max: 60, step: 1 });
const quantities = section('quantity', 'Cantidad con unidad', 'Para Food (ingredientes, raciones) e Invoices (importes): número a la española, unidad fija o seleccionable, botones de paso y validación de mínimo, máximo y decimales.',
  el('div', { class: 'demo-form' }, qtyWeight.element, qtyMoney.element, qtyCount.element, el('p', { class: 'small muted' }, 'Último cambio: ', qtyOut)),
);


// --- Hoja de importación (JSON ikisai.invoice.v1) ------------------------------------
const SAMPLE_IMPORT = {
  schema_version: 'ikisai.invoice.v1',
  invoice: { invoice_date: '2026-10-05', supplier_name: 'Proveedor Ejemplo S.L.', supplier_tax_id: 'B00000000', invoice_number: 'F-2026-123', object: 'alimentos_retiro_ejemplo', currency: 'EUR' },
  lines: [
    { description: 'Tomate', quantity: 20, unit: 'kg', unit_price: 2, discount_amount: 0, net_amount: 40, vat_rate: 10, vat_amount: 4, confidence: 0.99 },
    { description: 'Aceite de oliva', quantity: 5, unit: 'l', unit_price: 8.5, discount_amount: 0, net_amount: 42.5, vat_rate: 10, vat_amount: 4.25, confidence: 0.6 },
  ],
  taxes: [{ tax_type: 'iva', rate: 10, taxable_base: 82.5, amount: 8.25 }],
  document_totals: { base: 82.5, vat: 8.25, withholding: 0, total: 90.75 },
  extraction_notes: null,
  overall_confidence: 0.95,
};
type Doc = typeof SAMPLE_IMPORT;
function demoParse(text: string): { ok: true; document: Doc } | { ok: false; errors: Array<{ path: string; reason: string }> } {
  try {
    const value = JSON.parse(text) as Partial<Doc>;
    const errors: Array<{ path: string; reason: string }> = [];
    if (value.schema_version !== 'ikisai.invoice.v1') errors.push({ path: 'schema_version', reason: 'debe ser ikisai.invoice.v1' });
    if (!Array.isArray(value.lines) || value.lines.length === 0) errors.push({ path: 'lines', reason: 'al menos una línea' });
    if (!value.document_totals) errors.push({ path: 'document_totals', reason: 'obligatorio' });
    return errors.length ? { ok: false, errors } : { ok: true, document: value as Doc };
  } catch (e) {
    return { ok: false, errors: [{ path: '$', reason: (e as Error).message }] };
  }
}
function demoRecalc(doc: Doc) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const base = r2(doc.lines.reduce((s, l) => s + l.net_amount, 0));
  const vat = r2(doc.taxes.filter((t) => t.tax_type === 'iva').reduce((s, t) => s + t.amount, 0));
  const withholding = r2(doc.taxes.filter((t) => t.tax_type === 'irpf').reduce((s, t) => s + t.amount, 0));
  const total = r2(base + vat - withholding);
  const delta = r2(doc.document_totals.total - total);
  const warnings = doc.lines.flatMap((l, i) => l.quantity != null && l.unit_price != null && Math.abs(r2(l.quantity * l.unit_price - (l.discount_amount ?? 0)) - l.net_amount) > 0.02 ? [{ code: 'LINE_NET_MISMATCH', message: `Línea ${i + 1}: cantidad × precio − descuento no coincide con el neto.`, line: i }] : []);
  return { calculated_base: base, calculated_vat: vat, calculated_other: 0, calculated_withholding: withholding, calculated_total: total, totals_delta: delta, within_tolerance: Math.abs(delta) <= 0.02, taxes_derived: false, warnings };
}
const importSection = section('import', 'Hoja de importación', 'Pegar o subir un JSON (ikisai.invoice.v1), ver errores de formato o la previsualización con artículos, impuestos y cuadre de totales con tolerancia de 0,02 €. La app aporta parse, recálculo y sus campos (proveedor, categoría).',
  el('div', { class: 'demo-row' },
    el('button', { class: 'primary', type: 'button', id: 'openImport', onclick: () => openImportSheet<Doc>({
      title: 'Importar factura',
      parse: demoParse,
      recalculate: demoRecalc,
      initialText: JSON.stringify(SAMPLE_IMPORT, null, 2),
      fields: () => el('div', { class: 'row2' }, el('label', { class: 'field' }, el('span', null, 'Proveedor'), el('select', null, el('option', null, 'Crear «Proveedor Ejemplo S.L.»'))), el('label', { class: 'field' }, el('span', null, 'Categoría'), el('select', null, el('option', null, 'Compras')))),
      onImport: (doc, recalc) => { toast(`Importada ${doc.invoice.invoice_number} · ${recalc.within_tolerance ? 'cuadra' : 'revisar importes'}`); void closeSheet(true); },
    }) }, icon('upload', 18), 'Importar JSON de ejemplo'),
  ),
);


// --- Página imprimible (vista del organizador) ----------------------------------------
function dishImage(seed: number): string {
  const c = document.createElement('canvas'); c.width = 600; c.height = 400;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 600, 400); g.addColorStop(0, `hsl(${(seed * 47) % 360} 45% 55%)`); g.addColorStop(1, `hsl(${(seed * 47 + 60) % 360} 40% 35%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 600, 400);
  ctx.fillStyle = 'rgba(255,253,248,.85)'; ctx.beginPath(); ctx.arc(300, 200, 110, 0, Math.PI * 2); ctx.fill();
  return c.toDataURL('image/jpeg', 0.7);
}
const dish = (i: number, title: string, text: string, chips: Array<{ text: string; kind?: 'ok' | 'alert' | 'plain' }>, image = true) => ({ title, text, image: image ? dishImage(i) : null, chips });
const day1 = addDays(t0, 3), day2 = addDays(t0, 4);
const fmtDay = (d: string) => { const s = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(d + 'T12:00:00')); return s.charAt(0).toUpperCase() + s.slice(1); };
const printSpec = {
  brand: { appName: 'Food', markIcon: 'chef' as const, line: 'Cocina del retiro' },
  title: 'Retiro de yoga · otoño',
  subtitle: 'Menú para el organizador',
  meta: [`${fmtDay(day1)} → ${fmtDay(day2)}`, '24 personas', 'Pensión completa'],
  draft: true,
  intro: 'Platos previstos por día y servicio. Las dietas y alérgenos indicados son los declarados en cada receta.',
  sections: [
    { title: fmtDay(day1), subtitle: 'Llegada a las 17:00', groups: [
      { title: 'Cena', subtitle: '20:30', items: [dish(1, 'Crema de calabaza asada', 'Con semillas tostadas y aceite de romero.', [{ text: 'Vegano', kind: 'ok' }, { text: 'Sin gluten', kind: 'ok' }]), dish(2, 'Curry de verduras', 'Curry suave de verduras de temporada con arroz especiado.', [{ text: 'Vegano', kind: 'ok' }, { text: 'Apio', kind: 'alert' }]), dish(3, 'Fruta de temporada', 'Pera, uva y granada.', [{ text: 'Vegano', kind: 'ok' }], false)] },
    ] },
    { title: fmtDay(day2), groups: [
      { title: 'Desayuno', subtitle: '8:30', items: [dish(4, 'Porridge de avena', 'Con compota de manzana y canela.', [{ text: 'Vegetariano', kind: 'ok' }, { text: 'Gluten', kind: 'alert' }, { text: 'Lácteos', kind: 'alert' }]), dish(5, 'Pan de masa madre', 'Con aceite, tomate y mermelada casera.', [{ text: 'Gluten', kind: 'alert' }], false)] },
      { title: 'Comida', subtitle: '14:00', items: [dish(6, 'Ensalada de garbanzos', 'Garbanzos, pimiento asado, cebolla morada y comino.', [{ text: 'Vegano', kind: 'ok' }, { text: 'Sin gluten', kind: 'ok' }]), dish(7, 'Lasaña de verduras', 'Capas de berenjena y calabacín con bechamel de avena.', [{ text: 'Vegetariano', kind: 'ok' }, { text: 'Gluten', kind: 'alert' }, { text: 'Lácteos', kind: 'alert' }]), dish(8, 'Bizcocho de zanahoria', 'Con nueces y glaseado de limón.', [{ text: 'Frutos de cáscara', kind: 'alert' }, { text: 'Huevos', kind: 'alert' }])] },
      { title: 'Cena', subtitle: '20:30', items: [], empty: 'Pendiente de confirmar con el organizador.' },
    ] },
  ],
  notes: el('div', null, el('strong', null, 'Información dietética. '), 'Hay alternativa sin gluten y sin lácteos en todos los servicios. Indica en recepción cualquier alergia no declarada.'),
  footer: 'Ikisai Food · Casa de la Sierra',
};
const printView = createPrintView(printSpec, { onBack: () => toast('Volver'), actions: [el('button', { class: 'ghost', type: 'button', id: 'togglePrintDraft', onclick: () => { printSpec.draft = !printSpec.draft; printView.update(printSpec); } }, 'Alternar borrador')] });
const printSection = section('print', 'Página imprimible', 'Vista del organizador (canon §28–29): marca, título y fechas, días → servicios → platos con foto, nombre público, descripción, dietas y alérgenos; «BORRADOR» si el menú no está validado. Imprime en A4 sin navegación y sin partir platos.',
  el('div', { id: 'printHost' }, printView.element),
);


// --- Lista reordenable ----------------------------------------------------------------
interface Dish { id: string; name: string; position: number; course: string }
let dishes: Dish[] = [
  { id: 'd1', name: 'Crema de calabaza asada', position: 1024, course: 'Entrante' },
  { id: 'd2', name: 'Curry de verduras', position: 2048, course: 'Principal' },
  { id: 'd3', name: 'Ensalada de garbanzos', position: 3072, course: 'Entrante' },
  { id: 'd4', name: 'Bizcocho de zanahoria', position: 4096, course: 'Postre' },
];
const sortOut = el('code', { id: 'sortOut' }, dishes.map((d) => d.name.split(' ')[0]).join(' → '));
const sortable = createSortableList<Dish>({
  items: dishes,
  key: (d) => d.id,
  name: (d) => d.name,
  label: 'Platos de la cena',
  id: 'dishList',
  render: (d) => el('div', null, el('div', { class: 'row-title' }, el('span', { class: 'name' }, d.name)), el('div', { class: 'row-meta' }, el('span', null, d.course), el('span', null, `position ${d.position}`))),
  onReorder: (items, move) => {
    const prev = items[move.to - 1], next = items[move.to + 1];
    move.item.position = positionBetween(prev?.position, next?.position);
    dishes = items;
    sortable.setItems(items);
    sortOut.textContent = items.map((d) => d.name.split(' ')[0]).join(' → ');
    toast(`${move.item.name}: de ${move.from + 1} a ${move.to + 1} (position ${move.item.position})`);
  },
});
// Anidada: servicios con sus platos dentro (Food). Cada lista solo mueve sus filas directas.
interface Service { id: string; name: string; dishes: Dish[] }
const services: Service[] = [
  { id: 's1', name: 'Comida', dishes: [dishes[0]!, dishes[1]!] },
  { id: 's2', name: 'Cena', dishes: [dishes[2]!, dishes[3]!] },
];
const nestOut = el('code', { id: 'nestOut' });
const paintNest = () => { nestOut.textContent = services.map((s) => `${s.name}: ${s.dishes.map((d) => d.name.split(' ')[0]).join(', ')}`).join(' | '); };
paintNest();
const serviceList = createSortableList<Service>({
  items: services, key: (s) => s.id, name: (s) => s.name, label: 'Servicios del sábado', id: 'serviceList', buttons: false,
  render: (s) => el('div', null,
    el('div', { class: 'row-title' }, el('span', { class: 'name' }, s.name)),
    createSortableList<Dish>({ items: s.dishes, key: (d) => d.id, name: (d) => d.name, label: `Platos de ${s.name}`, id: `inner-${s.id}`, buttons: false, render: (d) => el('span', { class: 'name' }, d.name), onReorder: (items) => { s.dishes = items; paintNest(); } }).element),
  onReorder: (items) => { services.splice(0, services.length, ...items); paintNest(); },
});
const sortSection = section('sortable', 'Lista reordenable', 'Arrastra por el asa (en táctil, mantén pulsado), usa los botones o el teclado sobre el asa: flechas, Inicio y Fin. La app guarda position con positionBetween. Se puede anidar: cada lista solo mueve sus filas directas.',
  el('div', { id: 'sortHost' }, sortable.element),
  el('p', { class: 'small muted' }, 'Orden: ', sortOut),
  el('div', { id: 'nestHost' }, serviceList.element),
  el('p', { class: 'small muted' }, 'Servicios: ', nestOut),
);


// --- Campo de fecha con atajos ----------------------------------------------------------
const dateOut = el('code', { id: 'dateOut' }, '—');
const due = createDateField({ label: 'Fecha objetivo', name: 'due', hint: 'Atajos rápidos; el selector del sistema sigue disponible.', onChange: (v) => { dateOut.textContent = String(v); } });
const checkIn = createDateField({ label: 'Entrada', name: 'start', value: addDays(t0, 10), shortcuts: [{ label: 'Hoy', days: 0 }, { label: 'Este viernes', date: addDays(startOfWeekLocal(t0), 4) }], required: true, onChange: (v) => { checkOut.setMin(v); checkOut.validate(); } });
const checkOut = createDateField({ label: 'Salida', name: 'end', value: addDays(t0, 12), min: addDays(t0, 10), shortcuts: [{ label: '+2 noches', days: 12 }, { label: '+7 noches', days: 17 }], required: true });
function startOfWeekLocal(k: string): string { const d = new Date(k + 'T12:00:00'); const diff = (d.getDay() + 6) % 7; d.setDate(d.getDate() - diff); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const dateSection = section('date', 'Campo de fecha con atajos', 'Para Tasks (fecha objetivo) y Booking (entrada y salida): nativo con selector del sistema en móvil, atajos, fecha en palabras y distancia a hoy, y validación de límites entre dos campos.',
  el('div', { class: 'demo-form' }, due.element, el('div', { class: 'row2' }, checkIn.element, checkOut.element), el('p', { class: 'small muted' }, 'Último cambio: ', dateOut)),
);


// --- Selector de etiquetas por familias ---------------------------------------------------
const FAMILIES = [
  { id: 'person', name: 'Persona', color: '#6f5a8f' },
  { id: 'trade', name: 'Oficio', color: '#b76b3d' },
  { id: 'phase', name: 'Fase', color: '#6b7b54', single: true },
  { id: 'building', name: 'Edificio', color: '#4e6f72' },
];
const LABELS = [
  { id: 'vg', name: 'VG', familyId: 'person' }, { id: 'juan', name: 'Juan', familyId: 'person' }, { id: 'pro', name: 'Profesional', familyId: 'person' },
  { id: 'carp', name: 'Carpintería', familyId: 'trade' }, { id: 'font', name: 'Fontanería', familyId: 'trade' }, { id: 'elec', name: 'Electricidad', familyId: 'trade' }, { id: 'obra', name: 'Obra', familyId: 'trade' }, { id: 'limp', name: 'Limpieza', familyId: 'trade' },
  { id: 'apertura', name: 'Apertura', familyId: 'phase' }, { id: 'mejora', name: 'Mejora', familyId: 'phase' },
  { id: 'centro', name: 'Centro', familyId: 'building' }, { id: 'cocina', name: 'Cocina', familyId: 'building', parentId: 'centro' }, { id: 'salas', name: 'Salas', familyId: 'building', parentId: 'centro' }, { id: 'albergue', name: 'Albergue', familyId: 'building' }, { id: 'ext', name: 'Exteriores', familyId: 'building' },
];
const labelOut = el('code', { id: 'labelOut' }, 'carp, centro');
let createdCount = 0;
const picker = createLabelPicker({
  families: FAMILIES, labels: LABELS, selected: ['carp', 'centro'], preferred: ['juan'],
  onChange: (sel) => { labelOut.textContent = sel.join(', ') || '—'; },
  onCreate: (familyId, name) => ({ id: `new-${++createdCount}`, name, familyId }),
});
const FOOD_FAMILIES = [{ id: 'diet', name: 'Dieta', color: '#4f7a3a' }, { id: 'allergen', name: 'Alérgenos', color: '#b3412a' }];
const FOOD_LABELS = [
  ...['vegetariano', 'vegano', 'sin_gluten', 'sin_lactosa'].map((id) => ({ id, name: id.replace('_', ' '), familyId: 'diet' })),
  ...['gluten', 'crustaceos', 'huevos', 'pescado', 'cacahuetes', 'soja', 'lacteos', 'frutos_de_cascara', 'apio', 'mostaza', 'sesamo', 'sulfitos', 'altramuces', 'moluscos'].map((id) => ({ id, name: id.replace(/_/g, ' '), familyId: 'allergen' })),
];
const foodPicker = createLabelPicker({ families: FOOD_FAMILIES, labels: FOOD_LABELS, selected: ['vegano', 'apio'], search: false, collapsed: false, label: 'Dietas y alérgenos' });
const labelSection = section('labels', 'Selector de etiquetas por familias', 'Chips por familia con su color, resumen arriba, familias plegables, padres e hijas, búsqueda sin acentos, familias de una sola etiqueta («Fase») y alta en línea. Food lo usa con sus vocabularios fijos.',
  el('div', { class: 'demo-form', id: 'labelHost' }, picker.element, el('p', { class: 'small muted' }, 'Selección: ', labelOut)),
  el('h3', { class: 'demo-sub' }, 'Food: dietas y alérgenos'),
  el('div', { class: 'demo-form', id: 'foodLabelHost' }, foodPicker.element),
);

// --- Tarjeta de proyecto ----------------------------------------------------------------------
const cardChips = (ids: string[]) => labelChips(ids, LABELS, FAMILIES);
let pinnedDemo = true;
const projectHost = el('div', { class: 'cardgrid', id: 'projectHost' });
function paintProjects(): void {
  replace(projectHost,
    renderProjectCard({ id: 'p1', title: 'Edificio inferior', meta: '3 pendientes · 40 %', progress: 40, color: '#6f5a8f', pinned: pinnedDemo, urgency: 'critical', chips: cardChips(['centro', 'apertura', 'carp', 'juan']), budget: { spent: 2050, total: 3000 }, onOpen: () => toast('Abrir Edificio inferior'), onPin: (p) => { pinnedDemo = p; paintProjects(); toast(p ? 'Fijado' : 'Desfijado'); } }),
    renderProjectCard({ id: 'p2', title: 'Cocina operativa', meta: '2 pendientes · 33 %', progress: 33, urgency: 'high', chips: cardChips(['albergue', 'cocina', 'elec', 'pro']), budget: { spent: 3400, total: 3000 }, onOpen: () => toast('Abrir Cocina operativa'), onPin: () => toast('Pin') }),
    renderProjectCard({ id: 'p3', title: 'Piscina y exteriores', meta: '1 pendiente · 50 % · pausado', progress: 50, chips: cardChips(['ext', 'mejora', 'obra']), pending: true, onOpen: () => toast('Abrir Piscina'), onPin: () => toast('Pin') }),
    renderProjectCard({ id: 'inbox', title: 'Entrada', meta: '1 pendiente', progress: 0, system: true, chips: cardChips(['vg']), onOpen: () => toast('Abrir Entrada') }),
  );
}
paintProjects();
// --- Desglose de importes ---------------------------------------------------------------------
const moneyHost = el('div', { class: 'card', id: 'moneyHost' }, renderMoneyBreakdown({
  totalLabel: 'Coste real',
  compare: { label: 'presupuestados', amount: 1500 },
  max: 4,
  lines: [
    { id: 'food', label: 'Alimentación', amount: 612.4, meta: '3 facturas', href: '#money' },
    { id: 'clean', label: 'Limpieza', amount: 180, meta: '1 factura', href: '#money' },
    { id: 'energy', label: 'Energía', amount: 240.55, meta: 'Prorrateo del mes', onOpen: () => toast('Abrir energía') },
    { id: 'laundry', label: 'Lavandería', amount: 95, href: '#money' },
    { id: 'other', label: 'Otros', amount: 42.1 },
    { id: 'transport', label: 'Transporte', amount: 60 },
  ],
}));
const moneyOver = el('div', { class: 'card', id: 'moneyOver' }, renderMoneyBreakdown({ totalLabel: 'Coste real', compare: { label: 'del importe final', amount: 500 }, lines: [{ label: 'Alimentación', amount: 420 }, { label: 'Limpieza', amount: 160 }] }));
const moneyEmpty = el('div', { class: 'card', id: 'moneyEmpty' }, renderMoneyBreakdown({ totalLabel: 'Coste real', lines: [], emptyText: 'Invoices no ha asignado compras a esta reserva.' }));
// --- Barra de espacio de trabajo (Tasks) ------------------------------------------------------
const workspaceMenu = renderNavMenu({
  label: 'Navegación principal', attrs: { id: 'demoNavMenu' },
  header: [el('button', { type: 'button', class: 'softbtn small' }, icon('user', 16), 'Yo')],
  groups: [
    { label: 'Trabajo', icon: 'tasks', open: true, items: [{ label: 'Inicio', icon: 'home' }, { label: 'Proyectos', icon: 'grid', active: true }, { label: 'Todas las tareas', icon: 'list' }, { label: 'Etiquetas', icon: 'tag' }] },
    { label: 'Sistema', icon: 'settings', items: [{ label: 'Sincronización', icon: 'sync' }, { label: 'Historial de cambios', icon: 'history' }, { label: 'Registro de accesos', icon: 'lock', disabled: true }] },
  ],
  hint: el('span', null, 'Área actual: ', el('strong', null, 'Ikisai')),
});
const workspaceSection = section('workspace', 'Barra de espacio de trabajo', 'Para apps con áreas, vistas guardadas y menú agrupado (Tasks). Piezas sin estado: la app las monta o las repinta en cada render. El menú es desplegable en móvil y barra lateral en escritorio; aquí se muestra en línea.',
  el('div', { class: 'demo-workspace', id: 'workspaceHost' },
    renderWorkspaceBar({ name: 'Ikisai', sub: 'Tareas', markIcon: 'tasks', tools: [el('span', { class: 'chip ok' }, el('span', null, 'Al día')), el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Menú principal' }, icon('menu'))],
      rows: [
        renderAreaTabs({ label: 'Áreas de trabajo', leading: [renderStripTool({ label: 'Áreas de trabajo', icon: 'settings' })], items: [{ label: 'General', general: true }, { label: 'Ikisai', active: true, color: '#8a5a44', count: 7 }, { label: 'Personal', count: 1 }, { label: 'Detailorg' }] }),
        renderQuickViews({ label: 'Vistas guardadas', leading: [renderStripTool({ label: 'Guardar vista', icon: 'eye' })], items: [{ label: 'Mis tareas', icon: 'user', active: true }, { label: 'Fontanería' }, { label: 'Esta semana' }] }),
      ] }),
    workspaceMenu,
    renderTabBar({ label: 'Vistas', items: [{ label: 'Inicio', icon: 'home' }, { label: 'Proyectos', icon: 'grid', active: true }, { label: 'Tareas', icon: 'tasks' }, { label: 'Etiquetas', icon: 'tag' }, { label: 'Filtros', icon: 'filter' }] }),
  ),
);

// --- Agentes de IA ----------------------------------------------------------------------------
const agentNow = new Date();
const agoMs = (ms: number) => new Date(agentNow.getTime() - ms).toISOString();
const inMs = (ms: number) => new Date(agentNow.getTime() + ms).toISOString();
const HOUR = 3_600_000;
/** Hora fija de hoy (0) o de días anteriores (-1…): el registro por días no depende de la hora en que se abre la demo. */
const dayAt = (offset: number, h: number, m: number) => { const d = new Date(agentNow); d.setDate(d.getDate() + offset); d.setHours(h, m, 0, 0); return d.toISOString(); };
const TASK_TITLES = ['Revisar cierre de la puerta exterior', 'Sustituir puerta dañada', 'Activar agua fría', 'Desmontar elementos colgados', 'Limpieza a fondo de salas', 'Comprobar marco y medidas', 'Montar hoja y herrajes', 'Revisar enchufes de maquinaria', 'Sellar pequeños agujeros', 'Comprobar desagües', 'Pintar zócalo', 'Cambiar bombillas del pasillo'];
const bulkChanges: ChangeItem[] = [
  ...TASK_TITLES.slice(0, 11).map((title, i) => ({ op: 'update', table: 'tarea', tablePlural: 'tareas', title, id: `t${i}`, fields: [{ label: 'Nota', before: i === 6 ? '' : 'Sin clasificar todavía', after: 'Revisado por el asistente' }] })),
  { op: 'delete', table: 'tarea', tablePlural: 'tareas', title: TASK_TITLES[11]!, id: 't11' },
];
const proposals: (ProposalSummary & { changes: ChangeItem[] })[] = [
  { id: 'pr1', agent: 'Asistente de obra', status: 'pending', createdAt: agoMs(HOUR), expiresAt: inMs(23 * HOUR), affected: 12, reasons: [{ label: 'Incluye borrados', tone: 'alert' }], changes: bulkChanges },
  { id: 'pr2', agent: 'Asistente de obra', status: 'consumed', createdAt: agoMs(5 * HOUR), expiresAt: inMs(19 * HOUR), affected: 1, reasons: [{ label: 'Incluye borrados', tone: 'alert' }], changes: [{ op: 'delete', table: 'tarea', title: 'Revisar cierre de la puerta exterior' }] },
  { id: 'pr3', agent: 'Contable', status: 'expired', createdAt: agoMs(30 * HOUR), expiresAt: agoMs(6 * HOUR), affected: 1, reasons: [{ label: 'Archiva un proyecto', tone: 'warn' }], changes: [{ op: 'update', table: 'proyecto', title: 'Piscina y exteriores', fields: [{ label: 'Estado', before: 'Activo', after: 'Archivado' }] }] },
];
const proposalHost = el('div', { id: 'proposalHost' });
const paintProposals = () => replace(proposalHost, ...proposals.map((p) => renderProposalRow({ ...p, now: agentNow, onOpen: () => openProposalReview({
  proposal: p, changes: p.changes, threshold: 10, now: agentNow, max: 6,
  note: 'El resumen es el de cuando se preparó; si algo ha cambiado, aprobar lo comprueba de nuevo.',
  approveAttrs: { id: 'demoApprove' }, rejectAttrs: { id: 'demoReject' },
  onApprove: () => { p.status = 'approved'; paintProposals(); closeSheet(); toast('Propuesta aprobada'); },
  onReject: () => { p.status = 'rejected'; paintProposals(); closeSheet(); toast('Propuesta rechazada'); },
}) })));
paintProposals();
const secretOut = el('code', { id: 'secretOut' }, '');
const secretHost = el('div', { class: 'card', id: 'secretHost' }, renderSecretOnce({ value: 'ika_sO9OITyp5v2kCm_rhdKX3SdCj88E4BBXqLmZ0pT7wYuAzvE', valueAttrs: { id: 'demoSecret' }, doneAttrs: { id: 'demoSecretDone' }, copyAttrs: { id: 'demoSecretCopy' }, onDone: () => { secretOut.textContent = 'hecho'; } }));
const scopeOut = el('code', { id: 'scopeOut' }, '{"tabs":[],"projects":{}}');
const scopePicker = createScopePicker({ areas: [
  { id: 'ikisai', name: 'Ikisai', projects: [{ id: 'p1', name: 'Edificio inferior' }, { id: 'p2', name: 'Cocina operativa' }, { id: 'p3', name: 'Piscina y exteriores' }] },
  { id: 'personal', name: 'Personal', projects: [{ id: 'p4', name: 'Casa' }] },
], onChange: (v) => { scopeOut.textContent = JSON.stringify(v); } });
const agentsSection = section('agents', 'Agentes de IA', 'Piezas comunes para las pantallas de agentes (contrato §3.1): propuestas con estado y caducidad, revisión con pie fijo, riesgo, cambios agrupados con antes y después, clave mostrada una vez, registro por días y selector de ámbitos. La app traduce códigos, tablas y campos.',
  el('h3', { class: 'demo-sub' }, 'Propuestas'), proposalHost,
  el('h3', { class: 'demo-sub' }, 'Riesgo'), el('div', { id: 'riskHost' }, renderRiskSummary({ affected: 12, threshold: 10, reasons: [{ label: 'Incluye borrados', tone: 'alert' }, { label: 'Archiva un proyecto', tone: 'warn' }] })),
  el('h3', { class: 'demo-sub' }, 'Cambios'), el('div', { id: 'changeHost' }, renderChangeList({ changes: bulkChanges.slice(0, 4).concat(bulkChanges[11]!), max: 3 })),
  el('h3', { class: 'demo-sub' }, 'Clave mostrada una vez'), secretHost, el('p', { class: 'small muted' }, 'Estado: ', secretOut),
  el('h3', { class: 'demo-sub' }, 'Registro de accesos'), el('div', { class: 'card', id: 'accessLogHost' }, renderAccessLog({ now: agentNow, entries: [
    { at: dayAt(0, 12, 40), label: 'Propuesta aprobada', actor: 'Vera', actorKind: 'person', icon: 'check', tone: 'ok' },
    { at: dayAt(0, 11, 20), label: 'Propuesta preparada', actor: 'Asistente de obra', actorKind: 'agent', target: '12 elementos', icon: 'list', tone: 'warn' },
    { at: dayAt(0, 11, 5), label: 'Clave de agente creada', actor: 'Vera', actorKind: 'person', target: 'Asistente de obra', icon: 'lock' },
    { at: dayAt(-1, 17, 30), label: 'Clave revocada', actor: 'Vera', actorKind: 'person', target: 'Contable', icon: 'lock', tone: 'alert' },
  ] })),
  el('h3', { class: 'demo-sub' }, 'Ámbito'), el('div', { class: 'card', id: 'scopeHost' }, scopePicker.element), el('p', { class: 'small muted' }, 'Valor: ', scopeOut),
);

// --- Campo de color ---------------------------------------------------------------------------
const colorOut = el('code', { id: 'colorOut' }, '#b3c43a');
const colorField = createColorField({ label: 'Color', value: '#b3c43a', suggestions: ['#6f5a8f', '#b76b3d', '#6b7b54', '#4e6f72', '#9c744e', '#c87847', '#8a442d', '#46513b', '#3f6d8e', '#a3537a'], allowNone: true, onChange: (v) => { colorOut.textContent = v ?? 'sin color'; }, attrs: { id: 'colorHost' } });
const colorSection = section('color', 'Campo de color', 'Sugerencias, «Sin color» y «Personalizado» con tres degradados (matiz, saturación, brillo) ya colocados sobre el color actual, sin el diálogo nativo del sistema.',
  el('div', { class: 'card demo-form' }, colorField.element, el('p', { class: 'small muted' }, 'Valor: ', colorOut)),
);

// --- Lanzador de apps -------------------------------------------------------------------------
const LAUNCHER_CATALOG = { current: 'tasks', items: [
  { id: 'tasks', name: 'Tasks', domain: 'tasks.ikisai.com', aliasDomain: 'cuida.ikisai.com', kind: 'internal', description: 'Proyectos, tareas y etiquetas', role: 'owner' },
  { id: 'booking', name: 'Booking', domain: 'booking.ikisai.com', aliasDomain: 'acoge.ikisai.com', kind: 'internal', description: 'Reservas, operación y huéspedes', role: 'owner' },
  { id: 'food', name: 'Food', domain: 'food.ikisai.com', aliasDomain: 'papeaki.ikisai.com', kind: 'internal', description: 'Recetario, menús, compra y preparación', role: 'editor' },
  { id: 'invoices', name: 'Finance', domain: 'finance.ikisai.com', aliasDomain: 'tramita.ikisai.com', kind: 'internal', description: 'Facturas, compras y gestoría', role: 'reader' },
  { id: 'guests', name: 'Guests', domain: 'guests.ikisai.com', kind: 'portal', description: 'Portal de huéspedes', role: 'owner' },
] };
let launcherOnline = true;
const launcher = createAppLauncher({ storageKey: 'demo-launcher', feedback: { get: () => feedback.mode.get(), set: (on) => feedback.mode.set(on) }, review: { get mode() { return review.mode; }, available: () => review.available() }, center: () => { openFeedbackCenter({ api: fbApi, app: 'demo', canEdit: () => true, feedback }); }, fetchApps: async () => { await new Promise((r) => setTimeout(r, 120)); if (!launcherOnline) throw Object.assign(new Error('Sin red'), { code: 'NETWORK' }); return LAUNCHER_CATALOG; } });
const launcherMark = el('button', { type: 'button', class: 'mark markbtn', id: 'demoLauncher' }, icon('tasks', 20));
launcher.attach(launcherMark);
const launcherSection = section('launcher', 'Lanzador de apps', 'La marca de la cabecera abre la hoja con las apps de la cuenta (GET /api/v1/apps): internas arriba, portales debajo, la actual marcada; sin red, la última lista guardada.',
  el('div', { class: 'demo-row' }, launcherMark,
    el('label', { class: 'field check' }, el('input', { type: 'checkbox', id: 'launcherOffline', onchange: (e: Event) => { launcherOnline = !(e.target as HTMLInputElement).checked; } }), el('span', null, 'Simular sin red')),
    el('button', { type: 'button', class: 'ghost small', id: 'launcherForget', onclick: () => { try { localStorage.removeItem('demo-launcher'); } catch { /* */ } toast('Lista guardada borrada'); } }, 'Olvidar lista guardada')),
);

// --- Feedback (banco de pruebas aislado, servidor simulado de FEEDBACK.md §7) -------------------------------
/** Servidor simulado con estado en localStorage (sobrevive a recargar, para probar «se envía una sola vez»). */
const FB_KEY = 'demo-feedback-server';
type MockReport = { id: string; requestId: string; code: string; node: { id: string; path: string[] }; message: string; intent: string; status: string; display?: string; blocking?: boolean; supporters: string[]; attachments: string[]; context: unknown; verifiedBuild?: string | null; dismissReason?: string; reviewStatus?: string; originApp?: string; mergedInto?: string };
type FbState = { reports: MockReport[]; posts: number; offline: boolean; fail: string | null; notReviewer?: boolean; usage?: Record<string, Record<string, number | string>>; usageBatches?: number; consentedAt?: string | null; usagePosts?: { path: string; body: unknown }[]; usageSettings?: Record<string, Record<string, unknown>> };
const fbState = (): FbState => {
  try { const v = JSON.parse(localStorage.getItem(FB_KEY) ?? 'null') as FbState | null; if (v) return v; } catch { /* */ }
  return { reports: [], posts: 0, offline: false, fail: null };
};
const fbSave = (v: FbState) => { try { localStorage.setItem(FB_KEY, JSON.stringify(v)); } catch { /* */ } };
const fbError = (status: number, code: string) => Object.assign(new Error(code), { status, code });
const toReport = (r: MockReport) => ({ id: r.id, code: r.code, originApp: r.originApp ?? 'demo', reviewStatus: r.reviewStatus ?? 'new', routeRaw: (r.context as { routeRaw?: string } | null)?.routeRaw ?? null, subject: 'application', intent: r.intent, message: r.message, node: r.node, status: r.status, display: r.display ?? r.status, blocking: !!r.blocking, supportersCount: r.supporters.length, mine: true, createdAt: '2026-10-07T09:30:00.000Z', verifiedBuild: r.verifiedBuild ?? null });
const agentBlock = (r: MockReport) => `## ${r.code} · ${r.intent}${r.blocking ? ' · ME BLOQUEA' : ''}\n\nDónde: ${r.node.path.join(' › ')} (\`${r.node.id}\`)\n\n${r.message}\n\nContexto: ${JSON.stringify(r.context)}\n`;
const fbApi = (async (path: string, init: { method?: string; json?: unknown } = {}) => {
  await new Promise((r) => setTimeout(r, 60));
  const st = fbState();
  if (st.offline) throw fbError(0, 'NETWORK');
  const body = (init.json ?? {}) as Record<string, any>;
  if (path === '/feedback/uploads') { const id = crypto.randomUUID(); return { id, uploadUrl: `mock://upload/${id}`, method: 'PUT', headers: { 'Content-Type': body.mime }, duplicateOf: null }; }
  const verify = /^\/feedback\/uploads\/([^/]+)\/verify$/.exec(path);
  if (verify) return { id: verify[1], verified: true };
  if (path === '/feedback' && init.json) {
    st.posts += 1;
    if (st.fail) { const code = st.fail; fbSave(st); throw fbError(code === 'FEEDBACK_RATE_LIMITED' ? 429 : 422, code); }
    const known = st.reports.find((r) => r.id === body.id);
    if (known) { fbSave(st); return { report: toReport(known) }; }
    if (String(body.message).length > 4000) throw fbError(422, 'FEEDBACK_MESSAGE_TOO_LONG');
    if ((body.attachmentIds ?? []).length > 3) throw fbError(422, 'FEEDBACK_TOO_MANY_ATTACHMENTS');
    if (new Blob([JSON.stringify(body.context)]).size > 8192) throw fbError(422, 'FEEDBACK_CONTEXT_TOO_LARGE');
    const report: MockReport = { id: body.id, requestId: body.requestId, code: `FB_2026_${String(st.reports.length + 1).padStart(4, '0')}`, node: body.node, message: body.message, intent: body.intent, status: 'open', blocking: !!body.blocking, supporters: [], attachments: body.attachmentIds ?? [], context: body.context };
    st.reports.push(report); fbSave(st);
    return { report: toReport(report) };
  }
  if (path === '/usage/consent') {
    if (init.method === 'POST') { st.consentedAt = '2026-10-07T10:00:00.000Z'; fbSave(st); }
    return { consentedAt: st.consentedAt ?? null };
  }
  if (path === '/usage/review?app=all') {
    if (st.notReviewer) throw fbError(403, 'FORBIDDEN');
    return { items: DEMO_USAGE.map((u) => ({ ...u, ...(st.usageSettings?.[u.featureId] ?? {}) })) };
  }
  const feature = /^\/usage\/features\/([^/]+)(?:\/(decision|settings))?$/.exec(path);
  if (feature) {
    const id = decodeURIComponent(feature[1]!);
    const base = DEMO_USAGE.find((u) => u.featureId === id);
    if (!base) throw fbError(404, 'OUT_OF_SCOPE');
    if (feature[2]) {
      (st.usagePosts ??= []).push({ path: feature[2], body });
      st.usageSettings ??= {};
      const cur = (st.usageSettings[id] ??= {});
      { if (body.audience) cur.audience = body.audience; if ('frequency' in body) cur.frequency = body.frequency; if (body.newGeneration) cur.generation = Number(cur.generation ?? base.generation) + 1; }
      if ('decision' in body) { cur.decision = body.decision === 'clear' ? null : body.decision; cur.reviewAfter = body.reviewAfter ?? null; }
      fbSave(st); return { ok: true };
    }
    return {
      ...base, ...(st.usageSettings?.[id] ?? {}),
      byTeam: [{ teamId: TEAM_RECEPCION, name: 'Recepción', people: 2, exposures: 30, activations: 0, successes: 0 }, { teamId: TEAM_COCINA, name: 'Cocina', people: 1, exposures: 22, activations: 11, successes: 10 }],
      byPerson: [{ userId: PERSON_1, name: 'Persona 1', exposures: 22, activations: 11, successes: 10, errors: 1, lastUse: '2026-10-06' }],
      unattributed: { exposures: 4, activations: 1 },
      byContext: { production: 11, qa: 3 },
      teams: [{ teamId: TEAM_RECEPCION, name: 'Recepción' }, { teamId: TEAM_COCINA, name: 'Cocina' }, { teamId: TEAM_MANTENIMIENTO, name: 'Mantenimiento' }],
    };
  }
  if (path === '/usage/batch') {
    // Totales del día por dispositivo: el servidor se queda con el máximo de cada contador.
    st.usage ??= {}; st.usageBatches = (st.usageBatches ?? 0) + 1;
    for (const item of (body.items ?? []) as Record<string, number | string>[]) {
      const key = `${body.deviceId}|${item.day}|${item.featureId}|${item.context}`;
      const prev = st.usage[key] ?? {};
      const next: Record<string, number | string> = { ...item };
      for (const [k, v] of Object.entries(item)) if (typeof v === 'number') next[k] = Math.max(v, Number(prev[k] ?? 0));
      st.usage[key] = next;
    }
    fbSave(st); return { accepted: (body.items ?? []).length };
  }
  const q = new URLSearchParams(path.split('?')[1] ?? '');
  if (q.get('review') === 'true') {
    if (st.notReviewer) throw fbError(403, 'FORBIDDEN');
    return { items: st.reports.filter((r) => !r.mergedInto && (r.display ?? r.status) !== 'dismissed' && ((r.reviewStatus ?? 'new') === 'new' || (r.display ?? r.status) === 'pending_verify')).map(toReport) };
  }
  const review = /^\/feedback\/([^/?]+)\/(approve|merge)$/.exec(path);
  if (review) {
    const r = st.reports.find((x) => x.id === review[1]); if (!r) throw fbError(404, 'OUT_OF_SCOPE');
    if (review[2] === 'approve') r.reviewStatus = 'approved';
    else { const into = st.reports.find((x) => x.code === body.into); if (!into || into.id === r.id) throw fbError(404, 'OUT_OF_SCOPE'); r.mergedInto = into.code; r.reviewStatus = 'rejected'; into.supporters.push('merged'); }
    fbSave(st); return { report: toReport(r) };
  }
  const disp = (r: MockReport) => r.display ?? r.status;
  if (path.startsWith('/feedback/tree')) {
    const nodes = new Map<string, { id: string; path: string[]; open: number; pendingVerify: number; verified: number; total: number }>();
    for (const r of st.reports) {
      const n = nodes.get(r.node.id) ?? { id: r.node.id, path: r.node.path, open: 0, pendingVerify: 0, verified: 0, total: 0 };
      n.total += 1; if (disp(r) === 'open' || disp(r) === 'in_progress') n.open += 1; if (disp(r) === 'pending_verify') n.pendingVerify += 1; if (disp(r) === 'verified') n.verified += 1;
      nodes.set(r.node.id, n);
    }
    return { nodes: [...nodes.values()] };
  }
  if (path.startsWith('/feedback?')) {
    return { items: st.reports.filter((r) => (!q.get('node') || r.node.id === q.get('node')) && (!q.get('status') || q.get('status') === 'all' || disp(r) === q.get('status'))).map(toReport) };
  }
  const action = /^\/feedback\/([^/?]+)\/(verify|reopen|dismiss)$/.exec(path);
  if (action) {
    const r = st.reports.find((x) => x.id === action[1]); if (!r) throw fbError(404, 'OUT_OF_SCOPE');
    if (action[2] === 'verify') { r.status = 'verified'; r.display = 'verified'; r.verifiedBuild = body.build ?? null; }
    if (action[2] === 'reopen') { r.status = 'open'; r.display = 'open'; if (body.message) r.message += `\n\nSigue fallando: ${body.message}`; }
    if (action[2] === 'dismiss') { r.status = 'dismissed'; r.display = 'dismissed'; r.dismissReason = body.reason; r.reviewStatus = 'rejected'; }
    fbSave(st); return { report: toReport(r) };
  }
  const one = /^\/feedback\/([^/?]+)$/.exec(path);
  if (one && !init.json) { const r = st.reports.find((x) => x.id === one[1] || x.code === one[1]); if (!r) throw fbError(404, 'OUT_OF_SCOPE'); return { report: toReport(r), attachments: [], tasks: [], context: r.context, agentBlock: agentBlock(r) }; }
  const support = /^\/feedback\/([^/]+)\/support$/.exec(path);
  if (support) { const r = st.reports.find((x) => x.id === support[1]); if (!r) throw fbError(404, 'OUT_OF_SCOPE'); if (!r.supporters.includes('demo-user')) r.supporters.push('demo-user'); fbSave(st); return { supportersCount: r.supporters.length }; }
  throw fbError(404, 'NOT_FOUND');
}) as FeedbackApi;
const fbFetch: typeof fetch = async (input, init) => (String(input).startsWith('mock://') ? new Response(null, { status: fbState().offline ? 503 : 200 }) : fetch(input, init));
const feedback = createFeedback({ app: 'demo', api: fbApi, userId: () => 'demo-user', role: () => 'owner', fetchImpl: fbFetch, fallbackNode: () => ({ id: 'demo.feedback', path: ['Banco de feedback'] }) });
const fbClicks = el('output', { id: 'fbClicks' }, '0');
const fbTarget = el('button', { type: 'button', class: 'primary', id: 'fbAction', 'data-feedback-id': 'demo.reservation.guests.add', 'data-feedback-label': 'Añadir huésped', onclick: () => { fbClicks.textContent = String(Number(fbClicks.textContent) + 1); } }, 'Añadir huésped');
const fbScreen = el('div', { class: 'card', id: 'fbScreen', 'data-feedback-id': 'demo.reservation', 'data-feedback-label': 'Reserva' },
  el('h3', null, 'Reserva RSV_0042'),
  el('section', { 'data-feedback-id': 'demo.reservation.guests', 'data-feedback-label': 'Huéspedes' },
    el('p', null, 'Huéspedes: ', el('span', { 'data-feedback-ignore': '' }, 'Juan Pérez · 600 123 123')),
    el('label', { class: 'field' }, el('span', null, 'Nota'), el('input', { id: 'fbPrivate', value: 'Alergia al marisco' })),
    el('div', { class: 'demo-row' }, fbTarget, el('span', { class: 'small muted' }, 'Clics: ', fbClicks)),
  ),
  el('div', { class: 'segmented', role: 'tablist' },
    el('span', { role: 'tab', tabindex: '0', id: 'usageTab', 'data-feedback-id': 'demo.reservation.tab_payment', 'data-feedback-label': 'Cobro' }, 'Cobro')),
  el('div', { class: 'demo-row' },
    el('button', { type: 'button', class: 'ghost small', id: 'usageSaveOk', 'data-feedback-id': 'demo.reservation.save', 'data-feedback-label': 'Guardar', onclick: () => void usage.run('demo.reservation.save', async () => 'ok') }, 'Guardar'),
    el('button', { type: 'button', class: 'ghost small', id: 'usageSaveFail', onclick: () => void usage.run('demo.reservation.save', async () => { throw new Error('falla'); }).catch(() => null) }, 'Guardar (falla)'),
    el('button', { type: 'button', hidden: true, id: 'usageHidden', 'data-feedback-id': 'demo.reservation.hidden' }, 'Oculto'),
    el('details', null, el('summary', null, 'Más'), el('button', { type: 'button', id: 'usageInDetails', 'data-feedback-id': 'demo.reservation.more.export' }, 'Exportar'))),
);
const fbStatus = el('pre', { id: 'fbServer', class: 'small' });
const paintFbStatus = () => { const st = fbState(); fbStatus.textContent = `posts=${st.posts} reportes=${st.reports.length} sinRed=${st.offline} fallo=${st.fail ?? '-'}`; };
paintFbStatus(); setInterval(paintFbStatus, 400);
const fbOpened = el('output', { id: 'fbOpened', class: 'small' });
/** Funciones de ejemplo para «Revisor › Uso» (forma de `core.usage_feature_stats`, migración 0071). */
const TEAM_RECEPCION = '0b6f0e0a-0000-4000-8000-000000000001';
const TEAM_COCINA = '0b6f0e0a-0000-4000-8000-000000000002';
const TEAM_MANTENIMIENTO = '0b6f0e0a-0000-4000-8000-000000000003';
const PERSON_1 = '0b6f0e0a-0000-4000-8000-0000000000a1';
const DEMO_USAGE = [
  { featureId: 'demo.reservation.guests.add', app: 'demo', label: 'Añadir huésped', kind: 'button', insight: 'TARGET_NOT_ADOPTING', activity: 'baja', generation: 1, generationRelease: 'v0.17.0', frequency: 'frequent', decision: null, reviewAfter: null, audience: { teams: [TEAM_RECEPCION], people: [] }, lastProductiveUse: '2026-10-06', last30: { exposures: 52, activations: 11, successes: 10, errors: 1, target: { exposures: 30, activations: 0 }, others: { exposures: 22, activations: 11 }, qaActivations: 3 }, feedback: { open: 1, pendingVerify: 0 } },
  { featureId: 'demo.reservation.more.export', app: 'demo', label: 'Exportar', kind: 'button', insight: 'POSSIBLY_INACCESSIBLE', activity: 'dormida', generation: 1, frequency: 'normal', audience: { teams: [], people: [] }, last30: { exposures: 0, activations: 0, successes: 0, errors: 0, target: { exposures: 0, activations: 0 }, others: { exposures: 0, activations: 0 }, qaActivations: 0 }, feedback: { open: 0, pendingVerify: 0 } },
  { featureId: 'booking.reservations.import', app: 'booking', label: 'Importar reservas', kind: 'operation', insight: 'HIGH_ERROR', activity: 'media', generation: 2, frequency: 'occasional', audience: { teams: [], people: [] }, last30: { exposures: 20, activations: 14, successes: 9, errors: 5 }, feedback: { open: 2, pendingVerify: 0 } },
  { featureId: 'demo.reservation.save', app: 'demo', label: 'Guardar', kind: 'operation', insight: 'HIGH_ACTIVITY', activity: 'alta', generation: 1, frequency: 'frequent', audience: { teams: [], people: [] }, last30: { exposures: 300, activations: 280, successes: 279, errors: 1 }, feedback: { open: 0, pendingVerify: 0 } },
];
const review = createFeedbackReview({
  api: fbApi, app: 'demo', waitMs: 1200,
  appDomain: (app) => LAUNCHER_CATALOG.items.find((a) => a.id === app)?.domain,
  openUrl: (url) => { fbOpened.textContent = url; },
});
/** Reportes de ejemplo para el revisor: uno de otra app, uno cuyo elemento ya no existe y uno publicado. */
const fbSeed = () => {
  const st = fbState();
  const mk = (code: string, node: { id: string; path: string[] }, message: string, extra: Partial<MockReport> = {}): MockReport => ({ id: crypto.randomUUID(), requestId: code, code, node, message, intent: 'bug', status: 'open', supporters: [], attachments: [], context: { routeRaw: '/#feedback', steps: [{ action: 'abrió', route: '/feedback' }, { action: 'tocó', node: node.id, route: '/feedback' }] }, ...extra });
  st.reports.push(
    mk('FB_2026_0101', { id: 'demo.reservation.guests.add', path: ['Reserva', 'Huéspedes', 'Añadir huésped'] }, 'No añade al segundo huésped\nDetalle en otra línea', { blocking: true }),
    mk('FB_2026_0102', { id: 'booking.reservations.list', path: ['Reservas', 'Lista'] }, 'La lista tarda mucho', { originApp: 'booking' }),
    mk('FB_2026_0103', { id: 'demo.reservation.guests.gone', path: ['Reserva', 'Huéspedes', 'Botón antiguo'] }, 'El botón viejo no hacía nada'),
    mk('FB_2026_0104', { id: 'demo.reservation', path: ['Reserva'] }, 'El título salía cortado', { reviewStatus: 'approved', display: 'pending_verify' }),
  );
  fbSave(st);
};
const usage = createUsage({ app: 'demo', api: fbApi, userId: () => 'demo-user', flushEveryMs: 600_000, notice: false });
const fbPortalOut = el('pre', { id: 'fbPortalOut', class: 'small' });
const fbPortal = createFeedbackProgressiveForm({
  config: { start: 'about', steps: [
    { id: 'about', kind: 'choice', question: '¿Sobre qué quieres comentarnos algo?', options: [{ value: 'app', label: 'Aplicación', next: 'appKind' }, { value: 'event', label: 'Retiro / evento', next: 'eventCat' }, { value: 'space', label: 'Espacio', next: 'place' }] },
    { id: 'appKind', kind: 'choice', question: '¿Qué pasa?', options: [{ value: 'bug', label: 'Algo no funciona' }, { value: 'suggestion', label: 'Tengo una sugerencia' }], next: 'appWhere' },
    { id: 'appWhere', kind: 'signal', question: 'Mantén pulsado sobre el lugar de la aplicación al que te refieres.', action: 'Señalar en la pantalla' },
    { id: 'eventCat', kind: 'choice', question: '¿Sobre qué parte del retiro?', options: ['Horarios', 'Organización', 'Actividades', 'Comunicación', 'Comida', 'Otra'].map((l) => ({ value: l.toLowerCase(), label: l })), next: 'message' },
    { id: 'place', kind: 'choice', question: '¿Dónde?', suggest: () => ({ value: 'room-3', label: 'Habitación 3' }), options: [{ value: 'room-3', label: 'Tu habitación' }, { value: 'dining', label: 'Comedor' }, { value: 'pool', label: 'Piscina' }, { value: 'bath', label: 'Baños' }, { value: 'outside', label: 'Exterior' }, { value: 'other', label: 'Otro' }], next: 'spaceKind' },
    { id: 'spaceKind', kind: 'choice', question: '¿Qué tipo de problema?', options: [{ value: 'damage', label: 'Algo está roto' }, { value: 'cleaning', label: 'Limpieza' }, { value: 'missing', label: 'Falta algo' }, { value: 'utilities', label: 'Agua / electricidad' }, { value: 'safety', label: 'Seguridad' }, { value: 'other', label: 'Otra cosa' }], next: 'message' },
    { id: 'message', kind: 'text', question: 'Cuéntanos', placeholder: '¿Qué ha pasado?', images: true },
  ] },
  onSignal: () => { fbPortalOut.textContent = 'señalar'; },
  onSubmit: async (r) => { fbPortalOut.textContent = JSON.stringify({ answers: r.answers, message: r.message, images: r.images.length }); return 'sent'; },
});
fbPortal.element.id = 'fbPortal';
const fbModeSwitch = el('input', { type: 'checkbox', id: 'fbMode', onchange: (e: Event) => feedback.mode.set((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
fbModeSwitch.checked = feedback.mode.get();
feedback.mode.onChange((on) => { fbModeSwitch.checked = on; });
const feedbackSection = section('feedback', 'Feedback: modo, composer, borradores, bandeja y QA', 'Banco aislado con servidor simulado (rutas de FEEDBACK.md §7). Con «Señalar para comentar» (también al pie del lanzador) la pulsación mantenida o Mayúsculas+F10 abre el composer y se ven los pines.',
  fbScreen,
  el('div', { class: 'demo-row' },
    el('label', { class: 'field check' }, fbModeSwitch, el('span', null, 'Señalar para comentar')),
    el('button', { type: 'button', class: 'ghost small', id: 'fbCenter', onclick: () => void openFeedbackCenter({ api: fbApi, app: 'demo', canEdit: () => true, feedback }) }, 'Sugerencias y QA'),
    el('button', { type: 'button', class: 'ghost small', id: 'usageNotice', 'data-feedback-ignore': '', onclick: () => void showUsageNotice({ api: fbApi, userId: () => 'demo-user', delayMs: 0 }) }, 'Aviso de uso'),
    el('button', { type: 'button', class: 'ghost small', id: 'fbSeed', onclick: () => { fbSeed(); void review.refresh(); } }, 'Ejemplos del revisor'),
    el('button', { type: 'button', class: 'ghost small', id: 'fbFix', onclick: async () => { const st = fbState(); for (const r of st.reports) if ((r.display ?? r.status) === 'open') r.display = 'pending_verify'; fbSave(st); await feedback.refreshVerify(); } }, 'Publicar arreglo'),
    el('button', { type: 'button', class: 'ghost small', id: 'fbOpen', onclick: () => void feedback.signal(fbTarget) }, 'Comentar «Añadir huésped»'),
    el('label', { class: 'field check' }, el('input', { type: 'checkbox', id: 'fbOffline', checked: fbState().offline, onchange: (e: Event) => { const st = fbState(); st.offline = (e.target as HTMLInputElement).checked; fbSave(st); if (!st.offline) void feedback.flush(); } }), el('span', null, 'Servidor sin red')),
    el('button', { type: 'button', class: 'ghost small', id: 'fbReset', onclick: async () => { fbSave({ reports: [], posts: 0, offline: false, fail: null }); await feedback.clear('demo-user'); location.reload(); } }, 'Reiniciar banco')),
  fbStatus,
  el('p', { class: 'small muted' }, 'Abriría: ', fbOpened),
  el('h3', null, 'Formulario progresivo (portales)'),
  el('div', { class: 'card' }, fbPortal.element),
  fbPortalOut,
);
(window as unknown as { ikisaiFeedback: unknown }).ikisaiFeedback = { feedback, fbState, fbSave, fbPortal, review, fbSeed, usage };

const moneySection = section('money', 'Desglose de importes', 'Total frente a una referencia (presupuesto o importe final; en rojo si se excede), líneas por categoría con participación y enlace a la factura, «y N más». Para el «Coste real» de la reserva en Booking.',
  el('div', { class: 'cardgrid' }, moneyHost, moneyOver, moneyEmpty),
);

const projectSection = section('projects', 'Tarjeta de proyecto', 'Anillo de progreso, pin, estrella de urgencia heredada, chips por familia, presupuesto (en rojo si se pasa), estado pendiente, tarjeta del sistema y color propio con tinta calculada.', projectHost);

// Para las pruebas automáticas.
(window as unknown as { ikisaiKit: unknown }).ikisaiKit = { compressImage, renderLogin, toast, openSheet, el, renderProposalReview, openProposalReview, createCommandPalette };

// --- Página -----------------------------------------------------------------
const nav = el('nav', { class: 'demo-nav', 'aria-label': 'Secciones de la muestra' },
  ...[['#tokens', 'Tokens'], ['#controls', 'Controles'], ['#cards', 'Tarjetas'], ['#status', 'Estado'], ['#shell', 'Login y shell'], ['#overlays', 'Hoja y diálogo'], ['#conflicts', 'Conflictos'], ['#list', 'Lista'], ['#theme', 'Tema y paleta'], ['#images', 'Fotos'], ['#calendar', 'Calendario'], ['#quantity', 'Cantidad'], ['#import', 'Importación'], ['#print', 'Imprimir'], ['#sortable', 'Reordenar'], ['#date', 'Fecha'], ['#labels', 'Etiquetas'], ['#projects', 'Proyectos'], ['#money', 'Importes'], ['#workspace', 'Espacio de trabajo'], ['#agents', 'Agentes'], ['#color', 'Color'], ['#launcher', 'Lanzador'], ['#feedback', 'Feedback']].map(([href, text]) => el('a', { href }, text)),
);
replace(document.getElementById('app')!,
  el('header', { class: 'demo-head' },
    el('div', { class: 'brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('mark', 20)), el('h1', null, 'Ikisai UI kit', el('small', null, 'tokens «Taller» y componentes base · v0.7.0'))),
    nav,
  ),
  el('main', { class: 'demo-main' }, tokens, controls, cards, status, shells, overlays, conflicts, listDemo, themeAndPalette, images, calendars, quantities, importSection, printSection, sortSection, dateSection, labelSection, projectSection, moneySection, workspaceSection, agentsSection, colorSection, launcherSection, feedbackSection),
);
