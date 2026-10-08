/**
 * La ficha de Personas manda sobre el nombre de su cuenta (FB_2026_013, opción A del usuario). Al renombrar una ficha
 * enlazada, Central cambia el nombre visible de la cuenta en el núcleo. Sin red se apunta la cuenta (solo su id, nunca
 * el nombre) y se reintenta al volver la conexión con el nombre que tenga entonces la ficha.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { toast } from '@ikisai/ui-kit';
import { T } from './client.ts';
import type { Account, AdminApi, CatalogApp } from './admin.ts';

const KEY = 'ikisai-central.pending-account-names';

function pending(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function save(ids: string[]): void {
  try { ids.length ? localStorage.setItem(KEY, JSON.stringify([...new Set(ids)])) : localStorage.removeItem(KEY); } catch { /* sin almacenamiento: queda el aviso de Accesos */ }
}
export function clearPendingAccountNames(): void { save([]); }

/** Cambia el nombre de la cuenta; sin red lo deja apuntado y avisa. Devuelve si se cambió ya. */
export async function syncAccountName(admin: AdminApi, userId: string, name: string, quiet = false): Promise<boolean> {
  try {
    await admin.setDisplayName(userId, name);
    save(pending().filter((id) => id !== userId));
    return true;
  } catch (error) {
    if (!navigator.onLine || (error as { code?: string })?.code === 'OFFLINE' || (error as { status?: number })?.status === 0) {
      save([...pending(), userId]);
      if (!quiet) toast('El nombre de su cuenta se cambiará al volver la conexión.');
      return false;
    }
    if (!quiet) toast('La ficha se ha guardado, pero no se pudo cambiar el nombre de su cuenta. Revísalo en Accesos.');
    return false;
  }
}

/** Reintenta lo apuntado, con el nombre actual de cada ficha enlazada. */
export async function flushPendingAccountNames(admin: AdminApi, client: SyncClient): Promise<void> {
  const ids = pending();
  if (!ids.length || !navigator.onLine) return;
  const people = (await client.list(T.people)) as unknown as Array<{ user_id: string | null; display_name: string; deleted_at: string | null }>;
  let done = 0;
  for (const id of ids) {
    const person = people.find((p) => !p.deleted_at && p.user_id === id);
    if (!person) { save(pending().filter((x) => x !== id)); continue; }
    if (await syncAccountName(admin, id, person.display_name, true)) done++;
  }
  if (done) toast(done === 1 ? 'Nombre de la cuenta actualizado.' : `${done} nombres de cuenta actualizados.`);
}

/** Una cuenta es «del equipo» (debería tener ficha) si entra en alguna app interna; las de portal y los agentes, no. */
export function isStaffAccount(account: Account, catalog: CatalogApp[]): boolean {
  if (account.kind === 'agent') return false;
  const internal = new Set(catalog.filter((a) => a.kind !== 'portal').map((a) => a.id));
  return account.memberships.some((m) => internal.has(m.app));
}
