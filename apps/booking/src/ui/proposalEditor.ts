/** Editor de una propuesta (`#/propuesta/<id>`): cabecera, líneas reordenables, sugerencia desde el tarifario, extras y totales en vivo. */
import type { RowOperation, TableName } from '@ikisai/sync-client';
import { confirmDialog, createSortableList, el, icon, openSheet, plural, positionBetween, renumber, replace, toast, type Sheet, type Sortable } from '@ikisai/ui-kit';
import { extraBedsInUse, lineAmount, quantityFor, stayLength, suggestLines } from '@ikisai/domain-booking';
import { ASSIGNMENTS, BEDS, CONDITIONS, EVENTS, PROPOSALS, PROPOSAL_LINES, RATES, RESERVATIONS, canRead, canWrite, describeError, fullDay } from '../app/client.ts';
import { RATE_LABELS, RATE_OPTIONS } from '../app/labels.ts';
import { amountText, byPosition, eur, figures, lineAmounts, pct, qty, signedPct, type Row } from '../app/rates.ts';
import { openRowSheet, type FieldSpec } from './form.ts';
import type { ViewMount } from './shell.ts';

const LINE_SPECS: FieldSpec[] = [
  { key: 'description', label: 'Descripción', type: 'text', max: 300 },
  { key: 'unit', label: 'Unidad', type: 'select', options: RATE_OPTIONS.unit },
  { key: 'quantity', label: 'Cantidad', type: 'number', decimal: true, hint: 'En un porcentaje, 1 (se aplica una vez sobre el subtotal).' },
  { key: 'unit_amount', label: 'Importe unitario (€) o porcentaje', type: 'number', decimal: true, negative: true, hint: 'Con unidad «Porcentaje», un valor de −100 a 100 (−10 = descuento del 10 %).' },
  { key: 'discount_pct', label: 'Descuento %', type: 'number', decimal: true, hint: 'Descuento de esta línea, de 0 a 100.' },
];

const del = (table: TableName, row: Row): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });
const num = (value: unknown): number => Number(value ?? 0);

export function mountProposalEditor(id: string): ViewMount {
  return ({ main, client, navigate }) => {
    const writable = canWrite(client);
    const host = el('div', { 'data-feedback-id': 'booking.propuesta.editor', 'data-feedback-label': 'Editor de propuesta' });
    replace(main, host);
    let destroyed = false;
    const lists = new Map<string, { sortable: Sortable<Row>; sig: string }>();
    const sig = (rows: Row[]) => rows.map((r) => `${r.id}:${r.revision}:${r.unit}:${r.quantity}:${r.unit_amount}:${r.discount_pct}:${r.description}:${r._pending === true}`).join('|');

    async function paint(): Promise<void> {
      const proposal = (await client.get(PROPOSALS, id)) as Row | null;
      if (destroyed) return;
      if (!proposal || proposal.deleted_at !== null) {
        replace(host, el('div', { class: 'empty' }, el('strong', null, 'Propuesta no encontrada'), 'Puede que se haya borrado o que aún no se haya sincronizado.'),
          el('p', null, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.propuesta.no_encontrada.volver', 'data-feedback-label': 'Volver a Reservas', onclick: () => navigate('#/reservas') }, 'Volver a Reservas')));
        return;
      }
      const reservation = (await client.get(RESERVATIONS, proposal.reservation_id)) as Row | null;
      const live = async (table: TableName) => ((await client.list(table)) as Row[]).filter((r) => r.deleted_at === null);
      const lines = (await live(PROPOSAL_LINES)).filter((l) => l.proposal_id === id).sort(byPosition);
      const conditions = await live(CONDITIONS);
      const rates = await live(RATES);
      const chosen = conditions.find((c) => c.id === proposal.conditions_id) ?? null;
      const draft = proposal.status === 'borrador';
      const editable = writable && draft && reservation?.deleted_at === null;
      const f = figures(proposal, lines, chosen);
      const amounts = lineAmounts(lines);
      const run = async (operations: RowOperation[], message: string): Promise<boolean> => {
        try {
          await client.commit(operations);
          toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`);
          return true;
        } catch (error) {
          toast(describeError(error));
          return false;
        }
      };

      // --- cabecera
      const openHeader = () => openRowSheet({
        client, title: 'Cabecera de la propuesta', table: PROPOSALS, row: proposal, feedbackId: 'booking.propuesta.cabecera.hoja', feedbackLabel: 'Editar cabecera',
        specs: [
          { key: 'nature', label: 'Naturaleza', type: 'select', options: RATE_OPTIONS.nature, hint: 'Orientativa: importes que pueden variar. Cerrada: importes cerrados para esas fechas y condiciones.' },
          { key: 'conditions_id', label: 'Condiciones', type: 'select', optional: true, options: conditions.filter((c) => c.active || c.id === proposal.conditions_id).map((c) => [c.id, c.name] as const) },
          { key: 'start_date', label: 'Fecha de entrada', type: 'date' },
          { key: 'end_date', label: 'Fecha de salida', type: 'date' },
          { key: 'persons', label: 'Personas', type: 'number' },
          { key: 'valid_until', label: 'Válida hasta', type: 'date' },
          { key: 'includes', label: 'Qué incluye', type: 'textarea' },
          { key: 'excludes', label: 'Qué no incluye', type: 'textarea' },
          { key: 'notes', label: 'Notas internas', type: 'textarea', hint: 'No salen en el documento para el organizador.' },
        ],
        savedMessage: 'Cabecera guardada.', settle: true,
      });
      const openNotes = () => openRowSheet({ client, title: 'Notas de la propuesta', table: PROPOSALS, row: proposal, feedbackId: 'booking.propuesta.cabecera.notas_hoja', feedbackLabel: 'Notas de la propuesta', specs: [{ key: 'notes', label: 'Notas internas', type: 'textarea' }], savedMessage: 'Notas guardadas.' });

      const header = el('article', { class: 'card', id: 'proposalHeader', 'data-feedback-id': 'booking.propuesta.cabecera', 'data-feedback-label': 'Cabecera' },
        el('div', { class: 'cardhead' }, el('h3', null, 'Cabecera'),
          editable ? el('button', { class: 'linkbtn', type: 'button', id: 'editHeader', 'data-feedback-id': 'booking.propuesta.cabecera.editar', 'data-feedback-label': 'Editar', onclick: openHeader }, 'Editar')
            : writable && reservation?.deleted_at === null ? el('button', { class: 'linkbtn', type: 'button', id: 'editNotes', 'data-feedback-id': 'booking.propuesta.cabecera.editar_notas', 'data-feedback-label': 'Editar notas', onclick: openNotes }, 'Editar notas') : null),
        el('dl', { class: 'kv' },
          el('dt', null, 'Naturaleza'), el('dd', null, RATE_LABELS.nature[proposal.nature]),
          el('dt', null, 'Condiciones'), el('dd', null, chosen?.name ?? 'Sin elegir'),
          el('dt', null, 'Fechas'), el('dd', null, `${fullDay(proposal.start_date)} → ${fullDay(proposal.end_date)}`),
          el('dt', null, 'Personas'), el('dd', null, proposal.persons === null ? '—' : String(proposal.persons)),
          el('dt', null, 'Válida hasta'), el('dd', null, proposal.valid_until ? fullDay(proposal.valid_until) : '—'),
          proposal.includes ? el('dt', null, 'Incluye') : null, proposal.includes ? el('dd', null, proposal.includes) : null,
          proposal.excludes ? el('dt', null, 'No incluye') : null, proposal.excludes ? el('dd', null, proposal.excludes) : null,
          proposal.notes ? el('dt', null, 'Notas') : null, proposal.notes ? el('dd', null, proposal.notes) : null));

      // --- líneas
      const last = lines.reduce((max, l) => Math.max(max, num(l.position)), 0);
      function openLine(line: Row | null, defaults: Record<string, unknown> = {}): void {
        openRowSheet({
          client, title: line ? 'Línea de la propuesta' : 'Nueva línea', table: PROPOSAL_LINES, row: line, specs: LINE_SPECS, feedbackId: line ? 'booking.propuesta.lineas.hoja' : 'booking.propuesta.lineas.nueva', feedbackLabel: line ? 'Editar línea' : 'Nueva línea',
          defaults: { unit: 'unidad', quantity: 1, unit_amount: 0, discount_pct: 0, ...defaults },
          insertFields: { proposal_id: id, position: positionBetween(last || null, null), ...(defaults.rate_id ? { rate_id: defaults.rate_id } : {}) },
          extra: (merged) => {
            const amount = merged.unit === 'porcentaje' ? null : lineAmount({ unit: String(merged.unit), quantity: num(merged.quantity), unit_amount: num(merged.unit_amount), discount_pct: num(merged.discount_pct) });
            return el('p', { class: 'hint', id: 'lineAmountPreview' }, amount === null ? 'El importe de un porcentaje se calcula sobre el subtotal.' : `Importe de la línea: ${eur(amount)}`);
          },
          remove: line ? { label: 'Quitar línea', operations: () => [del(PROPOSAL_LINES, line)] } : undefined,
          savedMessage: 'Línea guardada.', settle: true,
        });
      }

      async function reorder(ordered: Row[], moved: Row, to: number): Promise<void> {
        const prev = ordered[to - 1], next = ordered[to + 1];
        const a = prev ? Number(prev.position) : null, b = next ? Number(next.position) : null;
        const position = positionBetween(a, b);
        const fits = Number.isFinite(position) && (a === null || position > a) && (b === null || position < b);
        await run(fits
          ? [{ op: 'update', table: PROPOSAL_LINES, id: moved.id, expectedRevision: moved.revision, fields: { position } }]
          : ordered.map((row, i): RowOperation => ({ op: 'update', table: PROPOSAL_LINES, id: row.id, expectedRevision: row.revision, fields: { position: renumber(ordered.length)[i]! } })),
        'Orden de las líneas guardado.');
      }

      function lineItem(line: Row): HTMLElement {
        const percent = line.unit === 'porcentaje';
        const discount = num(line.discount_pct);
        return el('div', { class: 'space-item line-item', dataset: { pending: String(line._pending === true) }, 'data-feedback-id': 'booking.propuesta.lineas.linea', 'data-feedback-label': 'Línea' },
          el('div', { class: 'space-main' },
            el('div', { class: 'row-title' }, el('span', { class: 'name' }, line.description), el('span', { class: 'line-amount', dataset: { role: 'amount' } }, eur(amounts.get(line.id) ?? 0))),
            el('div', { class: 'row-meta' }, percent ? `${signedPct(line.unit_amount)} sobre el subtotal` : `${qty(line.quantity)} × ${amountText(line.unit, line.unit_amount)}`,
              !percent && discount > 0 ? ` · descuento ${signedPct(-discount)}` : '')),
          editable ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar ${line.description}`, 'data-feedback-id': 'booking.propuesta.lineas.editar', 'data-feedback-label': 'Editar línea', onclick: () => openLine(line) }, icon('edit', 16)) : null);
      }

      const lineList = (): HTMLElement => {
        if (!editable) return el('ul', { class: 'list', 'data-feedback-id': 'booking.propuesta.lineas.lista', 'data-feedback-label': 'Lista de líneas' }, lines.map((l) => el('li', { class: 'row' }, lineItem(l))));
        const signature = sig(lines);
        const kept = lists.get('lines');
        if (kept) {
          if (kept.sig !== signature) { kept.sig = signature; kept.sortable.setItems(lines); }
          return kept.sortable.element;
        }
        const sortable = createSortableList<Row>({
          items: lines, key: (l) => l.id, name: (l) => String(l.description), label: 'Líneas de la propuesta', render: lineItem,
          onReorder: (ordered, move) => reorder(ordered, move.item, move.to),
        });
        sortable.element.setAttribute('data-feedback-id', 'booking.propuesta.lineas.lista');
        sortable.element.setAttribute('data-feedback-label', 'Lista de líneas');
        lists.set('lines', { sortable, sig: signature });
        return sortable.element;
      };

      // Sugerencia desde el tarifario con lo que la reserva usa (y las camas supletorias asignadas a su evento).
      async function extraBedsOfEvent(): Promise<number> {
        if (!canRead(client, ASSIGNMENTS) || !canRead(client, BEDS)) return 0;
        const event = ((await client.list(EVENTS)) as Row[]).find((e) => e.reservation_id === proposal!.reservation_id && e.deleted_at === null);
        if (!event) return 0;
        return extraBedsInUse(event.id, await live(BEDS) as any, await live(ASSIGNMENTS) as any).length;
      }

      async function suggest(): Promise<void> {
        if (!reservation) return;
        const base = { ...reservation, start_date: proposal!.start_date ?? reservation.start_date, end_date: proposal!.end_date ?? reservation.end_date } as any;
        const persons = proposal!.persons ?? reservation.expected_guests ?? undefined;
        const suggested = suggestLines(base, rates as any, { persons, extraBeds: await extraBedsOfEvent() });
        if (suggested.length === 0) return void toast('Ninguna tarifa activa aplica a estas fechas, personas y servicios. Revisa la cabecera o el tarifario.');
        if (lines.length > 0 && !(await confirmDialog({
          title: 'Sugerir desde el tarifario',
          text: `Esta propuesta ya tiene ${plural(lines.length, 'línea', 'líneas')}. Se añaden ${plural(suggested.length, 'línea sugerida', 'líneas sugeridas')} al final; no se borra nada.`,
          confirmLabel: 'Añadir líneas',
        }))) return;
        await run(suggested.map((s, i): RowOperation => ({ op: 'insert', table: PROPOSAL_LINES, id: crypto.randomUUID(),
          fields: { proposal_id: id, rate_id: s.rate_id, description: s.description, unit: s.unit, quantity: s.quantity, unit_amount: s.unit_amount, position: last + i + 1 } })),
        `Añadidas ${plural(suggested.length, 'línea', 'líneas')} del tarifario.`);
      }

      function chooseExtra(): void {
        const extras = rates.filter((r) => r.layer === 'extra' && r.active).sort(byPosition);
        const stay = reservation ? stayLength({ start_date: proposal!.start_date ?? reservation.start_date, end_date: proposal!.end_date ?? reservation.end_date }) : null;
        const persons = num(proposal!.persons ?? reservation?.expected_guests);
        let sheet: Sheet;
        sheet = openSheet({
          title: 'Añadir extra',
          body: extras.length === 0
            ? el('p', { class: 'hint', id: 'noExtras', 'data-feedback-id': 'booking.propuesta.extras.vacio', 'data-feedback-label': 'Catálogo de extras vacío' }, 'El catálogo de extras está vacío. El propietario los crea en «Tarifas y condiciones», en la capa «Extras».')
            : el('ul', { class: 'list', id: 'extraChoices', 'data-feedback-id': 'booking.propuesta.extras.lista', 'data-feedback-label': 'Extras disponibles' }, extras.map((r) => el('li', { class: 'row' },
                el('button', { class: 'linkbtn', type: 'button', dataset: { extra: r.name }, 'data-feedback-id': 'booking.propuesta.extras.extra', 'data-feedback-label': 'Extra', onclick: () => {
                  void sheet.close(true);
                  openLine(null, { rate_id: r.id, description: r.name, unit: r.unit, unit_amount: num(r.amount), quantity: stay ? quantityFor(r.unit, persons, stay) : 1 });
                } }, `${r.name} · ${amountText(r.unit, r.amount)}`)))),
          foot: el('div', { class: 'choices' }, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.propuesta.extras.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet.close() }, 'Cancelar')),
        });
      }

      async function discard(): Promise<void> {
        const go = await confirmDialog({ title: 'Quitar borrador', text: `Se quita la versión ${proposal!.version} con sus ${plural(lines.length, 'línea', 'líneas')}. Se puede restaurar desde la papelera.`, confirmLabel: 'Quitar borrador', danger: true });
        if (go && await run([...lines.map((l) => del(PROPOSAL_LINES, l)), del(PROPOSALS, proposal!)], 'Borrador enviado a la papelera.')) navigate(`#/reservas/${proposal!.reservation_id}`);
      }

      const focusedKey = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#proposalLines .sortable-row')?.dataset.key ?? null;
      const linesCard = el('article', { class: 'card', id: 'proposalLines', 'data-feedback-id': 'booking.propuesta.lineas', 'data-feedback-label': 'Líneas' },
        el('div', { class: 'cardhead' }, el('h3', null, 'Líneas'), el('span', { class: 'count' }, String(lines.length))),
        lines.length === 0 ? el('p', { class: 'hint' }, 'Sin líneas todavía.') : lineList(),
        editable ? el('div', { class: 'choices', style: 'margin-top:10px' },
          el('button', { class: 'primary small', type: 'button', id: 'suggestLines', 'data-feedback-id': 'booking.propuesta.lineas.sugerir', 'data-feedback-label': 'Sugerir desde el tarifario', onclick: () => void suggest() }, 'Sugerir desde el tarifario'),
          el('button', { class: 'ghost small', type: 'button', id: 'addExtra', 'data-feedback-id': 'booking.propuesta.lineas.extra', 'data-feedback-label': 'Añadir extra', onclick: chooseExtra }, 'Añadir extra'),
          el('button', { class: 'ghost small', type: 'button', id: 'addLine', 'data-feedback-id': 'booking.propuesta.lineas.anadir', 'data-feedback-label': 'Añadir línea', onclick: () => openLine(null) }, 'Añadir línea')) : null);

      // --- totales
      const totals = el('article', { class: 'card', id: 'proposalTotals', 'data-feedback-id': 'booking.propuesta.totales', 'data-feedback-label': 'Totales' },
        el('div', { class: 'cardhead' }, el('h3', null, 'Totales'), el('span', { class: 'chip' }, f.live ? 'En vivo' : 'Fijados al enviar')),
        el('dl', { class: 'kv' },
          el('dt', null, 'Subtotal'), el('dd', { id: 'totalSubtotal' }, eur(f.subtotal)),
          f.adjustments !== 0 ? el('dt', null, 'Ajustes') : null, f.adjustments !== 0 ? el('dd', { id: 'totalAdjustments' }, eur(f.adjustments)) : null,
          el('dt', null, 'IVA'), el('dd', { id: 'totalVat' }, f.includesVat ? `Incluido (${pct(f.vatRate)}): ${eur(f.vat_amount)}` : `${pct(f.vatRate)}: ${eur(f.vat_amount)}`),
          el('dt', null, 'Total'), el('dd', null, el('strong', { id: 'proposalTotal' }, eur(f.total))),
          el('dt', null, 'Señal'), el('dd', { id: 'proposalDeposit' }, chosen ? eur(f.deposit_amount) : 'Elige unas condiciones')));

      replace(host,
        el('p', null, el('button', { class: 'linkbtn', type: 'button', id: 'backToReservation', 'data-feedback-id': 'booking.propuesta.cabecera_pagina.volver', 'data-feedback-label': 'Volver a la reserva', onclick: () => navigate(`#/reservas/${proposal.reservation_id}`) }, `← ${reservation?.title ?? 'Reserva'}`)),
        el('div', { class: 'pagehead ficha' }, el('div', null,
          el('h2', null, `Propuesta v${proposal.version}`),
          el('p', null, reservation?.title ?? ''),
          el('div', { class: 'chips' }, el('span', { class: 'chip', id: 'proposalStatus', 'data-feedback-id': 'booking.propuesta.cabecera_pagina.estado', 'data-feedback-label': 'Estado', dataset: { status: proposal.status } }, RATE_LABELS.status[proposal.status]),
            proposal._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null))),
        draft ? null : el('div', { class: 'banner', id: 'proposalReadonly', 'data-feedback-id': 'booking.propuesta.solo_lectura', 'data-feedback-label': 'Aviso de solo lectura' }, el('span', null, `Esta propuesta está ${RATE_LABELS.status[proposal.status]!.toLowerCase()} y ya no se puede editar. Para cambiarla, crea una nueva versión desde la ficha.`)),
        el('div', { class: 'choices', 'data-feedback-id': 'booking.propuesta.acciones', 'data-feedback-label': 'Acciones' },
          el('button', { class: 'ghost small', type: 'button', id: 'viewDocument', 'data-feedback-id': 'booking.propuesta.acciones.documento', 'data-feedback-label': 'Ver documento', onclick: () => navigate(`#/propuesta/${id}/documento`) }, 'Ver documento'),
          editable ? el('button', { class: 'danger small', type: 'button', id: 'discardDraft', 'data-feedback-id': 'booking.propuesta.acciones.quitar_borrador', 'data-feedback-label': 'Quitar borrador', onclick: () => void discard() }, 'Quitar borrador') : null),
        el('div', { class: 'cardgrid ficha-grid' }, header, linesCard, totals));
      if (focusedKey) host.querySelector<HTMLElement>(`#proposalLines .sortable-row[data-key="${focusedKey}"] .sortable-handle`)?.focus({ preventScroll: true });
    }

    void paint();
    const offs = [PROPOSALS, PROPOSAL_LINES, CONDITIONS, RATES, RESERVATIONS, EVENTS, BEDS, ASSIGNMENTS].filter((table) => canRead(client, table) || table === RESERVATIONS)
      .map((table) => client.onTable(table, () => void paint()));
    return () => { destroyed = true; offs.forEach((off) => off()); lists.forEach(({ sortable }) => sortable.destroy()); };
  };
}
