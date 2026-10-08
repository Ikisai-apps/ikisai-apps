/**
 * «Analizar con IA» sin API de pago (ronda 29, fase 1): comparte el documento y el contrato con la app de IA que elija
 * el usuario (Web Share con archivos) y recoge lo que vuelve por el `share_target` del manifiesto.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, toast } from '@ikisai/ui-kit';
import { INVOICE_CONTRACT_FILENAME, invoiceContractText, type SharedSource } from '@ikisai/domain-invoices';

/** Caché donde el service worker deja lo compartido hacia Ikisai (ver `sw.ts`). */
export const SHARE_CACHE = 'ikisai-invoices-share';
export const SHARE_KEY = '/__shared__';

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Documento ya subido de una factura, como `File`, para compartirlo (URL firmada de 10 minutos). */
export async function fetchStoredDocument(client: SyncClient, fileId: string, filename: string, mime: string): Promise<File> {
  const url = await client.fileUrl(fileId);
  const response = await fetch(url);
  if (!response.ok) throw new Error('No se pudo leer el documento.');
  return new File([await response.blob()], filename, { type: mime });
}

function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = el('a', { href: url, download: filename, hidden: true });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * Comparte el documento con la app de IA. Con archivos: documento + contrato. Si la plataforma no acepta el TXT como
 * segundo archivo, el contrato va en `text` y además al portapapeles. Sin Web Share (escritorio): se copia y se descarga
 * el contrato para adjuntarlo a mano con el documento. Devuelve el camino usado (para las pruebas y el aviso).
 */
export async function shareWithAi(document: File, source: SharedSource | null): Promise<'files' | 'text' | 'fallback' | 'cancelled'> {
  const ok = await confirmDialog({
    title: 'Analizar con IA',
    text: el('div', null,
      el('p', null, `Se compartirá «${document.name}» y las instrucciones de Ikisai con la app que elijas (ChatGPT, Gemini…). Esa app recibe el documento: elige una de confianza.`),
      el('p', { class: 'hint' }, 'Cuando te devuelva el resultado, compártelo con Ikisai Finance o cópialo y pégalo en «Pegar resultado».')),
    confirmLabel: 'Compartir',
  });
  if (!ok) return 'cancelled';
  const contract = invoiceContractText(source);
  const contractFile = new File([contract], INVOICE_CONTRACT_FILENAME, { type: 'text/plain' });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  try {
    if (nav.share && nav.canShare?.({ files: [document, contractFile] })) {
      await nav.share({ files: [document, contractFile], title: 'Factura para Ikisai', text: 'Lee el documento y sigue las instrucciones del archivo de texto.' });
      return 'files';
    }
    if (nav.share && nav.canShare?.({ files: [document] })) {
      await copyText(contract);
      await nav.share({ files: [document], title: 'Factura para Ikisai', text: contract });
      toast('Las instrucciones van en el mensaje y también están en el portapapeles.');
      return 'text';
    }
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') return 'cancelled';
    // Si compartir falla por otra causa, se sigue con la alternativa de escritorio.
  }
  const copied = await copyText(contract);
  downloadText(contract, INVOICE_CONTRACT_FILENAME);
  toast(`Este navegador no comparte archivos con otras apps. ${copied ? 'Instrucciones copiadas y descargadas' : 'Instrucciones descargadas'}: adjunta el documento y el archivo ${INVOICE_CONTRACT_FILENAME} en tu app de IA.`);
  return 'fallback';
}

/** Lo que el service worker guardó al recibir un «Compartir» hacia Ikisai; se borra al leerlo. */
export async function takeSharedText(): Promise<string | null> {
  try {
    const cache = await caches.open(SHARE_CACHE);
    const response = await cache.match(SHARE_KEY);
    if (!response) return null;
    await cache.delete(SHARE_KEY);
    const data = (await response.json()) as { text?: string };
    return typeof data.text === 'string' && data.text.trim() ? data.text : null;
  } catch {
    return null;
  }
}

/** Facturas (PDF o fotos) compartidas con Finance desde otra app: se recogen una vez y se borran de la caché. */
export async function takeSharedDocuments(): Promise<File[]> {
  try {
    const cache = await caches.open(SHARE_CACHE);
    const index = await cache.match('/__shared_docs__');
    if (!index) return [];
    const data = (await index.json()) as { files?: Array<{ key: string; name: string; type: string }> };
    const files: File[] = [];
    for (const entry of data.files ?? []) {
      const response = await cache.match(entry.key);
      if (response) files.push(new File([await response.blob()], entry.name, { type: entry.type }));
      await cache.delete(entry.key);
    }
    await cache.delete('/__shared_docs__');
    return files;
  } catch {
    return [];
  }
}
