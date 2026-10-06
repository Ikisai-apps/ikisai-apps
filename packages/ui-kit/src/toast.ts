import { el, replace } from './dom.ts';

let node: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Con una hoja, un diálogo o la paleta abiertos, el aviso sube a la parte alta para no tapar su contenido ni su pie. */
function overlayOpen(): boolean {
  return !!document.querySelector('.sheetback.show, .dialogback, .palette-back');
}

function host(): HTMLDivElement {
  if (!node) {
    node = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(node);
  }
  node.classList.toggle('top', overlayOpen());
  // Con una hoja abierta, el aviso se coloca justo bajo su cabecera para no taparle el título ni el botón de cerrar.
  const head = document.querySelector<HTMLElement>('.sheetback.show .sheet-head');
  node.style.top = head ? `${Math.round(head.getBoundingClientRect().bottom) + 6}px` : '';
  return node;
}

/** Aviso breve, no bloqueante, anunciado a lectores de pantalla. */
export function toast(message: string, ms = 3200): void {
  const box = host();
  box.classList.remove('actionable');
  replace(box, message);
  box.classList.add('show');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => box.classList.remove('show'), ms);
}

export interface ToastAction {
  label: string;
  onClick(): void;
}

/** Aviso con una acción (por ejemplo «Deshacer»); se oculta al pulsarla o al pasar el tiempo. */
export function toastWithAction(message: string, action: ToastAction, ms = 6000): void {
  const box = host();
  box.classList.add('actionable');
  const button = el('button', { type: 'button', onclick: () => { action.onClick(); hideToast(); } }, action.label);
  replace(box, el('span', null, message), button);
  box.classList.add('show');
  if (timer) clearTimeout(timer);
  timer = setTimeout(hideToast, ms);
}

export function hideToast(): void {
  node?.classList.remove('show');
  if (timer) clearTimeout(timer);
  timer = null;
}
