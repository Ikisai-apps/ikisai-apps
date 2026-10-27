/**
 * Silueta de cabecera de Central (Recursos 0816, `space_images.header_for`): la que el owner elige en «Imágenes del
 * centro» sale de fondo a la derecha de la cabecera, decorativa (sin texto alternativo) y detrás de los botones. Sin
 * silueta elegida, o sin acceso a Recursos, la cabecera queda como siempre.
 *
 * Carga (Core, 27-10): **una sola lectura al arrancar**, solo de `resources.space_images` y sin arrancar la
 * sincronización de Recursos en todas las pantallas. Después solo cambia cuando Planos del centro avisa
 * (`announceHeaderArt`), que es donde se elige.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { el } from '@ikisai/ui-kit';
import { R, resourcesClient } from '../app/resources.ts';

const EVENT = 'central:header-art';
type Row = { id: string; file_id?: unknown; header_for?: readonly string[] | null; deleted_at?: string | null };
type Snapshot = { tables?: Array<{ table: string; rows: Row[] }> };

/** La silueta de cabecera de Central entre esas filas: `{ id, fileId }` o `null`. */
export function centralHeader(rows: readonly Row[]): { id: string; fileId: string } | null {
  const row = rows.find((i) => !i.deleted_at && (i.header_for ?? []).includes('central') && typeof i.file_id === 'string');
  return row ? { id: row.id, fileId: row.file_id as string } : null;
}

/** Planos del centro avisa cuando cambia la silueta de cabecera de Central (o deja de haberla). */
export function announceHeaderArt(rows: readonly Row[]): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: centralHeader(rows) }));
}

/** Pinta la silueta en la cabecera. Devuelve la limpieza. */
export function mountHeaderArt(client: SyncClient, header: HTMLElement): () => void {
  const r = resourcesClient(client);
  const img = el('img', { class: 'ctl-headart', alt: '', 'aria-hidden': 'true', decoding: 'async', hidden: true }) as HTMLImageElement;
  header.append(img);
  let alive = true;
  let shown: string | null = null;
  async function show(pick: { id: string; fileId: string } | null): Promise<void> {
    if (!alive || (pick?.id ?? null) === shown) return;
    shown = pick?.id ?? null;
    if (!pick) { img.hidden = true; img.removeAttribute('src'); delete img.dataset.headerImage; return; }
    try {
      const url = await r.fileUrl(pick.fileId);
      if (!alive || shown !== pick.id) return;
      img.src = url;
      img.dataset.headerImage = pick.id;
      img.hidden = false;
    } catch { shown = null; img.hidden = true; }
  }
  const onAnnounce = (e: Event) => void show((e as CustomEvent<{ id: string; fileId: string } | null>).detail);
  window.addEventListener(EVENT, onAnnounce);
  // Una lectura al arrancar, con red; sin red o sin acceso, sin silueta.
  if (navigator.onLine) {
    void r.api<Snapshot>(`/snapshot?tables=${encodeURIComponent(R.spaceImages)}&limit=500&offset=0`)
      .then((page) => show(centralHeader(page.tables?.find((t) => t.table === R.spaceImages)?.rows ?? [])))
      .catch(() => undefined);
  }
  return () => { alive = false; window.removeEventListener(EVENT, onAnnounce); img.remove(); };
}
