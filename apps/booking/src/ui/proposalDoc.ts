/**
 * Documento de la propuesta para el organizador (`#/propuesta/<id>/documento`): vista A4 limpia, con «Imprimir / Guardar PDF».
 * Cabecera con los datos de la entidad (Central: logotipo, razón social, NIF/CIF y domicilio fiscal). Sin datos de huéspedes.
 */
import type { TableName } from '@ikisai/sync-client';
import { el, plural, replace, type Child } from '@ikisai/ui-kit';
import { nights, renderConditionsText } from '@ikisai/domain-booking';
import { CONDITIONS, PROPOSALS, PROPOSAL_LINES, RESERVATIONS, TIERS, fullDay } from '../app/client.ts';
import { RATE_LABELS } from '../app/labels.ts';
import { amountText, byPosition, eur, figures, lineAmounts, pct, qty, signedPct, tierText, tiersOf, type Row } from '../app/rates.ts';
import type { ViewMount } from './shell.ts';

interface Entity {
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  address_line: string;
  postal_code: string;
  city: string;
  province: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}
/** `ok`: datos de la entidad; `missing`: Central aún no los tiene; `offline`: no se pudieron pedir (sin red). */
type EntityState = { kind: 'loading' } | { kind: 'ok'; entity: Entity; logoUrl: string | null } | { kind: 'missing' } | { kind: 'offline' };

function entityHeader(state: EntityState): Child {
  if (state.kind === 'loading') return null;
  if (state.kind === 'missing') return el('p', { class: 'banner warn noprint', id: 'entityMissing', 'data-feedback-id': 'booking.propuesta.documento.entidad_falta', 'data-feedback-label': 'Faltan datos de la entidad', role: 'status' }, 'Faltan los datos de la entidad en Central: el documento sale sin cabecera.');
  if (state.kind === 'offline') return el('p', { class: 'banner noprint', id: 'entityOffline', 'data-feedback-id': 'booking.propuesta.documento.entidad_sin_red', 'data-feedback-label': 'Entidad sin conexión', role: 'status' }, 'Sin conexión: la cabecera con los datos de la entidad se añade al volver la red.');
  const e = state.entity;
  const place = [e.postal_code, e.city, e.province && e.province !== e.city ? `(${e.province})` : null].filter(Boolean).join(' ');
  const contact = [e.phone, e.email, e.website?.replace(/^https:\/\//, '')].filter(Boolean).join(' · ');
  return el('div', { class: 'pdoc-entity', id: 'documentEntity', 'data-feedback-id': 'booking.propuesta.documento.entidad', 'data-feedback-label': 'Datos de la entidad' },
    state.logoUrl ? el('img', { class: 'pdoc-logo', src: state.logoUrl, alt: e.trade_name ?? e.legal_name }) : null,
    el('div', { class: 'pdoc-entity-text' },
      el('strong', null, e.legal_name),
      el('span', null, `NIF/CIF ${e.tax_id}`),
      el('span', null, e.address_line),
      el('span', null, place),
      contact ? el('span', null, contact) : null));
}

export function mountProposalDocument(id: string): ViewMount {
  return ({ main, client, navigate }) => {
    const host = el('div', { 'data-feedback-id': 'booking.propuesta.documento', 'data-feedback-label': 'Documento de la propuesta' });
    replace(main, host);
    let destroyed = false;
    let entity: EntityState = { kind: 'loading' };
    // Se pide una vez al abrir: la URL firmada del logotipo caduca en minutos y no se guarda.
    void client.api<{ entity: Entity | null; logoUrl: string | null }>('/entity')
      .then((out) => { entity = out.entity ? { kind: 'ok', entity: out.entity, logoUrl: out.logoUrl } : { kind: 'missing' }; })
      .catch(() => { entity = { kind: 'offline' }; })
      .then(() => { if (!destroyed) void paint(); });

    async function paint(): Promise<void> {
      const proposal = (await client.get(PROPOSALS, id)) as Row | null;
      if (destroyed) return;
      if (!proposal || proposal.deleted_at !== null) {
        replace(host, el('div', { class: 'empty' }, el('strong', null, 'Propuesta no encontrada'), 'Puede que se haya borrado o que aún no se haya sincronizado.'),
          el('p', null, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.propuesta.documento.volver_reservas', 'data-feedback-label': 'Volver a Reservas', onclick: () => navigate('#/reservas') }, 'Volver a Reservas')));
        return;
      }
      const reservation = (await client.get(RESERVATIONS, proposal.reservation_id)) as Row | null;
      const live = async (table: TableName) => ((await client.list(table)) as Row[]).filter((r) => r.deleted_at === null);
      const lines = (await live(PROPOSAL_LINES)).filter((l) => l.proposal_id === id).sort(byPosition);
      const conditions = ((await live(CONDITIONS)).find((c) => c.id === proposal.conditions_id) ?? null) as Row | null;
      const tiers = tiersOf(await live(TIERS), conditions?.id ?? null);
      const f = figures(proposal, lines, conditions);
      const amounts = lineAmounts(lines);
      const start = proposal.start_date ?? reservation?.start_date ?? null;
      const end = proposal.end_date ?? reservation?.end_date ?? null;
      const persons = proposal.persons ?? reservation?.expected_guests ?? null;
      const n = nights(start, end);
      const draft = proposal.status === 'borrador';

      const SECTION_IDS: Record<string, string> = {
        Detalle: 'booking.propuesta.documento.detalle', 'Qué incluye': 'booking.propuesta.documento.incluye', 'Señal y plazos': 'booking.propuesta.documento.senal',
        Cancelación: 'booking.propuesta.documento.cancelacion', Condiciones: 'booking.propuesta.documento.condiciones',
      };
      const section = (title: string, ...children: Child[]) => el('section', { class: 'pdoc-section', 'data-feedback-id': SECTION_IDS[title], 'data-feedback-label': title }, el('h2', null, title), ...children);
      const row = (term: string, value: Child, extra = '') => el('tr', { class: extra }, el('th', { scope: 'row' }, term), el('td', null, value));

      const vatRows = f.includesVat
        ? [row(`IVA incluido (${pct(f.vatRate)})`, eur(f.vat_amount), 'soft')]
        : [row('Base imponible', eur(f.subtotal + f.adjustments), 'soft'), row(`IVA (${pct(f.vatRate)})`, eur(f.vat_amount), 'soft')];

      const depositText = conditions && f.deposit_amount > 0
        ? `Para reservar se abona una señal de ${eur(f.deposit_amount)} (${pct(conditions.deposit_percent)} del total${Number(conditions.deposit_minimum) > 0 ? `, con un mínimo de ${eur(conditions.deposit_minimum)}` : ''}). `
          + `Se paga en ${plural(Number(conditions.deposit_days), 'día', 'días')} desde la aceptación; si faltan menos de ${plural(Number(conditions.short_notice_days), 'día', 'días')} para la entrada, en ${plural(Number(conditions.deposit_days_short), 'día', 'días')}.`
        : null;

      replace(host,
        el('div', { class: 'pdoc-actions noprint', 'data-feedback-id': 'booking.propuesta.documento.acciones', 'data-feedback-label': 'Acciones del documento' },
          el('button', { class: 'linkbtn', type: 'button', id: 'backFromDocument', 'data-feedback-id': 'booking.propuesta.documento.volver', 'data-feedback-label': 'Volver a la reserva', onclick: () => navigate(`#/reservas/${proposal.reservation_id}`) }, `← ${reservation?.title ?? 'Reserva'}`),
          el('button', { class: 'primary', type: 'button', id: 'printDocument', 'data-feedback-id': 'booking.propuesta.documento.imprimir', 'data-feedback-label': 'Imprimir o guardar PDF', onclick: () => window.print() }, 'Imprimir / Guardar PDF')),
        el('article', { class: 'pdoc', id: 'proposalDocument', 'data-feedback-id': 'booking.propuesta.documento.hoja', 'data-feedback-label': 'Hoja A4' },
          entityHeader(entity),
          el('header', { class: 'pdoc-head', 'data-feedback-id': 'booking.propuesta.documento.cabecera', 'data-feedback-label': 'Cabecera del documento' },
            el('p', { class: 'pdoc-kind', id: 'documentNature' }, `Propuesta ${RATE_LABELS.nature[proposal.nature]!.toLowerCase()}`),
            el('h1', null, reservation?.title ?? 'Propuesta'),
            el('p', { class: 'pdoc-sub' }, `Versión ${proposal.version}${proposal.sent_at ? ` · enviada el ${fullDay(String(proposal.sent_at).slice(0, 10))}` : ''}${reservation?.code ? ` · ${reservation.code}` : ''}`),
            draft ? el('p', { class: 'pdoc-draft', id: 'documentDraft' }, 'Borrador: todavía no se ha enviado') : null),
          el('table', { class: 'pdoc-facts', 'data-feedback-id': 'booking.propuesta.documento.datos', 'data-feedback-label': 'Fechas y personas' }, el('tbody', null,
            row('Fechas', `${fullDay(start)} → ${fullDay(end)}`), n === null ? null : row('Noches', String(n)), row('Personas', persons === null ? '—' : String(persons)))),
          section('Detalle',
            lines.length === 0 ? el('p', null, 'Sin líneas.') : el('table', { class: 'pdoc-lines', 'data-feedback-id': 'booking.propuesta.documento.lineas', 'data-feedback-label': 'Líneas' }, el('tbody', null, lines.map((l) => el('tr', null,
              el('td', null, el('span', { class: 'pdoc-desc' }, l.description),
                el('small', null, l.unit === 'porcentaje' ? `${signedPct(l.unit_amount)} sobre el subtotal`
                  : `${qty(l.quantity)} × ${amountText(l.unit, l.unit_amount)}${Number(l.discount_pct) > 0 ? ` · descuento ${signedPct(-Number(l.discount_pct))}` : ''}`)),
              el('td', { class: 'num' }, eur(amounts.get(l.id) ?? 0)))))),
            el('table', { class: 'pdoc-totals', 'data-feedback-id': 'booking.propuesta.documento.totales', 'data-feedback-label': 'Totales' }, el('tbody', null,
              row('Subtotal', eur(f.subtotal), 'soft'),
              f.adjustments !== 0 ? row('Ajustes', eur(f.adjustments), 'soft') : null,
              ...vatRows,
              row('Total', el('strong', { id: 'documentTotal' }, eur(f.total)), 'grand'))),
            el('p', { class: 'pdoc-note', id: 'documentNatureNote' }, proposal.nature === 'cerrada'
              ? 'Importes cerrados para las fechas, el número de personas y los servicios indicados.'
              : 'Importes orientativos: pueden variar si cambia el número de personas, las fechas o los servicios.')),
          proposal.includes || proposal.excludes ? section('Qué incluye',
            proposal.includes ? el('p', { class: 'pdoc-text' }, proposal.includes) : null,
            proposal.excludes ? el('p', null, el('strong', null, 'No incluye: '), el('span', { class: 'pdoc-text' }, proposal.excludes)) : null) : null,
          depositText ? section('Señal y plazos', el('p', { id: 'documentDeposit' }, depositText)) : null,
          conditions ? section('Cancelación',
            tiers.length === 0 ? el('p', null, 'No se devuelve la señal.') : el('ul', { class: 'pdoc-tiers' }, [
              ...tiers.map((t) => el('li', null, tierText(t))),
              Number(tiers[tiers.length - 1]!.min_days_before) > 0 ? el('li', null, 'Con menos antelación: no se devuelve la señal.') : null,
            ])) : null,
          // marcadores del texto ({{condiciones.…}}) resueltos con los campos y los tramos de estas condiciones
          conditions?.text ? section('Condiciones', el('p', { class: 'pdoc-text' }, renderConditionsText(conditions.text, conditions, tiers).text)) : null,
          proposal.valid_until ? el('p', { class: 'pdoc-valid', id: 'documentValidUntil', 'data-feedback-id': 'booking.propuesta.documento.validez', 'data-feedback-label': 'Validez' }, `Propuesta válida hasta el ${fullDay(proposal.valid_until)}.`) : null));
    }

    void paint();
    const offs = [PROPOSALS, PROPOSAL_LINES, CONDITIONS, TIERS, RESERVATIONS].map((table) => client.onTable(table, () => void paint()));
    return () => { destroyed = true; offs.forEach((off) => off()); };
  };
}
