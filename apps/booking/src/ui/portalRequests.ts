/**
 * Lo que el organizador manda desde su portal (docs/booking/API.md §21): peticiones («Quiere confirmar», comentarios) y extras
 * pedidos. El personal solo cambia el `status` de una petición; los extras se pasan a la propuesta en borrador con un botón.
 */
import type { RowOperation, SyncClient, TableName } from '@ikisai/sync-client';
import { el, formatDate, plural } from '@ikisai/ui-kit';
import { EXTRA_REQUESTS, PORTAL_REQUESTS, PROPOSAL_LINES, RATES, canRead } from '../app/client.ts';
import { amountText, eur, qty, type Row } from '../app/rates.ts';

export interface PortalData {
  /** Peticiones vivas de la reserva, la más reciente primero. */
  requests: Row[];
  /** Extras pedidos vivos. */
  extras: Row[];
  /** Tarifas vivas (para el nombre y el importe de cada extra). */
  rates: Row[];
}

export type RunOperations = (operations: RowOperation[], message: string) => Promise<boolean>;

const KIND = { quiere_confirmar: 'Quiere confirmar', comentario: 'Comentario' } as const;
const STATUS = { enviada: 'Enviada', vista: 'Vista', respondida: 'Respondida' } as const;

/** Lee del espejo lo del portal para esta reserva; `null` si el rol no puede leer ninguna de las dos tablas. */
export async function loadPortalData(client: SyncClient, reservationId: string): Promise<PortalData | null> {
  const readRequests = canRead(client, PORTAL_REQUESTS), readExtras = canRead(client, EXTRA_REQUESTS);
  if (!readRequests && !readExtras) return null;
  const live = async (table: TableName) => ((await client.list(table)) as Row[]).filter((r) => r.deleted_at === null || r.deleted_at === undefined);
  const requests = readRequests ? (await live(PORTAL_REQUESTS)).filter((r) => r.reservation_id === reservationId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id))) : [];
  const extras = readExtras ? (await live(EXTRA_REQUESTS)).filter((r) => r.reservation_id === reservationId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id))) : [];
  return { requests, extras, rates: readExtras && canRead(client, RATES) ? await live(RATES) : [] };
}

/** ¿Hay alguna petición sin ver? Da el chip de la cabecera. */
export const hasUnseenRequest = (data: PortalData | null): boolean => !!data?.requests.some((r) => r.status === 'enviada');

/** Bloque «Peticiones del portal»; `null` si no hay ninguna. */
export function renderPortalRequests(options: { data: PortalData; proposals: Row[]; run: RunOperations }): HTMLElement | null {
  const { data, proposals, run } = options;
  if (data.requests.length === 0) return null;
  const setStatus = (request: Row, status: 'vista' | 'respondida') =>
    void run([{ op: 'update', table: PORTAL_REQUESTS, id: request.id, expectedRevision: request.revision, fields: { status } }],
      status === 'vista' ? 'Petición marcada como vista.' : 'Petición marcada como respondida.');
  const unseen = data.requests.filter((r) => r.status === 'enviada').length;
  return el('article', { class: 'card', id: 'blockPortalRequests', 'data-feedback-id': 'booking.reserva.peticiones', 'data-feedback-label': 'Peticiones del portal' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Peticiones del portal'), unseen > 0 ? el('span', { class: 'chip alert' }, `${unseen} sin ver`) : null),
    el('ul', { class: 'list', id: 'portalRequestList', 'data-feedback-id': 'booking.reserva.peticiones.lista', 'data-feedback-label': 'Lista de peticiones' }, data.requests.map((r) => {
      const proposal = r.proposal_id ? proposals.find((p) => p.id === r.proposal_id) : null;
      const wants = r.kind === 'quiere_confirmar';
      return el('li', { class: 'row portal-item', dataset: { request: String(r.kind), status: String(r.status), pending: String(r._pending === true) }, 'data-feedback-id': 'booking.reserva.peticiones.fila', 'data-feedback-label': 'Petición del portal' },
        el('div', { class: 'row-title' },
          el('span', { class: `chip${wants ? ' alert' : ''}`, dataset: { role: 'kind' } }, KIND[r.kind as keyof typeof KIND] ?? String(r.kind)),
          el('span', { class: `chip${r.status === 'enviada' ? ' pending' : ''}`, dataset: { role: 'status' } }, STATUS[r.status as keyof typeof STATUS] ?? String(r.status))),
        el('div', { class: 'row-meta' }, [proposal ? `Propuesta v${proposal.version}` : r.proposal_id ? 'Una propuesta ya quitada' : null, formatDate(r.created_at)].filter(Boolean).join(' · ')),
        r.message ? el('p', { class: 'portal-message', 'data-feedback-ignore': '' }, String(r.message)) : null,
        el('div', { class: 'choices' },
          r.status === 'enviada' ? el('button', { class: 'ghost small', type: 'button', dataset: { action: 'seen' }, 'data-feedback-id': 'booking.reserva.peticiones.vista', 'data-feedback-label': 'Marcar vista', onclick: () => setStatus(r, 'vista') }, 'Marcar vista') : null,
          r.status !== 'respondida' ? el('button', { class: 'ghost small', type: 'button', dataset: { action: 'answered' }, 'data-feedback-id': 'booking.reserva.peticiones.respondida', 'data-feedback-label': 'Marcar respondida', onclick: () => setStatus(r, 'respondida') }, 'Marcar respondida') : null));
    })));
}

/** Sección «Extras pedidos por el organizador» (dentro del Resumen); `null` si no hay ninguno. `draft` es el borrador al que añadirlos. */
export function renderExtraRequests(options: { data: PortalData; draft: Row | null; draftLines: Row[]; editable: boolean; run: RunOperations }): HTMLElement | null {
  const { data, draft, draftLines, editable, run } = options;
  if (data.extras.length === 0) return null;
  const last = draftLines.reduce((max, l) => Math.max(max, Number(l.position ?? 0)), 0);
  return el('div', { id: 'extraRequests', 'data-feedback-id': 'booking.reserva.resumen.extras', 'data-feedback-label': 'Extras pedidos por el organizador' },
    el('div', { class: 'sectionlabel' }, 'Extras pedidos por el organizador', el('span', { class: 'count' }, String(data.extras.length))),
    el('ul', { class: 'list' }, data.extras.map((extra) => {
      const rate = data.rates.find((r) => r.id === extra.rate_id) ?? null;
      const name = rate ? String(rate.name) : 'Tarifa no disponible';
      const added = !!draft && draftLines.some((l) => l.rate_id === extra.rate_id);
      const add = () => void run([{ op: 'insert', table: PROPOSAL_LINES, id: crypto.randomUUID(),
        fields: { proposal_id: draft!.id, rate_id: rate!.id, description: rate!.name, unit: rate!.unit, quantity: Number(extra.quantity), unit_amount: Number(rate!.amount ?? 0), position: last + 1 } }],
      `«${name}» añadido a la propuesta.`);
      return el('li', { class: 'row portal-item', dataset: { extra: name }, 'data-feedback-id': 'booking.reserva.resumen.extras.fila', 'data-feedback-label': 'Extra pedido' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, name), el('span', null, `× ${qty(extra.quantity)}`),
          added ? el('span', { class: 'chip ok' }, 'En la propuesta') : null),
        rate ? el('div', { class: 'row-meta' }, `${amountText(rate.unit, rate.amount)} · ${eur(Number(rate.amount ?? 0) * Number(extra.quantity))} aprox.`) : null,
        extra.note ? el('p', { class: 'portal-message', 'data-feedback-ignore': '' }, String(extra.note)) : null,
        editable && draft && rate && !added ? el('div', { class: 'choices' },
          el('button', { class: 'ghost small', type: 'button', dataset: { action: 'addExtraToProposal' }, 'data-feedback-id': 'booking.reserva.resumen.extras.anadir', 'data-feedback-label': 'Añadir a la propuesta', onclick: add }, 'Añadir a la propuesta', el('span', { class: 'vh' }, ` ${name}`))) : null);
    })),
    editable && !draft ? el('p', { class: 'hint' }, plural(data.extras.length, 'extra pedido', 'extras pedidos') + ': para añadirlos, crea antes una propuesta en borrador.') : null);
}
