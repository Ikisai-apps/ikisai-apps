import { bindOnline, el, fieldAttrs, icon, renderOfflineReason, toast, type Child } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import { timeLabel } from '../app/labels.ts';
import { describeError } from '../app/client.ts';
import type { ViewContext } from './shell.ts';

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
export async function copyText(text: string, done = t('Copiado. Ya puedes pegarlo donde quieras.')): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea', { ...fieldAttrs({ id: 'organizers.comun.copiar_texto', label: 'Texto para copiar', type: 'text', sensitivity: 'internal', confirm: 'none' }), readonly: '', style: 'position:fixed;opacity:0' }, text) as HTMLTextAreaElement;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(done);
}

/**
 * Aviso de datos guardados en el dispositivo cuando no hay red. No promete que «todo se desactiva»: lo que va por la cola
 * de sincronización se sigue guardando. Con `retry`, «Reintentar» vuelve a leer.
 */
export function staleNote(at: string, retry?: () => void): HTMLElement {
  return el('p', { class: 'banner warn', role: 'status', id: 'staleNote' }, icon('offline', 18),
    el('span', null, t('Sin conexión · datos de las {hora}. Lo que necesita red queda apagado; lo demás se guarda al volver la conexión.', { hora: timeLabel(at) })),
    retry ? el('button', { type: 'button', class: 'ghost orgretry', 'data-feedback-id': 'organizers.comun.sin_red.reintentar', 'data-feedback-label': 'Reintentar', onclick: retry }, t('Reintentar')) : null);
}

/**
 * Botón que **necesita red** (MUELA-075, pieza 9): sin red se apaga con su motivo y «Reintentar». Solo para lo que no
 * va por la cola de sincronización («Quiero confirmar», decidir solicitudes, «Enviar su enlace», abrir una factura…).
 * Devuelve la función que lo suelta; la vista la llama al desmontarse.
 */
export function needsNet(ctx: Pick<ViewContext, 'client'>, button: HTMLElement, reason?: string, line?: HTMLElement): () => void {
  return bindOnline(button, { client: ctx.client, reason, retry: () => void ctx.client.sync().catch(() => undefined), ...(line ? { line } : {}) });
}

/**
 * Una sola línea de motivo para varios botones que necesitan red (kit 0.49, `renderOfflineReason`): la vista la coloca
 * donde quiera y la pasa a `needsNet(…, line)`. Empieza oculta.
 */
export function offlineReason(ctx: Pick<ViewContext, 'client'>, reason: string): HTMLElement {
  return renderOfflineReason({ reason, retry: () => void ctx.client.sync().catch(() => undefined) });
}

export function loading(text = t('Cargando…')): HTMLElement {
  return el('p', { class: 'muted', role: 'status' }, text);
}

export function failure(error: unknown, retry?: () => void): HTMLElement {
  return el('div', { class: 'empty plain', role: 'alert' },
    el('strong', null, t('No se ha podido cargar')),
    el('p', null, describeError(error)),
    retry ? el('button', { type: 'button', class: 'ghost', onclick: retry }, t('Reintentar')) : null);
}

export function section(title: string, attrs: Record<string, string>, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card orgcard', ...attrs }, el('h3', null, title), ...children);
}
