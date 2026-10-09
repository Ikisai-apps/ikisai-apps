/**
 * Lectura del documento (fase 0 de REVISION_LECTOR, 9-10-2026): un PDF con texto nunca termina en una pantalla vacía.
 * Lo que el lector encontró, lo que falta, un mensaje honesto y el texto leído, plegado y con «Copiar texto».
 */
import { el, replace, toast } from '@ikisai/ui-kit';
import { extractWithTemplates, readingMessage, readingText, type PartialInvoice, type PdfTextItem, type ReadLevel, type TemplateExtraction } from '@ikisai/domain-invoices';
import type { LocalInvoice } from '../app/client.ts';
import { eur, shortDate, type Mirror } from '../app/data.ts';
import { fetchStoredDocument } from '../app/ai-share.ts';
import { readPdfItems } from '../app/pdf-text.ts';
import { fbBlock } from './common.ts';
import type { ViewContext } from './shell.ts';

/** El lector con las plantillas y los proveedores de este dispositivo. */
export function extractFor(mirror: Mirror, items: PdfTextItem[], target: LocalInvoice | null = null): TemplateExtraction {
  const supplier = target ? mirror.supplierById.get(target.supplier_id) ?? null : null;
  const placeholder = supplier?.slug === 'sin_identificar';
  return extractWithTemplates(items, {
    suppliers: mirror.suppliers.filter((s) => !s.deleted_at).map((s) => ({ id: s.id, name: s.name, tax_id: s.tax_id })),
    templates: mirror.templates, fallbackSupplierId: target && !placeholder ? target.supplier_id : null,
    fallback: target && !placeholder ? { supplier_name: supplier?.name ?? null, supplier_tax_id: supplier?.tax_id ?? null, object: target.object } : target ? { supplier_name: null, supplier_tax_id: null, object: target.object } : undefined,
  });
}

/** Campo a campo: el valor encontrado o «Falta». */
function foundList(found: PartialInvoice): HTMLElement {
  const vat = found.vat.length ? found.vat.map((v) => `${v.rate} %: ${eur(v.quota)}`).join(' · ') : null;
  const rows: Array<[string, string | null]> = [
    ['Proveedor', found.supplier_name], ['NIF', found.supplier_tax_id], ['Número', found.invoice_number],
    ['Fecha', found.invoice_date ? shortDate(found.invoice_date) : null], ['Base', found.base === null ? null : eur(found.base)],
    ['IVA', vat], ['Retención', found.withholding ? eur(found.withholding.amount) : null], ['Total', found.total === null ? null : eur(found.total)],
  ];
  return el('dl', { class: 'reading-fields', id: 'readingFields', 'data-feedback-ignore': '' }, ...rows.flatMap(([label, value]) => [
    el('dt', null, label),
    el('dd', null, value ?? (label === 'Retención' ? el('span', { class: 'hint' }, 'No aparece') : el('span', { class: 'chip warn' }, 'Falta'))),
  ]));
}

/** «Texto leído»: plegado, para verlo y copiarlo (a ChatGPT, a Claude o para una prueba). */
export function readTextPanel(text: string): HTMLElement {
  return el('details', { class: 'provenance', id: 'readingText' },
    el('summary', null, 'Texto leído'),
    el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.lectura.copiar', 'data-feedback-label': 'Copiar texto', class: 'softbtn small', type: 'button', id: 'readingCopy',
      onclick: () => void navigator.clipboard.writeText(text).then(() => toast('Texto copiado.'), () => toast('No se pudo copiar: selecciónalo a mano.')) }, 'Copiar texto')),
    el('pre', { class: 'reading-text', 'data-feedback-ignore': '' }, text));
}

/** Mensaje, campos y texto de una lectura. */
export function readingPanel(r: { read: ReadLevel; found: PartialInvoice; message: string; text: string | null }): HTMLElement {
  return el('div', { class: 'reading', id: 'readingPanel' },
    el('div', { class: `banner ${r.read === 'sufficient' ? 'ok' : 'warn'}`, id: 'readingMessage', role: 'status' }, el('span', null, r.message)),
    r.read === 'no_text' ? null : foundList(r.found),
    r.text ? readTextPanel(r.text) : null);
}

/** Texto del documento: el guardado en el servidor o, si no lo hay, el PDF leído en este dispositivo. */
async function documentItems(ctx: ViewContext, original: { file_id: string; normalized_filename: string; mime_type: string }): Promise<PdfTextItem[]> {
  const stored = await ctx.client.api<{ items: PdfTextItem[] } | null>('/read/invoices.document_text', { json: { file_id: original.file_id } }).catch(() => null);
  if (stored && Array.isArray(stored.items) && stored.items.length) return stored.items;
  return readPdfItems(await fetchStoredDocument(ctx.client, original.file_id, original.normalized_filename, original.mime_type));
}

/** Lo que se lee hoy del documento de una factura (para dárselo a la IA); `null` si no se puede (sin red, foto…). */
export async function currentReading(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice, original: { file_id: string; normalized_filename: string; mime_type: string }): Promise<TemplateExtraction | null> {
  if (original.mime_type !== 'application/pdf' || !navigator.onLine) return null;
  try { return extractFor(mirror, await documentItems(ctx, original), invoice); } catch { return null; }
}

/**
 * Bloque «Lectura del documento» de la ficha (PDF de una factura pendiente): el resumen guardado al leerla y, al abrirlo,
 * la lectura actual con los campos, lo que falta y el texto.
 */
export function documentReadingBlock(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice, original: { file_id: string; normalized_filename: string; mime_type: string }): HTMLElement {
  const saved = (invoice.import_meta as { reading?: { read?: ReadLevel; missing?: string[] } } | null)?.reading;
  const summary = saved?.read === 'no_text' ? 'sin texto' : saved?.read === 'partial' ? `parcial${saved.missing?.length ? ` · falta ${saved.missing.join(', ')}` : ''}` : 'ver lo leído';
  const body = el('div', { id: 'readingBody' }, el('p', { class: 'hint' }, 'Abre para ver lo que se lee en el documento.'));
  const node = fbBlock({ feedbackId: 'invoices.facturas.ficha.lectura', feedbackLabel: 'Lectura del documento' }, 'Lectura del documento', summary, invoice.status === 'pendiente_datos', body);
  node.id = 'readingBlock';
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    if (!navigator.onLine) { replace(body, el('p', { class: 'hint' }, 'Ver la lectura necesita conexión (el documento está en la nube).')); return; }
    loaded = true;
    replace(body, el('p', { class: 'hint' }, 'Leyendo…'));
    try {
      const items = await documentItems(ctx, original);
      const r = extractFor(mirror, items, invoice);
      replace(body, readingPanel({ read: r.read, found: r.found, message: readingMessage(r), text: r.hasText ? readingText(items) : null }));
    } catch {
      loaded = false;
      replace(body, el('div', { class: 'banner warn', id: 'readingMessage', role: 'status' }, el('span', null, 'No se pudo abrir el PDF. Puede estar dañado o protegido.')));
    }
  };
  node.addEventListener('toggle', () => { if ((node as HTMLDetailsElement).open) void load(); });
  if ((node as HTMLDetailsElement).open) void load();
  return node;
}
