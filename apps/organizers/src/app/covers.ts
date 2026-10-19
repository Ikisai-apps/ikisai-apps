/**
 * Portada de cada retiro (pasada única, zona 1): la primera foto de sus materiales (antes que el logotipo), guardada en
 * el dispositivo para verla sin red. Sin foto, sin red y sin copia, o sin IndexedDB, salen las iniciales.
 * - Candidatas: los materiales del espejo local (`organizers.materials`), en su orden, de tipo archivo y ya subidos (los
 *   que siguen en la cola, con `{$blob}`, no valen). No añade lecturas al servidor: `/files/{id}` es la llamada de Ofertas.
 * - Se guarda la imagen (no la URL firmada, que caduca), solo si pesa 2 MB o menos. Al salir, `cache.clearUser` la borra.
 * - Como mucho 3 retiros a la vez; cuando llega el espejo (en el primer arranque está vacío), se vuelven a pedir.
 * - Devuelve *object URL*: las revoca `destroy()` al desmontar la vista.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { cache, type CachedImage } from './cache.ts';
import { fileIdOf, rowsOf, TABLES, watch } from './own.ts';

export interface CoverSource { client: SyncClient; userId: string }

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TRIES = 3;
const MAX_PARALLEL = 3;

/** Archivos que pueden ser portada: primero los que no son logotipo, después el logotipo. */
async function candidates(client: SyncClient, reservationId: string): Promise<string[]> {
  const rows = (await rowsOf(client, TABLES.materials, reservationId)).filter((m) => m.kind === 'file' && fileIdOf(m.file_id));
  return [...rows.filter((m) => !m.is_logo), ...rows.filter((m) => m.is_logo)].map((m) => fileIdOf(m.file_id)!);
}

const offline = (client: SyncClient) => client.status().network === 'offline';
const safe = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => { try { return await work(); } catch { return fallback; } };

/** Portada del retiro como *object URL*, o `null` (iniciales). Quien la recibe la revoca. */
export async function coverFor({ client, userId }: CoverSource, reservationId: string): Promise<string | null> {
  const list = await safe(() => candidates(client, reservationId), [] as string[]);
  const saved = await safe(() => cache.image(userId, reservationId), null as CachedImage | null);
  const skipped = new Set(saved?.skipped ?? []);
  const firstImage = list.find((id) => !skipped.has(id)) ?? null;
  if (saved && (saved.fileId === firstImage || offline(client))) return URL.createObjectURL(saved.blob);
  if (!list.length) {
    // Con el espejo ya traído y sin archivos, la portada se quita; sin espejo aún, se queda la copia.
    if (client.status().lastPullAt) { await safe(() => cache.dropImage(userId, reservationId), undefined); return null; }
    return saved ? URL.createObjectURL(saved.blob) : null;
  }
  if (offline(client)) return null;
  const notImages: string[] = [];
  for (const fileId of list.slice(0, MAX_TRIES)) {
    try {
      const meta = await client.api<{ url: string; mime: string }>(`/files/${fileId}`);
      if (!meta.mime?.startsWith('image/')) { notImages.push(fileId); continue; }
      const response = await fetch(meta.url);
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size <= MAX_BYTES) await safe(() => cache.saveImage(userId, reservationId, { fileId, blob, mime: meta.mime, skipped: notImages }), undefined);
      return URL.createObjectURL(blob);
    } catch { /* sin red o archivo no disponible: se prueba el siguiente */ }
  }
  return saved ? URL.createObjectURL(saved.blob) : null;
}

export interface CoverLoader {
  /** Pide la portada de un retiro (una vez; se repite sola cuando cambian los materiales). */
  request(reservationId: string): void;
  destroy(): void;
}

/** Cargador para una vista: cola de 3 en paralelo, nueva petición al cambiar el espejo y revocación al desmontar. */
export function createCoverLoader(source: CoverSource, onCover: (reservationId: string, url: string | null) => void): CoverLoader {
  let alive = true;
  const requested = new Set<string>();
  const queue: string[] = [];
  const current = new Map<string, string>();
  let running = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = () => {
    while (alive && running < MAX_PARALLEL && queue.length) {
      const id = queue.shift()!;
      running++;
      void coverFor(source, id).catch(() => null).then((url) => {
        running--;
        if (!alive) { if (url) URL.revokeObjectURL(url); return; }
        const before = current.get(id);
        if (url) current.set(id, url); else current.delete(id);
        onCover(id, url);
        if (before) URL.revokeObjectURL(before);
        pump();
      });
    }
  };
  const enqueue = (id: string) => { if (!queue.includes(id)) queue.push(id); pump(); };
  const off = watch(source.client, [TABLES.materials], () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; requested.forEach(enqueue); }, 400);
  });

  return {
    request(reservationId) {
      if (requested.has(reservationId)) return;
      requested.add(reservationId);
      enqueue(reservationId);
    },
    destroy() {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
      queue.length = 0;
      current.forEach((url) => URL.revokeObjectURL(url));
      current.clear();
    },
  };
}
