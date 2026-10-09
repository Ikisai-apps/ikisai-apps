/**
 * Texto leído en el dispositivo, camino del servidor (fase 1 del lector, PR 3). Lo que se lee al subir («Subir varias»,
 * «Nueva factura») se guarda aquí por SHA-256 del documento y, en cuanto el documento está subido (también al volver la
 * red), se manda a `POST documents/:id/text` con `fill: true`. El servidor rellena lo que falte del borrador con el mismo
 * núcleo que Drive (`readAndFill`) y guarda el resumen de la lectura; nunca pisa lo que ya tiene la factura.
 *
 * Solo en este dispositivo (localStorage), con límites de tamaño, y sin datos en registros ni telemetría.
 */
import type { SyncClient } from '@ikisai/sync-client';
import type { PdfTextItem } from '@ikisai/domain-invoices';
import { loadMirror } from './data.ts';

const KEY = 'ikisai.invoices.pendingTexts';
const MAX_ENTRIES = 20;
const MAX_ITEMS = 4000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Entry { sha256: string; items: PdfTextItem[]; at: number }

function read(): Entry[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function write(entries: Entry[]): void {
  try { if (entries.length) localStorage.setItem(KEY, JSON.stringify(entries)); else localStorage.removeItem(KEY); } catch { /* sin espacio: se pierde el relleno en el servidor, no la factura */ }
}

/** Guarda el texto leído de un documento para mandarlo cuando esté subido. */
export function queueDocumentText(sha256: string, items: PdfTextItem[]): void {
  if (!sha256 || !items.length) return;
  const slim = items.slice(0, MAX_ITEMS).map((it) => ({ str: it.str.slice(0, 500), page: it.page, x: it.x, y: it.y, w: it.w, h: it.h }));
  write([...read().filter((e) => e.sha256 !== sha256), { sha256, items: slim, at: Date.now() }].slice(-MAX_ENTRIES));
}

export function pendingTexts(): number { return read().length; }

/** Al cerrar sesión: el texto de los documentos no se queda en el dispositivo. */
export function clearPendingTexts(): void { write([]); }

let running: Promise<number> | null = null;

/** Manda los textos cuyo documento ya está subido. Devuelve cuántos se han enviado. */
export function flushDocumentTexts(client: SyncClient): Promise<number> {
  if (running) return running;
  // `running` se limpia al terminar, fuera de la función: si acabara sin esperar nada, un `finally` dentro lo limpiaría
  // antes de asignarlo y la promesa ya resuelta se quedaría guardada para siempre.
  const run = (async () => {
    {
      if (!navigator.onLine || !read().length) return 0;
      const mirror = await loadMirror(client);
      let sent = 0;
      for (const entry of read()) {
        const file = mirror.files.find((f) => !f.deleted_at && f.sha256 === entry.sha256 && typeof f.file_id === 'string' && UUID.test(f.file_id));
        if (!file) {
          if (Date.now() - entry.at > MAX_AGE_MS) write(read().filter((e) => e.sha256 !== entry.sha256));
          continue;
        }
        try {
          await client.api(`/documents/${file.file_id}/text`, { json: { source: 'pdf_text', items: entry.items, fill: true } });
          sent += 1;
          write(read().filter((e) => e.sha256 !== entry.sha256));
        } catch (error) {
          // Rechazo definitivo (documento ajeno, borrado…): se descarta. Red o servidor caído: se reintenta después.
          const status = (error as { status?: number })?.status ?? 0;
          if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) write(read().filter((e) => e.sha256 !== entry.sha256));
          else break;
        }
      }
      return sent;
    }
  })();
  running = run;
  void run.catch(() => 0).finally(() => { if (running === run) running = null; });
  return run;
}

/** Engancha el envío a la sincronización: cuando no queda nada por subir, manda lo pendiente. */
export function startTextQueue(client: SyncClient): () => void {
  let last = 0;
  const off = client.onStatus((status) => {
    if (status.network === 'offline' || status.pendingCommands || status.pendingBlobs || !read().length) return;
    if (Date.now() - last < 2000) return;
    last = Date.now();
    void flushDocumentTexts(client);
  });
  // El espejo recibe el id definitivo del documento un poco después de subirlo: mientras quede algo, se reintenta.
  const timer = setInterval(() => {
    const status = client.status();
    if (read().length && status.network !== 'offline' && !status.pendingCommands && !status.pendingBlobs) void flushDocumentTexts(client);
  }, 5000);
  void flushDocumentTexts(client);
  return () => { off(); clearInterval(timer); };
}
