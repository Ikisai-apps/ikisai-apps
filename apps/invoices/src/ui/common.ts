/** Utilidades compartidas por las vistas de Facturas (recibidas y emitidas). */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { el, fieldAttrs, toast, type FieldSpec } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';

/** Commit con aviso: con red, «guardado»; sin red, «se sincronizará». Los rechazos se cuentan en un aviso. */
export async function commitSafely(client: SyncClient, operations: RowOperation[], okMessage: string, blobs?: Blob[]): Promise<boolean> {
  try {
    await client.commit(operations, blobs ? { blobs } : undefined);
    toast(client.status().network === 'offline' ? `${okMessage} Se sincronizará cuando haya red.` : okMessage);
    return true;
  } catch (error) {
    toast(describeError(error));
    return false;
  }
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el('label', { class: 'field' }, el('span', null, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
}

/**
 * Desplegable. Para el inventario de campos, quien llama expande en `extra` las marcas del kit con la especificación literal
 * (así la lee el catálogo); `spec` sirve cuando la especificación llega ya hecha.
 */
export function select(id: string, options: Array<[string, string]>, value: string | null | undefined, extra: Record<string, unknown> = {}, spec?: FieldSpec): HTMLSelectElement {
  return el('select', { ...fieldAttrs(spec), id, ...extra }, ...options.map(([v, label]) => el('option', { value: v, selected: (value ?? '') === v }, label)));
}

export function block(title: string, summary: string, open: boolean, ...children: Array<HTMLElement | null>): HTMLElement {
  return el('details', { class: 'inv-block', open }, el('summary', null, el('span', null, title), el('span', { class: 'hint' }, summary)), ...children);
}

/** Bloque plegable con su marca de «Sugerencias y QA» (`{ feedbackId, feedbackLabel }` literal: así entra en el catálogo). */
export function fbBlock(mark: Record<'feedbackId' | 'feedbackLabel', string>, title: string, summary: string, open: boolean, ...children: Array<HTMLElement | null>): HTMLElement {
  const node = block(title, summary, open, ...children);
  node.setAttribute('data-feedback-id', mark.feedbackId);
  node.setAttribute('data-feedback-label', mark.feedbackLabel);
  return node;
}
