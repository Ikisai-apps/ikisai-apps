import { el, replace } from './dom.ts';
import { kitLayer } from './layer.ts';

let node: HTMLDivElement | null = null;

/**
 * Lo que enseña el aviso. Los que llevan acción («Deshacer») viven cada uno su tiempo y ningún aviso posterior se los
 * lleva: se apilan, el más antiguo arriba. Un aviso sin acción sustituye al anterior sin acción, como siempre.
 */
interface Entry { message: string; action: ToastAction | null; timer: ReturnType<typeof setTimeout> }
let entries: Entry[] = [];
/** Como mucho, tantos avisos con acción a la vez; el más antiguo cede su sitio. */
const MAX_ACTIONS = 3;

/** Con una hoja, un diálogo o la paleta abiertos, el aviso sube a la parte alta para no tapar su contenido ni su pie. */
function overlayOpen(): boolean {
  return !!document.querySelector('.sheetback.show, .dialogback, .palette-back');
}

function host(): HTMLDivElement {
  if (!node) {
    node = el('div', { class: 'toast ikisai-toast', role: 'status', 'aria-live': 'polite' });
  }
  // En la capa del kit (apps con el CSS acotado): fuera de ella el aviso se quedaba sin sus estilos.
  const layer = kitLayer();
  if (node.parentElement !== layer) layer.appendChild(node);
  const overlay = overlayOpen();
  node.classList.toggle('top', overlay);
  // Dentro de lo **visible** (`visualViewport`): con el teclado abierto en Android la vista visible es más baja o está
  // desplazada, y un aviso colocado respecto a la de diseño quedaba fuera de la vista (FB_2026_016/017).
  const vv = window.visualViewport;
  const visTop = vv ? vv.offsetTop : 0;
  const visBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  // Con una hoja abierta, el aviso se coloca justo bajo su cabecera para no taparle el título ni el botón de cerrar.
  // `bottom: auto` en línea también: con solo `top`, una regla `.toast { bottom: … }` de la app lo estiraba en columna.
  const head = document.querySelector<HTMLElement>('.sheetback.show .sheet-head');
  if (overlay) {
    const wanted = head ? Math.round(head.getBoundingClientRect().bottom) + 6 : visTop + 12;
    node.style.top = `${Math.max(visTop + 8, Math.min(wanted, visBottom - 64))}px`;
    node.style.bottom = 'auto';
  } else {
    const hidden = Math.round(window.innerHeight - visBottom);
    node.style.top = '';
    node.style.bottom = hidden > 1 ? `${hidden + 24}px` : '';
  }
  node.style.height = 'auto';
  return node;
}

function drop(entry: Entry): void {
  clearTimeout(entry.timer);
  entries = entries.filter((e) => e !== entry);
  paint();
}

function paint(): void {
  const box = host();
  if (!entries.length) { box.classList.remove('show'); return; }
  const actionButton = (e: Entry) => el('button', { type: 'button', onclick: () => { drop(e); e.action!.onClick(); } }, e.action!.label);
  const only = entries.length === 1 ? entries[0]! : null;
  box.classList.toggle('actionable', entries.some((e) => e.action));
  box.classList.toggle('stacked', !only);
  // Uno solo: lo de siempre (texto, o texto y botón). Varios: una fila por aviso.
  if (only) replace(box, ...(only.action ? [el('span', null, only.message), actionButton(only)] : [only.message]));
  else replace(box, ...entries.map((e) => el('div', { class: 'toast-item' }, el('span', null, e.message), e.action ? actionButton(e) : null)));
  box.classList.add('show');
}

function push(message: string, action: ToastAction | null, ms: number): void {
  // El aviso sin acción anterior se va; los que tienen acción se quedan (hasta `MAX_ACTIONS`).
  for (const e of entries.filter((x) => !x.action)) clearTimeout(e.timer);
  entries = entries.filter((x) => x.action);
  if (action) while (entries.length >= MAX_ACTIONS) { clearTimeout(entries[0]!.timer); entries.shift(); }
  const entry: Entry = { message, action, timer: setTimeout(() => drop(entry), ms) };
  entries.push(entry);
  paint();
}

/** Aviso breve, no bloqueante, anunciado a lectores de pantalla. */
export function toast(message: string, ms = 3200): void {
  push(message, null, ms);
}

export interface ToastAction {
  label: string;
  onClick(): void;
}

/**
 * Aviso con una acción (por ejemplo «Deshacer»); se oculta al pulsarla o al pasar el tiempo. Otro aviso mientras tanto
 * no le quita el botón: se apila con él.
 */
export function toastWithAction(message: string, action: ToastAction, ms = 6000): void {
  push(message, action, ms);
}

/** Quita todos los avisos (también los que tienen acción). */
export function hideToast(): void {
  for (const e of entries) clearTimeout(e.timer);
  entries = [];
  node?.classList.remove('show');
}
