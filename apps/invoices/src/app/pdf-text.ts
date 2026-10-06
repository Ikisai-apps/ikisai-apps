/**
 * Texto con posiciones de un PDF, en el navegador (ronda 29, fase 2). PDF.js se carga solo al usarlo (import dinámico)
 * y queda fuera del precacheo del shell; el service worker lo guarda la primera vez que se usa (ver `sw.ts`).
 */
import type { PdfTextItem } from '@ikisai/domain-invoices';

/** Páginas que se leen como máximo: una factura rara vez pasa de unas pocas. */
const MAX_PAGES = 10;

export async function readPdfItems(file: Blob): Promise<PdfTextItem[]> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const items: PdfTextItem[] = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , c, d, e, f] = item.transform as number[];
        items.push({ str: item.str, page: n, x: e!, y: f!, w: item.width, h: item.height || Math.hypot(c!, d!) });
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return items;
}
