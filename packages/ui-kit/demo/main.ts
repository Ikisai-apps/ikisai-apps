/* Muestra de @ikisai/ui-kit: tokens, componentes, barra de estado, login y shell. Sin red ni cliente real. */
import '../src/styles/ui-kit.css';
import './demo.css';
import type { PendingConflict, RejectedBatch, SyncStatus } from '@ikisai/sync-client';
import {
  alertDialog,
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
const controls = section('controls', 'Botones, campos y chips', 'Objetivo táctil de 46 px; variantes pequeñas de 36 px.',
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

// --- Página -----------------------------------------------------------------
const nav = el('nav', { class: 'demo-nav', 'aria-label': 'Secciones de la muestra' },
  ...[['#tokens', 'Tokens'], ['#controls', 'Controles'], ['#cards', 'Tarjetas'], ['#status', 'Estado'], ['#shell', 'Login y shell'], ['#overlays', 'Hoja y diálogo'], ['#conflicts', 'Conflictos'], ['#list', 'Lista'], ['#theme', 'Tema y paleta']].map(([href, text]) => el('a', { href }, text)),
);
replace(document.getElementById('app')!,
  el('header', { class: 'demo-head' },
    el('div', { class: 'brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('mark', 20)), el('h1', null, 'Ikisai UI kit', el('small', null, 'tokens «Taller» y componentes base · v0.2.0'))),
    nav,
  ),
  el('main', { class: 'demo-main' }, tokens, controls, cards, status, shells, overlays, conflicts, listDemo, themeAndPalette),
);
