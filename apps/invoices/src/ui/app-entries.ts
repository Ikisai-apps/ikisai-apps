/**
 * Ingresos y gastos de apps (0244, API.md §17; encargo de VG del 26-10-2026):
 * - «Ingresos y gastos de apps» (`#/apuntes`): las cifras (facturado, no facturado, sin evento), el resultado por evento
 *   y los apuntes por mes. Cada apunte se factura o no con un toque; al dejarlo sin facturar, «Añadir motivo». Tocar el
 *   apunte abre su ficha: importes, medios, desglose, evento (enlazar con red), motivo y notas.
 * - «Evento» (`#/evento?id=…`): ingresos (apuntes de apps y emitidas asignadas) − gastos (recibidas validadas asignadas
 *   y gastos de apps) = resultado, sin IVA, con cada movimiento.
 * Lo que viene de la otra app no se edita aquí; un apunte ya entregado a la gestoría no cambia de «facturado».
 * Solo piezas del kit; el lector ve todo sin botones de escritura.
 */
import { bindOnline, closeSheet, el, formatDate, icon, listRow, openSheet, renderGroups, renderStats, replace, toast, toastWithAction } from '@ikisai/ui-kit';
import { APP_ENTRIES, EXPORTS, ISSUED_ALLOCATIONS, ISSUED_INVOICES, describeError, type LocalAppEntry } from '../app/client.ts';
import { eur, loadMirror, monthLabel, onAnyTable, shortDate } from '../app/data.ts';
import { appName, entriesTotals, entryDelivered, eventResults, liveEntries, type EventResult, type EventSources } from '../app/app-entries-state.ts';
import { rememberTarget, searchTargets, type TargetChoice } from '../app/targets.ts';
import type { SyncClient } from '@ikisai/sync-client';
import type { ViewContext, ViewMount } from './shell.ts';

const METHOD_LABELS: Record<string, string> = { cash: 'Efectivo', bizum: 'Bizum', card: 'Tarjeta', transfer: 'Transferencia' };
const methodLabel = (k: string) => METHOD_LABELS[k] ?? k;
const fromCents = (c: number) => eur(c / 100);
type ExportLike = { status: string; deleted_at: string | null; manifest?: { app_entries?: Array<{ id: string }> } | null };

interface Data { entries: LocalAppEntry[]; events: EventResult[]; exports: ExportLike[] }

async function loadData(client: SyncClient): Promise<Data> {
  const [entries, m, issuedAllocations, issued, exports] = await Promise.all([
    client.list(APP_ENTRIES) as unknown as Promise<LocalAppEntry[]>,
    loadMirror(client),
    client.list(ISSUED_ALLOCATIONS) as unknown as Promise<EventSources['issuedAllocations']>,
    client.list(ISSUED_INVOICES, { includeDeleted: true }) as unknown as Promise<EventSources['issued']>,
    client.list(EXPORTS) as unknown as Promise<ExportLike[]>,
  ]);
  const live = liveEntries(entries);
  const events = eventResults({ entries: live, allocations: m.allocations, lines: m.lines, invoices: m.invoices, issuedAllocations, issued });
  return { entries: live, events, exports };
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
  const locked = entryDelivered(entry.id, data.exports);
  const event = entry.event_id ? data.events.find((r) => r.eventId === entry.event_id) : undefined;
  const reason = el('input', { type: 'text', id: 'appEntryReason', maxlength: '300', value: entry.invoiced_reason ?? '', placeholder: 'Por qué no se factura (opcional)' }) as HTMLInputElement;
  const notes = el('textarea', { id: 'appEntryNotes', rows: '3', maxlength: '2000' }, entry.notes ?? '') as HTMLTextAreaElement;
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
        el('dt', null, 'Facturado'), el('dd', { id: 'appEntryInvoiced' }, entry.invoiced ? 'Sí' : `No${entry.invoiced_reason ? ` · ${entry.invoiced_reason}` : ''}`,
          entry.invoiced_changed_at ? el('span', { class: 'hint' }, ` (cambiado el ${formatDate(entry.invoiced_changed_at)})`) : null),
        el('dt', null, 'Evento'), el('dd', null, entry.event_id
          ? el('a', { href: `#/evento?id=${entry.event_id}`, 'data-feedback-id': 'invoices.apuntes.ficha.ver_evento', 'data-feedback-label': 'Ver el evento',
            onclick: (e: Event) => { e.preventDefault(); void closeSheet(); navigate(`#/evento?id=${entry.event_id}`); } }, eventLabel(event, entry.event_id))
          : 'Sin evento'),
        el('dt', null, 'Recibido'), el('dd', null, formatDate(entry.received_at)),
        el('dt', null, 'Referencia'), el('dd', { class: 'hint' }, entry.source_ref)),
      locked ? el('p', { class: 'hint', id: 'appEntryLocked' }, 'Ya está en una entrega a la gestoría: «facturado» no se cambia.') : null,
      entry.detail?.length
        ? el('details', { 'data-feedback-id': 'invoices.apuntes.ficha.desglose', 'data-feedback-label': 'Desglose' }, el('summary', null, `Desglose (${entry.detail.length})`),
          el('ul', { class: 'plain', id: 'appEntryDetail', 'data-feedback-ignore': '' }, ...entry.detail.map((d) => el('li', null, `${d.code ? `${d.code} · ` : ''}${d.name} × ${d.quantity} · ${fromCents(d.amount_cents)}`))))
        : null,
      canEdit ? el('p', { class: 'btnrow' }, linkButton) : null, linkReason,
      canEdit ? el('label', { class: 'field' }, el('span', null, 'Motivo de no facturar'), reason) : null,
      canEdit ? el('label', { class: 'field' }, el('span', null, 'Notas'), notes) : el('p', null, entry.notes ?? '')),
    foot: [
      canEdit ? el('button', { 'data-feedback-id': 'invoices.apuntes.ficha.guardar', 'data-feedback-label': 'Guardar', class: 'primary', type: 'button', id: 'appEntrySave', onclick: async () => {
        const fields: Record<string, unknown> = {};
        const r = reason.value.trim() || null; const n = notes.value.trim() || null;
        if (r !== (entry.invoiced_reason ?? null)) fields.invoiced_reason = r;
        if (n !== (entry.notes ?? null)) fields.notes = n;
        if (!Object.keys(fields).length) { void closeSheet(); return; }
        if (await save(client, entry, fields, 'Apunte guardado.')) { void closeSheet(); reload(); }
      } }, 'Guardar') : null,
      el('button', { class: canEdit ? 'ghost' : 'primary', type: 'button', onclick: () => void closeSheet() }, 'Cerrar'),
    ].filter(Boolean) as HTMLElement[],
  });
}

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
  const canEdit = (client.bootstrap()?.membership.role ?? 'reader') !== 'reader';
  const stats = el('div', { id: 'appEntriesStats' });
  const eventsHost = el('section', { id: 'appEntriesEvents', 'data-feedback-id': 'invoices.apuntes.eventos', 'data-feedback-label': 'Por evento' });
  const listHost = el('section', { id: 'appEntriesList' });
  let data: Data | null = null;

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Ingresos y gastos de apps'),
      el('p', null, 'Lo que mandan otras apps, como las ventas de la barra de Flow. Lo facturado va a la gestoría y al IVA; lo no facturado, no.'))),
    stats, eventsHost, listHost);

  async function toggle(entry: LocalAppEntry): Promise<void> {
    const to = !entry.invoiced;
    const ok = await save(client, entry, { invoiced: to }, to ? `«${entry.description}» facturado: entra en la gestoría.` : `«${entry.description}» sin facturar: fuera de la gestoría y del IVA.`);
    if (!ok) return;
    await load();
    if (!to) {
      const fresh = data?.entries.find((e) => e.id === entry.id);
      if (fresh) toastWithAction('Puedes dejar el motivo.', { label: 'Añadir motivo', onClick: () => data && openEntry(ctx, data, fresh, () => void load()) }, 8000);
    }
  }

  function row(entry: LocalAppEntry, d: Data): HTMLLIElement {
    const locked = entryDelivered(entry.id, d.exports);
    const toggleButton = canEdit ? el('button', {
      'data-feedback-id': 'invoices.apuntes.lista.facturado', 'data-feedback-label': 'Facturado sí o no', class: 'linkbtn', type: 'button',
      'aria-pressed': String(entry.invoiced), 'aria-label': `${entry.invoiced ? 'Facturado' : 'No facturado'}: ${entry.description}`,
      ...(locked ? { 'aria-disabled': 'true', title: 'Ya entregado a la gestoría' } : {}),
      onclick: (e: Event) => { e.stopPropagation(); if (locked) { toast('Ya está en una entrega a la gestoría: no se cambia.'); return; } void toggle(entry); },
    }, icon(entry.invoiced ? 'check' : 'close', 16), entry.invoiced ? 'Facturado' : 'No facturado') : null;
    const li = listRow({
      id: entry.id,
      title: entry.description,
      meta: [shortDate(entry.entry_date), appName(entry.source_app), entry.kind === 'income' ? 'Ingreso' : 'Gasto', entry.event_id ? eventLabel(d.events.find((r) => r.eventId === entry.event_id), entry.event_id) : 'Sin evento'],
      chips: [el('span', { class: 'chip' }, fromCents(entry.amount_cents)), canEdit ? null : el('span', { class: `chip${entry.invoiced ? ' ok' : ' warn'}` }, entry.invoiced ? 'Facturado' : 'No facturado')].filter(Boolean) as HTMLElement[],
      pending: (entry as { _pending?: boolean })._pending === true,
      actions: toggleButton ? [toggleButton] : [],
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
      { value: fromCents(t.invoicedIncomeCents), label: 'ingresos facturados', hint: 'con IVA' },
      { value: t.notInvoiced, label: 'sin facturar', tone: t.notInvoiced ? 'warn' : null, hint: t.notInvoiced ? fromCents(t.notInvoicedCents) : undefined },
      { value: t.withoutEvent, label: 'sin evento' },
      { value: d.events.length, label: d.events.length === 1 ? 'evento' : 'eventos', onClick: d.events.length ? () => eventsHost.scrollIntoView({ behavior: 'smooth' }) : undefined, feedbackId: 'invoices.apuntes.cifras.eventos' },
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
        el('p', null, 'Cuando Flow cierre el día de la barra, sus ventas aparecerán aquí, facturadas por defecto.')));
      return;
    }
    const byMonth = new Map<string, LocalAppEntry[]>();
    for (const e of [...d.entries].sort((a, b) => b.entry_date.localeCompare(a.entry_date) || a.source_ref.localeCompare(b.source_ref))) {
      const key = e.entry_date.slice(0, 7);
      byMonth.set(key, [...(byMonth.get(key) ?? []), e]);
    }
    replace(listHost, el('h3', { class: 'sectionlabel' }, 'Apuntes'), renderGroups<LocalAppEntry>({
      label: 'Apuntes por mes', feedbackId: 'invoices.apuntes.lista.grupos', worstFirst: false,
      toneOf: (e) => (e.invoiced ? null : 'warn'),
      groups: [...byMonth.entries()].map(([key, items], i) => {
        const tt = entriesTotals(items);
        return { key, title: monthLabel(key), items, open: i === 0, summary: [`${items.length} apunte${items.length === 1 ? '' : 's'}`, tt.notInvoiced ? `${tt.notInvoiced} sin facturar` : null].filter(Boolean).join(' · ') };
      }),
      row: (e) => row(e, d),
    }).element);
  }

  async function load(): Promise<void> {
    data = await loadData(client);
    paint(data);
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
      r.pendingInvoices ? el('p', { class: 'hint', id: 'eventPending' }, `${r.pendingInvoices} factura${r.pendingInvoices === 1 ? '' : 's'} asignada${r.pendingInvoices === 1 ? '' : 's'} al evento aún sin validar: no cuenta${r.pendingInvoices === 1 ? '' : 'n'} todavía.`) : null,
      el('h3', { class: 'sectionlabel' }, 'Movimientos'),
      el('ul', { class: 'list', id: 'eventMoves', 'aria-label': 'Movimientos del evento' }, ...r.moves.map((m) => {
        const li = listRow({
          id: `${m.kind}-${m.id}`, title: m.title, meta: [shortDate(m.date), KIND[m.kind]],
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

/** Pista de la herramienta de Inicio: lo facturado o lo que falta decidir. */
export async function appEntriesHint(client: SyncClient): Promise<string> {
  const t = entriesTotals(liveEntries((await client.list(APP_ENTRIES)) as unknown as LocalAppEntry[]));
  if (!t.count) return 'Nada todavía';
  return t.notInvoiced ? `${t.notInvoiced} sin facturar` : fromCents(t.invoicedIncomeCents);
}
