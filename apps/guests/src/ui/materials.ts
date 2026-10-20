/**
 * Materiales del organizador (API.md §13.5, dueño Organizers): documentos, enlaces y textos publicados para el momento
 * actual, dentro de la «Guía del retiro» (tanda 31, MUELA-037). Un archivo se abre con una URL de 5 minutos de
 * `GET portal-files/:fileId` (C8). Los PDF y las imágenes se pueden guardar en el dispositivo para verlos sin conexión
 * (caché del navegador por persona, como mucho 20 MB; se borra al salir del dispositivo).
 * «Nuevo» (regla aprobada por VG): lo que el huésped aún no ha abierto. Mientras Organizers no guarde «visto» en el
 * servidor (petición de la tanda 31), se recuerda en este dispositivo, por persona; en la vista previa no se marca nada.
 */
import { el, icon, renderMedal, toast } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { describeError } from '../app/client.ts';
import { t } from '../app/i18n.ts';
import type { Material } from '../app/portal.ts';
import { centralText } from './common.ts';

const OFFLINE_CACHE = 'ikisai-guests-materials';
const OFFLINE_LIMIT = 20 * 1024 * 1024;
const offlineKey = (userId: string, fileId: string) => `/offline/${userId}/${fileId}`;
const SEEN = (userId: string) => `ikisai-guests-seen:${userId}`;

/** Borra los materiales guardados de una persona (al salir del dispositivo o al cambiar de persona). */
export async function clearOfflineMaterials(userId: string): Promise<void> {
  try {
    const store = await caches.open(OFFLINE_CACHE);
    for (const request of await store.keys()) if (new URL(request.url).pathname.startsWith(`/offline/${userId}/`)) await store.delete(request);
  } catch { /* sin Cache Storage */ }
  try { localStorage.removeItem(SEEN(userId)); } catch { /* sin almacenamiento */ }
}

export async function savedBlob(userId: string, fileId: string): Promise<Blob | null> {
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

export const sizeLabel = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Materiales vistos en este dispositivo (por persona). */
export function seenMaterials(userId: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN(userId)) ?? '[]') as string[]); } catch { return new Set(); }
}
export function markSeen(userId: string, id: string): void {
  const seen = seenMaterials(userId);
  if (seen.has(id)) return;
  seen.add(id);
  try { localStorage.setItem(SEEN(userId), JSON.stringify([...seen])); } catch { /* solo en memoria */ }
}

export interface MaterialRowOptions {
  ctx: GuestContext;
  userId: string;
  /** «Nuevo» (no en la vista previa). */
  isNew: boolean;
  /** Se abrió (o se leyó, una nota): cuenta como visto. */
  onSeen(): void;
}

/** Una fila de material: medallón, título, «Nuevo» y, en los archivos, «Guardar para verlo sin conexión». */
export async function materialRow(item: Material, options: MaterialRowOptions): Promise<HTMLElement | null> {
  const { ctx, userId } = options;
  const badge = options.isNew ? el('span', { class: 'gnew' }, t('materials.new')) : null;
  const medal = (name: string) => renderMedal({ name, size: 40 });
  if (item.kind === 'text') {
    return el('section', { class: 'card gcard gmaterial', dataset: { material: item.id } },
      el('h3', { class: 'gmedrow' }, medal(item.title), el('span', null, item.title), badge), centralText(item.body ?? '', false));
  }
  if (item.kind === 'link') {
    return el('a', { class: 'card gcard glink gmaterial', href: item.url ?? '#', target: '_blank', rel: 'noopener', dataset: { material: item.id },
      'data-feedback-id': 'guests.materiales.enlace.abrir', 'data-feedback-label': 'Abrir enlace', onclick: () => options.onSeen() },
    medal(item.title), el('span', null, el('strong', null, item.title, badge), item.description ? el('span', { class: 'muted small' }, item.description) : null));
  }
  const file = item.file;
  if (!file) return null;
  const saved = Boolean(await savedBlob(userId, file.id));
  const offlinable = /^(application\/pdf|image\/)/.test(file.mime);
  const open = async () => {
    const copy = await savedBlob(userId, file.id);
    if (copy) { options.onSeen(); window.open(URL.createObjectURL(copy), '_blank', 'noopener'); return; }
    try {
      const { url } = await ctx.reads.fileUrl(file.id);
      options.onSeen();
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      toast(describeError(error));
    }
  };
  const keep = async (button: HTMLButtonElement) => {
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
  };
  const keepButton = offlinable ? el('button', { type: 'button', class: 'ghost small', disabled: saved ? '' : null, dataset: { file: file.id },
    'data-feedback-id': 'guests.materiales.archivo.guardar', 'data-feedback-label': 'Guardar sin conexión',
    onclick: (event: Event) => void keep(event.currentTarget as HTMLButtonElement) }, saved ? t('materials.saved') : t('materials.keep')) as HTMLButtonElement : null;
  return el('section', { class: 'card gcard gmaterial', dataset: { file: file.id, material: item.id } },
    el('button', { type: 'button', class: 'glink', 'data-feedback-id': 'guests.materiales.archivo.abrir', 'data-feedback-label': 'Abrir documento', onclick: () => void open() },
      medal(item.title), el('span', null, el('strong', null, item.title, badge), el('span', { class: 'muted small' }, `${file.name} · ${sizeLabel(file.size)}`),
        item.description ? el('span', { class: 'small' }, item.description) : null), icon('download', 18)),
    keepButton);
}
