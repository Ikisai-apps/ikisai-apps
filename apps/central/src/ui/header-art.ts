/**
 * Silueta de cabecera de Central (Recursos 0816, `space_images.header_for`): la que el owner elige en «Imágenes del
 * centro» sale de fondo a la derecha de la cabecera, decorativa (sin texto alternativo) y detrás de los botones. Sin
 * silueta elegida, o sin acceso a Recursos, la cabecera queda como siempre.
 */
import type { SyncClient, TableName } from '@ikisai/sync-client';
import { el } from '@ikisai/ui-kit';
import { headerOf, type HeaderImage } from '../app/decor.ts';
import { R, startResources } from '../app/resources.ts';

const IMAGES = R.spaceImages as TableName;

/** Pinta la silueta en la cabecera y la cambia cuando cambia la elegida. Devuelve la limpieza. */
export function mountHeaderArt(client: SyncClient, header: HTMLElement): () => void {
  const r = startResources(client);
  const img = el('img', { class: 'ctl-headart', alt: '', 'aria-hidden': 'true', decoding: 'async', hidden: true }) as HTMLImageElement;
  header.append(img);
  let alive = true;
  let shown: string | null = null;
  async function paint(rows?: readonly unknown[]): Promise<void> {
    const list = (rows ?? await r.list(IMAGES).catch(() => [])) as unknown as Array<HeaderImage & { file_id?: unknown }>;
    const id = headerOf(list, 'central');
    const file = list.find((i) => i.id === id)?.file_id;
    if (!alive || id === shown) return;
    shown = id;
    if (!id || typeof file !== 'string') { img.hidden = true; img.removeAttribute('src'); delete img.dataset.headerImage; return; }
    try {
      const url = await r.fileUrl(file);
      if (!alive || shown !== id) return;
      img.src = url;
      img.dataset.headerImage = id;
      img.hidden = false;
    } catch { shown = null; img.hidden = true; }
  }
  const off = r.onTable(IMAGES, (rows) => void paint(rows));
  void paint();
  return () => { alive = false; off(); img.remove(); };
}
