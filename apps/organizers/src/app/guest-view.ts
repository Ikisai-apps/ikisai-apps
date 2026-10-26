/**
 * «Verlo como huésped» (decisión de VG del 26-10-2026): quien organiza recibe también acceso a Guests y figura como huésped
 * de su retiro (Booking B21, `as_guest_id`). El botón abre Ven con la misma cuenta: no hay otro inicio de sesión, porque
 * Guests entra con el pase común (`auth/sso`, contrato §3.4), que el núcleo alarga también al refrescar la sesión (K9).
 * El dominio sale del catálogo de apps de la cuenta (`GET apps`): sin acceso a Guests, no hay botón.
 */
import type { LauncherCatalog } from '@ikisai/ui-kit';
import type { SyncClient } from '@ikisai/sync-client';

/**
 * Dirección de Guests en la ficha de ese retiro (Guests Gu1), o null si no aplica: sin ficha de huésped en el retiro o sin
 * Guests en el catálogo.
 */
export function guestViewUrl(catalog: LauncherCatalog | null, reservationId: string, asGuestId: string | null | undefined): string | null {
  if (!asGuestId) return null;
  const guests = catalog?.items.find((app) => app.id === 'guests');
  if (!guests?.domain) return null;
  // Ruta confirmada por Guests (Gu1): `#/r/<reservation_id>` en minúsculas abre ese retiro (la familia, o la ficha si es una).
  return `https://${guests.domain}/#/r/${encodeURIComponent(reservationId.toLowerCase())}`;
}

let catalog: Promise<LauncherCatalog | null> | null = null;

/** Catálogo de apps de la cuenta, una vez por sesión de la página; sin red o con error, null (y se vuelve a pedir). */
export function loadCatalog(client: SyncClient): Promise<LauncherCatalog | null> {
  catalog ??= client.api<LauncherCatalog>('/apps').catch(() => { catalog = null; return null; });
  return catalog;
}

/** Al cerrar sesión o entrar otra persona (`onSessionEnd`): el catálogo es de la cuenta. */
export function resetCatalog(): void {
  catalog = null;
}
