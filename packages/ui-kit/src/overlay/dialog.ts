import { el, type Child } from '../dom.ts';
import { focusFirst, lockScroll, trapFocus } from './focus.ts';
import { kt } from '../i18n/i18n.ts';
import { installKeyboardInsets } from './keyboard.ts';

export interface DialogOptions {
  title: string;
  /** Texto o contenido explicativo. */
  text?: Child;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Acción destructiva: botón de confirmación en rojo. */
  danger?: boolean;
  /** Sin botón de cancelar (aviso con un solo botón). */
  noCancel?: boolean;
  /** Dónde montarlo; por defecto `document.body`. */
  container?: HTMLElement;
}

/** Diálogo de confirmación modal: resuelve `true` al confirmar; Escape, fondo o «Cancelar» resuelven `false`. */
export function confirmDialog(options: DialogOptions): Promise<boolean> {
  installKeyboardInsets();
  return new Promise((resolve) => {
    const opener = document.activeElement as HTMLElement | null;
    const titleId = 'dialogTitle';
    const confirm = el('button', { class: options.danger ? 'danger' : 'primary', type: 'button', id: 'dialogConfirm' }, options.confirmLabel ?? kt('Aceptar'));
    const cancel = options.noCancel ? null : el('button', { class: 'ghost', type: 'button', id: 'dialogCancel' }, options.cancelLabel ?? kt('Cancelar'));
    const panel = el('section', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': options.text ? 'dialogText' : null, tabindex: '-1' },
      el('h2', { id: titleId }, options.title),
      options.text ? el('p', { id: 'dialogText' }, options.text) : null,
      el('div', { class: 'choices' }, cancel, confirm),
    );
    const back = el('div', { class: 'dialogback' }, panel);
    const unlock = lockScroll();
    let done = false;
    function finish(value: boolean): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      unlock();
      back.remove();
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
      resolve(value);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') trapFocus(e, panel);
    };
    confirm.addEventListener('click', () => finish(true));
    cancel?.addEventListener('click', () => finish(false));
    back.addEventListener('click', (e) => { if (e.target === back) finish(false); });
    document.addEventListener('keydown', onKey);
    (options.container ?? document.body).appendChild(back);
    focusFirst(panel, options.danger && cancel ? cancel : confirm);
  });
}

/** Aviso con un solo botón. */
export function alertDialog(title: string, text?: Child, label?: string): Promise<void> {
  return confirmDialog({ title, text, confirmLabel: label ?? kt('Entendido'), noCancel: true }).then(() => undefined);
}
