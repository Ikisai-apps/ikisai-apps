import { FOOD_PROCEDURES, crossContext, serviceConsumption, undeclaredAllergens, type Consumption, type Menu, type MenuComment, type PreparationItem, type Recipe, type ShoppingList } from '@ikisai/domain-food';
import { el, icon, replace, toast } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { ALLERGEN_LABELS, T, describeError, type Mirror } from '../app/client.ts';
import { loadInventory } from '../app/consumption.ts';
import { longDay } from '../app/events.ts';
import { loadMenuData } from '../app/menu-data.ts';
import { tonedChecks, verdictText, type ToneCheck } from './checks.ts';
import { SERVICE_LABELS } from './events.ts';
import { guard } from '../app/guard.ts';
import type { TabContext } from './menu-shopping.ts';
import { onlineBinder } from './online.ts';
import { usage } from '../app/usage.ts';

const GUIDE = 'Raciones reales servidas · cambios sobre el menú · sobras relevantes · productos a reponer · incidencias · comentarios del grupo · qué hacer distinto la próxima vez';
const NO_NET = 'Necesita conexión: las notas se pueden seguir escribiendo.';

/**
 * Cierre A «Veredicto y comprobaciones» (tanda 38, MUELA-091): el veredicto y las comprobaciones de siempre, más los
 * comentarios del organizador y los alérgenos; «Cerrar menú» también aquí (la misma acción que en la pestaña Menú) y,
 * debajo, las notas del menú y el cierre de cocina (canon §31). Con algo pendiente, cerrar solo avisa (decisión de VG).
 */
export function mountClosing({ client, menuId, host, canWrite, navigate, goToComments }: TabContext): () => void {
  let menu: Mirror<Menu> | null = null;
  let closing = false;
  const checksHost = el('div', { class: 'fd-checkshost' });
  const closeHost = el('div', { class: 'fd-closebar', id: 'closeBar' });
  const notes = el('textarea', { 'data-field-id': 'food.menu.cierre.notas', 'data-field-entity': 'food.menus', 'data-field-prop': 'notes', 'data-feedback-id': 'food.menu.cierre.notas', 'data-feedback-label': 'Notas del menú', 'data-feedback-ignore': '', id: 'menuNotes', rows: '3', placeholder: 'Para cocina: avisos, acuerdos con el organizador…' });
  const closingNotes = el('textarea', { 'data-field-id': 'food.menu.cierre.cierre_cocina', 'data-field-entity': 'food.menus', 'data-field-prop': 'closing_notes', 'data-feedback-id': 'food.menu.cierre.cierre_cocina', 'data-feedback-label': 'Cierre de cocina', 'data-feedback-ignore': '', id: 'closingNotes', rows: '8', placeholder: GUIDE });
  const save = el('button', { 'data-feedback-id': 'food.menu.cierre.guardar', 'data-feedback-label': 'Guardar notas', class: 'primary', type: 'button', id: 'saveClosing', hidden: true, onclick: () => void commit() }, 'Guardar');
  const value = (node: HTMLTextAreaElement) => node.value.trim() || null;
  const dirty = () => !!menu && (value(notes) !== (menu.notes ?? null) || value(closingNotes) !== (menu.closing_notes ?? null));
  const refresh = () => { save.hidden = !dirty(); guard.dirtyEditor = dirty(); };
  notes.oninput = closingNotes.oninput = refresh;
  const net = onlineBinder(client);

  async function commit(): Promise<boolean> {
    if (!menu) return false;
    const fields: Record<string, unknown> = {};
    if (value(notes) !== (menu.notes ?? null)) fields.notes = value(notes);
    if (value(closingNotes) !== (menu.closing_notes ?? null)) fields.closing_notes = value(closingNotes);
    try {
      await usage.run('food.cierre.guardar_notas', () => client.commit([{ op: 'update', table: T.menus, id: menu!.id, expectedRevision: menu!.revision, fields }]));
      toast(navigator.onLine ? 'Notas guardadas.' : 'Notas guardadas en este dispositivo. Se sincronizarán cuando haya red.');
      await load(true);
      return true;
    } catch (error) {
      toast(describeError(error));
      return false;
    }
  }

  /** «Cerrar menú» aquí: las notas sin guardar se guardan antes (si no, se quedarían en el campo) y después se cierra. */
  async function closeMenu(): Promise<void> {
    if (!menu || closing) return;
    closing = true;
    try {
      if (dirty()) {
        if (!(await commit())) return;
        await client.sync().catch(() => undefined);
        menu = ((await client.get(T.menus, menuId)) as Mirror<Menu> | null) ?? menu;
      }
      await runCall(client, FOOD_PROCEDURES.setMenuStatus, { menu_id: menu!.id, expectedRevision: menu!.revision, status: 'cerrado' });
      usage.track('food.cierre.cerrar', 'success');
      toast('Menú cerrado.');
    } catch (error) {
      usage.track('food.cierre.cerrar', 'error');
      toast(describeError(error));
    } finally {
      closing = false;
      await client.sync().catch(() => undefined);
      await load();
    }
  }

  /**
   * Veredicto y comprobaciones del cierre (tanda 27; regla de VG): ✓ de consumo solo con «Consumo anotado» en todos los
   * servicios que ya pasaron; «se está descontando solo» va en ámbar (en curso: el stock aún no está descontado).
   * Tanda 38: los comentarios del organizador (rojo si hay nuevos, ámbar si quedan sin resolver) y los alérgenos
   * (rojo: sin revisar o un posible sin declarar).
   */
  async function paintChecks(): Promise<void> {
    if (!menu) return;
    const [data, steps, lists, consumptions, inventory, allComments] = await Promise.all([
      loadMenuData(client, menuId),
      client.list(T.preparation) as Promise<Array<Mirror<PreparationItem>>>,
      client.list(T.shoppingLists) as Promise<Array<Mirror<ShoppingList>>>,
      client.list(T.consumptions) as Promise<Array<Mirror<Consumption>>>,
      loadInventory(client).catch(() => null),
      client.list(T.menuComments) as Promise<Array<Mirror<MenuComment>>>,
    ]);
    if (!menu) return;
    const writable = canWrite() && !!navigate;
    const go = (label: string, hash: string, feedbackId: string) => (writable ? { label, onClick: () => navigate!(hash), feedbackId } : null);
    // Ver (comentarios, receta) también lo puede quien solo lee; la etiqueta del id es el texto del botón.
    const act = (label: string, onClick: () => void, feedbackId: string) => ({ label, onClick, feedbackId });
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

    // Comentarios del organizador: verlos también lo puede hacer quien solo lee.
    const comments = allComments.filter((c) => c.menu_id === menuId && !c.deleted_at);
    const open = comments.filter((c) => c.status !== 'resuelto');
    const fresh = open.filter((c) => c.status === 'nuevo').length;
    items.push({ tone: fresh ? 'alert' : 'warn', ok: open.length === 0, text: 'Comentarios del organizador resueltos',
      detail: open.length ? `${open.length === 1 ? '1 comentario sin resolver' : `${open.length} comentarios sin resolver`}${fresh ? ` (${fresh === 1 ? '1 nuevo' : `${fresh} nuevos`})` : ''}` : null,
      action: open.length && goToComments ? act('Ver comentarios', goToComments, 'food.menu.cierre.comprobar.comentarios') : null });

    // Alérgenos: cada receta del menú revisada y sin alérgenos posibles sin declarar (MUELA-086).
    const used = new Set(data.items.filter((i) => !i.deleted_at).map((i) => i.recipe_id));
    const recipes = data.recipes.filter((r) => used.has(r.id));
    const context = crossContext({ recipe_ingredients: data.lines, ingredients: data.ingredients });
    const unreviewed = recipes.filter((r) => !r.allergens_checked);
    const undeclared = recipes.flatMap((r) => undeclaredAllergens(r as unknown as Recipe, context).map((u) => ({ recipe: r, allergen: u.allergen })));
    const firstBad = unreviewed[0] ?? undeclared[0]?.recipe;
    items.push({ tone: 'alert', ok: !firstBad, text: 'Alérgenos revisados',
      detail: firstBad ? [unreviewed.length ? `sin revisar: ${unreviewed.map((r) => r.name).join(', ')}` : null,
        undeclared.length ? `posibles sin declarar: ${undeclared.map((u) => `${u.recipe.name} (${ALLERGEN_LABELS[u.allergen].toLowerCase()})`).join(', ')}` : null].filter(Boolean).join(' · ') : null,
      action: firstBad && navigate ? act('Abrir en el Recetario', () => navigate(`#/recetario?receta=${firstBad.id}`), 'food.menu.cierre.comprobar.alergenos') : null });

    // «Menú cerrado», la última. Si se puede cerrar aquí, lo dice.
    const closable = canWrite() && menu.status === 'validado';
    items.push({ tone: 'alert', ok: menu.status === 'cerrado', text: 'Menú cerrado',
      detail: menu.status === 'cerrado' ? null : closable ? 'con «Cerrar menú», aquí debajo o en la pestaña Menú' : 'se cierra en la pestaña Menú, con «Cerrar menú»',
      action: menu.status === 'cerrado' || closable ? null : go('Ir a Menú', `#/menus/${menuId}`, 'food.menu.cierre.comprobar.cerrar') });
    replace(checksHost, tonedChecks(items, { verdict: verdictText(items, 'Cierre completo'), label: 'Cierre', feedbackId: 'food.menu.cierre.comprobaciones', feedbackLabel: 'Comprobaciones del cierre' }));
    paintClose(items.filter((i) => !i.ok && i.text !== 'Menú cerrado').length);
  }

  /**
   * «Cerrar menú» también aquí (decisión de VG: con algo pendiente, solo avisa). Sin nada pendiente, en verde; con algo,
   * en gris y con la frase. Sin red, apagado y solo con el motivo. Solo con el menú validado y para quien escribe.
   */
  function paintClose(pending: number): void {
    net.release();
    if (!menu || menu.status === 'cerrado') {
      replace(closeHost, menu?.status === 'cerrado' ? el('p', { class: 'fd-closed' }, icon('check', 16), 'Menú cerrado.') : null);
      return;
    }
    if (!canWrite() || menu.status !== 'validado') { replace(closeHost); return; }
    const button = el('button', { 'data-feedback-id': 'food.menu.cierre.cerrar', 'data-feedback-label': 'Cerrar menú', class: pending ? 'ghost' : 'primary', type: 'button', id: 'closeMenuHere', disabled: closing,
      onclick: () => void closeMenu() }, 'Cerrar menú');
    replace(closeHost, button,
      pending && navigator.onLine ? el('span', { class: 'hint' }, 'Puedes cerrarlo igualmente; el Cierre seguirá diciendo lo que falta.') : null);
    net.bind(button, NO_NET);
  }

  async function load(force = false): Promise<void> {
    const row = (await client.get(T.menus, menuId)) as Mirror<Menu> | null;
    if (!row || row.deleted_at) { replace(host); return; }
    const first = menu === null;
    menu = row;
    if (first || force || !dirty()) {
      notes.value = row.notes ?? '';
      closingNotes.value = row.closing_notes ?? '';
    }
    notes.disabled = closingNotes.disabled = !canWrite();
    if (first) {
      replace(host,
        checksHost,
        closeHost,
        el('h3', { class: 'sectionlabel fd-notesh' }, 'Notas'),
        el('label', { class: 'field' }, el('span', null, 'Notas del menú'), notes),
        el('label', { class: 'field' }, el('span', null, 'Cierre de cocina'), closingNotes, el('span', { class: 'hint' }, 'Se puede escribir durante el retiro y completar al terminar. No sale en el menú del organizador.')),
        el('div', { class: 'btnrow' }, save));
    }
    refresh();
    void paintChecks();
  }

  void load();
  const off = client.onTable(T.menus, () => { if (!closing) void load(); });
  const offChecks = [T.preparation, T.shoppingLists, T.consumptions, T.menuComments, T.menuItems, T.recipes].map((table) => client.onTable(table, () => void paintChecks()));
  // La frase de debajo de «Cerrar menú» cambia con la red (sin ella, solo el motivo).
  const repaint = () => void paintChecks();
  window.addEventListener('online', repaint);
  window.addEventListener('offline', repaint);
  return () => {
    off();
    offChecks.forEach((stop) => stop());
    net.release();
    window.removeEventListener('online', repaint);
    window.removeEventListener('offline', repaint);
    guard.dirtyEditor = false;
  };
}
