/**
 * Ingresos y gastos de apps (0244, API.md §17; encargo de VG del 26-10-2026):
 * - «Ingresos y gastos de apps» (`#/apuntes`): las cifras (ingresos, gastos, sin evento), el resultado por evento y los
 *   apuntes por mes. Tocar el apunte abre su ficha: importes, medios, desglose, evento (enlazar con red) y notas.
 *   Sin «facturado sí/no» (decisión de VG del 26-10): todo apunte que llega es real y va al IVA y a la gestoría.
 * - «Evento» (`#/evento?id=…`): ingresos (apuntes de apps y emitidas asignadas) − gastos (recibidas validadas asignadas
 *   y gastos de apps) = resultado, sin IVA, con cada movimiento.
 * Lo que viene de la otra app no se edita aquí: si estaba mal, lo corrige la app de origen con otro envío.
 * Solo piezas del kit; el lector ve todo sin botones de escritura.
 */
import { bindOnline, closeSheet, createPrintView, el, formatDate, icon, listRow, openSheet, renderGroups, renderStats, replace, toast } from '@ikisai/ui-kit';
import { APP_ENTRIES, ISSUED_ALLOCATIONS, ISSUED_INVOICES, describeError, type LocalAppEntry } from '../app/client.ts';
import { eur, loadMirror, monthLabel, onAnyTable, shortDate } from '../app/data.ts';
import { appName, entriesTotals, eventResults, isFiscal, liveEntries, type EventResult, type EventSources } from '../app/app-entries-state.ts';
import { rememberTarget, searchTargets, type TargetChoice } from '../app/targets.ts';
import { dayReceipt, methodLabel } from '../app/day-receipt.ts';
import { MISSING_ENTITY, fetchEntity, issuerLines } from './issued.ts';
import { ACCEPT_ATTR, openFile, stageDocument } from '../app/files.ts';
import type { SyncClient } from '@ikisai/sync-client';
import type { ViewContext, ViewMount } from './shell.ts';

const fromCents = (c: number) => eur(c / 100);
interface Data { entries: LocalAppEntry[]; events: EventResult[] }

async function loadData(client: SyncClient): Promise<Data> {
  const [entries, m, issuedAllocations, issued] = await Promise.all([
    client.list(APP_ENTRIES) as unknown as Promise<LocalAppEntry[]>,
    loadMirror(client),
    client.list(ISSUED_ALLOCATIONS) as unknown as Promise<EventSources['issuedAllocations']>,
    client.list(ISSUED_INVOICES, { includeDeleted: true }) as unknown as Promise<EventSources['issued']>,
  ]);
  const live = liveEntries(entries);
  const events = eventResults({ entries: live, allocations: m.allocations, lines: m.lines, invoices: m.invoices, issuedAllocations, issued });
  return { entries: live, events };
}

/** Rótulo de un evento: el de las asignaciones o, sin él, el recordado al enlazar. */
function eventLabel(r: EventResult | undefined, eventId: string): string {
  return r?.label ?? rememberedLabel(eventId) ?? 'Evento de Booking';
}
const LABELS_KEY = 'ikisai-invoices-event-labels';
function rememberedLabel(id: string): string | null {
  try { return (JSON.parse(localStorage.getItem(LABELS_KEY) ?? '{}') as Record<string, string>)[id] ?? null; } catch { return null; }
}
function rememberLabel(id: string, label: string): void {
  try { const all = JSON.parse(localStorage.getItem(LABELS_KEY) ?? '{}') as Record<string, string>; all[id] = label; localStorage.setItem(LABELS_KEY, JSON.stringify(all)); } catch { /* sin almacenamiento local */ }
}

/** La ficha de un apunte, compartida por la lista y la vista «Evento». */
function openEntry(ctx: ViewContext, data: Data, entry: LocalAppEntry, reload: () => void): void {
  const { client, navigate } = ctx;
  const canEdit = (client.bootstrap()?.membership.role ?? 'reader') !== 'reader';
  const event = entry.event_id ? data.events.find((r) => r.eventId === entry.event_id) : undefined;
  const notes = el('textarea', { id: 'appEntryNotes', rows: '3', maxlength: '2000' }, entry.notes ?? '') as HTMLTextAreaElement;
  // Justificante (0245): con él, un apunte de proceso pasa a fiscal y va a la gestoría (el único sentido permitido)
  const receiptFile = el('input', { type: 'file', id: 'appEntryReceiptFile', accept: ACCEPT_ATTR }) as HTMLInputElement;
  const receiptNumber = el('input', { type: 'text', id: 'appEntryReceiptNumber', maxlength: '64', value: entry.receipt_number ?? '', placeholder: 'Número de la factura o del ticket' }) as HTMLInputElement;
  // 0247: factura o ticket. Un gasto con ticket se registra, pero no es deducible ni va a la gestoría.
  const receiptKind = el('select', { id: 'appEntryReceiptKind', 'data-feedback-id': 'invoices.apuntes.ficha.tipo_justificante', 'data-feedback-label': 'Factura o ticket' },
    el('option', { value: 'invoice', selected: (entry.receipt_kind ?? 'invoice') === 'invoice' }, 'Factura'),
    el('option', { value: 'ticket', selected: entry.receipt_kind === 'ticket', disabled: entry.receipt_kind === 'invoice' }, 'Ticket')) as HTMLSelectElement;
  const linkButton = canEdit ? el('button', { 'data-feedback-id': 'invoices.apuntes.ficha.enlazar_evento', 'data-feedback-label': 'Enlazar con un evento', class: 'ghost', type: 'button', id: 'appEntryLinkEvent',
    onclick: () => openEventPicker(ctx, entry, reload) }, icon('calendar', 16), entry.event_id ? 'Cambiar el evento' : 'Enlazar con un evento') : null;
  const linkReason = el('div', { class: 'inv-reason' });
  if (linkButton) bindOnline(linkButton, { client, reason: 'Buscar eventos de Booking necesita conexión.', reasonHost: linkReason });
  const methods = Object.entries(entry.methods ?? {});
  openSheet({
    title: entry.description,
    meta: `${appName(entry.source_app)} · ${shortDate(entry.entry_date)} · ${entry.kind === 'income' ? 'Ingreso' : 'Gasto'}`,
    panelAttrs: { 'data-feedback-id': 'invoices.apuntes.ficha', 'data-feedback-label': 'Ficha del apunte' },
    body: el('div', { id: 'appEntrySheet' },
      el('dl', { class: 'kv' },
        el('dt', null, 'Total'), el('dd', null, el('strong', null, fromCents(entry.amount_cents)), ' IVA incluido'),
        el('dt', null, 'Base'), el('dd', null, fromCents(entry.net_cents)),
        el('dt', null, `IVA ${String(Number(entry.tax_rate)).replace('.', ',')} %`), el('dd', null, fromCents(entry.tax_cents)),
        entry.pending_refunds_cents ? el('dt', null, 'Devoluciones pendientes') : null,
        entry.pending_refunds_cents ? el('dd', null, `${fromCents(entry.pending_refunds_cents)} (aún no devueltas en ${appName(entry.source_app)})`) : null,
        methods.length ? el('dt', null, 'Medios') : null,
        methods.length ? el('dd', null, methods.map(([k, v]) => `${methodLabel(k)} ${fromCents(Number(v))}`).join(' · ')) : null,
        el('dt', null, 'Evento'), el('dd', null, entry.event_id
          ? el('a', { href: `#/evento?id=${entry.event_id}`, 'data-feedback-id': 'invoices.apuntes.ficha.ver_evento', 'data-feedback-label': 'Ver el evento',
            onclick: (e: Event) => { e.preventDefault(); void closeSheet(); navigate(`#/evento?id=${entry.event_id}`); } }, eventLabel(event, entry.event_id))
          : 'Sin evento'),
        el('dt', null, 'Tipo'), el('dd', { id: 'appEntryNature' }, isFiscal(entry) ? 'Fiscal: va a la gestoría y al IVA' : 'De proceso: informativo, no va a la gestoría'),
        el('dt', null, 'Justificante'), el('dd', { id: 'appEntryReceiptInfo' }, entry.receipt_kind ? `${entry.receipt_kind === 'ticket' ? 'Ticket' : 'Factura'} ` : null, entry.receipt_number ? `Nº ${entry.receipt_number}` : null,
          entry.receipt_file_id ? el('button', { 'data-feedback-id': 'invoices.apuntes.ficha.ver_justificante', 'data-feedback-label': 'Ver el justificante', class: 'linkbtn', type: 'button',
            onclick: () => void openFile(client, entry.receipt_file_id!).catch((e) => toast(describeError(e))) }, ' Ver el documento') : null,
          !entry.receipt_number && !entry.receipt_file_id ? 'Sin justificante' : null),
        el('dt', null, 'Recibido'), el('dd', null, formatDate(entry.received_at)),
        el('dt', null, 'Referencia'), el('dd', { class: 'hint' }, entry.source_ref)),
      entry.detail?.length
        ? el('details', { 'data-feedback-id': 'invoices.apuntes.ficha.desglose', 'data-feedback-label': 'Desglose' }, el('summary', null, `Desglose (${entry.detail.length})`),
          el('ul', { class: 'plain', id: 'appEntryDetail', 'data-feedback-ignore': '' }, ...entry.detail.map((d) => el('li', null, `${d.code ? `${d.code} · ` : ''}${d.name} × ${d.quantity} · ${fromCents(d.amount_cents)}`))))
        : null,
      canEdit ? el('p', { class: 'btnrow' }, linkButton) : null, linkReason,
      canEdit ? el('fieldset', { class: 'field', id: 'appEntryReceiptForm' }, el('legend', null, 'Justificante'),
        isFiscal(entry) ? null : el('p', { class: 'hint' }, entry.kind === 'expense'
          ? 'Con su factura pasa a fiscal: va a la gestoría y su IVA cuenta como soportado. Con ticket se registra, pero no es deducible. No se puede deshacer.'
          : 'Con su factura o su ticket pasa a fiscal y va a la gestoría. No se puede deshacer.'),
        el('label', { class: 'field' }, el('span', null, 'Tipo'), receiptKind),
        el('label', { class: 'field' }, el('span', null, 'Foto o PDF'), receiptFile),
        el('label', { class: 'field' }, el('span', null, 'Número'), receiptNumber)) : null,
      canEdit ? el('label', { class: 'field' }, el('span', null, 'Notas'), notes) : el('p', null, entry.notes ?? '')),
    foot: [
      entry.kind === 'income' && isFiscal(entry) ? el('button', { 'data-feedback-id': 'invoices.apuntes.ficha.justificante', 'data-feedback-label': 'Justificante del día', class: 'ghost', type: 'button', id: 'appEntryReceipt',
        onclick: () => void openDayReceipt(ctx, entry) }, icon('invoice', 16), 'Justificante') : null,
      canEdit ? el('button', { 'data-feedback-id': 'invoices.apuntes.ficha.guardar', 'data-feedback-label': 'Guardar', class: 'primary', type: 'button', id: 'appEntrySave', onclick: async () => {
        const fields: Record<string, unknown> = {};
        const n = notes.value.trim() || null;
        if (n !== (entry.notes ?? null)) fields.notes = n;
        const number = receiptNumber.value.trim() || null;
        if (number !== (entry.receipt_number ?? null)) fields.receipt_number = number;
        if ((number || receiptFile.files?.length || entry.receipt_file_id || entry.receipt_number) && receiptKind.value !== (entry.receipt_kind ?? 'invoice')) fields.receipt_kind = receiptKind.value;
        const file = receiptFile.files?.[0];
        if (file) {
          try { fields.receipt_file_id = (await stageDocument(client, file)).marker; } catch (error) { toast(describeError(error)); return; }
        }
        if (!Object.keys(fields).length) { void closeSheet(); return; }
        if (await save(client, entry, fields, 'Apunte guardado.')) { void closeSheet(); reload(); }
      } }, 'Guardar') : null,
      el('button', { class: canEdit ? 'ghost' : 'primary', type: 'button', onclick: () => void closeSheet() }, 'Cerrar'),
    ].filter(Boolean) as HTMLElement[],
  });
}

/** Enlace estable al justificante de un apunte (API.md §17.9): por su id o por la clave de la app de origen. */
export const receiptLink = (entry: { id: string }) => `#/justificante/${entry.id}`;

/**
 * El justificante imprimible de un ingreso (API.md §17.5 y §17.9): emisor de Central (con red), número de cobro, fecha,
 * líneas, medios de cobro e IVA incluido; ticket o factura simplificada según `receipt_kind` (`app/day-receipt.ts`).
 * La vista de impresión del kit lleva «Imprimir / Guardar PDF» (y su CSS de impresión); aquí se añade «Compartir».
 */
async function receiptView(ctx: ViewContext, entry: LocalAppEntry, options: { onBack?: () => void } = {}): Promise<{ title: string; meta: string; element: HTMLElement }> {
  const r = dayReceipt(entry);
  const { entity } = await fetchEntity(ctx.client);
  const rate = `${String(r.rate).replace('.', ',')} %`;
  const body = el('div', { class: 'issued-print', id: 'dayReceipt' },
    el('div', { class: 'issued-print-parties' },
      el('div', { id: 'receiptIssuer' }, el('small', null, 'Emisor'),
        ...(entity ? issuerLines(entity).map((l, i) => (i === 0 ? el('strong', null, l) : el('div', null, l))) : [el('div', { class: 'banner warn' }, MISSING_ENTITY)])),
      el('div', null, el('small', null, r.number ? 'Cobro' : 'Ventas'), el('strong', { id: 'receiptNumber' }, r.number ? `Nº ${r.number}` : r.description),
        el('div', null, `${shortDate(r.date)} · ${appName(entry.source_app)}`), r.number ? el('div', null, r.description) : null)),
    r.lines.length ? el('table', { class: 'inv-table', id: 'receiptLines' },
      el('thead', null, el('tr', null, el('th', null, 'Concepto'), el('th', { class: 'num' }, 'Cantidad'), el('th', { class: 'num' }, 'Importe'))),
      el('tbody', null, ...r.lines.map((l) => el('tr', null, el('td', null, l.label), el('td', { class: 'num' }, String(l.quantity).replace('.', ',')), el('td', { class: 'num' }, fromCents(l.cents)))))) : null,
    r.methods.length ? el('table', { class: 'inv-table', id: 'receiptMethods' },
      el('thead', null, el('tr', null, el('th', null, 'Medio de cobro'), el('th', { class: 'num' }, 'Importe'))),
      el('tbody', null, ...r.methods.map((m) => el('tr', null, el('td', null, m.label), el('td', { class: 'num' }, fromCents(m.cents)))))) : null,
    el('div', { class: 'inv-totals', 'data-feedback-ignore': '' },
      el('div', null, el('span', null, 'Base'), el('strong', null, fromCents(r.netCents))),
      el('div', null, el('span', null, `IVA ${rate} incluido`), el('strong', null, fromCents(r.taxCents))),
      r.pendingRefundsCents ? el('div', null, el('span', null, 'Devoluciones pendientes'), el('strong', null, fromCents(r.pendingRefundsCents))) : null,
      el('div', { class: 'total' }, el('span', null, 'TOTAL'), el('strong', null, fromCents(r.totalCents)))));
  // «Compartir»: la hoja del sistema con el enlace (desde ella, o desde «Imprimir», el móvil guarda o comparte el PDF)
  const url = `${location.origin}${location.pathname}${receiptLink(entry)}`;
  const share = typeof navigator.share === 'function'
    ? el('button', { 'data-feedback-id': 'invoices.justificante.compartir', 'data-feedback-label': 'Compartir', class: 'ghost', type: 'button', id: 'receiptShare',
      onclick: () => void navigator.share({ title: `${r.title}${r.number ? ` ${r.number}` : ''}`, text: `${r.title} · ${fromCents(r.totalCents)} · ${shortDate(r.date)}`, url }).catch(() => undefined) }, icon('upload', 18), 'Compartir')
    : null;
  const view = createPrintView({
    brand: { appName: 'Finance', markIcon: 'invoice', line: entity?.legal_name ?? MISSING_ENTITY },
    title: r.title,
    subtitle: r.number ? `Nº ${r.number}` : undefined,
    meta: [shortDate(r.date), r.description],
    draft: r.kind === 'invoice' ? false : 'TICKET',
    intro: body,
    sections: [],
    notes: r.notice,
    runningFoot: `Ikisai Finance · ${r.title}${r.number ? ` ${r.number}` : ''} · ${r.date}`,
  }, { printLabel: 'Imprimir / Guardar PDF', actions: share ? [share] : [], ...(options.onBack ? { onBack: options.onBack, backLabel: 'Volver' } : {}) });
  return { title: r.title, meta: `${shortDate(r.date)} · ${r.description}`, element: view.element };
}

/** El justificante en una hoja, desde la ficha del apunte. */
async function openDayReceipt(ctx: ViewContext, entry: LocalAppEntry): Promise<void> {
  const v = await receiptView(ctx, entry);
  openSheet({ title: v.title, meta: v.meta,
    body: el('div', { 'data-feedback-id': 'invoices.apuntes.justificante', 'data-feedback-label': 'Justificante del día', 'data-feedback-ignore': '', id: 'dayReceiptView' }, v.element),
    foot: [el('button', { 'data-feedback-id': 'invoices.apuntes.justificante.cerrar', 'data-feedback-label': 'Cerrar', class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')] });
}

/**
 * «Justificante» a página completa (API.md §17.9): `#/justificante/<id>` o `#/justificante?ref=<source_ref>` (la clave
 * de la app de origen, para que Flow enlace sin guardar ids). Funciona sin red con el espejo del dispositivo; el emisor
 * de Central necesita red (sin ella, avisa).
 */
export const mountReceipt: ViewMount = (ctx) => {
  const { main, client, navigate } = ctx;
  const [path, query] = location.hash.slice(1).split('?');
  const id = (path ?? '').split('/')[2] ?? '';
  const ref = new URLSearchParams(query ?? '').get('ref');
  const host = el('div', { id: 'receiptPage', 'data-feedback-id': 'invoices.justificante', 'data-feedback-label': 'Justificante', 'data-feedback-ignore': '' });
  replace(main, host);
  const back = () => (history.length > 1 ? history.back() : navigate('#/apuntes'));
  async function load(): Promise<void> {
    const entries = liveEntries((await client.list(APP_ENTRIES)) as unknown as LocalAppEntry[]);
    const entry = entries.find((e) => (id && e.id === id) || (!!ref && e.source_ref === ref));
    if (!entry) {
      replace(host, el('div', { class: 'card', id: 'receiptMissing' }, el('h3', null, 'Este justificante no está en este dispositivo'),
        el('p', null, 'Puede que aún no haya llegado de la otra app o que no se haya sincronizado. Vuelve a intentarlo con conexión.')));
      return;
    }
    if (entry.kind !== 'income' || !isFiscal(entry)) {
      replace(host, el('div', { class: 'card', id: 'receiptMissing' }, el('h3', null, 'Este apunte no tiene justificante'),
        el('p', null, entry.kind !== 'income' ? 'Solo los cobros tienen justificante de venta.' : 'Es un apunte de proceso: no va a la gestoría ni lleva justificante.')));
      return;
    }
    replace(host, (await receiptView(ctx, entry, { onBack: back })).element);
  }
  void load();
  return onAnyTable(client, () => void load());
};

async function save(client: SyncClient, entry: LocalAppEntry, fields: Record<string, unknown>, okMessage: string): Promise<boolean> {
  try {
    await client.commit([{ op: 'update', table: APP_ENTRIES, id: entry.id, expectedRevision: entry.revision, fields }]);
    toast(client.status().network === 'offline' ? `${okMessage} Se sincronizará cuando haya red.` : okMessage);
    return true;
  } catch (error) {
    toast(describeError(error));
    return false;
  }
}

/** Buscar un evento de Booking (con red) y enlazarlo al apunte. */
function openEventPicker(ctx: ViewContext, entry: LocalAppEntry, reload: () => void): void {
  const { client } = ctx;
  const results = el('ul', { class: 'plain', id: 'appEntryEvents', 'data-feedback-ignore': '' });
  const input = el('input', { type: 'search', id: 'appEntryEventSearch', placeholder: 'Buscar el evento', 'aria-label': 'Buscar el evento' }) as HTMLInputElement;
  let seq = 0;
  const search = async () => {
    const mine = ++seq;
    try {
      const items = await searchTargets(client, 'booking', input.value.trim(), 'event');
      if (mine !== seq) return;
      replace(results, ...(items.length ? items.map((t) => el('li', null, el('button', { 'data-feedback-id': 'invoices.apuntes.evento.elegir', 'data-feedback-label': 'Elegir el evento', class: 'linkbtn', type: 'button', onclick: () => void choose(t) },
        el('strong', null, t.label), t.code ? ` · ${t.code}` : ''))) : [el('li', { class: 'hint' }, 'No hay eventos con ese nombre.')]));
    } catch (error) { if (mine === seq) replace(results, el('li', { class: 'hint' }, describeError(error))); }
  };
  const choose = async (t: TargetChoice) => {
    rememberTarget(t); rememberLabel(t.id, t.label);
    if (await save(client, entry, { event_id: t.id }, `Enlazado con «${t.label}».`)) { void closeSheet(true); reload(); }
  };
  input.addEventListener('input', () => void search());
  openSheet({
    title: 'Enlazar con un evento',
    meta: 'Eventos de Booking: el resultado del evento sumará este apunte.',
    body: el('div', null, input, results,
      entry.event_id ? el('p', null, el('button', { 'data-feedback-id': 'invoices.apuntes.evento.quitar', 'data-feedback-label': 'Quitar el evento', class: 'ghost', type: 'button',
        onclick: async () => { if (await save(client, entry, { event_id: null }, 'Evento quitado.')) { void closeSheet(true); reload(); } } }, 'Quitar el evento')) : null),
    foot: [el('button', { class: 'primary', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')],
  });
  void search();
}

/** «Ingresos y gastos de apps». */
export const mountAppEntries: ViewMount = (ctx) => {
  const { main, client, navigate } = ctx;
  const stats = el('div', { id: 'appEntriesStats' });
  const eventsHost = el('section', { id: 'appEntriesEvents', 'data-feedback-id': 'invoices.apuntes.eventos', 'data-feedback-label': 'Por evento' });
  const listHost = el('section', { id: 'appEntriesList' });

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Ingresos y gastos de apps'),
      el('p', null, 'Lo que mandan otras apps, como las ventas de la barra de Flow. Todo es real: va al IVA y a la entrega a la gestoría.'))),
    stats, eventsHost, listHost);

  function row(entry: LocalAppEntry, d: Data): HTMLLIElement {
    const li = listRow({
      id: entry.id,
      title: entry.description,
      meta: [shortDate(entry.entry_date), appName(entry.source_app), entry.kind === 'income' ? 'Ingreso' : 'Gasto', isFiscal(entry) ? 'Fiscal' : 'De proceso', entry.event_id ? eventLabel(d.events.find((r) => r.eventId === entry.event_id), entry.event_id) : 'Sin evento'],
      chips: [el('span', { class: `chip${entry.kind === 'income' ? ' ok' : ''}` }, `${entry.kind === 'income' ? '+' : '−'}${fromCents(entry.amount_cents)}`)],
      pending: (entry as { _pending?: boolean })._pending === true,
      onClick: () => openEntry(ctx, d, entry, () => void load()),
      label: `Abrir ${entry.description}`,
    });
    li.setAttribute('data-feedback-id', 'invoices.apuntes.lista.fila');
    li.setAttribute('data-feedback-label', 'Apunte');
    return li;
  }

  function paint(d: Data): void {
    const t = entriesTotals(d.entries);
    replace(stats, renderStats([
      { value: fromCents(t.incomeCents), label: 'ingresos', hint: t.process ? `fiscal ${fromCents(t.fiscalIncomeCents)} · con IVA` : 'con IVA' },
      { value: fromCents(t.expenseCents), label: 'gastos', hint: 'con IVA' },
      { value: t.withoutEvent, label: 'sin evento' },
      { value: d.events.length, label: 'eventos', onClick: d.events.length ? () => eventsHost.scrollIntoView({ behavior: 'smooth' }) : undefined, feedbackId: 'invoices.apuntes.cifras.eventos' },
    ], { label: 'Ingresos y gastos de apps' }));
    replace(eventsHost, ...(d.events.length ? [
      el('h3', { class: 'sectionlabel' }, 'Resultado por evento'),
      el('ul', { class: 'list', 'aria-label': 'Resultado por evento' }, ...d.events.map((r) => {
        const li = listRow({
          id: r.eventId,
          title: eventLabel(r, r.eventId),
          meta: [`Ingresos ${fromCents(r.incomeCents)}`, `Gastos ${fromCents(r.expenseCents)}`, 'sin IVA'],
          chips: [el('span', { class: `chip ${r.resultCents >= 0 ? 'ok' : 'alert'}` }, `Resultado ${fromCents(r.resultCents)}`)],
          onClick: () => navigate(`#/evento?id=${r.eventId}`),
          label: `Ver el resultado de ${eventLabel(r, r.eventId)}`,
        });
        li.setAttribute('data-feedback-id', 'invoices.apuntes.eventos.fila');
        li.setAttribute('data-feedback-label', 'Evento');
        return li;
      })),
    ] : []));
    if (!d.entries.length) {
      replace(listHost, el('div', { class: 'card', id: 'appEntriesEmpty' }, el('h3', null, 'Todavía no ha llegado nada'),
        el('p', null, 'Cuando Flow cierre el día de la barra, sus ventas aparecerán aquí.')));
      return;
    }
    const byMonth = new Map<string, LocalAppEntry[]>();
    for (const e of [...d.entries].sort((a, b) => b.entry_date.localeCompare(a.entry_date) || a.source_ref.localeCompare(b.source_ref))) {
      const key = e.entry_date.slice(0, 7);
      byMonth.set(key, [...(byMonth.get(key) ?? []), e]);
    }
    replace(listHost, el('h3', { class: 'sectionlabel' }, 'Apuntes'), renderGroups<LocalAppEntry>({
      label: 'Apuntes por mes', feedbackId: 'invoices.apuntes.lista.grupos', worstFirst: false,
      toneOf: (e) => (e.event_id ? null : 'warn'),
      groups: [...byMonth.entries()].map(([key, items], i) => {
        const tt = entriesTotals(items);
        return { key, title: monthLabel(key), items, open: i === 0, summary: [`${items.length} apunte${items.length === 1 ? '' : 's'}`, fromCents(tt.incomeCents - tt.expenseCents), tt.withoutEvent ? `${tt.withoutEvent} sin evento` : null].filter(Boolean).join(' · ') };
      }),
      row: (e) => row(e, d),
    }).element);
  }

  async function load(): Promise<void> {
    paint(await loadData(client));
  }
  void load();
  return onAnyTable(client, () => void load());
};

/** «Evento»: ingresos − gastos = resultado, sin IVA, con cada movimiento. */
export const mountEvent: ViewMount = (ctx) => {
  const { main, client, navigate } = ctx;
  const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get('id') ?? '';

  function paint(d: Data): void {
    const r = d.events.find((x) => x.eventId === id);
    const back = el('p', null, el('a', { href: '#/apuntes', 'data-feedback-id': 'invoices.evento.volver', 'data-feedback-label': 'Volver a ingresos y gastos de apps',
      onclick: (e: Event) => { e.preventDefault(); navigate('#/apuntes'); } }, '‹ Ingresos y gastos de apps'));
    if (!r) {
      replace(main, back, el('div', { class: 'card', id: 'eventEmpty' }, el('h3', null, 'Este evento no tiene movimientos'),
        el('p', null, 'Ni apuntes de apps ni facturas asignadas a él.')));
      return;
    }
    const open = (m: EventResult['moves'][number]) => {
      if (m.kind === 'invoice') navigate(`#/facturas/${m.id}`);
      else if (m.kind === 'issued') navigate('#/facturas?vista=emitidas');
      else { const entry = d.entries.find((e) => e.id === m.id); if (entry) openEntry(ctx, d, entry, () => void load()); }
    };
    const KIND = { app: 'App', invoice: 'Factura recibida', issued: 'Factura emitida' } as const;
    replace(main, back,
      el('div', { class: 'pagehead' }, el('div', null, el('h2', { id: 'eventTitle' }, eventLabel(r, r.eventId)),
        el('p', null, 'Resultado del evento sin IVA: lo cobrado (apps y facturas emitidas) menos lo gastado (facturas recibidas validadas y gastos de apps).'))),
      el('div', { id: 'eventStats' }, renderStats([
        { value: fromCents(r.incomeCents), label: 'ingresos', hint: `apps ${fromCents(r.appIncomeCents)} · emitidas ${fromCents(r.issuedIncomeCents)}` },
        { value: fromCents(r.expenseCents), label: 'gastos', hint: `facturas ${fromCents(r.invoiceExpenseCents)} · apps ${fromCents(r.appExpenseCents)}` },
        { value: fromCents(r.resultCents), label: 'resultado', tone: r.resultCents >= 0 ? 'ok' : 'alert' },
      ], { label: 'Resultado del evento' })),
      r.pendingInvoices ? el('p', { class: 'hint', id: 'eventPending' }, `${r.pendingInvoices} factura${r.pendingInvoices === 1 ? '' : 's'} asignada${r.pendingInvoices === 1 ? '' : 's'} al evento aún sin validar: cuenta${r.pendingInvoices === 1 ? '' : 'n'} como gasto de proceso hasta tener su justificante y validarse.`) : null,
      el('h3', { class: 'sectionlabel' }, 'Movimientos'),
      el('ul', { class: 'list', id: 'eventMoves', 'aria-label': 'Movimientos del evento' }, ...r.moves.map((m) => {
        const li = listRow({
          id: `${m.kind}-${m.id}`, title: m.title, meta: [shortDate(m.date), KIND[m.kind], m.process ? 'De proceso' : ''].filter(Boolean),
          chips: [el('span', { class: `chip ${m.sign > 0 ? 'ok' : ''}` }, `${m.sign > 0 ? '+' : '−'}${fromCents(m.cents)}`)],
          onClick: () => open(m), label: `Abrir ${m.title}`,
        });
        li.setAttribute('data-feedback-id', 'invoices.evento.movimiento');
        li.setAttribute('data-feedback-label', 'Movimiento');
        return li;
      })));
  }

  async function load(): Promise<void> {
    paint(await loadData(client));
  }
  void load();
  return onAnyTable(client, () => void load());
};

/** Pista de la herramienta de Inicio: lo ingresado o lo que falta enlazar a un evento. */
export async function appEntriesHint(client: SyncClient): Promise<string> {
  const t = entriesTotals(liveEntries((await client.list(APP_ENTRIES)) as unknown as LocalAppEntry[]));
  if (!t.count) return 'Nada todavía';
  return fromCents(t.incomeCents);
}
