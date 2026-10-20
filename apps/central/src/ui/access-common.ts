/**
 * Accesos · lo común a Cuentas, Alta, Agentes y Registro (API.md §9.4): el aviso sin red, las fichas que hacen falta para
 * enlazar cuentas, la ficha nueva de una cuenta del equipo, la contraseña temporal y cómo se dicen roles, apps y horas.
 */
import { el, formatDate, icon, openSheet, renderSecretOnce, type Sheet } from '@ikisai/ui-kit';
import type { SyncClient } from '@ikisai/sync-client';
import { relationForLevel, type HouseLevel } from '@ikisai/domain-central';
import { T } from '../app/client.ts';
import type { CatalogApp, Role } from '../app/admin.ts';
import { fbIgnoreWithin, fbMark } from './feedback.ts';

export function offlineNote(at?: string): HTMLElement {
  return el('p', { class: 'note warn', role: 'status', 'data-feedback-id': 'central.accesos.sin_conexion', 'data-feedback-label': 'Aviso sin conexión' }, icon('offline', 18),
    at ? ` Sin conexión: lista del ${formatDate(at)}. Los cambios necesitan red.` : ' Sin conexión: los accesos se leen y cambian en el momento y necesitan red.');
}

/** Estado de una pestaña montada: `alive` hasta salir, y lo que hay que soltar al salir (`bindOnline`, escuchas). */
export interface AccessState { alive: boolean; cleanups: Array<() => void> }

/** Motivo de los botones que escriben en Core (`bindOnline`). */
export const NEEDS_NETWORK = 'Los accesos se cambian en el momento: necesita conexión.';

/** Ficha de Personas, lo que Accesos necesita para enlazar cuentas (FB_2026_013: la ficha manda sobre el nombre). */
export interface PersonLite { id: string; revision: number; display_name: string; base_role: string; active: boolean; user_id: string | null; deleted_at: string | null; position: number; house_level?: HouseLevel | null; initials?: string | null }

export async function loadPeopleLite(client: SyncClient): Promise<{ people: PersonLite[]; emails: Map<string, string> }> {
  const people = ((await client.list(T.people)) as unknown as PersonLite[]).filter((p) => !p.deleted_at)
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));
  const emails = new Map<string, string>();
  try {
    for (const x of (await client.list(T.personPrivate)) as unknown as Array<{ person_id: string; email: string | null; deleted_at: string | null }>) {
      if (!x.deleted_at && x.email) emails.set(x.person_id, x.email);
    }
  } catch { /* sin datos reservados: el correo se escribe a mano */ }
  return { people, emails };
}

/** Con el nivel de casa activo (fase P1), la ficha nace con su nivel y la relación que le corresponde; si no, como antes. */
export const levelsActive = (people: PersonLite[]) => people.some((p) => !!p.house_level);

/** Ficha mínima para una cuenta del equipo que aún no la tenía (el resto se completa en Personas). */
export const newPersonFields = (name: string, userId: string, level?: HouseLevel | null) => ({
  ...(level !== undefined ? { house_level: level, relation: relationForLevel(level) } : { relation: 'equipo' }),
  display_name: name, base_role: 'otro', coverage: 'todo', availability: 'segun_calendario', committed_post: false, user_id: userId, position: Date.now() / 1000,
});

/** Letra de cada rol en la cuadrícula (MUELA-085): P, E, L u O. */
export const ROLE_LETTERS: Record<Role, string> = { owner: 'P', editor: 'E', reader: 'L', outsider: 'O' };

export const appShort = (catalog: readonly CatalogApp[], id: string) => catalog.find((a) => a.id === id)?.name.replace(/^Ikisai /, '') ?? id;

/** «lun 19 oct, 10:42» en la hora de la casa: cada línea de un registro de seguridad lleva su día y su hora (Bloque 2, §2). */
export function dayAndTime(iso: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short' }).format(d).replace(/\./g, '').replace(',', '');
  const time = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(d);
  return `${day}, ${time}`;
}

/** Contraseña temporal mostrada una sola vez, con botón de copiar (kit). */
export function showSecret(password: string, email: string, onDone?: () => void): void {
  let sheet: Sheet | null = null;
  sheet = openSheet({
    title: 'Contraseña temporal',
    meta: email,
    panelAttrs: { 'data-feedback-id': 'central.accesos.contrasena', 'data-feedback-label': 'Contraseña temporal' },
    closeAttrs: { 'data-feedback-id': 'central.accesos.contrasena.cerrar', 'data-feedback-label': 'Cerrar' },
    body: el('div', { 'data-feedback-id': 'central.accesos.contrasena.contenido', 'data-feedback-label': 'Contraseña temporal' },
      el('p', null, 'Pásasela a la persona por un canal privado. Al entrar, conviene que la cambie.'),
      fbMark(renderSecretOnce({
        value: password, label: 'Contraseña temporal', warning: 'Solo se muestra ahora: no se puede volver a consultar.', onDone: () => { void sheet?.close(); onDone?.(); },
        valueAttrs: { 'data-feedback-id': 'central.accesos.contrasena.valor', 'data-feedback-label': 'Contraseña', 'data-feedback-ignore': '' },
        copyAttrs: { 'data-feedback-id': 'central.accesos.contrasena.copiar', 'data-feedback-label': 'Copiar' },
        doneAttrs: { 'data-feedback-id': 'central.accesos.contrasena.hecho', 'data-feedback-label': 'Hecho' },
      }), 'central.accesos.contrasena.bloque', 'Datos de la contraseña')),
  });
  // El correo de la cuenta va en la línea secundaria de la hoja.
  if (sheet) fbIgnoreWithin(sheet.element, '.sheet-body > .meta');
}
