import { serviceConsumption, type Consumption, type Menu, type PreparationItem, type ShoppingList } from '@ikisai/domain-food';
import { el, replace, toast } from '@ikisai/ui-kit';
import { T, describeError, type Mirror } from '../app/client.ts';
import { loadInventory } from '../app/consumption.ts';
import { longDay } from '../app/events.ts';
import { loadMenuData } from '../app/menu-data.ts';
import { tonedChecks, verdictText, type ToneCheck } from './checks.ts';
import { SERVICE_LABELS } from './events.ts';
import { guard } from '../app/guard.ts';
import type { TabContext } from './menu-shopping.ts';
import { usage } from '../app/usage.ts';

const GUIDE = 'Raciones reales servidas · cambios sobre el menú · sobras relevantes · productos a reponer · incidencias · comentarios del grupo · qué hacer distinto la próxima vez';

/** Notas del menú y cierre de cocina (canon §31): solo lo útil para mejorar la próxima vez. Editable también con el menú validado. */
export function mountClosing({ client, menuId, host, canWrite, navigate }: TabContext): () => void {
  let menu: Mirror<Menu> | null = null;
  const checksHost = el('div', { class: 'fd-checkshost' });
  const notes = el('textarea', { 'data-feedback-id': 'food.menu.cierre.notas', 'data-feedback-label': 'Notas del menú', 'data-feedback-ignore': '', id: 'menuNotes', rows: '3', placeholder: 'Para cocina: avisos, acuerdos con el organizador…' });
  const closing = el('textarea', { 'data-feedback-id': 'food.menu.cierre.cierre_cocina', 'data-feedback-label': 'Cierre de cocina', 'data-feedback-ignore': '', id: 'closingNotes', rows: '8', placeholder: GUIDE });
  const save = el('button', { 'data-feedback-id': 'food.menu.cierre.guardar', 'data-feedback-label': 'Guardar notas', class: 'primary', type: 'button', id: 'saveClosing', hidden: true, onclick: () => void commit() }, 'Guardar');
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
      await usage.run('food.cierre.guardar_notas', () => client.commit([{ op: 'update', table: T.menus, id: menu!.id, expectedRevision: menu!.revision, fields }]));
      toast(navigator.onLine ? 'Notas guardadas.' : 'Notas guardadas en este dispositivo. Se sincronizarán cuando haya red.');
      await load(true);
    } catch (error) {
      toast(describeError(error));
    }
  }

  /**
   * Veredicto y comprobaciones del cierre (tanda 27; regla de VG): ✓ de consumo solo con «Consumo anotado» en todos los
   * servicios que ya pasaron; «se está descontando solo» va en ámbar (en curso: el stock aún no está descontado).
   */
  async function paintChecks(): Promise<void> {
    if (!menu) return;
    const [data, steps, lists, consumptions, inventory] = await Promise.all([
      loadMenuData(client, menuId),
      client.list(T.preparation) as Promise<Array<Mirror<PreparationItem>>>,
      client.list(T.shoppingLists) as Promise<Array<Mirror<ShoppingList>>>,
      client.list(T.consumptions) as Promise<Array<Mirror<Consumption>>>,
      loadInventory(client).catch(() => null),
    ]);
    const writable = canWrite() && !!navigate;
    const go = (label: string, hash: string, feedbackId: string) => (writable ? { label, onClick: () => navigate!(hash), feedbackId } : null);
    const items: ToneCheck[] = [];
    if (inventory?.kitchen.size) {
      const now = new Date();
      const states = data.services.map((s) => ({ s, state: serviceConsumption(s, data.graph, consumptions, inventory.movements, now).state }));
      const due = states.filter((x) => x.state === 'por_confirmar');
      const running = states.filter((x) => x.state === 'automatico');
      const label = (x: (typeof states)[number]) => `${SERVICE_LABELS[x.s.service_type].toLowerCase()} del ${longDay(x.s.service_date)}`;
      items.push(due.length
        ? { tone: 'alert', ok: false, text: 'Consumo anotado', detail: `falta confirmar el consumo de ${due.map(label).join(', ')}`, action: go('Confirmar en el menú', `#/menus/${menuId}`, 'food.menu.cierre.comprobar.consumo') }
        : running.length
          ? { tone: 'warn', ok: false, text: 'Consumo anotado', detail: `se está descontando solo (en curso): ${running.map(label).join(', ')}` }
          // ✓ solo si todo lo que se descuenta está anotado; lo que aún no ha llegado no cuenta como hecho.
          : { tone: 'warn', ok: states.every((x) => x.state === 'hecho' || x.state === 'no_aplica'), text: 'Consumo anotado',
              detail: states.some((x) => x.state === 'antes') ? 'quedan servicios por llegar' : null });
    }
    const own = steps.filter((p) => p.menu_id === menuId && !p.deleted_at);
    const left = own.filter((p) => !p.done).length;
    items.push({ tone: 'warn', ok: own.length > 0 && left === 0, text: 'Preparación hecha', detail: !own.length ? 'no hay plan de preparación' : left ? `${left} ${left === 1 ? 'paso sin hacer' : 'pasos sin hacer'}` : null,
      action: left || !own.length ? go('Ir a Preparación', `#/menus/${menuId}/preparacion`, 'food.menu.cierre.comprobar.preparacion') : null });
    const list = lists.find((l) => l.menu_id === menuId && !l.deleted_at);
    items.push({ tone: 'warn', ok: list?.status === 'cerrada', text: 'Compra cerrada', detail: !list ? 'no hay lista de compra' : list.status === 'cerrada' ? null : 'la lista sigue abierta',
      action: list?.status === 'cerrada' ? null : go('Ir a Compra', `#/menus/${menuId}/compra`, 'food.menu.cierre.comprobar.compra') });
    items.push({ tone: 'warn', ok: !!menu.closing_notes?.trim(), text: 'Cierre de cocina escrito', detail: menu.closing_notes?.trim() ? null : 'lo que conviene recordar la próxima vez' });
    items.push({ tone: 'alert', ok: menu.status === 'cerrado', text: 'Menú cerrado', detail: menu.status === 'cerrado' ? null : 'se cierra en la pestaña Menú, con «Cerrar menú»',
      action: menu.status === 'cerrado' ? null : go('Ir a Menú', `#/menus/${menuId}`, 'food.menu.cierre.comprobar.cerrar') });
    replace(checksHost, tonedChecks(items, { verdict: verdictText(items, 'Cierre completo'), label: 'Cierre', feedbackId: 'food.menu.cierre.comprobaciones', feedbackLabel: 'Comprobaciones del cierre' }));
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
        checksHost,
        el('label', { class: 'field' }, el('span', null, 'Notas del menú'), notes),
        el('label', { class: 'field' }, el('span', null, 'Cierre de cocina'), closing, el('span', { class: 'hint' }, 'Se puede escribir durante el retiro y completar al terminar. No sale en el menú del organizador.')),
        el('div', { class: 'btnrow' }, save));
    }
    refresh();
    void paintChecks();
  }

  void load();
  const off = client.onTable(T.menus, () => void load());
  const offChecks = [T.preparation, T.shoppingLists, T.consumptions].map((table) => client.onTable(table, () => void paintChecks()));
  return () => {
    off();
    offChecks.forEach((stop) => stop());
    guard.dirtyEditor = false;
  };
}
