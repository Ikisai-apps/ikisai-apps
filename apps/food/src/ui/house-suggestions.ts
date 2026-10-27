/**
 * Food · platos sugeridos para el menú de casa (O3c; contrato §3.10 y §3.11; docs/food/API.md §2.6 y §2.9).
 *
 * Una persona de fuera con nivel de casa «outsider» propone desde Guests un plato para un día y un servicio
 * (`plato_casa`). Tanda 27 (MUELA-033 con la interacción de 068 §3, «Votar deslizando, decide quien administra»):
 * - **El mazo:** votan todas las personas de la cocina, también quien solo lee (`scope=vote`, sin ver quién propone).
 *   Se desliza a la derecha (aprobar) o a la izquierda (descartar), con botones de 46 px o con ← y →. Los votos orientan.
 * - **La ficha «Para decidir (n)»:** el día, el menú de casa ese día y «Ya pasó»; el recuento y «Tu voto»; y, para editor
 *   u owner, Aprobar / Descartar con comentario, «Usar receta parecida» y un **«Deshacer» de verdad**: el envío espera 5 s
 *   (si se cierra la app antes, no se envía y la sugerencia sigue pendiente).
 * - **«Ver todas en lista»:** Pendientes · Aprobadas · Descartadas (la cola del kit, solo para ver), con el comentario de
 *   quien decidió y «Ver en el menú de casa».
 *
 * Las sugerencias necesitan red: sin conexión, la pantalla lo dice y la entrada de Menús no aparece.
 */
import {
  HOUSE_DISH_SUGGESTION_KIND, HOUSE_MENU_ID, houseDishWithRecipe, voteRequest, voteTally,
  type MenuItem, type MenuService, type Recipe, type ServiceType, type SuggestionVote,
} from '@ikisai/domain-food';
import type { RowOperation, Suggestion, SyncClient } from '@ikisai/sync-client';
import {
  createProposalList, createVoteDeck, el, proposalFromSuggestion, renderMedal, replace, toast, toastWithAction,
  type ProposalSource, type VoteDeck,
} from '@ikisai/ui-kit';
import { T, describeError, type Mirror } from '../app/client.ts';
import { longDay, todayKey } from '../app/events.ts';
import { HOUSE_MENU_HASH } from '../app/house.ts';
import { usage } from '../app/usage.ts';
import { SERVICE_LABELS } from './events.ts';
import type { ViewMount } from './shell.ts';

export const HOUSE_SUGGESTIONS_HASH = '#/menus/sugerencias';
/** Marca de la cola de «Ver todas»; el kit pone las etiquetas de sus partes (`PROPOSAL_LIST_MARKS`). */
const QUEUE_MARK = 'food.menus.sugeridos.cola';
/** Lo que espera el envío de una decisión, para que «Deshacer» la anule de verdad. */
export const UNDO_MS = 5000;

interface DishArgs { name: string; date: string; service: ServiceType }
/** La sugerencia como la da el núcleo; con `scope=vote`, sin autor para quien no es editor ni owner (§3.11). */
type VoteSuggestion = Omit<Suggestion, 'author'> & { author: { id: string; name: string } | null; anonymous?: boolean };

const role = (client: SyncClient) => client.bootstrap()?.membership.role ?? '';
const canReview = (client: SyncClient) => ['editor', 'owner'].includes(role(client));
const canVote = (client: SyncClient) => ['editor', 'owner', 'reader'].includes(role(client));

/** Lo que pide la sugerencia: los argumentos de su única llamada. */
function dishArgs(operations: unknown): DishArgs | null {
  const call = Array.isArray(operations) ? (operations[0] as { procedure?: string; args?: Partial<DishArgs> } | undefined) : undefined;
  const a = call?.procedure === 'food.house_dish_from_suggestion' ? call.args : undefined;
  return a && typeof a.name === 'string' && typeof a.date === 'string' && typeof a.service === 'string' ? (a as DishArgs) : null;
}

/** Las pendientes que puede ver esta persona: todas para editor u owner; para votar (sin autor), el resto. */
async function pendingSuggestions(client: SyncClient, limit?: number): Promise<{ items: VoteSuggestion[]; pendingCount: number | null }> {
  const query = new URLSearchParams({ scope: 'vote' });
  if (limit) query.set('limit', String(limit));
  return client.api(`/suggestions?${query}`);
}

/** Cuántas hay pendientes, o `null` si no hay ninguna sugerencia, no hay red o no puede votar ni decidir. */
export async function houseSuggestionsSummary(client: SyncClient): Promise<{ pending: number } | null> {
  if (!canVote(client) || (typeof navigator !== 'undefined' && !navigator.onLine)) return null;
  try {
    if (canReview(client)) {
      const res = await client.suggestions({ scope: 'all', limit: 1 });
      return res.items.length ? { pending: res.pendingCount ?? 0 } : null;
    }
    const res = await pendingSuggestions(client, 1);
    const pending = res.pendingCount ?? res.items.length;
    return pending ? { pending } : null;
  } catch {
    return null;
  }
}

export const pendingDishesText = (n: number) => (n === 0 ? 'Ninguno pendiente' : n === 1 ? '1 pendiente de revisar' : `${n} pendientes de revisar`);

const tallyText = (keep: number, drop: number) => `${keep} aprobar · ${drop} descartar`;
const voteWord = (vote: 'keep' | 'drop') => (vote === 'keep' ? 'Aprobar' : 'Descartar');

export const mountHouseSuggestions: ViewMount = ({ main, client, navigate }) => {
  const reviewer = canReview(client);
  const me = client.bootstrap()?.profile.userId ?? null;
  let pending: VoteSuggestion[] = [];
  let votes: Array<Mirror<SuggestionVote>> = [];
  /** Mis votos recién enviados, hasta que llegan al espejo. */
  const myVotes = new Map<string, 'keep' | 'drop' | null>();
  let recipes: Array<Mirror<Recipe>> = [];
  let houseServices: Array<Mirror<MenuService>> = [];
  let houseItems: Array<Mirror<MenuItem>> = [];
  let selected: string | null = null;
  let showAll = false;
  /** «Elegir varias» (hallazgo F-SUG-5): las marcadas para decidir de una vez; `null` = decidir de una en una. */
  let batch: Set<string> | null = null;
  let loaded = false;
  let error: string | null = null;
  /** Decisiones que esperan sus 5 s: se pueden deshacer; al salir de la pantalla se envían. */
  const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; send: () => Promise<void> }>();
  const comments = new Map<string, string>();
  const similar = new Map<string, string>();
  let deck: VoteDeck<VoteSuggestion> | null = null;
  let deckIds = '';
  let allList: ReturnType<typeof createProposalList> | null = null;

  const head = el('div', { class: 'pagehead' }, el('div', null,
    el('p', { class: 'crumb' }, el('a', { 'data-feedback-id': 'food.menus.sugeridos.volver', 'data-feedback-label': 'Volver a Menús', href: '#/menus', onclick: (ev: Event) => { ev.preventDefault(); navigate('#/menus'); } }, '← Menús')),
    el('h2', null, 'Platos sugeridos'),
    el('p', null, reviewer
      ? 'Lo que proponen para el menú de casa las personas de fuera. Vota y decide: al aprobarlo, el plato entra en ese día.'
      : 'Lo que proponen para el menú de casa las personas de fuera. Tu voto orienta; decide quien administra la cocina.')));
  const deckHost = el('div', { 'data-feedback-id': 'food.menus.sugeridos.votar', 'data-feedback-label': 'Votar', class: 'fd-deck', id: 'suggestionDeck' });
  const sheetHost = el('section', { 'data-feedback-id': 'food.menus.sugeridos.ficha', 'data-feedback-label': 'Para decidir', class: 'card fd-decide', id: 'suggestionDecide' });
  const body = el('div', { class: 'fd-suggest' }, deckHost, sheetHost);
  replace(main, head, body);

  const visible = () => pending.filter((s) => !waiting.has(s.id));
  const argsOf = (s: VoteSuggestion) => dishArgs(s.operations);
  const nameOf = (s: VoteSuggestion) => argsOf(s)?.name ?? s.summary;
  const myVote = (id: string) => (myVotes.has(id) ? myVotes.get(id)! : voteTally(votes, id, me).mine?.vote ?? null);
  const tally = (id: string) => {
    const t = voteTally(votes, id, me);
    // Mi voto recién enviado cuenta ya, aunque el espejo aún no lo tenga.
    if (myVotes.has(id)) {
      const before = t.mine?.vote ?? null;
      const now = myVotes.get(id)!;
      if (before) t[before] -= 1;
      if (now) t[now] += 1;
    }
    return t;
  };
  const known = (a: DishArgs) => recipes.find((r) => r.name.trim().toLowerCase() === a.name.trim().toLowerCase());

  function cardOf(s: VoteSuggestion): HTMLElement {
    const a = argsOf(s);
    const t = tally(s.id);
    return el('div', { class: 'fd-vcard' },
      el('div', { class: 'fd-vcard-band' }, renderMedal({ name: nameOf(s), size: 44 }), el('span', null, 'Plato para casa')),
      el('strong', { class: 'fd-vcard-name', 'data-feedback-ignore': '' }, nameOf(s)),
      a ? el('p', null, `${SERVICE_LABELS[a.service] ?? a.service} del ${longDay(a.date)}${a.date < todayKey() ? ' · Ya pasó' : ''}`) : el('p', { class: 'hint' }, 'Esta sugerencia no trae un plato que se pueda leer.'),
      a ? el('p', { class: 'muted' }, known(a) ? 'Ya está en el Recetario' : 'Receta nueva: plato rápido por completar') : null,
      el('p', { class: 'muted', 'data-feedback-ignore': '' }, `Propone: ${s.author?.name ?? 'Una persona invitada'}`),
      el('p', { class: 'fd-tally' }, tallyText(t.keep, t.drop)));
  }

  async function sendVote(s: VoteSuggestion, vote: 'keep' | 'drop' | null): Promise<void> {
    const before = myVotes.has(s.id) ? myVotes.get(s.id)! : voteTally(votes, s.id, me).mine?.vote ?? null;
    myVotes.set(s.id, vote);
    paintSheet();
    try {
      await usage.run('food.menus.sugeridos.votar', () => client.api('/suggestion-votes', { json: voteRequest(s.id, vote, crypto.randomUUID()) }));
      void client.sync().catch(() => undefined);
    } catch (failure) {
      myVotes.set(s.id, before);
      toast(describeError(failure));
      paintSheet();
    }
  }

  /**
   * Aparta la sugerencia y deja su envío esperando 5 s. `quiet`: sin el aviso de «Completar la receta» (en un lote saldrían
   * varios a la vez). Devuelve cómo anularla mientras no se haya enviado.
   */
  function schedule(s: VoteSuggestion, decision: 'approve' | 'reject', quiet = false): { undo: () => boolean } {
    const comment = comments.get(s.id)?.trim() || undefined;
    const recipeId = similar.get(s.id);
    const operations = decision === 'approve' && recipeId ? houseDishWithRecipe(s.operations, recipeId) as RowOperation[] | null : null;
    const dish = argsOf(s);
    // Aprobada como plato rápido nuevo: se ofrece completarlo al momento (hallazgo F-SUG-2).
    const quick = decision === 'approve' && !recipeId && !!dish && !known(dish);
    let sent = false;
    const send = async () => {
      if (sent) return;
      sent = true;
      waiting.delete(s.id);
      try {
        await usage.run(decision === 'approve' ? 'food.menus.sugeridos.aprobar' : 'food.menus.sugeridos.descartar',
          () => client.decideSuggestion(s.id, decision, { ...(comment ? { comment } : {}), ...(operations ? { operations } : {}) }));
        // Lo aplica el servidor: se trae en seguida para que el plato ya esté en el menú de casa al abrirlo.
        if (decision === 'approve') await client.sync().catch(() => undefined);
      } catch (failure) {
        toast(describeError(failure));
        await load();
        return;
      }
      await load();
      const created = quick && !quiet ? known(dish!) : undefined;
      if (created) toastWithAction(`«${created.name}» está en el menú de casa como plato rápido: faltan sus alérgenos e ingredientes.`, {
        label: 'Completar la receta', onClick: () => navigate(`#/recetario?receta=${created.id}`),
      }, 10_000);
    };
    const timer = setTimeout(() => void send(), UNDO_MS);
    waiting.set(s.id, { timer, send });
    if (selected === s.id) selected = null;
    return { undo: () => { if (sent) return false; clearTimeout(timer); waiting.delete(s.id); return true; } };
  }

  /** Aprobar o descartar con «Deshacer»: la sugerencia se aparta al momento y el envío espera 5 s. */
  function decideLater(s: VoteSuggestion, decision: 'approve' | 'reject'): void {
    const handle = schedule(s, decision);
    paint();
    toastWithAction(`${decision === 'approve' ? 'Aprobado' : 'Descartado'}: ${nameOf(s)}`, {
      label: 'Deshacer',
      onClick: () => { if (handle.undo()) { selected = s.id; paint(); } },
    }, UNDO_MS);
  }

  /** Varias a la vez (F-SUG-5): cada una con su comentario y su receta parecida, si los tiene; un solo «Deshacer» para todas. */
  function decideMany(list: VoteSuggestion[], decision: 'approve' | 'reject'): void {
    if (!list.length) return;
    const handles = list.map((s) => schedule(s, decision, true));
    batch = null;
    paint();
    const n = list.length;
    toastWithAction(`${decision === 'approve' ? (n === 1 ? 'Aprobada' : 'Aprobadas') : (n === 1 ? 'Descartada' : 'Descartadas')}: ${n === 1 ? nameOf(list[0]!) : `${n} sugerencias`}`, {
      label: 'Deshacer',
      onClick: () => { const back = handles.filter((h) => h.undo()).length; if (back) { selected = list[0]!.id; paint(); } },
    }, UNDO_MS);
  }

  /** La lista para marcar varias: nombre, cuándo y «Ya pasó»; las pasadas solo se pueden descartar. */
  function paintBatch(top: HTMLElement, list: VoteSuggestion[]): void {
    const marked = list.filter((s) => batch!.has(s.id));
    const pastOf = (s: VoteSuggestion) => { const a = argsOf(s); return !a || a.date < todayKey(); };
    const rows = list.map((s) => {
      const a = argsOf(s);
      const box = el('input', { type: 'checkbox', id: `batch-${s.id}`, checked: batch!.has(s.id),
        onchange: () => { if (box.checked) batch!.add(s.id); else batch!.delete(s.id); paintSheet(); } }) as HTMLInputElement;
      return el('li', null, el('label', { class: 'checkline', for: box.id }, box,
        el('span', { 'data-feedback-ignore': '' }, nameOf(s), a ? el('span', { class: 'muted' }, ` · ${SERVICE_LABELS[a.service] ?? a.service} del ${longDay(a.date)}`) : null),
        pastOf(s) ? el('span', { class: 'chip warn fd-past' }, 'Ya pasó') : null));
    });
    const approvable = marked.length > 0 && !marked.some(pastOf);
    replace(sheetHost, top,
      el('ul', { 'data-feedback-id': 'food.menus.sugeridos.lote.lista', 'data-feedback-label': 'Sugerencias para decidir juntas', class: 'plainlist fd-batch', id: 'suggestionBatch' }, ...rows),
      el('div', { class: 'btnrow' },
        el('button', { 'data-feedback-id': 'food.menus.sugeridos.lote.descartar', 'data-feedback-label': 'Descartar las marcadas', class: 'ghost fd-decide-btn', type: 'button', id: 'rejectBatch',
          disabled: !marked.length, onclick: () => decideMany(marked, 'reject') }, `Descartar (${marked.length})`),
        el('button', { 'data-feedback-id': 'food.menus.sugeridos.lote.aprobar', 'data-feedback-label': 'Aprobar las marcadas', class: 'primary fd-decide-btn', type: 'button', id: 'approveBatch',
          disabled: !approvable, onclick: () => decideMany(marked, 'approve') }, `Aprobar (${marked.length})`)),
      marked.some(pastOf) ? el('p', { class: 'hint' }, 'Entre las marcadas hay alguna de un día que ya pasó: esas solo se pueden descartar.') : null);
  }

  function paintDeck(): void {
    const list = visible().filter((s) => myVote(s.id) === null);
    const ids = list.map((s) => s.id).join(',');
    // El mazo se rehace solo si cambian las que quedan por votar (al votar, el propio mazo pasa a la siguiente).
    if (deck && ids === deckIds) return;
    deckIds = ids;
    deck = createVoteDeck<VoteSuggestion>({
      label: `¿Entran en el menú de casa? ${visible().length}`,
      items: list,
      card: cardOf,
      name: nameOf,
      onVote: (s, vote) => { void sendVote(s, vote); deckIds = deckIds.split(',').filter((id) => id !== s.id).join(','); },
      onOpen: (s) => { selected = s.id; paintSheet(); sheetHost.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
      texts: {
        keep: 'Aprobar', drop: 'Descartar',
        keepLabel: 'Aprobar: votar para que entre', dropLabel: 'Descartar: votar para que no entre',
        hint: 'Desliza la tarjeta: a la derecha, aprobar; a la izquierda, descartar. También con los botones o con ← y →.',
        empty: 'Has votado todos los platos', open: 'Ver la ficha',
      },
      feedbackId: 'food.menus.sugeridos.mazo',
    });
    replace(deckHost, deck.element);
  }

  function houseThatDay(day: string): string {
    const names = new Map(recipes.map((r) => [r.id, r.name]));
    const lines = houseServices.filter((s) => s.service_date === day)
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((s) => {
        const dishes = houseItems.filter((i) => i.service_id === s.id);
        // Cuántos comen (hallazgo F-SUG-1): la mayor ración de sus platos, como en el coste por servicio.
        const people = Math.max(0, ...dishes.map((i) => Number(i.servings) || 0));
        return `${SERVICE_LABELS[s.service_type]}: ${dishes.map((i) => names.get(i.recipe_id) ?? '—').join(', ') || 'sin platos'}${people ? ` (comen ${people})` : ''}`;
      });
    return lines.length ? lines.join(' · ') : 'Ese día no hay nada en el menú de casa.';
  }

  function paintSheet(): void {
    if (showAll) return;
    const list = visible();
    const current = list.find((s) => s.id === selected) ?? list[0] ?? null;
    selected = current?.id ?? null;
    const at = current ? list.indexOf(current) : -1;
    const top = el('div', { class: 'fd-decide-head' },
      el('h3', null, `Para decidir (${list.length})`),
      reviewer && (list.length > 1 || batch) ? el('button', { 'data-feedback-id': 'food.menus.sugeridos.lote', 'data-feedback-label': 'Elegir varias', class: 'linkbtn', type: 'button', id: 'suggestionsBatchToggle',
        'aria-pressed': String(!!batch), onclick: () => { batch = batch ? null : new Set(); paintSheet(); } }, batch ? 'Decidir de una en una' : 'Elegir varias') : null,
      reviewer ? el('button', { 'data-feedback-id': 'food.menus.sugeridos.ver_todas', 'data-feedback-label': 'Ver todas en lista', class: 'linkbtn', type: 'button', id: 'suggestionsAll', onclick: () => { showAll = true; paintAll(); } }, 'Ver todas en lista') : null);
    if (batch && list.length) { paintBatch(top, list); return; }
    if (!current) {
      replace(sheetHost, top, el('p', { class: 'muted', id: 'suggestionsEmpty' }, loaded ? 'No hay platos sugeridos pendientes.' : 'Cargando…'));
      return;
    }
    const a = argsOf(current);
    const past = !!a && a.date < todayKey();
    const t = tally(current.id);
    const mine = myVote(current.id);
    const comment = el('textarea', { 'data-feedback-id': 'food.menus.sugeridos.comentario', 'data-feedback-label': 'Comentario', id: 'suggestionComment', rows: '2', maxlength: '500', placeholder: 'Opcional: lo verá quien lo propuso' }) as HTMLTextAreaElement;
    comment.value = comments.get(current.id) ?? '';
    comment.addEventListener('input', () => comments.set(current.id, comment.value));
    const options = recipes.filter((r) => r.status !== 'archivada').sort((x, y) => x.name.localeCompare(y.name, 'es'));
    const pick = el('select', { 'data-feedback-id': 'food.menus.sugeridos.receta_parecida', 'data-feedback-label': 'Usar receta parecida', id: 'similarRecipe' },
      el('option', { value: '' }, a && known(a) ? `La del Recetario: ${known(a)!.name}` : 'Nueva: plato rápido por completar'),
      ...options.map((r) => el('option', { value: r.id, selected: similar.get(current.id) === r.id }, r.name))) as HTMLSelectElement;
    pick.addEventListener('change', () => { if (pick.value) similar.set(current.id, pick.value); else similar.delete(current.id); });
    const voteButton = (vote: 'keep' | 'drop') => el('button', { type: 'button', class: 'ghost fd-myvote', 'aria-pressed': String(mine === vote),
      onclick: () => void sendVote(current, mine === vote ? null : vote) }, voteWord(vote));
    replace(sheetHost, top,
      el('div', { class: 'fd-decide-nav' },
        el('button', { 'data-feedback-id': 'food.menus.sugeridos.anterior', 'data-feedback-label': 'Anterior', class: 'ghost', type: 'button', disabled: at <= 0, onclick: () => { selected = list[at - 1]!.id; paintSheet(); } }, '‹ Anterior'),
        el('span', { class: 'muted' }, `${at + 1} de ${list.length}`),
        el('button', { 'data-feedback-id': 'food.menus.sugeridos.siguiente', 'data-feedback-label': 'Siguiente', class: 'ghost', type: 'button', disabled: at >= list.length - 1, onclick: () => { selected = list[at + 1]!.id; paintSheet(); } }, 'Siguiente ›')),
      el('h4', { class: 'fd-decide-name', 'data-feedback-ignore': '' }, nameOf(current)),
      a ? el('dl', { class: 'kv suggestiondish' },
        el('dt', null, 'Cuándo'), el('dd', null, `${SERVICE_LABELS[a.service] ?? a.service} del ${longDay(a.date)}`, past ? el('span', { class: 'chip warn fd-past' }, 'Ya pasó') : null),
        el('dt', null, 'Ese día en casa'), el('dd', null, houseThatDay(a.date)),
        el('dt', null, 'Receta'), el('dd', null, known(a) ? 'Ya está en el Recetario: se usará esa.' : 'Nueva: se creará como plato rápido. Luego complétalo (alérgenos e ingredientes).'),
        el('dt', null, 'Propone'), el('dd', { 'data-feedback-ignore': '' }, current.author?.name ?? 'Una persona invitada'))
        : el('p', { class: 'hint' }, 'Esta sugerencia no trae un plato que se pueda leer.'),
      el('div', { 'data-feedback-id': 'food.menus.sugeridos.votacion', 'data-feedback-label': 'Votación y decisión', class: 'fd-voting' },
        el('h4', null, 'Votación y decisión'),
        el('p', { class: 'fd-tally', id: 'suggestionTally' }, tallyText(t.keep, t.drop)),
        el('p', null, 'Tu voto: ', el('strong', { id: 'suggestionMyVote' }, mine ? voteWord(mine) : 'sin votar')),
        el('div', { class: 'btnrow' }, voteButton('keep'), voteButton('drop')),
        el('p', { class: 'hint' }, reviewer ? 'Los votos orientan; decides tú, aunque digan otra cosa.' : 'Los votos orientan; decide quien administra la cocina.')),
      reviewer ? el('div', { class: 'fd-decision' },
        el('label', { class: 'field' }, el('span', null, 'Comentario'), comment),
        a && !past ? el('label', { class: 'field' }, el('span', null, 'Usar receta parecida'), pick) : null,
        el('div', { class: 'btnrow' },
          el('button', { 'data-feedback-id': 'food.menus.sugeridos.descartar', 'data-feedback-label': 'Descartar', class: 'ghost fd-decide-btn', type: 'button', id: 'rejectSuggestion', onclick: () => decideLater(current, 'reject') }, 'Descartar'),
          el('button', { 'data-feedback-id': 'food.menus.sugeridos.aprobar', 'data-feedback-label': 'Aprobar', class: 'primary fd-decide-btn', type: 'button', id: 'approveSuggestion', disabled: past || !a,
            onclick: () => decideLater(current, 'approve') }, 'Aprobar')),
        past ? el('p', { class: 'hint' }, 'Ese día ya pasó: no se puede poner en el menú. Descártala con un comentario.') : null) : null);
  }

  /** «Ver todas en lista»: Pendientes · Aprobadas · Descartadas, con el comentario y «Ver en el menú de casa». Solo para ver. */
  function paintAll(): void {
    allList?.destroy();
    const source: ProposalSource = {
      async list() {
        const res = await client.suggestions({ scope: 'all' });
        return res.items.map(proposalFromSuggestion);
      },
      pendingCount: () => visible().length,
    };
    allList = createProposalList({
      mode: 'review', label: 'Platos sugeridos', feedbackId: QUEUE_MARK, source,
      kinds: { [HOUSE_DISH_SUGGESTION_KIND]: { label: 'Plato para casa' } }, apps: { food: 'Food' },
      canDecide: false,
      emptyText: 'No hay platos sugeridos.',
      renderDetail: (item) => {
        const a = dishArgs(pending.find((s) => s.id === item.id)?.operations ?? (item as { operations?: unknown }).operations);
        return a ? el('dl', { class: 'kv suggestiondish' }, el('dt', null, 'Plato'), el('dd', null, a.name), el('dt', null, 'Cuándo'), el('dd', null, `${SERVICE_LABELS[a.service] ?? a.service} del ${longDay(a.date)}`))
          : el('p', { class: 'hint' }, 'Esta sugerencia no trae un plato que se pueda leer.');
      },
      link: (item) => (item.status === 'approved' ? { label: 'Ver en el menú de casa', href: HOUSE_MENU_HASH } : null),
    });
    replace(sheetHost,
      el('div', { class: 'fd-decide-head' }, el('h3', null, 'Todas las sugerencias'),
        el('button', { 'data-feedback-id': 'food.menus.sugeridos.volver_decidir', 'data-feedback-label': 'Volver a decidir', class: 'linkbtn', type: 'button', onclick: () => { showAll = false; allList?.destroy(); allList = null; paintSheet(); } }, 'Volver a decidir')),
      allList.element);
    void allList.refresh();
  }

  function paint(): void {
    if (!navigator.onLine || error) {
      deck = null; deckIds = '';
      replace(body, el('div', { class: 'empty', id: 'suggestionsOffline' }, el('strong', null, 'Las sugerencias necesitan red'),
        error ?? 'Vuelve a abrir esta pantalla cuando haya conexión.',
        el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', onclick: () => { error = null; replace(body, deckHost, sheetHost); void load(); } }, 'Reintentar'))));
      return;
    }
    if (body.firstChild !== deckHost) replace(body, deckHost, sheetHost);
    paintDeck();
    if (!showAll) paintSheet();
  }

  async function load(): Promise<void> {
    try {
      const res = await pendingSuggestions(client);
      pending = res.items.filter((s) => s.status === 'pending' && s.kind === HOUSE_DISH_SUGGESTION_KIND);
      error = null;
    } catch (failure) {
      error = describeError(failure);
    }
    const [voteRows, recipeRows, services, items] = await Promise.all([
      client.list(T.suggestionVotes) as unknown as Promise<Array<Mirror<SuggestionVote>>>,
      client.list(T.recipes) as Promise<Array<Mirror<Recipe>>>,
      client.list(T.menuServices) as Promise<Array<Mirror<MenuService>>>,
      client.list(T.menuItems) as Promise<Array<Mirror<MenuItem>>>,
    ]);
    votes = voteRows;
    // Lo que ya llegó al espejo manda sobre lo recién enviado.
    for (const [id, vote] of myVotes) if ((voteTally(votes, id, me).mine?.vote ?? null) === vote) myVotes.delete(id);
    recipes = recipeRows.filter((r) => !r.deleted_at);
    houseServices = services.filter((s) => s.menu_id === HOUSE_MENU_ID && !s.deleted_at);
    houseItems = items.filter((i) => !i.deleted_at && houseServices.some((s) => s.id === i.service_id));
    loaded = true;
    paint();
  }

  void load();
  const offTables = [T.suggestionVotes, T.menuServices, T.menuItems].map((table) => client.onTable(table, () => void load()));
  const onOnline = () => void load();
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', paint);
  return () => {
    offTables.forEach((off) => off());
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', paint);
    // Al salir de la pantalla, lo decidido se envía ya (el «Deshacer» ya no está a la vista).
    for (const { timer, send } of waiting.values()) { clearTimeout(timer); void send(); }
    allList?.destroy();
  };
};
