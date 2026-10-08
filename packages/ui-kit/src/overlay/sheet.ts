import { el, replace, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { focusFirst, lockScroll, trapFocus } from './focus.ts';
import { installKeyboardInsets } from './keyboard.ts';
import { kt } from '../i18n/i18n.ts';

export interface SheetOptions {
  title: string;
  /** Contenido principal (formulario, texto). */
  body: Child;
  /** Pie con acciones; si se omite no hay pie. */
  foot?: Child;
  /** Línea pequeña bajo el título (revisión, fecha). */
  meta?: string;
  /** Pie oculto al abrir (por ejemplo hasta que el formulario cambie). */
  footHidden?: boolean;
  /** Se llama al cerrar por cualquier vía. `reason`: 'close' (botón, Escape, fondo) o 'replace' (se abrió otra hoja). */
  onClose?: (reason: 'close' | 'replace') => void;
  /** Antes de cerrar por botón, Escape o fondo: devolver `false` cancela (por ejemplo, con cambios sin guardar). */
  beforeClose?: () => boolean | Promise<boolean>;
  /** Control que recibe el foco al abrir; por defecto el primero del cuerpo. */
  initialFocus?: HTMLElement | null;
  /** Id del título, por si la app lo necesita estable. */
  titleId?: string;
  closeLabel?: string;
  /** Atributos extra del fondo (`.sheetback`), del panel (`.sheet`) y del botón de cerrar: ganchos de la app (p. ej. `{ id: 'sheetBack' }`, `{ id: 'sheet' }`, `{ id: 'closeDialog' }`). */
  backAttrs?: Record<string, string | null | undefined>;
  /** Atributos del cuerpo desplazable (`.sheet-body`); `class` se suma a la del kit. */
  bodyAttrs?: Record<string, string | null | undefined>;
  /** Título solo para lectores de pantalla: la app lo pinta dentro del cuerpo y el botón de cerrar flota arriba a la derecha. */
  hideTitle?: boolean;
  panelAttrs?: Record<string, string | null | undefined>;
  closeAttrs?: Record<string, string | null | undefined>;
  /** Dónde montar la hoja; por defecto `document.body`. En apps con el CSS del kit acotado, su capa `.ikisai-kit`. */
  container?: HTMLElement;
}

export interface Sheet {
  element: HTMLElement;
  panel: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement | null;
  /** Cierra la hoja. Con `force` no consulta `beforeClose`. */
  close(force?: boolean): Promise<boolean>;
  setFootHidden(hidden: boolean): void;
  setTitle(text: string): void;
  isOpen(): boolean;
}

let current: Sheet | null = null;

/** Hoja inferior (diálogo centrado en escritorio): una sola abierta, foco atrapado, Escape y fondo cierran, foco devuelto. */
export function openSheet(options: SheetOptions): Sheet {
  installKeyboardInsets();
  if (current) {
    const previous = current;
    current = null;
    previous.element.remove();
    (previous as unknown as { release: () => void }).release();
  }
  const opener = document.activeElement as HTMLElement | null;
  const titleId = options.titleId ?? 'sheetTitle';
  const title = el('h2', { id: titleId, class: options.hideTitle ? 'vh' : null }, options.title);
  const withClass = (base: string, attrs?: Record<string, string | null | undefined>) => ({ ...(attrs ?? {}), class: [base, attrs?.class].filter(Boolean).join(' ') });
  const closeButton = el('button', { class: 'iconbtn', type: 'button', 'aria-label': options.closeLabel ?? kt('Cerrar'), ...(options.closeAttrs ?? {}), onclick: () => void close(false) }, icon('close'));
  const body = el('div', withClass('sheet-body', options.bodyAttrs), options.meta ? el('p', { class: 'meta' }, options.meta) : null, options.body);
  const foot = options.foot ? el('div', { class: 'sheet-foot', hidden: !!options.footHidden }, options.foot) : null;
  const panel = el('section', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1', ...withClass(options.hideTitle ? 'sheet notitle' : 'sheet', options.panelAttrs) },
    el('div', { class: 'handle', 'aria-hidden': 'true' }),
    el('div', { class: 'sheet-head' }, title, closeButton),
    body,
    foot,
  );
  const element = el('div', { ...withClass('sheetback show', options.backAttrs), onclick: (e: Event) => { if (e.target === element) void close(false); } }, panel);
  const onKey = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); void close(false); }
    else if (e.key === 'Tab') trapFocus(e, panel);
  };
  let open = true;
  const unlock = lockScroll();
  document.addEventListener('keydown', onKey);
  (options.container ?? document.body).appendChild(element);
  focusFirst(body, options.initialFocus ?? null);

  function release(): void {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', onKey);
    unlock();
  }

  async function close(force = false): Promise<boolean> {
    if (!open) return true;
    if (!force && options.beforeClose && !(await options.beforeClose())) return false;
    release();
    element.remove();
    if (current === sheet) current = null;
    options.onClose?.('close');
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    return true;
  }

  const sheet: Sheet & { release: () => void } = {
    element,
    panel,
    body,
    foot,
    close,
    setFootHidden(hidden) { if (foot) foot.hidden = hidden; },
    setTitle(text) { replace(title, text); },
    isOpen: () => open,
    release: () => { release(); options.onClose?.('replace'); },
  };
  current = sheet;
  return sheet;
}

/** Cierra la hoja abierta, si la hay. */
export function closeSheet(force = false): Promise<boolean> {
  return current ? current.close(force) : Promise.resolve(true);
}

export function currentSheet(): Sheet | null {
  return current;
}
