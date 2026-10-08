/**
 * Materiales del organizador (API.md §13.5, dueño Organizers): documentos, enlaces y textos publicados para el momento
 * actual. Un archivo se abre con una URL de 5 minutos de `GET portal-files/:fileId` (C8). Los PDF y las imágenes se pueden
 * guardar en el dispositivo para verlos sin conexión (caché del navegador por persona, como mucho 20 MB; se borra al
 * salir del dispositivo).
 */
import { el, icon, replace, toast } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { describeError } from '../app/client.ts';
import { t } from '../app/i18n.ts';
import { inWindow, type Material } from '../app/portal.ts';
import { centralText, failure, loading, staleNote } from './common.ts';
import { momentOf } from './home.ts';

const OFFLINE_CACHE = 'ikisai-guests-materials';
const OFFLINE_LIMIT = 20 * 1024 * 1024;
const offlineKey = (userId: string, fileId: string) => `/offline/${userId}/${fileId}`;

/** Borra los materiales guardados de una persona (al salir del dispositivo o al cambiar de persona). */
export async function clearOfflineMaterials(userId: string): Promise<void> {
  try {
    const store = await caches.open(OFFLINE_CACHE);
    for (const request of await store.keys()) if (new URL(request.url).pathname.startsWith(`/offline/${userId}/`)) await store.delete(request);
  } catch { /* sin Cache Storage */ }
}

async function savedBlob(userId: string, fileId: string): Promise<Blob | null> {
  try {
    const hit = await (await caches.open(OFFLINE_CACHE)).match(offlineKey(userId, fileId));
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

async function savedBytes(userId: string): Promise<number> {
  try {
    const store = await caches.open(OFFLINE_CACHE);
    let total = 0;
    for (const request of await store.keys()) {
      if (!new URL(request.url).pathname.startsWith(`/offline/${userId}/`)) continue;
      total += Number((await store.match(request))?.headers.get('content-length') ?? 0);
    }
    return total;
  } catch {
    return 0;
  }
}

const sizeLabel = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function mountMaterials(main: HTMLElement, ctx: GuestContext, userId: string): () => void {
  let alive = true;
  replace(main, loading());

  async function open(item: Material): Promise<void> {
    const file = item.file!;
    const saved = await savedBlob(userId, file.id);
    if (saved) { window.open(URL.createObjectURL(saved), '_blank', 'noopener'); return; }
    try {
      const { url } = await ctx.reads.fileUrl(file.id);
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function keep(item: Material, button: HTMLButtonElement): Promise<void> {
    const file = item.file!;
    if ((await savedBytes(userId)) + file.size > OFFLINE_LIMIT) { toast(t('materials.full')); return; }
    button.disabled = true;
    try {
      const { url } = await ctx.reads.fileUrl(file.id);
      const response = await fetch(url);
      if (!response.ok) throw Object.assign(new Error('download'), { code: 'NETWORK' });
      const blob = await response.blob();
      await (await caches.open(OFFLINE_CACHE)).put(offlineKey(userId, file.id), new Response(blob, { headers: { 'content-type': file.mime, 'content-length': String(blob.size) } }));
      button.textContent = t('materials.saved');
    } catch (error) {
      button.disabled = false;
      toast(describeError(error));
    }
  }

  void ctx.reads.materials(ctx.grant.reservation_id).then(async (loaded) => {
    if (!alive) return;
    const moment = momentOf(ctx.guest());
    const items = (loaded?.value.items ?? []).filter((m) => inWindow(m.window, moment));
    const rows = await Promise.all(items.map(async (item) => {
      if (item.kind === 'text') return el('section', { class: 'card gcard gmaterial' }, el('h3', null, item.title), centralText(item.body ?? '', false));
      if (item.kind === 'link') {
        return el('a', { class: 'card gcard glink gmaterial', href: item.url ?? '#', target: '_blank', rel: 'noopener', 'data-feedback-id': 'guests.materiales.enlace.abrir', 'data-feedback-label': 'Abrir enlace' },
          icon('attach', 20), el('span', null, el('strong', null, item.title), item.description ? el('span', { class: 'muted small' }, item.description) : null));
      }
      const file = item.file;
      if (!file) return null;
      const saved = Boolean(await savedBlob(userId, file.id));
      const offlinable = /^(application\/pdf|image\/)/.test(file.mime);
      const keepButton = offlinable ? el('button', { type: 'button', class: 'ghost small', disabled: saved ? '' : null, dataset: { file: file.id },
        'data-feedback-id': 'guests.materiales.archivo.guardar', 'data-feedback-label': 'Guardar sin conexión',
        onclick: (event: Event) => void keep(item, event.currentTarget as HTMLButtonElement) }, saved ? t('materials.saved') : t('materials.keep')) as HTMLButtonElement : null;
      return el('section', { class: 'card gcard gmaterial', dataset: { file: file.id } },
        el('button', { type: 'button', class: 'glink', 'data-feedback-id': 'guests.materiales.archivo.abrir', 'data-feedback-label': 'Abrir documento', onclick: () => void open(item) },
          icon('download', 20), el('span', null, el('strong', null, item.title), el('span', { class: 'muted small' }, `${file.name} · ${sizeLabel(file.size)}`),
            item.description ? el('span', { class: 'small' }, item.description) : null)),
        keepButton);
    }));
    if (!alive) return;
    replace(main,
      loaded?.stale ? staleNote(loaded.at) : null,
      el('div', { class: 'pagehead' }, el('h2', null, t('materials.title')), el('p', { class: 'muted' }, t('materials.intro'))),
      rows.some(Boolean) ? el('div', { id: 'materialsList' }, ...rows) : el('p', { class: 'card gcard muted', id: 'materialsEmpty' }, t('materials.empty')));
  }).catch((error) => { if (alive) replace(main, failure(error)); });
  return () => { alive = false; };
}
