/**
 * Mis retiros (API.md §9.2; pasada única, zona 1): lista de tarjetas con portada, recorrido y «Te toca»; los pasados y
 * los cancelados, plegados aparte. Con un solo retiro activo, se abre su ficha la primera vez.
 */
import { el, renderMedal, renderStages, replace } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import type { PortalReservation } from '../app/api.ts';
import { install } from '../app/install.ts';
import { dateRange, isCancelled, statusLabel, STATUS_TONE } from '../app/labels.ts';
import { countdownText, groupRetreats, phaseOf, showsCountdown, STAGES, stageKeyOf, toDoOf, todayMadrid } from '../app/journey.ts';
import { createCoverLoader } from '../app/covers.ts';
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
    el('span', { class: 'chips' }, el('span', { class: `chip status ${STATUS_TONE[r.status]}`, id: ids.status }, statusLabel(r.status)))),
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
    top.prepend(renderMedal({ image: url, cover: true }));
    top.classList.add('orgretreat-photo');
  } else if (!top.querySelector('.medal-disc')) {
    top.classList.remove('orgretreat-photo');
    top.prepend(renderMedal({ name: title, size: 44 }));
  }
}

export const mountRetreats = (options: { autoOpen: boolean }): ViewMount => ({ api, main, navigate, client, userId }) => {
  let alive = true;
  const host = el('div', { id: 'retreats' });
  const cards = new Map<string, { node: HTMLElement; title: string }>();
  const covers = createCoverLoader({ client, userId }, (id, url) => {
    const card = cards.get(id);
    if (card) setCover(card.node, card.title, url);
  });
  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, t('Mis retiros')), el('p', { class: 'muted' }, t('Los retiros que organizas en Ikisai.')))),
    host);

  const cardsFor = (items: PortalReservation[], today: string, eager: boolean) => items.map((r) => {
    const node = retreatCard(r, today);
    cards.set(r.id, { node, title: r.title });
    if (eager) covers.request(r.id);
    return node;
  });

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
    return box;
  }

  async function load(): Promise<void> {
    replace(host, loading());
    try {
      const out = await api.reservations();
      if (!alive) return;
      const items = out.value.items;
      // La regla de siempre: un solo retiro no cancelado (aunque ya haya pasado) abre su ficha.
      const active = items.filter((r) => !isCancelled(r.status));
      if (options.autoOpen && active.length === 1) {
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
      replace(host,
        out.stale ? staleNote(out.at, () => void load()) : null,
        install.shouldPromote() ? install.card() : null,
        el('div', { class: 'orgcards', 'data-feedback-id': 'organizers.retiros.lista', 'data-feedback-label': 'Lista de retiros' },
          ...(groups.main.length ? cardsFor(groups.main, today, true) : [el('p', { class: 'muted' }, t('No tienes retiros en marcha.'))])),
        fold('past', groups.past, today),
        fold('cancelled', groups.cancelled, today));
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }
  void load();
  return () => { alive = false; covers.destroy(); };
};
