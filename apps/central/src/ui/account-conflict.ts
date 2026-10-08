/**
 * Una persona, una ficha, una cuenta (decisión del usuario del 8-10-2026). Antes de dar cuenta (Accesos › Alta o «Dar cuenta»
 * en la ficha), si ese correo ya tiene cuenta se avisa y se deja elegir:
 * 1. cuenta sin ficha → enlazar esta ficha a esa cuenta (los accesos marcados se suman);
 * 2. cuenta enlazada a otra ficha → es la misma persona duplicada: fusionar las dos fichas (o cancelar);
 * 3. es otra persona → usar otro correo.
 * Sin esta comprobación, `admin/invite` reutilizaría la cuenta en silencio (#404).
 */
import type { SyncClient } from '@ikisai/sync-client';
import { el, openSheet, type Sheet } from '@ikisai/ui-kit';
import { MERGE_PEOPLE_PROCEDURE } from '@ikisai/domain-central';
import { T } from '../app/client.ts';
import type { AdminApi } from '../app/admin.ts';
import { fbIgnoreWithin, fbMark } from './feedback.ts';

export interface PersonRef { id: string; display_name: string }
export type ExistingChoice =
  | { kind: 'none' }
  | { kind: 'link' }
  | { kind: 'merge'; into: PersonRef }
  | { kind: 'use_existing'; into: PersonRef }
  | { kind: 'abort'; otherEmail: boolean };

/** Busca si el correo ya tiene cuenta y, si la tiene, pregunta qué hacer. Necesita red (lee las cuentas del núcleo). */
export async function checkExistingAccount(opts: {
  admin: AdminApi; client: SyncClient; email: string; person: PersonRef | null; appName: (id: string) => string;
}): Promise<ExistingChoice> {
  const email = opts.email.trim().toLowerCase();
  const account = (await opts.admin.accounts()).find((a) => (a.email ?? '').toLowerCase() === email);
  if (!account) return { kind: 'none' };
  const people = (await opts.client.list(T.people)) as unknown as Array<PersonRef & { user_id: string | null; deleted_at: string | null }>;
  const linked = people.find((p) => !p.deleted_at && p.user_id === account.userId) ?? null;
  const apps = account.memberships.map((m) => opts.appName(m.app)).join(', ') || 'ninguna app';
  const name = account.displayName || account.email || 'sin nombre';

  return new Promise<ExistingChoice>((resolve) => {
    let sheet: Sheet | null = null;
    let done = false;
    const choose = (choice: ExistingChoice) => { done = true; resolve(choice); void sheet?.close(true); };
    // Cada botón lleva su id de feedback literal con `fbMark` (el catálogo de la publicación solo recoge literales).
    const option = (id: string, label: string, help: string | null, choice: ExistingChoice, primary = false) =>
      el('div', { class: 'choice' },
        el('button', { class: primary ? 'primary' : 'ghost', type: 'button', id, onclick: () => choose(choice) }, label),
        help ? el('p', { class: 'muted small', 'data-feedback-ignore': '' }, help) : null);
    const button = (wrap: HTMLElement) => wrap.querySelector('button');
    const options: HTMLElement[] = [];
    if (account.kind === 'agent') {
      // Una cuenta de agente nunca es una persona del equipo.
    } else if (!linked) {
      const wrap = opts.person
        ? option('existingLink', 'Enlazar esta ficha a esa cuenta', `«${opts.person.display_name}» queda unida a esa cuenta y los accesos que has marcado se suman a los que ya tiene.`, { kind: 'link' }, true)
        : option('existingLink', 'Crear su ficha y enlazarla a esa cuenta', 'Se crea su ficha en Personas y los accesos que has marcado se suman a los que ya tiene.', { kind: 'link' }, true);
      fbMark(button(wrap), 'central.accesos.cuenta_existente.enlazar', 'Enlazar con la cuenta');
      options.push(wrap);
    } else if (opts.person) {
      const wrap = option('existingMerge', 'Fusionar las dos fichas',
        `Probablemente es la misma persona. Queda «${linked.display_name}» (la de la cuenta) con los datos, equipos, registros y documentos de las dos; «${opts.person.display_name}» va a la papelera, desde donde se puede restaurar. Los accesos marcados se suman.`,
        { kind: 'merge', into: linked }, true);
      fbMark(button(wrap), 'central.accesos.cuenta_existente.fusionar', 'Fusionar las dos fichas');
      options.push(wrap);
    } else {
      const wrap = option('existingUse', 'Añadir los accesos a su cuenta',
        `Ya tiene ficha («${linked.display_name}»): no se crea otra. Los accesos que has marcado se suman a los que ya tiene.`, { kind: 'use_existing', into: linked }, true);
      fbMark(button(wrap), 'central.accesos.cuenta_existente.usar', 'Añadir los accesos a su cuenta');
      options.push(wrap);
    }
    const other = option('existingOther', 'Es otra persona: usar otro correo', null, { kind: 'abort', otherEmail: true });
    fbMark(button(other), 'central.accesos.cuenta_existente.otro_correo', 'Usar otro correo');
    options.push(other);

    const message = el('p', { 'data-feedback-ignore': '' }, 'Este correo ya tiene cuenta: ', el('strong', null, name), `, con acceso a ${apps}, `,
      linked ? el('span', null, 'enlazada a la ficha ', el('strong', null, `«${linked.display_name}»`)) : 'sin ficha', '.');
    sheet = openSheet({
      title: 'Este correo ya tiene cuenta',
      body: el('div', { id: 'existingAccount', 'data-feedback-id': 'central.accesos.cuenta_existente.contenido', 'data-feedback-label': 'Correo con cuenta' }, message, ...options),
      panelAttrs: { 'data-feedback-id': 'central.accesos.cuenta_existente', 'data-feedback-label': 'Correo con cuenta' },
      closeAttrs: { 'data-feedback-id': 'central.accesos.cuenta_existente.cerrar', 'data-feedback-label': 'Cerrar' },
      foot: [el('button', { class: 'ghost', type: 'button', id: 'existingCancel', 'data-feedback-id': 'central.accesos.cuenta_existente.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => choose({ kind: 'abort', otherEmail: false }) }, 'Cancelar')],
      onClose: () => { if (!done) { done = true; resolve({ kind: 'abort', otherEmail: false }); } },
    });
    fbIgnoreWithin(sheet.element, '.sheet-head h2');
  });
}

/** Fusiona la ficha `from` en `into` (procedimiento del servidor, una sola transacción; necesita red). */
export function mergePeople(client: SyncClient, from: string, into: string) {
  return client.commit([{ op: 'call', procedure: MERGE_PEOPLE_PROCEDURE, args: { from, into } }]);
}
