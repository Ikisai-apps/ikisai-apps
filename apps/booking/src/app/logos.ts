/**
 * Logo de cada retiro (API §17.8, de Organizers): `GET /logos` firma las URL por 10 minutos. Con red se pide una vez
 * por sesión y cada imagen se guarda en Cache Storage por su `sha256`, para verla también sin red. Sin logo, quien
 * pinta usa el color de la fase. Se borra al cerrar sesión.
 */
import type { SyncClient } from '@ikisai/sync-client';

interface LogoItem { reservation_id: string; mime: string; sha256: string; updated_at: string; url: string }

const CACHE = 'booking-logos';
const INDEX_KEY = 'booking.logos.index';
let urls = new Map<string, string>();
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

const readIndex = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as Record<string, string>; } catch { return {}; }
};
const writeIndex = (index: Record<string, string>) => { try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch { /* sin almacenamiento: solo con red */ } };

async function fromCache(index: Record<string, string>): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE);
    for (const [reservationId, sha] of Object.entries(index)) {
      if (urls.has(reservationId)) continue;
      const hit = await cache.match(`/__logo/${sha}`);
      if (hit) urls.set(reservationId, URL.createObjectURL(await hit.blob()));
    }
  } catch { /* la caché puede no estar disponible */ }
}

async function refresh(client: SyncClient): Promise<void> {
  const index = readIndex();
  await fromCache(index);
  if (!navigator.onLine) return;
  try {
    const out = await client.api<{ items?: LogoItem[] }>('/logos');
    const next: Record<string, string> = {};
    const cache = typeof caches === 'undefined' ? null : await caches.open(CACHE).catch(() => null);
    for (const item of out.items ?? []) {
      next[item.reservation_id] = item.sha256;
      if (index[item.reservation_id] === item.sha256 && urls.has(item.reservation_id)) continue;
      urls.set(item.reservation_id, item.url);
      if (cache) void fetch(item.url).then((res) => (res.ok ? cache.put(`/__logo/${item.sha256}`, res) : undefined)).catch(() => undefined);
    }
    for (const id of [...urls.keys()]) if (!(id in next)) urls.delete(id);
    writeIndex(next);
  } catch { /* sin logos: el color de la fase */ }
}

/** Logos conocidos (al instante, de la caché) y aviso cuando llegan los de la red. */
export function retreatLogos(client: SyncClient): ReadonlyMap<string, string> {
  if (!loaded) loaded = refresh(client).then(() => listeners.forEach((fn) => fn()));
  return urls;
}

export function onLogos(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function forgetLogos(): void {
  for (const url of urls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  urls = new Map();
  loaded = null;
  writeIndex({});
  if (typeof caches !== 'undefined') void caches.delete(CACHE).catch(() => undefined);
}
