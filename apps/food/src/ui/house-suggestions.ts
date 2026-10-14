/**
 * Food · platos sugeridos para el menú de casa (O3c; contrato §3.10; docs/food/API.md §2.6).
 *
 * Una persona de fuera con nivel de casa «outsider» propone desde Guests un plato para un día y un servicio
 * (`plato_casa`). Aquí, quien cocina (editor u owner) lo aprueba o lo descarta con la cola del kit. Al aprobar, el
 * servidor usa la receta del mismo nombre o crea una rápida «por completar», y pone el plato en ese día.
 *
 * Las sugerencias necesitan red: sin conexión, o sin permiso, la entrada de Menús no aparece.
 */
import { HOUSE_DISH_SUGGESTION_KIND, type Recipe, type ServiceType } from '@ikisai/domain-food';
import type { SyncClient } from '@ikisai/sync-client';
import { createProposalList, createSuggestionSource, el, proposalFromSuggestion, replace, type ProposalItem, type ProposalSource } from '@ikisai/ui-kit';
import { T, type Mirror } from '../app/client.ts';
import { longDay } from '../app/events.ts';
import { HOUSE_MENU_HASH } from '../app/house.ts';
import { SERVICE_LABELS } from './events.ts';
import type { ViewMount } from './shell.ts';

export const HOUSE_SUGGESTIONS_HASH = '#/menus/sugerencias';
/** Marca de la cola; el kit pone las etiquetas de sus partes (`PROPOSAL_LIST_MARKS`). */
const QUEUE_MARK = 'food.menus.sugeridos.cola';

interface DishArgs { name: string; date: string; service: ServiceType }

const canReview = (client: SyncClient) => ['editor', 'owner'].includes(client.bootstrap()?.membership.role ?? '');

/** Lo que pide la sugerencia: los argumentos de su única llamada. */
function dishArgs(operations: unknown): DishArgs | null {
  const call = Array.isArray(operations) ? (operations[0] as { procedure?: string; args?: Partial<DishArgs> } | undefined) : undefined;
  const a = call?.procedure === 'food.house_dish_from_suggestion' ? call.args : undefined;
  return a && typeof a.name === 'string' && typeof a.date === 'string' && typeof a.service === 'string' ? (a as DishArgs) : null;
}

/** Cuántas hay pendientes, o `null` si no hay ninguna sugerencia (ni decidida), no hay red o no puede decidir. */
export async function houseSuggestionsSummary(client: SyncClient): Promise<{ pending: number } | null> {
  if (!canReview(client) || (typeof navigator !== 'undefined' && !navigator.onLine)) return null;
  try {
    const res = await client.suggestions({ scope: 'all', limit: 1 });
    return res.items.length ? { pending: res.pendingCount ?? 0 } : null;
  } catch {
    return null;
  }
}

export const pendingDishesText = (n: number) => (n === 0 ? 'Ninguno pendiente' : n === 1 ? '1 pendiente de revisar' : `${n} pendientes de revisar`);

/** Cola de platos sugeridos: pendientes, aprobados y descartados. */
export const mountHouseSuggestions: ViewMount = ({ main, client, navigate }) => {
  const decide = createSuggestionSource(client, { scope: 'all' });
  const args = new Map<string, DishArgs | null>();
  let recipes: Array<Mirror<Recipe>> = [];
  let pending: number | null = null;
  // La misma lista que da el kit, guardando además lo que pide cada sugerencia para enseñarlo.
  const source: ProposalSource = {
    async list() {
      const [res, rows] = await Promise.all([client.suggestions({ scope: 'all' }), client.list(T.recipes) as Promise<Array<Mirror<Recipe>>>]);
      recipes = rows.filter((r) => !r.deleted_at && r.status !== 'archivada');
      pending = res.pendingCount;
      for (const s of res.items) args.set(s.id, dishArgs(s.operations));
      return res.items.map(proposalFromSuggestion);
    },
    pendingCount: () => pending,
  };

  function detail(item: ProposalItem): HTMLElement {
    const a = args.get(item.id);
    if (!a) return el('p', { class: 'hint' }, 'Esta sugerencia no trae un plato que se pueda leer.');
    const known = recipes.find((r) => r.name.trim().toLowerCase() === a.name.trim().toLowerCase());
    return el('dl', { class: 'kv suggestiondish' },
      el('dt', null, 'Plato'), el('dd', null, a.name),
      el('dt', null, 'Cuándo'), el('dd', null, `${SERVICE_LABELS[a.service] ?? a.service} del ${longDay(a.date)}`),
      el('dt', null, 'Receta'), el('dd', null, item.status === 'pending'
        ? (known ? 'Ya está en el Recetario: se usará esa.' : 'Nueva: se creará como plato rápido. Luego complétalo (alérgenos e ingredientes).')
        : (known ? known.name : '—')));
  }

  const list = createProposalList({
    mode: 'review', label: 'Platos sugeridos', feedbackId: QUEUE_MARK, source,
    kinds: { [HOUSE_DISH_SUGGESTION_KIND]: { label: 'Plato para casa' } }, apps: { food: 'Food' },
    canDecide: canReview(client),
    emptyText: 'No hay platos sugeridos.',
    // Lo aplica el servidor: se trae en seguida para que el plato ya esté en el menú de casa al abrirlo.
    onApprove: async (item, comment) => { await decide.approve(item, comment); void client.sync().catch(() => undefined); },
    onReject: decide.reject,
    renderDetail: detail,
    link: (item) => (item.status === 'approved' ? { label: 'Ver en el menú de casa', href: HOUSE_MENU_HASH } : null),
  });
  replace(main,
    el('div', { class: 'pagehead' }, el('div', null,
      el('p', { class: 'crumb' }, el('a', { 'data-feedback-id': 'food.menus.sugeridos.volver', 'data-feedback-label': 'Volver a Menús', href: '#/menus', onclick: (ev: Event) => { ev.preventDefault(); navigate('#/menus'); } }, '← Menús')),
      el('h2', null, 'Platos sugeridos'),
      el('p', null, 'Lo que proponen para el menú de casa las personas de fuera. Al aprobarlo, el plato entra en ese día.'))),
    list.element);
  void list.refresh();
  return () => list.destroy();
};
