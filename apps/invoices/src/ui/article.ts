/**
 * R4, PR 3: «Artículo» de una línea de factura (docs/invoices/API.md §16.19). Con el enlace con Recursos encendido sustituye
 * a «Mi nombre»: el mismo botón abre `createItemPicker` del kit (buscar o crear el artículo al momento, sin red también).
 *
 * - La cantidad y la unidad son las de la factura. Si la unidad de la factura no es una del artículo, se pide la
 *   conversión del proveedor («1 saco = 25 kg») y se guarda en Recursos para las siguientes.
 * - «Dónde entra»: el sitio habitual del artículo, cambiable.
 * - «Ya entró desde la compra de Food»: si Food ya metió ese artículo al comprarlo, la línea no crea entrada y su coste va
 *   a esa entrada.
 * - «Usar «texto» sin artículo» guarda el texto como «Mi nombre», como antes.
 * Tanda 27 (MUELA-070): va en una hoja (la abre la ficha); antes de guardar dice qué entra al inventario y lo pone al día
 * con cada cambio; Guardar y «Quitar artículo» llevan «Deshacer» (un enlace aplazado se quita de la lista de aplazados).
 * Una conversión nueva creada en Recursos se queda: sirve para las siguientes.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { createItemPicker, createSyncItemSource, createSyncSpaceSource, el, fieldAttrs, formatQuantity, replace, unitsFor, type ItemPick } from '@ikisai/ui-kit';
import { describeError, type LocalInvoice, type LocalInvoiceLine } from '../app/client.ts';
import { INVOICE_LINES } from '../app/client.ts';
import { R, dropDeferred, foodEntriesWithoutCost, linkLine, linkedItem, resourcesClient, spaceName } from '../app/resources.ts';
import { commitSafely, field } from './common.ts';
import { offerUndo, pick } from './undo.ts';

/** Marca de feedback del selector del kit (su etiqueta es `label`). */
const PICKER_FEEDBACK_ID = 'invoices.facturas.articulo.selector';
/** Lo que «Deshacer» vuelve a poner en la línea. */
const LINK_FIELDS = ['item_id', 'item_factor', 'space_id', 'entered_movement_id', 'label'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const dayText = (iso: string | null) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : 'la de la factura');
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const pick_ = (line: LocalInvoiceLine) => pick(line as unknown as Record<string, unknown>, LINK_FIELDS);

export function articleForm(client: SyncClient, invoice: LocalInvoice, line: LocalInvoiceLine, supplierName: (id: string) => string | null, done: () => void): HTMLElement {
  const r = resourcesClient();
  if (!r) return el('p', { class: 'hint' }, 'El enlace con el inventario está apagado.');
  const items = createSyncItemSource(r, { supplierName });
  const spaces = createSyncSpaceSource(r);
  let pick: ItemPick = { itemId: line.item_id ?? null, spaceId: line.space_id ?? null };
  const unitArea = el('div', { id: 'articleUnit' });
  const foodArea = el('div', { id: 'articleFood' });
  // Lo que entra al inventario con lo elegido ahora (se pone al día con cada cambio)
  const preview = el('p', { class: 'hint inv-article-preview', id: 'articlePreview', role: 'status' });
  const error = el('p', { class: 'formerror', role: 'alert' });
  let conversion: HTMLInputElement | null = null;
  let factor: number | null = num(line.item_factor);
  let unitId: string | null = null;
  let needsConversion = false;
  let entered: string | null = line.entered_movement_id ?? null;
  const quantity = num(line.quantity);
  const unit = line.unit?.trim() || null;

  async function paintExtras(): Promise<void> {
    replace(unitArea); replace(foodArea); conversion = null; needsConversion = false; unitId = null;
    if (!pick.itemId) return;
    const snapshot = await items.list();
    const item = snapshot.items.find((i) => i.id === pick.itemId);
    if (!item) return;
    // La unidad de la factura: una del artículo (base, métrica o conversión, las del proveedor primero) o una nueva
    const options = unitsFor(item, snapshot.units, { supplierId: invoice.supplier_id, supplierName });
    const match = unit ? options.find((o) => o.unit.toLowerCase() === unit.toLowerCase() && (o.supplierId === null || o.supplierId === invoice.supplier_id)) : options[0];
    if (!unit) {
      factor = null;
      replace(unitArea, el('p', { class: 'hint' }, quantity === null ? `Sin cantidad en la factura: no entra al inventario.` : `${formatQuantity(quantity)} ${item.baseUnit}`));
    } else if (match) {
      factor = match.value === 'base' ? null : match.factor;
      unitId = match.value.startsWith('metric:') || match.value === 'base' ? null : match.value;
      replace(unitArea, el('p', { class: 'hint', id: 'articleEquivalence' }, quantity === null ? `En ${unit}` : `${formatQuantity(quantity)} ${unit} = ${formatQuantity(quantity * (factor ?? 1))} ${item.baseUnit}`));
    } else {
      needsConversion = true;
      conversion = el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.conversion', label: 'Conversión del proveedor', type: 'number', entity: 'invoices.invoice_lines', prop: 'item_factor', sensitivity: 'internal', confirm: 'none' }), type: 'text', inputmode: 'decimal', id: 'articleConversion', value: factor !== null ? String(factor).replace('.', ',') : '', oninput: () => paintPreview() }) as HTMLInputElement;
      replace(unitArea, field(`1 ${unit} =`, el('span', { class: 'inline-field' }, conversion, ` ${item.baseUnit}`), `La factura viene en «${unit}». Se guarda como conversión de este proveedor para las siguientes.`));
    }
    // «Ya entró desde la compra de Food»
    const food = await foodEntriesWithoutCost(item.id);
    if (entered && !food.some((f) => f.id === entered)) entered = null;
    if (!food.length) return;
    const option = (value: string | null, text: string) => el('label', { class: 'check' },
      el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.entrada', label: '¿Cómo entra al inventario?', type: 'radio', entity: 'invoices.invoice_lines', prop: 'entered_movement_id', sensitivity: 'internal', confirm: 'none' }), type: 'radio', name: 'articleEntered', value: value ?? '', checked: entered === value, onchange: () => { entered = value; paintPreview(); } }), ` ${text}`);
    replace(foodArea, el('fieldset', { class: 'field' }, el('legend', null, '¿Cómo entra al inventario?'),
      option(null, 'Entra con esta factura'),
      ...food.slice(0, 5).map((f) => option(f.id, `Ya entró desde la compra de Food: ${formatQuantity(f.quantity)} ${item.baseUnit}, ${new Date(f.at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}`)),
    ));
  }

  function paintPreview(): void {
    if (!pick.itemId) { preview.textContent = pick.text?.trim() ? 'Solo texto: no entra al inventario.' : ''; return; }
    const item = linkedItem(pick.itemId);
    if (entered) { preview.textContent = 'Ya entró desde la compra de Food: no entra otra vez; su coste va a esa entrada.'; return; }
    if (quantity === null) { preview.textContent = 'Sin cantidad en la factura: no entra al inventario.'; return; }
    const typed = conversion ? Number((conversion.value || '').replace(',', '.')) : null;
    const f = needsConversion ? (typed && typed > 0 ? typed : null) : factor;
    if (needsConversion && f === null) { preview.textContent = `Indica la conversión de «${unit}» para saber cuánto entra.`; return; }
    const where = spaceName(pick.spaceId ?? item?.defaultSpaceId ?? null);
    if (!where) { preview.textContent = 'Sin sitio: no entra al inventario. Elige dónde entra.'; return; }
    const amount = `${formatQuantity(Math.round(quantity * (f ?? 1) * 1000) / 1000)} ${item?.baseUnit ?? ''}`.trim();
    const when = invoice.status === 'validada' || invoice.status === 'archivada' ? 'Entra al inventario' : 'Al validar, entra al inventario';
    preview.textContent = `${when}: ${amount} en ${where}, con fecha ${dayText(invoice.invoice_date)}.`;
  }

  const picker = createItemPicker({
    label: 'Artículo', source: items, spaces, value: line.item_id ?? null, supplierId: invoice.supplier_id, allowText: true,
    space: { label: 'Dónde entra', value: line.space_id ?? null }, placeholder: line.label ?? line.description,
    // El picker toma su etiqueta de `label` («Artículo»)
    feedbackId: PICKER_FEEDBACK_ID,
    onChange: (p) => { pick = p; if (p.itemId !== line.item_id) entered = null; void paintExtras().then(paintPreview); paintPreview(); },
  });
  void paintExtras().then(paintPreview);

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    error.textContent = '';
    pick = picker.get();
    if (!pick.itemId) {
      if (pick.text?.trim()) {
        const ok = await commitSafely(client, [{ op: 'update', table: INVOICE_LINES, id: line.id, expectedRevision: line.revision,
          fields: { label: pick.text.trim().slice(0, 120), item_id: null, item_factor: null, space_id: null, entered_movement_id: null } }], 'Nombre guardado, sin artículo.');
        if (ok) done();
      } else error.textContent = 'Elige o crea un artículo, o usa el texto sin artículo.';
      return;
    }
    let newUnit: RowOperation | null = null;
    if (needsConversion) {
      const value = Number((conversion?.value ?? '').replace(',', '.'));
      if (!Number.isFinite(value) || value <= 0) { error.textContent = `Indica cuántos ${linkedItem(pick.itemId)?.baseUnit ?? ''} hay en 1 ${unit}.`.replace('  ', ' '); return; }
      factor = value;
      unitId = crypto.randomUUID();
      newUnit = { op: 'insert', table: R.itemUnits, id: unitId, fields: { item_id: pick.itemId, unit, factor: value, supplier_id: invoice.supplier_id } };
    }
    const habitual = linkedItem(pick.itemId)?.defaultSpaceId ?? null;
    const fields = { item_id: pick.itemId, item_factor: factor, space_id: pick.spaceId && pick.spaceId !== habitual ? pick.spaceId : null, entered_movement_id: entered };
    const before = pick_(line);
    try {
      if (newUnit) await resourcesClient()!.commit([newUnit]);
      // El servidor solo comprueba el artículo: la conversión nueva puede subir después sin retrasar el enlace
      const out = await linkLine(client, line.id, pick.itemId, null, fields);
      // «Deshacer»: un aplazado se quita de la lista; uno guardado vuelve a como estaba (la conversión nueva se queda)
      offerUndo(client, { table: INVOICE_LINES, id: line.id, before },
        out === 'deferred' ? 'Se enlazará en cuanto el artículo nuevo llegue al servidor.' : 'Artículo enlazado.',
        'Artículo como estaba.', undefined, out === 'deferred' ? () => dropDeferred(line.id) : undefined);
      done();
    } catch (err) { error.textContent = describeError(err); }
  }

  async function unlink(): Promise<void> {
    const before = pick_(line);
    try {
      await client.commit([{ op: 'update', table: INVOICE_LINES, id: line.id, expectedRevision: line.revision,
        fields: { item_id: null, item_factor: null, space_id: null, entered_movement_id: null } }]);
    } catch (err) { error.textContent = describeError(err); return; }
    offerUndo(client, { table: INVOICE_LINES, id: line.id, before }, 'Artículo quitado de la línea.', 'Artículo otra vez en la línea.');
    done();
  }

  const form = el('form', { 'data-feedback-id': 'invoices.facturas.articulo', 'data-feedback-label': 'Artículo', class: 'inv-form', id: 'articleForm', novalidate: true, onsubmit: (e: Event) => void save(e) },
    el('p', { class: 'hint', 'data-feedback-ignore': '' }, `En la factura: «${line.description}»`),
    picker.element, unitArea, foodArea, preview, error,
    el('div', { class: 'btnrow' },
      el('button', { 'data-feedback-id': 'invoices.facturas.articulo.guardar', 'data-feedback-label': 'Guardar artículo', class: 'primary small', type: 'submit', id: 'saveArticle' }, 'Guardar'),
      line.item_id ? el('button', { 'data-feedback-id': 'invoices.facturas.articulo.quitar', 'data-feedback-label': 'Quitar artículo', class: 'ghost small', type: 'button', id: 'unlinkArticle', onclick: () => void unlink() }, 'Quitar artículo') : null,
      el('button', { 'data-feedback-id': 'invoices.facturas.articulo.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost small', type: 'button', onclick: () => { picker.destroy(); done(); } }, 'Cancelar'),
    ),
  );
  return form;
}
