/**
 * Fotos de receta (docs/food/API.md §8 y §10.2).
 * - La imagen elegida se recomprime aquí a «resolución WhatsApp»: 1600 px de lado mayor y una miniatura de 480 px,
 *   en WebP (JPEG si el navegador no codifica WebP). El original NO se conserva (decisión del usuario, contrato §11).
 * - Los dos archivos se dejan en la cola de blobs de sync-client y la receta los referencia con `{ "$blob": sha }`;
 *   el cliente sustituye el marcador por el `file_id` cuando la subida está verificada, también si la foto se hizo sin red.
 * - Para verlas sin red, cada foto se guarda en Cache Storage: por sha mientras está en cola y por `file_id` después.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { PHOTO_MAX_BYTES, PHOTO_MAX_SIDE, PHOTO_THUMB_SIDE } from '@ikisai/domain-food';

const CACHE = 'ikisai-food-photos-v1';

/** Referencia a una foto en una fila: `file_id` confirmado, marcador de blob en cola o nada. */
export type PhotoRef = string | { $blob: string } | null | undefined;

export function isBlobMarker(value: unknown): value is { $blob: string } {
  return !!value && typeof value === 'object' && typeof (value as { $blob?: unknown }).$blob === 'string';
}

function cacheKey(ref: Exclude<PhotoRef, null | undefined>): string {
  return isBlobMarker(ref) ? `/__photos/sha/${ref.$blob}` : `/__photos/file/${ref}`;
}

async function openCache(): Promise<Cache | null> {
  try {
    return 'caches' in globalThis ? await caches.open(CACHE) : null;
  } catch {
    return null;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Reduce una imagen a `side` px de lado mayor. Nunca la amplía. */
async function resize(bitmap: ImageBitmap, side: number, maxBytes: number): Promise<Blob> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Este navegador no puede preparar la foto.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.78, 0.6, 0.45]) {
    let blob = await canvasToBlob(canvas, 'image/webp', quality);
    // Safari antiguo ignora el tipo pedido y devuelve PNG: se usa JPEG.
    if (!blob || blob.type !== 'image/webp') blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error('La foto es demasiado grande incluso recomprimida.');
}

export interface PreparedPhoto {
  display: Blob;
  thumb: Blob;
}

/** Decodifica (respetando la orientación de la cámara) y genera la versión de 1600 px y la miniatura. */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('No se pudo leer la imagen. Prueba con una foto JPEG, PNG o WebP.');
  }
  try {
    return { display: await resize(bitmap, PHOTO_MAX_SIDE, PHOTO_MAX_BYTES), thumb: await resize(bitmap, PHOTO_THUMB_SIDE, PHOTO_MAX_BYTES) };
  } finally {
    bitmap.close();
  }
}

const extension = (blob: Blob) => (blob.type === 'image/webp' ? 'webp' : 'jpg');

/** Deja la foto en la cola de subida y devuelve los marcadores para `photo_file_id` y `photo_thumb_file_id`. */
export async function stagePhoto(client: SyncClient, photo: PreparedPhoto): Promise<{ photo_file_id: { $blob: string }; photo_thumb_file_id: { $blob: string } }> {
  const displaySha = await client.stageBlob(photo.display, { filename: `receta.${extension(photo.display)}`, mime: photo.display.type });
  const thumbSha = await client.stageBlob(photo.thumb, { filename: `receta-mini.${extension(photo.thumb)}`, mime: photo.thumb.type });
  const cache = await openCache();
  await cache?.put(cacheKey({ $blob: displaySha }), new Response(photo.display, { headers: { 'Content-Type': photo.display.type } }));
  await cache?.put(cacheKey({ $blob: thumbSha }), new Response(photo.thumb, { headers: { 'Content-Type': photo.thumb.type } }));
  return { photo_file_id: { $blob: displaySha }, photo_thumb_file_id: { $blob: thumbSha } };
}

const urls = new Map<string, string>();

/** URL local (`blob:`) de una foto: de la caché si está; si no, se descarga con URL firmada y se guarda. `null` si no se puede. */
export async function photoUrl(client: SyncClient, ref: PhotoRef): Promise<string | null> {
  if (!ref) return null;
  const key = cacheKey(ref);
  const known = urls.get(key);
  if (known) return known;
  const cache = await openCache();
  let response = (await cache?.match(key)) ?? null;
  if (!response && !isBlobMarker(ref)) {
    try {
      const fetched = await fetch(await client.fileUrl(ref));
      if (!fetched.ok) return null;
      await cache?.put(key, fetched.clone());
      response = fetched;
    } catch {
      return null; // sin red y sin caché: la tarjeta enseña el hueco
    }
  }
  if (!response) return null;
  const url = URL.createObjectURL(await response.blob());
  urls.set(key, url);
  return url;
}

/** Pone la foto en un `<img>` cuando esté disponible; mientras tanto el contenedor muestra su fondo. */
export function showPhoto(client: SyncClient, img: HTMLImageElement, ref: PhotoRef): void {
  img.hidden = true;
  void photoUrl(client, ref).then((url) => {
    if (!url) return;
    img.src = url;
    img.hidden = false;
  });
}

/** Al cerrar sesión no queda ninguna foto en el dispositivo. */
export async function clearPhotoCache(): Promise<void> {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  try {
    if ('caches' in globalThis) await caches.delete(CACHE);
  } catch {
    // sin Cache Storage no hay nada que borrar
  }
}
