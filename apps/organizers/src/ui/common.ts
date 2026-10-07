import { el, icon, toast, type Child } from '@ikisai/ui-kit';
import { timeLabel } from '../app/labels.ts';
import { describeError } from '../app/client.ts';

/** Zona con datos personales: el gesto de feedback no se dispara aquí y su contenido nunca viaja en un reporte. */
export function fbIgnore<T extends Element>(node: T): T {
  node.setAttribute('data-feedback-ignore', '');
  return node;
}

/** Marca una pieza con su id y etiqueta (literales: el catálogo de la publicación los recoge de `fbMark(nodo, 'id', 'etiqueta')`). */
export function fbMark<T extends Element>(node: T, id: string, label: string): T {
  node.setAttribute('data-feedback-id', id);
  node.setAttribute('data-feedback-label', label);
  return node;
}

/** Copia al portapapeles (con alternativa para navegadores sin la API) y lo confirma. */
export async function copyText(text: string, done = 'Copiado. Ya puedes pegarlo donde quieras.'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea', { readonly: '', style: 'position:fixed;opacity:0' }, text) as HTMLTextAreaElement;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(done);
}

/** Aviso de datos guardados en el dispositivo cuando no hay red. */
export function staleNote(at: string): HTMLElement {
  return el('p', { class: 'banner warn', role: 'status', id: 'staleNote' }, icon('offline', 18), ` Sin conexión · datos de las ${timeLabel(at)}. Para guardar cambios necesitas red.`);
}

export function loading(text = 'Cargando…'): HTMLElement {
  return el('p', { class: 'muted', role: 'status' }, text);
}

export function failure(error: unknown, retry?: () => void): HTMLElement {
  return el('div', { class: 'empty plain', role: 'alert' },
    el('strong', null, 'No se ha podido cargar'),
    el('p', null, describeError(error)),
    retry ? el('button', { type: 'button', class: 'ghost', onclick: retry }, 'Reintentar') : null);
}

export function section(title: string, attrs: Record<string, string>, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card orgcard', ...attrs }, el('h3', null, title), ...children);
}
