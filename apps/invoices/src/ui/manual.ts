/**
 * «Rellenar a mano» (9-10-2026, petición del usuario vía Core): para una factura en «Pendiente de datos» que no se pudo
 * leer, los datos esenciales en una sola hoja: proveedor por NIF (con alta rápida), número, fecha, base por tipo de IVA,
 * cuota, retención y total del documento, con el cuadre en vivo. «Guardar y validar» valida en el mismo lote y aprende la
 * plantilla del proveedor con lo confirmado (si el documento tiene texto), para que la próxima factura se lea sola.
 */
import type { RowOperation } from '@ikisai/sync-client';
import { closeSheet, confirmDialog, el, openSheet, replace } from '@ikisai/ui-kit';
import { validSpanishTaxId, type PartialInvoice, type PdfTextItem, type ReadLevel } from '@ikisai/domain-invoices';
import { CATEGORIES, CATEGORY_LABELS, INVOICES, INVOICE_LINES, SUPPLIERS, TAX_LINES, type LocalInvoice } from '../app/client.ts';
import { eur, parseAmount, type Mirror } from '../app/data.ts';
import { guard } from '../app/guard.ts';
import { usage } from '../app/usage.ts';
import { commitSafely, field, select } from './common.ts';
import { readingPanel } from './reading.ts';
import type { ViewContext } from './shell.ts';

const RATES: Array<[string, string]> = [['21', 'IVA 21 %'], ['10', 'IVA 10 %'], ['4', 'IVA 4 %'], ['0', 'IVA 0 % / exenta']];
const WITHHOLDINGS: Array<[string, string]> = [['', 'Sin retención'], ['15', 'IRPF 15 %'], ['7', 'IRPF 7 %'], ['19', 'IRPF 19 %'], ['otro', 'Otra (importe)']];
const cents = (v: number) => Math.round(v * 100);
const money = (v: number | null) => (v === null ? '' : String(v).replace('.', ','));

/** Lo que leyó «Leer PDF» sin llegar a una factura completa: rellena lo vacío y se enseña arriba, con el texto. */
export interface ManualPrefill { read: ReadLevel; found: PartialInvoice; message: string; text: string | null; items?: PdfTextItem[] }
