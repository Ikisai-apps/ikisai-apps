import type { Menu } from '@ikisai/domain-food';
import { el, replace, toast } from '@ikisai/ui-kit';
import { T, describeError, type Mirror } from '../app/client.ts';
import { guard } from '../app/guard.ts';
import type { TabContext } from './menu-shopping.ts';

const GUIDE = 'Raciones reales servidas · cambios sobre el menú · sobras relevantes · productos a reponer · incidencias · comentarios del grupo · qué hacer distinto la próxima vez';

/** Notas del menú y cierre de cocina (canon §31): solo lo útil para mejorar la próxima vez. Editable también con el menú validado. */
export function mountClosing({ client, menuId, host, canWrite }: TabContext): () => void {
  let menu: Mirror<Menu> | null = null;
  const notes = el('textarea', { id: 'menuNotes', rows: '3', placeholder: 'Para cocina: avisos, acuerdos con el organizador…' });
  const closing = el('textarea', { id: 'closingNotes', rows: '8', placeholder: GUIDE });
  const save = el('button', { class: 'primary', type: 'button', id: 'saveClosing', hidden: true, onclick: () => void commit() }, 'Guardar');
  const value = (node: HTMLTextAreaElement) => node.value.trim() || null;
  const dirty = () => !!menu && (value(notes) !== (menu.notes ?? null) || value(closing) !== (menu.closing_notes ?? null));
  const refresh = () => { save.hidden = !dirty(); guard.dirtyEditor = dirty(); };
  notes.oninput = closing.oninput = refresh;

  async function commit(): Promise<void> {
    if (!menu) return;
    const fields: Record<string, unknown> = {};
    if (value(notes) !== (menu.notes ?? null)) fields.notes = value(notes);
    if (value(closing) !== (menu.closing_notes ?? null)) fields.closing_notes = value(closing);
    try {
      await client.commit([{ op: 'update', table: T.menus, id: menu.id, expectedRevision: menu.revision, fields }]);
      toast(navigator.onLine ? 'Notas guardadas.' : 'Notas guardadas en este dispositivo. Se sincronizarán cuando haya red.');
      await load(true);
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function load(force = false): Promise<void> {
    const row = (await client.get(T.menus, menuId)) as Mirror<Menu> | null;
    if (!row || row.deleted_at) { replace(host); return; }
    const first = menu === null;
    menu = row;
    if (first || force || !dirty()) {
      notes.value = row.notes ?? '';
      closing.value = row.closing_notes ?? '';
    }
    notes.disabled = closing.disabled = !canWrite();
    if (first) {
      replace(host,
        el('label', { class: 'field' }, el('span', null, 'Notas del menú'), notes),
        el('label', { class: 'field' }, el('span', null, 'Cierre de cocina'), closing, el('span', { class: 'hint' }, 'Se puede escribir durante el retiro y completar al terminar. No sale en el menú del organizador.')),
        el('div', { class: 'btnrow' }, save));
    }
    refresh();
  }

  void load();
  const off = client.onTable(T.menus, () => void load());
  return () => {
    off();
    guard.dirtyEditor = false;
  };
}
