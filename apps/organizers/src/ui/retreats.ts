/**
 * Mis retiros (API.md §9.2; pasada única, zona 1): lista de tarjetas con portada, recorrido y «Te toca»; los pasados y
 * los cancelados, plegados aparte. Con un solo retiro activo, se abre su ficha la primera vez.
 *
 * El acceso no caduca (decisión de VG del 26-10-2026): los pasados y los cancelados se quedan. Con el ámbito «todos»
 * (dirección como coorganizadora, Booking B20) salen todos los retiros de Ikisai: los que no son suyos llevan
 * «Coorganizas», hay buscador y sus portadas se piden al dejar de filtrar o al abrir su grupo, no todas de golpe.
 */
import { el, fieldAttrs, renderMedal, renderStages, replace } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import type { PortalReservation } from '../app/api.ts';
import { install } from '../app/install.ts';
import { dateRange, isCancelled, statusLabel, STATUS_TONE } from '../app/labels.ts';
import { countdownText, groupRetreats, isCoorganizer, matchesRetreat, phaseOf, showsCountdown, STAGES, stageKeyOf, toDoOf, todayMadrid } from '../app/journey.ts';
import { createCoverLoader } from '../app/covers.ts';
import { loadGuestFeedback } from '../app/retreat-comments.ts';
import { allReadIds, unreadByReservation } from '../app/comment-reads.ts';
import { loadReplies, unreadRepliesByReservation } from '../app/replies.ts';
import { proposalReservation } from '../../../../supabase/functions/_domain/organizers/mod.ts';
import { failure, loading, staleNote } from './common.ts';
import type { ViewMount } from './shell.ts';

export function progressText(r: Pick<PortalReservation, 'confirmed' | 'mode' | 'guests' | 'complete' | 'expected_guests'>): string | null {
  if (!r.confirmed || r.mode === 'ninguno') return null;
  const total = Math.max(r.guests, r.expected_guests ?? 0);
  return t('{hechos} de {total} asistentes con los datos completos', { hechos: r.complete, total });
}

/** Etapas traducidas para `renderStages`. */
export const stagesText = () => STAGES.map((s) => ({ key: s.key, label: t(s.label) }));

function retreatCard(r: PortalReservation, today: string): HTMLElement {
  const phase = phaseOf(r, today);
  const progress = progressText(r);
  const when = showsCountdown(phase) && r.start_date ? `${dateRange(r.start_date, r.end_date)} · ${countdownText(r.start_date, r.end_date, today, t)}` : dateRange(r.start_date, r.end_date);
  const ids = { title: `rt-${r.id}-t`, when: `rt-${r.id}-w`, status: `rt-${r.id}-s`, caption: `rt-${r.id}-c`, progress: `rt-${r.id}-p` };
  const stages = renderStages({
    label: t('Recorrido de {titulo}', { titulo: r.title }), stages: stagesText(), current: stageKeyOf(r, today), mini: true,
    caption: toDoOf(r, today, t), stopText: t('Cancelado: ya no sigue adelante.'),
  });
  const caption = stages.querySelector<HTMLElement>('.stage-caption, .stage-stop');
  if (caption) caption.id = ids.caption;
  const described = [caption ? ids.caption : null, progress ? ids.progress : null].filter(Boolean).join(' ');
  return el('a', {
    class: `card cardlink orgretreat${isCancelled(r.status) ? ' orgretreat-off' : ''}`, href: `#/retiro/${r.id}`, dataset: { id: r.id },
    'aria-labelledby': `${ids.title} ${ids.when} ${ids.status}`, 'aria-describedby': described || null,
    'data-feedback-id': 'organizers.retiros.lista.abrir', 'data-feedback-label': 'Abrir retiro',
  },
  el('div', { class: 'orgretreat-top' },
    renderMedal({ name: r.title, size: 44 }),
    el('strong', { class: 'orgretreat-title', id: ids.title }, r.title),
    el('span', { class: 'orgretreat-when', id: ids.when }, when),
    el('span', { class: 'chips' }, el('span', { class: `chip status ${STATUS_TONE[r.status]}`, id: ids.status }, statusLabel(r.status)),
      isCoorganizer(r) ? el('span', { class: 'chip orgcoorg' }, t('Coorganizas')) : null)),
  stages,
  progress ? el('span', { class: 'muted small', id: ids.progress }, progress) : null);
}

/** Pone la foto en la tarjeta ya pintada (mismo nodo: no se repinta la lista) o vuelve a las iniciales. */
function setCover(card: HTMLElement, title: string, url: string | null): void {
  const top = card.querySelector<HTMLElement>('.orgretreat-top');
  if (!top) return;
  top.querySelector('.medal-cover')?.remove();
  if (url) {
    top.querySelector('.medal-disc')?.remove();
    top.prepend(renderMedal({ image: url, cover: true, veil: 'full' }));
    top.classList.add('orgretreat-photo');
  } else if (!top.querySelector('.medal-disc')) {
    top.classList.remove('orgretreat-photo');
    top.prepend(renderMedal({ name: title, size: 44 }));
  }
}

export const mountRetreats = (options: { autoOpen: boolean }): ViewMount => ({ api, main, navigate, client, userId }) => {
  let alive = true;
  const host = el('div', { id: 'retreats' });
  const cards = new Map<string, { node: HTMLElement; title: string; r: PortalReservation }>();
  const folds: HTMLDetailsElement[] = [];
  const covers = createCoverLoader({ client, userId }, (id, url) => {
    const card = cards.get(id);
    if (card) setCover(card.node, card.title, url);
  });
  const subtitle = el('p', { class: 'muted' }, t('Los retiros que organizas en Ikisai.'));
  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, t('Mis retiros')), subtitle)),
    host);

  // Con «todos», los de otros no piden su portada hasta que se buscan o se abre su grupo.
  const cardsFor = (items: PortalReservation[], today: string, eager: boolean) => items.map((r) => {
    const node = retreatCard(r, today);
    cards.set(r.id, { node, title: r.title, r });
    if (eager && !isCoorganizer(r)) covers.request(r.id);
    return node;
  });

  /** Buscador (solo con «todos»): esconde lo que no coincide, abre los grupos con coincidencias y dice cuántos hay. */
  function searchBox(): HTMLElement {
    const result = el('p', { class: 'hint', id: 'retreatSearchResult', 'aria-live': 'polite' });
    const input = el('input', { ...fieldAttrs({ id: 'organizers.retiros.buscador.campo', label: 'Buscar retiros', type: 'search', sensitivity: 'internal', confirm: 'none' }),
      type: 'search', id: 'retreatSearch', placeholder: t('Buscar por nombre o código'), 'aria-label': t('Buscar retiros'), autocomplete: 'off',
      'aria-describedby': 'retreatSearchResult', 'data-feedback-id': 'organizers.retiros.buscador.campo', 'data-feedback-label': 'Buscar retiros',
    }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const query = input.value;
      let shown = 0;
      for (const card of cards.values()) {
        const hit = matchesRetreat(card.r, query);
        card.node.hidden = !hit;
        if (hit) {
          shown++;
          if (query.trim() && shown <= 12) covers.request(card.r.id);
        }
      }
      if (query.trim()) for (const box of folds) if (box.querySelector('.orgretreat:not([hidden])')) box.open = true;
      result.textContent = !query.trim() ? '' : shown === 0 ? t('Ningún retiro con «{texto}».', { texto: query.trim() })
        : shown === 1 ? t('1 retiro') : t('{n} retiros', { n: shown });
    });
    return el('div', { class: 'orgsearch', 'data-feedback-id': 'organizers.retiros.buscador', 'data-feedback-label': 'Buscador de retiros' }, input, result);
  }

  /** Grupo plegado; sus portadas se piden al abrirlo. */
  function fold(kind: 'past' | 'cancelled', items: PortalReservation[], today: string): HTMLElement | null {
    if (!items.length) return null;
    const box = kind === 'past'
      ? el('details', { class: 'orgfold', 'data-feedback-id': 'organizers.retiros.pasados', 'data-feedback-label': 'Pasados' },
        el('summary', null, t('Pasados · {n}', { n: items.length })))
      : el('details', { class: 'orgfold', 'data-feedback-id': 'organizers.retiros.cancelados', 'data-feedback-label': 'Cancelados' },
        el('summary', null, t('Cancelados · {n}', { n: items.length })));
    box.append(el('div', { class: 'orgcards' }, ...cardsFor(items, today, false)));
    box.addEventListener('toggle', () => { if ((box as HTMLDetailsElement).open) items.forEach((r) => covers.request(r.id)); });
    folds.push(box as HTMLDetailsElement);
    return box;
  }

  /**
   * Propuestas del equipo de Ikisai pendientes (0703): quien organiza las ve en la tarjeta de su retiro, después de pintar
   * la lista para no retrasarla. Necesita red; sin ella (o si la lectura falla), sin marca.
   */
  async function markProposals(): Promise<void> {
    const pending = await client.suggestions({ scope: 'pending' }).then((out) => out.items).catch(() => []);
    if (!alive) return;
    const counts = new Map<string, number>();
    for (const s of pending) {
      const id = proposalReservation(s);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
      const chips = cards.get(id)?.node.querySelector('.chips');
      chips?.querySelector('.orgteam')?.remove();
      chips?.append(el('span', { class: 'chip warn orgteam' }, n === 1 ? t('1 propuesta del equipo') : t('{n} propuestas del equipo', { n })));
    }
  }

  /**
   * Comentarios de asistentes sin ver (0706, COMENTARIOS_LEIDOS.md): el número en la tarjeta de su retiro, como las
   * propuestas. Cada persona, lo suyo. Necesita red para los comentarios; sin ella, sin marca.
   */
  async function markComments(): Promise<void> {
    const [items, read] = await Promise.all([loadGuestFeedback(client), allReadIds(client, userId)]).catch(() => [[], new Set<string>()] as const);
    if (!alive) return;
    const counts = unreadByReservation(items, read);
    for (const [id, card] of cards) {
      const n = counts.get(id.toLowerCase()) ?? 0;
      const chips = card.node.querySelector('.chips');
      chips?.querySelector('.orgunread')?.remove();
      if (n) chips?.append(el('span', { class: 'chip warn orgunread' }, n === 1 ? t('1 comentario nuevo') : t('{n} comentarios nuevos', { n })));
    }
  }

  /** Respuestas de la casa sin ver (0117, RESPUESTAS_CASA.md): «N respuestas» en la tarjeta. Se leen en «Ayuda y sugerencias». */
  async function markReplies(): Promise<void> {
    const counts = unreadRepliesByReservation(await loadReplies(client).catch(() => []));
    if (!alive) return;
    for (const [id, card] of cards) {
      const n = counts.get(id.toLowerCase()) ?? 0;
      const chips = card.node.querySelector('.chips');
      chips?.querySelector('.orgreplies')?.remove();
      if (n) chips?.append(el('span', { class: 'chip warn orgreplies' }, n === 1 ? t('1 respuesta de Ikisai') : t('{n} respuestas de Ikisai', { n })));
    }
  }

  async function load(): Promise<void> {
    replace(host, loading());
    try {
      const out = await api.reservations();
      if (!alive) return;
      const items = out.value.items;
      // La regla de siempre: un solo retiro no cancelado (aunque ya haya pasado) abre su ficha. Con «todos», nunca.
      const active = items.filter((r) => !isCancelled(r.status));
      const coorganizes = items.some(isCoorganizer);
      if (options.autoOpen && active.length === 1 && !coorganizes) {
        navigate(`#/retiro/${active[0]!.id}`, true);
        return;
      }
      if (!items.length) {
        replace(host, el('div', { class: 'empty' }, el('strong', null, t('Aún no tienes retiros')), el('p', null, t('Cuando Ikisai te dé acceso a una reserva, aparecerá aquí.'))));
        return;
      }
      const today = todayMadrid();
      const groups = groupRetreats(items, today);
      cards.clear();
      folds.length = 0;
      subtitle.textContent = coorganizes ? t('Los que organizas y, desde dirección, todos los de Ikisai.') : t('Los retiros que organizas en Ikisai.');
      replace(host,
        out.stale ? staleNote(out.at, () => void load()) : null,
        install.shouldPromote() ? install.card() : null,
        coorganizes ? searchBox() : null,
        el('div', { class: 'orgcards', 'data-feedback-id': 'organizers.retiros.lista', 'data-feedback-label': 'Lista de retiros' },
          ...(groups.main.length ? cardsFor(groups.main, today, true) : [el('p', { class: 'muted' }, t('No tienes retiros en marcha.'))])),
        fold('past', groups.past, today),
        fold('cancelled', groups.cancelled, today));
      void markProposals();
      void markComments();
      void markReplies();
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }
  void load();
  return () => { alive = false; covers.destroy(); };
};
