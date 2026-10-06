/* Muestra de @ikisai/ui-kit: tokens, componentes, barra de estado, login y shell. Sin red ni cliente real. */
import '../src/styles/ui-kit.css';
import './demo.css';
import type { SyncStatus } from '@ikisai/sync-client';
import {
  applyAccent,
  applyTheme,
  createAppShell,
  createStatusBar,
  effectiveTheme,
  el,
  icon,
  itemColorStyle,
  renderLogin,
  replace,
  statusBanners,
  toast,
  toastWithAction,
  toggleTheme,
} from '../src/index.ts';

applyTheme();

const base: SyncStatus = { network: 'online', cursor: 42, pendingCommands: 0, pendingBlobs: 0, conflicts: 0, lastPullAt: new Date().toISOString(), lastError: null, autoMerged: 0 };
const STATES: Array<{ name: string; status: SyncStatus }> = [
  { name: 'En línea, todo guardado', status: base },
  { name: 'Sincronizando', status: { ...base, network: 'syncing', pendingCommands: 2 } },
  { name: 'Sin conexión con pendientes', status: { ...base, network: 'offline', pendingCommands: 3, pendingBlobs: 1 } },
  { name: 'Conflictos', status: { ...base, conflicts: 2, pendingCommands: 1 } },
  { name: 'Error de red', status: { ...base, network: 'error', pendingCommands: 1, lastError: { code: 'BACKEND_UNAVAILABLE', message: 'El servidor no responde.' } as SyncStatus['lastError'] } },
];

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
  stateButtons.append(el('button', { class: 'ghost small', type: 'button', dataset: { state: status.network + (status.conflicts ? '-conflicts' : '') }, onclick: () => { liveBar.update(status); replace(bannersHost, ...statusBanners(status, { onResolveConflicts: () => toast('Ir a conflictos'), onRetry: () => toast('Reintentando…'), describeError: (e) => e?.message ?? '' })); } }, name));
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
  tools: [el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Cambiar tema', onclick: () => toggleTheme() }, icon(effectiveTheme() === 'dark' ? 'sun' : 'moon'))],
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

// --- Página -----------------------------------------------------------------
const nav = el('nav', { class: 'demo-nav', 'aria-label': 'Secciones de la muestra' },
  ...[['#tokens', 'Tokens'], ['#controls', 'Controles'], ['#cards', 'Tarjetas'], ['#status', 'Estado'], ['#shell', 'Login y shell']].map(([href, text]) => el('a', { href }, text)),
);
replace(document.getElementById('app')!,
  el('header', { class: 'demo-head' },
    el('div', { class: 'brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('mark', 20)), el('h1', null, 'Ikisai UI kit', el('small', null, 'tokens «Taller» y componentes base · v0.1.0'))),
    nav,
  ),
  el('main', { class: 'demo-main' }, tokens, controls, cards, status, shells),
);
