/** Mis retiros (API.md §9.2): tarjetas por fecha; con un solo retiro activo, se abre su ficha la primera vez. */
import { el, replace } from '@ikisai/ui-kit';
import type { PortalReservation } from '../app/api.ts';
import { dateRange, isCancelled, STATUS_LABELS, STATUS_TONE } from '../app/labels.ts';
import { failure, loading, staleNote } from './common.ts';
import type { ViewMount } from './shell.ts';

export function progressText(r: Pick<PortalReservation, 'confirmed' | 'mode' | 'guests' | 'complete' | 'expected_guests'>): string | null {
  if (!r.confirmed || r.mode === 'ninguno') return null;
  const total = Math.max(r.guests, r.expected_guests ?? 0);
  return `${r.complete} de ${total} asistentes con los datos completos`;
}

export const mountRetreats = (options: { autoOpen: boolean }): ViewMount => ({ api, main, navigate }) => {
  let alive = true;
  const host = el('div', { id: 'retreats' });
  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Mis retiros'), el('p', { class: 'muted' }, 'Los retiros que organizas en Ikisai.'))),
    host);

  async function load(): Promise<void> {
    replace(host, loading());
    try {
      const out = await api.reservations();
      if (!alive) return;
      const items = [...out.value.items].sort((a, b) => Number(isCancelled(a.status)) - Number(isCancelled(b.status)) || (a.start_date ?? '9999').localeCompare(b.start_date ?? '9999'));
      const active = items.filter((r) => !isCancelled(r.status));
      if (options.autoOpen && active.length === 1) {
        navigate(`#/retiro/${active[0]!.id}`, true);
        return;
      }
      if (!items.length) {
        replace(host, el('div', { class: 'empty' }, el('strong', null, 'Aún no tienes retiros'), el('p', null, 'Cuando Ikisai te dé acceso a una reserva, aparecerá aquí.')));
        return;
      }
      replace(host,
        out.stale ? staleNote(out.at) : null,
        el('div', { class: 'orgcards', 'data-feedback-id': 'organizers.retiros.lista', 'data-feedback-label': 'Lista de retiros' },
          ...items.map((r) => {
            const progress = progressText(r);
            return el('a', {
              class: `card cardlink orgretreat${isCancelled(r.status) ? ' muted' : ''}`, href: `#/retiro/${r.id}`,
              'data-feedback-id': 'organizers.retiros.lista.abrir', 'data-feedback-label': 'Abrir retiro',
            },
            el('strong', { class: 'orgretreat-title' }, r.title),
            el('span', null, dateRange(r.start_date, r.end_date)),
            el('span', { class: 'chips' }, el('span', { class: `chip status ${STATUS_TONE[r.status]}` }, STATUS_LABELS[r.status] ?? r.status)),
            progress ? el('span', { class: 'muted small' }, progress) : null);
          })));
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }
  void load();
  return () => { alive = false; };
};
