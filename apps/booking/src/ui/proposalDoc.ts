/** Documento de la propuesta para el organizador (`#/propuesta/<id>/documento`): vista A4 limpia, con «Imprimir / Guardar PDF». Sin datos de huéspedes. */
import type { TableName } from '@ikisai/sync-client';
import { el, plural, replace, type Child } from '@ikisai/ui-kit';
import { nights } from '@ikisai/domain-booking';
import { CONDITIONS, PROPOSALS, PROPOSAL_LINES, RESERVATIONS, TIERS, fullDay } from '../app/client.ts';
import { RATE_LABELS } from '../app/labels.ts';
import { amountText, byPosition, eur, figures, lineAmounts, pct, qty, signedPct, tierText, tiersOf, type Row } from '../app/rates.ts';
import type { ViewMount } from './shell.ts';

export function mountProposalDocument(id: string): ViewMount {
  return ({ main, client, navigate }) => {
    const host = el('div');
    replace(main, host);
    let destroyed = false;

    async function paint(): Promise<void> {
      const proposal = (await client.get(PROPOSALS, id)) as Row | null;
      if (destroyed) return;
      if (!proposal || proposal.deleted_at !== null) {
        replace(host, el('div', { class: 'empty' }, el('strong', null, 'Propuesta no encontrada'), 'Puede que se haya borrado o que aún no se haya sincronizado.'),
          el('p', null, el('button', { class: 'ghost', type: 'button', onclick: () => navigate('#/reservas') }, 'Volver a Reservas')));
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

      const section = (title: string, ...children: Child[]) => el('section', { class: 'pdoc-section' }, el('h2', null, title), ...children);
      const row = (term: string, value: Child, extra = '') => el('tr', { class: extra }, el('th', { scope: 'row' }, term), el('td', null, value));

      const vatRows = f.includesVat
        ? [row(`IVA incluido (${pct(f.vatRate)})`, eur(f.vat_amount), 'soft')]
        : [row('Base imponible', eur(f.subtotal + f.adjustments), 'soft'), row(`IVA (${pct(f.vatRate)})`, eur(f.vat_amount), 'soft')];

      const depositText = conditions && f.deposit_amount > 0
        ? `Para reservar se abona una señal de ${eur(f.deposit_amount)} (${pct(conditions.deposit_percent)} del total${Number(conditions.deposit_minimum) > 0 ? `, con un mínimo de ${eur(conditions.deposit_minimum)}` : ''}). `
          + `Se paga en ${plural(Number(conditions.deposit_days), 'día', 'días')} desde la aceptación; si faltan menos de ${plural(Number(conditions.short_notice_days), 'día', 'días')} para la entrada, en ${plural(Number(conditions.deposit_days_short), 'día', 'días')}.`
        : null;

      replace(host,
        el('div', { class: 'pdoc-actions noprint' },
          el('button', { class: 'linkbtn', type: 'button', id: 'backFromDocument', onclick: () => navigate(`#/reservas/${proposal.reservation_id}`) }, `← ${reservation?.title ?? 'Reserva'}`),
          el('button', { class: 'primary', type: 'button', id: 'printDocument', onclick: () => window.print() }, 'Imprimir / Guardar PDF')),
        el('article', { class: 'pdoc', id: 'proposalDocument' },
          el('header', { class: 'pdoc-head' },
            el('p', { class: 'pdoc-kind', id: 'documentNature' }, `Propuesta ${RATE_LABELS.nature[proposal.nature]!.toLowerCase()}`),
            el('h1', null, reservation?.title ?? 'Propuesta'),
            el('p', { class: 'pdoc-sub' }, `Versión ${proposal.version}${proposal.sent_at ? ` · enviada el ${fullDay(String(proposal.sent_at).slice(0, 10))}` : ''}${reservation?.code ? ` · ${reservation.code}` : ''}`),
            draft ? el('p', { class: 'pdoc-draft', id: 'documentDraft' }, 'Borrador: todavía no se ha enviado') : null),
          el('table', { class: 'pdoc-facts' }, el('tbody', null,
            row('Fechas', `${fullDay(start)} → ${fullDay(end)}`), n === null ? null : row('Noches', String(n)), row('Personas', persons === null ? '—' : String(persons)))),
          section('Detalle',
            lines.length === 0 ? el('p', null, 'Sin líneas.') : el('table', { class: 'pdoc-lines' }, el('tbody', null, lines.map((l) => el('tr', null,
              el('td', null, el('span', { class: 'pdoc-desc' }, l.description),
                el('small', null, l.unit === 'porcentaje' ? `${signedPct(l.unit_amount)} sobre el subtotal`
                  : `${qty(l.quantity)} × ${amountText(l.unit, l.unit_amount)}${Number(l.discount_pct) > 0 ? ` · descuento ${signedPct(-Number(l.discount_pct))}` : ''}`)),
              el('td', { class: 'num' }, eur(amounts.get(l.id) ?? 0)))))),
            el('table', { class: 'pdoc-totals' }, el('tbody', null,
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
          conditions?.text ? section('Condiciones', el('p', { class: 'pdoc-text' }, conditions.text)) : null,
          proposal.valid_until ? el('p', { class: 'pdoc-valid', id: 'documentValidUntil' }, `Propuesta válida hasta el ${fullDay(proposal.valid_until)}.`) : null));
    }

    void paint();
    const offs = [PROPOSALS, PROPOSAL_LINES, CONDITIONS, TIERS, RESERVATIONS].map((table) => client.onTable(table, () => void paint()));
    return () => { destroyed = true; offs.forEach((off) => off()); };
  };
}
