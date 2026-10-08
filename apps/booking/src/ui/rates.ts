/** Tarifario y condiciones comerciales (docs/booking/API.md §15.2): tarifas por capa, condiciones con sus tramos de cancelación. Solo el propietario escribe. */
import type { RowOperation, TableName } from '@ikisai/sync-client';
import { CONDITIONS_MARKERS, RATE_LAYERS, renderConditionsText } from '@ikisai/domain-booking';
import { createSortableList, el, icon, plural, positionBetween, renumber, replace, toast, type Sortable } from '@ikisai/ui-kit';
import { CONDITIONS, PROPOSALS, RATES, TIERS, canRead, describeError, fullDay } from '../app/client.ts';
import { OPTIONS, RATE_LABELS, RATE_OPTIONS, label } from '../app/labels.ts';
import { amountText, byPosition, eur, pct, tierText, tiersOf, type Row, balanceDeadlineHours } from '../app/rates.ts';
import { openRowSheet, type FieldSpec } from './form.ts';
import type { ViewMount } from './shell.ts';

const RATE_SPECS: FieldSpec[] = [
  { key: 'name', label: 'Nombre', type: 'text', max: 120 },
  { key: 'layer', label: 'Capa', type: 'select', options: RATE_OPTIONS.layer, hint: 'Recinto (uso del espacio), por persona, servicios sueltos, ajustes (descuentos y recargos) o extras (catálogo que se añade a mano, como sonido o camas supletorias).' },
  { key: 'unit', label: 'Unidad', type: 'select', options: RATE_OPTIONS.unit },
  { key: 'amount', label: 'Importe', type: 'number', decimal: true, negative: true, hint: 'En euros. Con unidad «Porcentaje» es un % sobre el subtotal: −10 para un descuento del 10 %.' },
  { key: 'service', label: 'Solo si la reserva usa', type: 'select', options: RATE_OPTIONS.service, optional: true, hint: 'Sin elegir, se sugiere siempre. Los extras no se sugieren, salvo «Camas supletorias» cuando la reserva las activa.' },
  { key: 'min_persons', label: 'Desde (personas)', type: 'number', section: 'Cuándo se sugiere' },
  { key: 'max_persons', label: 'Hasta (personas)', type: 'number' },
  { key: 'valid_from', label: 'Vigente desde', type: 'date' },
  { key: 'valid_to', label: 'Vigente hasta', type: 'date' },
  { key: 'event_types', label: 'Tipos de reserva', type: 'multi', options: OPTIONS.eventType, hint: 'Sin marcar ninguno, vale para todos los tipos.' },
  { key: 'includes', label: 'Qué incluye', type: 'textarea', section: 'Texto para el organizador' },
  { key: 'excludes', label: 'Qué no incluye', type: 'textarea' },
  { key: 'active', label: 'Activa (se sugiere en las propuestas)', type: 'check' },
  { key: 'portal_visible', label: 'Visible en el portal del organizador', type: 'check', section: 'Portal del organizador' },
  { key: 'public_name', label: 'Nombre público', type: 'text', max: 120, hint: 'Lo ve el organizador en su calculadora.' },
  { key: 'public_description', label: 'Descripción pública', type: 'textarea', max: 1000, hint: 'Lo ve el organizador en su calculadora.' },
];

const CONDITION_SPECS: FieldSpec[] = [
  { key: 'name', label: 'Nombre', type: 'text', max: 120 },
  { key: 'deposit_percent', label: 'Señal (% del total)', type: 'number', decimal: true, section: 'Señal' },
  { key: 'deposit_minimum', label: 'Señal mínima (€)', type: 'number', decimal: true },
  { key: 'deposit_days', label: 'Plazo para pagar la señal (días)', type: 'number' },
  { key: 'deposit_days_short', label: 'Plazo con poca antelación (días)', type: 'number' },
  { key: 'balance_deadline_hours_after_end', label: 'Plazo máximo del saldo, interno (horas tras el final)', type: 'number', hint: 'Dato interno: a partir de aquí Ikisai exige el pago. El organizador no lo ve.' },
  { key: 'short_notice_days', label: 'Poca antelación: faltan menos de (días)', type: 'number' },
  { key: 'prices_include_vat', label: 'Precios con IVA incluido', type: 'check', section: 'IVA' },
  { key: 'vat_rate', label: 'Tipo de IVA (%)', type: 'number', decimal: true },
  { key: 'minimum_total', label: 'Mínimo por retiro (€)', type: 'number', decimal: true, section: 'Mínimo comercial', hint: 'Si el total no llega, se cobra el mínimo.' },
  { key: 'text', label: 'Texto de las condiciones', type: 'textarea', section: 'Texto para el organizador', hint: 'Sale en el documento de la propuesta y en el portal. No repitas cifras: usa los marcadores de abajo, que se rellenan con los campos.' },
  { key: 'is_default', label: 'Condiciones por defecto (las usan las propuestas nuevas)', type: 'check', section: 'Uso' },
  { key: 'active', label: 'Activas', type: 'check' },
];

const TIER_SPECS: FieldSpec[] = [
  { key: 'min_days_before', label: 'Días de antelación (como mínimo)', type: 'number', hint: 'Cancelando con tantos días o más antes de la entrada se aplica este tramo.' },
  { key: 'deposit_refund_pct', label: 'Parte de la señal que se devuelve (%)', type: 'number', decimal: true },
  { key: 'extra_costs', label: 'Además se cobran costes extra', type: 'check' },
];

const del = (table: TableName, row: Row): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });
const num = (value: unknown): number => Number(value ?? 0);

/** «de 16 a 30 personas», «desde 16 personas», «hasta 15 personas». */
function personsText(rate: Row): string | null {
  const min = rate.min_persons, max = rate.max_persons;
  if (min !== null && max !== null) return `de ${min} a ${plural(Number(max), 'persona', 'personas')}`;
  if (min !== null) return `desde ${plural(Number(min), 'persona', 'personas')}`;
  if (max !== null) return `hasta ${plural(Number(max), 'persona', 'personas')}`;
  return null;
}

function validityText(rate: Row): string | null {
  if (rate.valid_from && rate.valid_to) return `del ${fullDay(rate.valid_from)} al ${fullDay(rate.valid_to)}`;
  if (rate.valid_from) return `desde el ${fullDay(rate.valid_from)}`;
  if (rate.valid_to) return `hasta el ${fullDay(rate.valid_to)}`;
  return null;
}

/** Monta la pantalla `#/tarifas`. */
export const mountRates: ViewMount = ({ main, client, navigate }) => {
  const owner = client.bootstrap()?.membership.role === 'owner';
  const seesProposals = canRead(client, PROPOSALS);
  const rateHost = el('div', { 'data-feedback-id': 'booking.tarifas.tarifario', 'data-feedback-label': 'Tarifas' });
  const conditionHost = el('div', { 'data-feedback-id': 'booking.tarifas.condiciones', 'data-feedback-label': 'Condiciones' });
  let rates: Row[] = [];
  let conditions: Row[] = [];
  let tiers: Row[] = [];
  let proposals: Row[] = [];
  let destroyed = false;
  const lists = new Map<string, { sortable: Sortable<Row>; sig: string }>();

  async function reorder(ordered: Row[], moved: Row, to: number): Promise<void> {
    const prev = ordered[to - 1], next = ordered[to + 1];
    const a = prev ? Number(prev.position) : null, b = next ? Number(next.position) : null;
    const position = positionBetween(a, b);
    const fits = Number.isFinite(position) && (a === null || position > a) && (b === null || position < b);
    const operations: RowOperation[] = fits
      ? [{ op: 'update', table: RATES, id: moved.id, expectedRevision: moved.revision, fields: { position } }]
      : ordered.map((row, i): RowOperation => ({ op: 'update', table: RATES, id: row.id, expectedRevision: row.revision, fields: { position: renumber(ordered.length)[i]! } }));
    try {
      await client.commit(operations);
      toast(navigator.onLine ? 'Orden de las tarifas guardado.' : 'Orden de las tarifas guardado. Se enviará al reconectar.');
    } catch (error) {
      toast(describeError(error));
    }
  }

  const sig = (rows: Row[]) => rows.map((r) => `${r.id}:${r.revision}:${r._pending === true}`).join('|');

  function openRate(rate: Row | null): void {
    const last = rates.reduce((max, r) => Math.max(max, num(r.position)), 0);
    openRowSheet({
      client, title: rate ? 'Tarifa' : 'Nueva tarifa', table: RATES, row: rate, specs: RATE_SPECS, feedbackId: rate ? 'booking.tarifas.tarifa' : 'booking.tarifas.nueva_tarifa', feedbackLabel: rate ? 'Editar tarifa' : 'Nueva tarifa',
      defaults: { layer: 'por_persona', unit: 'persona_noche', active: true },
      insertFields: { position: positionBetween(last || null, null) },
      remove: rate ? { label: 'Quitar', operations: () => [del(RATES, rate)], confirmDialog: { title: 'Quitar tarifa', text: 'La tarifa deja de sugerirse. Las propuestas que ya la usan no cambian.', confirmLabel: 'Quitar' } } : undefined,
      savedMessage: 'Tarifa guardada.',
    });
  }

  const editButton = (name: string, fbId: string, fbLabel: string, onclick: () => void) => (owner ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': name, 'data-feedback-id': fbId, 'data-feedback-label': fbLabel, onclick }, icon('edit', 16)) : null);

  function rateItem(rate: Row): HTMLElement {
    const details = [personsText(rate), validityText(rate), rate.event_types?.length ? (rate.event_types as string[]).map((t) => label(t)).join(', ') : 'Todos los tipos de reserva'].filter(Boolean).join(' · ');
    return el('div', { class: 'space-item rate-item', dataset: { pending: String(rate._pending === true), rate: rate.name }, 'data-feedback-id': 'booking.tarifas.tarifario.tarifa', 'data-feedback-label': 'Tarifa' },
      el('div', { class: 'space-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, rate.name),
          rate.service ? el('span', { class: 'chip' }, RATE_LABELS.service[rate.service] ?? rate.service) : null, rate.active ? null : el('span', { class: 'chip' }, 'Inactiva'),
          rate.portal_visible === true ? el('span', { class: 'chip ok', dataset: { role: 'portal' }, 'data-feedback-id': 'booking.tarifas.tarifario.portal', 'data-feedback-label': 'Tarifa en el portal' }, 'En el portal') : null),
        el('div', { class: 'rate-amount', dataset: { role: 'amount' } }, amountText(rate.unit, rate.amount)),
        el('div', { class: 'row-meta' }, details),
        rate.includes ? el('div', { class: 'row-meta' }, `Incluye: ${rate.includes}`) : null,
        rate.excludes ? el('div', { class: 'row-meta' }, `No incluye: ${rate.excludes}`) : null),
      editButton(`Editar ${rate.name}`, 'booking.tarifas.tarifario.editar', 'Editar tarifa', () => openRate(rate)));
  }

  function rateList(layer: string, items: Row[]): HTMLElement {
    if (!owner) return el('ul', { class: 'list', 'data-feedback-id': 'booking.tarifas.tarifario.lista', 'data-feedback-label': 'Lista de tarifas' }, items.map((item) => el('li', { class: 'row' }, rateItem(item))));
    const signature = sig(items);
    const kept = lists.get(layer);
    if (kept) {
      if (kept.sig !== signature) { kept.sig = signature; kept.sortable.setItems(items); }
      return kept.sortable.element;
    }
    const sortable = createSortableList<Row>({
      items, key: (item) => item.id, name: (item) => String(item.name), label: `Tarifas de ${RATE_LABELS.layer[layer]}`, render: rateItem,
      onReorder: (ordered, move) => reorder(ordered, move.item, move.to),
    });
    sortable.element.setAttribute('data-feedback-id', 'booking.tarifas.tarifario.lista');
    sortable.element.setAttribute('data-feedback-label', 'Lista de tarifas');
    lists.set(layer, { sortable, sig: signature });
    return sortable.element;
  }

  // --- condiciones

  const inUse = (c: Row) => proposals.some((p) => p.deleted_at === null && p.conditions_id === c.id && p.status !== 'borrador');
  const usedByDraft = (c: Row) => proposals.some((p) => p.deleted_at === null && p.conditions_id === c.id);

  function conditionOperations(row: Row | null, values: Record<string, unknown>): RowOperation[] {
    const id = row?.id ?? crypto.randomUUID();
    const operations: RowOperation[] = [];
    // Solo una puede ser la de por defecto: la anterior se desmarca primero, en el mismo lote.
    if (values.is_default === true && row?.is_default !== true) {
      for (const other of conditions.filter((c) => c.id !== id && c.is_default === true)) {
        operations.push({ op: 'update', table: CONDITIONS, id: other.id, expectedRevision: other.revision, fields: { is_default: false } });
      }
    }
    if (row) {
      const fields = Object.fromEntries(Object.entries(values).filter(([key, value]) => (typeof value === 'number' ? Number(row[key]) !== value : (row[key] ?? null) !== value)));
      if (Object.keys(fields).length) operations.push({ op: 'update', table: CONDITIONS, id, expectedRevision: row.revision, fields });
    } else {
      operations.push({ op: 'insert', table: CONDITIONS, id, fields: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)) });
    }
    return operations;
  }

  // Ayuda de los marcadores y vista previa del texto ya resuelto con los valores del formulario.
  function conditionsTextHelp(merged: Record<string, unknown>, own: Row[]): HTMLElement {
    const preview = renderConditionsText(merged.text as string | null, merged, own);
    return el('div', { id: 'conditionsTextHelp', 'data-feedback-id': 'booking.tarifas.condiciones_hoja.marcadores', 'data-feedback-label': 'Marcadores del texto' },
      el('details', null, el('summary', null, 'Marcadores del texto'),
        el('ul', { class: 'hint' }, CONDITIONS_MARKERS.map(([key, text]) => el('li', null, el('code', null, `{{${key}}}`), ` · ${text}`))),
        el('p', { class: 'hint' }, 'Bloque que desaparece si el campo está vacío: ', el('code', null, '{{#condiciones.senal_minima}}…{{/condiciones.senal_minima}}'), '. Los tramos se editan en la tarjeta de las condiciones.')),
      preview.text ? [el('div', { class: 'sectionlabel' }, 'Vista previa'), el('p', { class: 'pdoc-text', id: 'conditionsTextPreview' }, preview.text)] : null,
      preview.unknown.length ? el('p', { class: 'banner warn', role: 'status', id: 'conditionsTextUnknown' }, `Marcadores desconocidos: ${preview.unknown.map((k) => `{{${k}}}`).join(', ')}`) : null);
  }

  function openConditions(row: Row | null): void {
    openRowSheet({
      client, title: row ? 'Condiciones' : 'Nuevas condiciones', table: CONDITIONS, row, specs: CONDITION_SPECS, feedbackId: row ? 'booking.tarifas.condiciones_hoja' : 'booking.tarifas.nuevas_condiciones', feedbackLabel: row ? 'Editar condiciones' : 'Nuevas condiciones',
      defaults: { deposit_percent: 30, deposit_minimum: 0, deposit_days: 5, deposit_days_short: 2, short_notice_days: 15, balance_deadline_hours_after_end: 24, prices_include_vat: true, vat_rate: 10, active: true, is_default: conditions.every((c) => c.is_default !== true) },
      check: (merged) => (num(merged.deposit_percent) > 100 || num(merged.vat_rate) > 100 ? 'Los porcentajes van de 0 a 100.' : null),
      extra: (merged) => [
        row && inUse(row)
          ? el('p', { class: 'hint', id: 'conditionsInUse' }, 'Ya se usaron en una propuesta enviada: solo puedes cambiar si están activas o por defecto. Para otros cambios, crea unas nuevas (botón «Duplicar»).') : null,
        conditionsTextHelp(merged, row ? tiersOf(tiers, row.id) : []),
      ].filter(Boolean) as HTMLElement[],
      buildOperations: (values) => {
        const unknown = renderConditionsText(values.text as string | null, values, row ? tiersOf(tiers, row.id) : []).unknown;
        if (unknown.length) toast(`Marcadores desconocidos en el texto: ${unknown.map((k) => `{{${k}}}`).join(', ')}. Se verán tal cual.`);
        return conditionOperations(row, values);
      },
      remove: row && !usedByDraft(row)
        ? { label: 'Quitar', operations: () => [...tiersOf(tiers, row.id).map((t) => del(TIERS, t)), del(CONDITIONS, row)], confirmDialog: { title: 'Quitar condiciones', text: 'Se quitan también sus tramos de cancelación.', confirmLabel: 'Quitar' } } : undefined,
      savedMessage: 'Condiciones guardadas.', settle: true,
    });
  }

  async function duplicate(row: Row): Promise<void> {
    const id = crypto.randomUUID();
    const copy = Object.fromEntries(['deposit_percent', 'deposit_minimum', 'deposit_days', 'deposit_days_short', 'short_notice_days', 'balance_deadline_hours_after_end', 'prices_include_vat', 'vat_rate', 'text']
      .map((key) => [key, key.startsWith('deposit_') || key === 'vat_rate' || key === 'short_notice_days' ? Number(row[key]) : row[key]]).filter(([, value]) => value !== null));
    const operations: RowOperation[] = [
      { op: 'insert', table: CONDITIONS, id, fields: { ...copy, name: `${row.name} (copia)` } },
      ...tiersOf(tiers, row.id).map((t): RowOperation => ({ op: 'insert', table: TIERS, id: crypto.randomUUID(),
        fields: { conditions_id: id, min_days_before: Number(t.min_days_before), deposit_refund_pct: Number(t.deposit_refund_pct), extra_costs: t.extra_costs === true } })),
    ];
    try {
      await client.commit(operations);
      toast(navigator.onLine ? 'Condiciones duplicadas.' : 'Condiciones duplicadas. Se enviarán al reconectar.');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function makeDefault(row: Row): Promise<void> {
    const operations = [
      ...conditions.filter((c) => c.id !== row.id && c.is_default === true).map((c): RowOperation => ({ op: 'update', table: CONDITIONS, id: c.id, expectedRevision: c.revision, fields: { is_default: false } })),
      { op: 'update', table: CONDITIONS, id: row.id, expectedRevision: row.revision, fields: { is_default: true } } as RowOperation,
    ];
    try {
      await client.commit(operations);
      toast(navigator.onLine ? 'Condiciones por defecto cambiadas.' : 'Cambio guardado. Se enviará al reconectar.');
    } catch (error) {
      toast(describeError(error));
    }
  }

  function openTier(condition: Row, tier: Row | null): void {
    openRowSheet({
      client, title: tier ? 'Tramo de cancelación' : 'Nuevo tramo de cancelación', table: TIERS, row: tier, specs: TIER_SPECS, feedbackId: tier ? 'booking.tarifas.tramo' : 'booking.tarifas.nuevo_tramo', feedbackLabel: tier ? 'Editar tramo' : 'Nuevo tramo',
      defaults: { min_days_before: 30, deposit_refund_pct: 50, extra_costs: false },
      insertFields: { conditions_id: condition.id },
      remove: tier ? { label: 'Quitar', operations: () => [del(TIERS, tier)], confirmDialog: { title: 'Quitar tramo', text: 'Se quita este tramo de cancelación.', confirmLabel: 'Quitar' } } : undefined,
      savedMessage: 'Tramo guardado.', settle: true,
    });
  }

  function conditionCard(c: Row): HTMLElement {
    const own = tiersOf(tiers, c.id);
    const used = inUse(c);
    return el('article', { class: 'card condition', dataset: { conditions: c.name, pending: String(c._pending === true) }, 'data-feedback-id': 'booking.tarifas.condiciones.tarjeta', 'data-feedback-label': 'Condiciones comerciales' },
      el('div', { class: 'cardhead' }, el('h3', null, c.name), editButton(`Editar condiciones ${c.name}`, 'booking.tarifas.condiciones.editar', 'Editar condiciones', () => openConditions(c))),
      el('div', { class: 'chips' },
        c.is_default ? el('span', { class: 'chip', dataset: { role: 'default' } }, 'Por defecto') : null,
        c.active ? null : el('span', { class: 'chip' }, 'Inactivas'),
        used ? el('span', { class: 'chip', dataset: { role: 'inuse' } }, 'En uso') : null),
      el('dl', { class: 'kv' },
        el('dt', null, 'Señal'), el('dd', null, `${pct(c.deposit_percent)} del total, mínimo ${eur(c.deposit_minimum)}`),
        el('dt', null, 'Plazo'), el('dd', null, `${plural(Number(c.deposit_days), 'día', 'días')} (${plural(Number(c.deposit_days_short), 'día', 'días')} si faltan menos de ${plural(Number(c.short_notice_days), 'día', 'días')})`),
        el('dt', null, 'Saldo (interno)'), el('dd', null, `Plazo máximo: ${balanceDeadlineHours(c)} h tras el final del evento`),
        el('dt', null, 'IVA'), el('dd', null, c.prices_include_vat ? `Incluido (${pct(c.vat_rate)})` : `No incluido: se suma el ${pct(c.vat_rate)}`),
        c.minimum_total !== null && c.minimum_total !== undefined ? el('dt', null, 'Mínimo por retiro') : null, c.minimum_total !== null && c.minimum_total !== undefined ? el('dd', null, eur(c.minimum_total)) : null,
        c.text ? el('dt', null, 'Texto') : null, c.text ? el('dd', { class: 'pdoc-text' }, renderConditionsText(c.text, c, own).text) : null),
      el('div', { class: 'sectionlabel' }, 'Cancelación', el('span', { class: 'count' }, String(own.length))),
      own.length === 0 ? el('p', { class: 'hint' }, 'Sin tramos: no se devuelve nada de la señal.')
        : el('ul', { class: 'list tiers', 'data-feedback-id': 'booking.tarifas.condiciones.tramos', 'data-feedback-label': 'Tramos de cancelación' }, own.map((t) => el('li', { class: 'row tier', dataset: { pending: String(t._pending === true) }, 'data-feedback-id': 'booking.tarifas.condiciones.tramos.fila', 'data-feedback-label': 'Tramo' },
            el('span', { class: 'tier-text' }, tierText(t)),
            editButton(`Editar tramo de ${t.min_days_before} días de ${c.name}`, 'booking.tarifas.condiciones.tramos.editar', 'Editar tramo', () => openTier(c, t))))),
      owner ? el('div', { class: 'choices', style: 'margin-top:10px' },
        el('button', { class: 'ghost small', type: 'button', dataset: { action: 'addTier' }, 'data-feedback-id': 'booking.tarifas.condiciones.anadir_tramo', 'data-feedback-label': 'Añadir tramo', onclick: () => openTier(c, null) }, 'Añadir tramo', el('span', { class: 'vh' }, ` a ${c.name}`)),
        !c.is_default && c.active ? el('button', { class: 'ghost small', type: 'button', dataset: { action: 'makeDefault' }, 'data-feedback-id': 'booking.tarifas.condiciones.por_defecto', 'data-feedback-label': 'Marcar por defecto', onclick: () => void makeDefault(c) }, 'Marcar por defecto', el('span', { class: 'vh' }, ` ${c.name}`)) : null,
        el('button', { class: 'ghost small', type: 'button', dataset: { action: 'duplicate' }, 'data-feedback-id': 'booking.tarifas.condiciones.duplicar', 'data-feedback-label': 'Duplicar', onclick: () => void duplicate(c) }, 'Duplicar', el('span', { class: 'vh' }, ` ${c.name}`))) : null);
  }

  async function paint(): Promise<void> {
    const live = async (table: TableName) => ((await client.list(table)) as Row[]).filter((r) => r.deleted_at === null);
    rates = (await live(RATES)).sort(byPosition);
    conditions = (await live(CONDITIONS)).sort((a, b) => Number(b.is_default === true) - Number(a.is_default === true) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
    tiers = await live(TIERS);
    proposals = seesProposals ? await live(PROPOSALS) : [];
    if (destroyed) return;

    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest<HTMLElement>('.sortable-row');
    const focused = row && active?.classList.contains('sortable-handle') ? { list: row.parentElement?.getAttribute('aria-label') ?? '', key: row.dataset.key ?? '' } : null;

    const liveLayers = new Set<string>();
    const groups = RATE_LAYERS.filter((layer) => rates.some((r) => r.layer === layer)).map((layer) => {
      const items = rates.filter((r) => r.layer === layer);
      liveLayers.add(layer);
      return el('section', { class: 'zone', dataset: { layer }, 'data-feedback-id': 'booking.tarifas.tarifario.capa', 'data-feedback-label': 'Capa de tarifas' },
        el('div', { class: 'sectionlabel' }, RATE_LABELS.layer[layer], el('span', { class: 'count' }, String(items.length))),
        rateList(layer, items));
    });
    for (const [key, entry] of lists) if (!liveLayers.has(key)) { entry.sortable.destroy(); lists.delete(key); }

    replace(rateHost, groups.length === 0
      ? el('div', { class: 'empty', 'data-feedback-id': 'booking.tarifas.tarifario.vacio', 'data-feedback-label': 'Sin tarifas' }, el('strong', null, 'Todavía no hay tarifas'), owner ? 'Crea la primera: por ejemplo «Alojamiento en grupo», 40 € por persona y noche.' : 'El propietario aún no ha creado el tarifario.')
      : groups);
    replace(conditionHost, conditions.length === 0
      ? el('div', { class: 'empty', 'data-feedback-id': 'booking.tarifas.condiciones.vacio', 'data-feedback-label': 'Sin condiciones' }, el('strong', null, 'Todavía no hay condiciones'), owner ? 'Crea unas condiciones: señal, IVA y tramos de cancelación. Las marcadas por defecto se usan en las propuestas nuevas.' : 'El propietario aún no ha creado condiciones.')
      : conditions.map(conditionCard));
    if (focused) {
      const target = Array.from(rateHost.querySelectorAll<HTMLElement>('ul.sortable')).find((ul) => ul.getAttribute('aria-label') === focused.list);
      target?.querySelector<HTMLElement>(`:scope > .sortable-row[data-key="${focused.key}"] > .sortable-handle`)?.focus({ preventScroll: true });
    }
  }

  if (!canRead(client, RATES)) {
    replace(main, el('p', null, el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'booking.tarifas.cabecera.volver', 'data-feedback-label': 'Volver a Inicio', onclick: () => navigate('#/') }, '← Inicio')),
      el('div', { class: 'empty' }, el('strong', null, 'Sin acceso'), 'El tarifario es solo para editores y propietarios.'));
    return () => undefined;
  }

  replace(
    main,
    el('p', null, el('button', { class: 'linkbtn', type: 'button', id: 'backToHome', 'data-feedback-id': 'booking.tarifas.cabecera.volver', 'data-feedback-label': 'Volver a Inicio', onclick: () => navigate('#/') }, '← Inicio')),
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Tarifas y condiciones'),
      el('p', null, owner ? 'Lo que se sugiere al preparar una propuesta y las condiciones comerciales que se le aplican.' : 'Solo lectura: el tarifario y las condiciones los edita el propietario.'))),
    el('div', { class: 'sectionlabel' }, 'Tarifas'),
    rateHost,
    el('div', { class: 'sectionlabel', style: 'margin-top:22px' }, 'Condiciones'),
    owner ? el('p', null, el('button', { class: 'ghost small', type: 'button', id: 'newConditions', 'data-feedback-id': 'booking.tarifas.condiciones.nuevas', 'data-feedback-label': 'Nuevas condiciones', onclick: () => openConditions(null) }, icon('plus', 16), 'Nuevas condiciones')) : null,
    conditionHost,
    owner ? el('button', { class: 'fab', type: 'button', id: 'newRate', 'data-feedback-id': 'booking.tarifas.nueva_tarifa_boton', 'data-feedback-label': 'Nueva tarifa', onclick: () => openRate(null) }, icon('plus'), 'Nueva tarifa') : null,
  );

  void paint();
  const offs = [RATES, CONDITIONS, TIERS, ...(seesProposals ? [PROPOSALS] : [])].map((table) => client.onTable(table, () => void paint()));
  return () => {
    destroyed = true;
    offs.forEach((off) => off());
    lists.forEach(({ sortable }) => sortable.destroy());
    lists.clear();
  };
};
