import type { SyncClient } from '@ikisai/sync-client';

/**
 * Nombres de las personas de Flow (`GET members`, que en una app interna puede leer cualquier miembro) para decir quién
 * tiene una tarjeta. Se guardan en la sesión del navegador para verlos sin red; nunca se inventa un autor.
 */
const KEY = 'ikisai-flow-people';
let cache: Map<string, string> | null = null;

function readStored(): Map<string, string> {
  try { return new Map(Object.entries(JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, string>)); } catch { return new Map(); }
}

export async function loadPeople(client: SyncClient): Promise<Map<string, string>> {
  cache ??= readStored();
  try {
    const items = await client.api<Array<{ userId: string; displayName: string }>>('/members');
    cache = new Map(items.map((m) => [m.userId, m.displayName || 'Sin nombre']));
    try { sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(cache))); } catch { /* sin almacenamiento */ }
  } catch { /* sin red: lo último conocido */ }
  return cache;
}

/** «Tú», el nombre o «otra persona» si aún no se conoce. */
export function personName(people: Map<string, string> | null, userId: string | null, me: string | null): string {
  if (!userId) return '';
  if (userId === me) return 'Tú';
  return people?.get(userId) ?? 'Otra persona';
}
