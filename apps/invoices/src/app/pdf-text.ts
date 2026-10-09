/**
 * Texto con posiciones de un PDF, en el navegador (ronda 29, fase 2). PDF.js se carga solo al usarlo (import dinámico)
 * y queda fuera del precacheo del shell; el service worker lo guarda la primera vez que se usa (ver `sw.ts`). El análisis
 * corre en el worker de PDF.js: el hilo de la interfaz solo recoge los fragmentos.
 */
import type { PdfTextItem } from '@ikisai/domain-invoices';

/** Páginas que se leen como máximo: las primeras (cabecera) y las últimas (totales), si hay muchas. */
const FIRST_PAGES = 8;
const LAST_PAGES = 2;
/**
 * Límites de la lectura automática al subir (fase 1), los mismos que Drive. Medido con la CPU 4× más lenta y 390 px
 * (prueba «medición», IKISAI_MEASURE=1): de 1 a 30 páginas, unos 0,6 s; 15 MB, sin ninguna tarea larga en el hilo de la
 * interfaz (el análisis va en el worker). Más allá, o si tarda más de 8 s, la factura queda para leerla después.
 */
export const READ_LIMITS = { maxBytes: 15 * 1024 * 1024, timeoutMs: 8_000 };

/** Las páginas que se leen: todas si son pocas; si no, las primeras y las últimas. */
export function pagesToRead(total: number): number[] {
  if (total <= FIRST_PAGES + LAST_PAGES) return Array.from({ length: total }, (_, i) => i + 1);
  return [...Array.from({ length: FIRST_PAGES }, (_, i) => i + 1), ...Array.from({ length: LAST_PAGES }, (_, i) => total - LAST_PAGES + i + 1)];
}

/** La lectura se ha saltado por tamaño o se ha cortado por tiempo (no es un PDF dañado). */
export class ReadLimitError extends Error {
  constructor(readonly kind: 'size' | 'timeout') { super(kind === 'size' ? 'PDF demasiado grande para leerlo aquí' : 'La lectura ha tardado demasiado'); }
}

export async function readPdfItems(file: Blob, limits: { maxBytes?: number; timeoutMs?: number } = {}): Promise<PdfTextItem[]> {
  if (limits.maxBytes && file.size > limits.maxBytes) throw new ReadLimitError('size');
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let timedOut = false;
  const timer = limits.timeoutMs ? setTimeout(() => { timedOut = true; void task.destroy(); }, limits.timeoutMs) : null;
  const items: PdfTextItem[] = [];
  try {
    const doc = await task.promise;
    for (const n of pagesToRead(doc.numPages)) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , c, d, e, f] = item.transform as number[];
        items.push({ str: item.str, page: n, x: e!, y: f!, w: item.width, h: item.height || Math.hypot(c!, d!) });
      }
      page.cleanup();
    }
  } catch (error) {
    if (timedOut) throw new ReadLimitError('timeout');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await task.destroy();
  }
  if (timedOut) throw new ReadLimitError('timeout');
  return items;
}
