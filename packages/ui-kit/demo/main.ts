/* Muestra de @ikisai/ui-kit: tokens, componentes, barra de estado, login y shell. Sin red ni cliente real. */
import '../src/styles/ui-kit.css';
import './demo.css';
import type { PendingConflict, RejectedBatch, SyncStatus } from '@ikisai/sync-client';
import {
  addDays,
  alertDialog,
  closeSheet,
  compressImage,
  createCalendar,
  createDateField,
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
  { id: 'r1', title: 'Familia Ortega', start: addDays(t0, -2), end: addDays(t0, 2), color: '#4f7a3a', status: 'confirmada' },
  { id: 'r2', title: 'Retiro de yoga', start: addDays(t0, 4), end: addDays(t0, 9), color: '#3a6ea5', status: 'en_ejecucion', badge: '[PRE]' },
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
const sortSection = section('sortable', 'Lista reordenable', 'Arrastra por el asa (en táctil, mantén pulsado), usa los botones o el teclado sobre el asa: flechas, Inicio y Fin. La app guarda position con positionBetween.',
  el('div', { id: 'sortHost' }, sortable.element),
  el('p', { class: 'small muted' }, 'Orden: ', sortOut),
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

// Para las pruebas automáticas.
(window as unknown as { ikisaiKit: unknown }).ikisaiKit = { compressImage };

// --- Página -----------------------------------------------------------------
const nav = el('nav', { class: 'demo-nav', 'aria-label': 'Secciones de la muestra' },
  ...[['#tokens', 'Tokens'], ['#controls', 'Controles'], ['#cards', 'Tarjetas'], ['#status', 'Estado'], ['#shell', 'Login y shell'], ['#overlays', 'Hoja y diálogo'], ['#conflicts', 'Conflictos'], ['#list', 'Lista'], ['#theme', 'Tema y paleta'], ['#images', 'Fotos'], ['#calendar', 'Calendario'], ['#quantity', 'Cantidad'], ['#import', 'Importación'], ['#print', 'Imprimir'], ['#sortable', 'Reordenar'], ['#date', 'Fecha']].map(([href, text]) => el('a', { href }, text)),
);
replace(document.getElementById('app')!,
  el('header', { class: 'demo-head' },
    el('div', { class: 'brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('mark', 20)), el('h1', null, 'Ikisai UI kit', el('small', null, 'tokens «Taller» y componentes base · v0.6.0'))),
    nav,
  ),
  el('main', { class: 'demo-main' }, tokens, controls, cards, status, shells, overlays, conflicts, listDemo, themeAndPalette, images, calendars, quantities, importSection, printSection, sortSection, dateSection),
);
