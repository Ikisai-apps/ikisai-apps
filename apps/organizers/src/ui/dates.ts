/**
 * Fechas del retiro (fase 2, API.md §13.2; Booking B6–B8). «Ikisai fija y el organizador propone»:
 * - `fixed`: la fecha definitiva, solo para leer;
 * - `ikisai_options`: las fechas que propone Ikisai; el organizador marca las que le vienen bien;
 * - `calendar`: los fines de semana de los próximos doce meses (libre, en opción u ocupado, sin decir quién); marca los
 *   que le vienen bien entre los que no están ocupados.
 * Lo marcado son posibilidades, nunca la fecha definitiva. Se guarda solo (sin botón) y avisa al comercial por la cola.
 */
import { createSaveState, el, replace, toast } from '@ikisai/ui-kit';
import type { DateOption, DatePreference, PortalDates, Weekend } from '../app/api.ts';
import { describeError, errorCode, online } from '../app/client.ts';
import { i18n, t } from '../app/i18n.ts';
import { dateRange, hourLabel } from '../app/labels.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

const MAX_OPTIONS = 20;

/** Etiqueta de disponibilidad: «En opción» avisa sin bloquear; «Ocupado» no se puede marcar. */
function availabilityChip(status: Weekend['status']): HTMLElement | null {
  if (status === 'en_opcion') return el('span', { class: 'chip small warn' }, t('En opción'));
  if (status === 'ocupado') return el('span', { class: 'chip small trash' }, t('Ocupado'));
  return null;
}

const monthKey = (date: string) => date.slice(0, 7);
const monthLabel = (date: string) => {
  const [y, m] = date.split('-').map(Number);
  const text = new Intl.DateTimeFormat(i18n.tag(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, 1)));
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const dayNumber = (date: string) => Number(date.slice(8, 10));

export function renderDates(ctx: ViewContext, reservationId: string, onSaved?: () => void): HTMLElement {
  const host = el('div', { id: 'dates', 'data-feedback-id': 'organizers.fechas', 'data-feedback-label': 'Fechas' }, loading());
  const saves = createSaveState({ savedMs: 4000 });
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: DatePreference[] | null = null;

  async function save(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    if (!online()) { saves.set('fechas', 'pending'); return; }
    const options = pending;
    try {
      await saves.track('fechas', ctx.usage.run('organizers.fechas.guardar', () => ctx.api.setDatePreferences(reservationId, options)), { retry: () => save() });
      if (pending === options) pending = null;
      onSaved?.();
    } catch (error) {
      const code = errorCode(error);
      if (code === 'NETWORK' || code === 'BACKEND_UNAVAILABLE' || code === 'OFFLINE') return; // pendiente: se reintenta al volver la red
      pending = null;
      toast(describeError(error));
      // La fecha ya es definitiva, otra reserva ocupó la fecha o Ikisai cambió sus propuestas: se vuelve a leer.
      if (code === 'DATES_FIXED' || code === 'DATE_UNAVAILABLE' || code === 'DATE_NOT_OFFERED') void load();
    }
  }
  const schedule = (options: DatePreference[]) => { pending = options; if (timer) clearTimeout(timer); timer = setTimeout(() => void save(), 800); };
  const resume = () => { if (pending) void save(); };
  window.addEventListener('online', resume);

  async function load(): Promise<void> {
    replace(host, loading());
    try {
      const dates = await ctx.api.dates(reservationId);
      const weekends = dates.value.mode === 'calendar' ? await ctx.api.availability(reservationId) : null;
      if (!alive) return;
      paint(dates.value, weekends?.value.weekends ?? [], (dates.stale && dates.at) || (weekends?.stale && weekends.at) || null);
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }

  function paint(dates: PortalDates, weekends: Weekend[], staleAt: string | null): void {
    const note = el('p', { class: 'muted small', id: 'datesNote' }, t('Lo que marques son posibilidades: Ikisai confirmará la fecha definitiva.'));
    if (dates.mode === 'fixed' && dates.definitive) {
      const d = dates.definitive;
      const hours = [hourLabel(d.arrival_time) && t('llegada a las {hora}', { hora: hourLabel(d.arrival_time) }), hourLabel(d.departure_time) && t('salida a las {hora}', { hora: hourLabel(d.departure_time) })].filter(Boolean).join(' · ');
      replace(host, staleAt ? staleNote(staleAt) : null,
        section(t('Fecha definitiva'), { id: 'datesFixed' },
          el('p', null, el('strong', null, dateRange(d.start, d.end))),
          hours ? el('p', { class: 'muted' }, hours) : null,
          el('p', { class: 'muted small' }, t('Ikisai ya ha fijado la fecha de tu retiro. Si necesitas cambiarla, escríbenos desde «Ayuda y sugerencias».'))));
      return;
    }

    if (dates.mode === 'ikisai_options') {
      const ok = new Map(dates.options.map((o) => [o.id, o.organizer_ok]));
      const rows = dates.options.map((o: DateOption) => {
        const busy = o.availability === 'ocupado';
        const input = el('input', { type: 'checkbox', checked: ok.get(o.id) ? '' : null, disabled: busy ? '' : null,
          onchange: (e: Event) => {
            ok.set(o.id, (e.target as HTMLInputElement).checked);
            schedule(dates.options.map((x) => ({ option_id: x.id, ok: ok.get(x.id) === true })));
          } }) as HTMLInputElement;
        return el('label', { class: `field check orgdateoption${busy ? ' muted' : ''}`, 'data-option': o.id },
          input, el('span', null, dateRange(o.start, o.end), ' ', availabilityChip(o.availability)));
      });
      replace(host, staleAt ? staleNote(staleAt) : null,
        section(t('Fechas que te propone Ikisai'), { id: 'datesIkisai' },
          el('p', null, t('Marca las que te vienen bien.')),
          fbMark(el('div', { class: 'orgdateoptions' }, ...rows), 'organizers.fechas.opciones.marcar', 'Marcar fechas propuestas'),
          note, legend()),
        el('div', { class: 'orgsave' }, el('div', { class: 'orgsavestate', id: 'datesSaveState' }, saves.field('fechas').element)));
      return;
    }

    // Calendario de fines de semana: lo marcado por el organizador son sus opciones (`proposed_by: organizer`).
    const selected = new Map(dates.options.map((o) => [o.start, o.end]));
    const groups = new Map<string, Weekend[]>();
    for (const w of weekends) groups.set(monthKey(w.start), [...(groups.get(monthKey(w.start)) ?? []), w]);
    const toggle = (w: Weekend, button: HTMLButtonElement) => {
      if (selected.has(w.start)) selected.delete(w.start);
      else {
        if (selected.size >= MAX_OPTIONS) { toast(t('Puedes marcar como mucho {n} fechas.', { n: MAX_OPTIONS })); return; }
        selected.set(w.start, w.end);
      }
      button.classList.toggle('on', selected.has(w.start));
      button.setAttribute('aria-pressed', String(selected.has(w.start)));
      paintCount();
      schedule([...selected].sort(([a], [b]) => a.localeCompare(b)).map(([start, end]) => ({ start, end })));
    };
    const count = el('p', { class: 'muted small', id: 'datesCount' });
    const paintCount = () => replace(count, selected.size
      ? (selected.size === 1 ? t('Has marcado 1 fin de semana.') : t('Has marcado {n} fines de semana.', { n: selected.size }))
      : t('Aún no has marcado ninguno.'));
    paintCount();
    const months = [...groups].map(([key, list]) => el('div', { class: 'orgmonth', 'data-month': key },
      el('h4', null, monthLabel(list[0]!.start)),
      el('div', { class: 'orgweekends' }, ...list.map((w) => {
        const busy = w.status === 'ocupado';
        const button = el('button', {
          type: 'button', class: `orgweekend${selected.has(w.start) ? ' on' : ''}${busy ? ' busy' : ''}`, 'data-start': w.start,
          'aria-pressed': String(selected.has(w.start)), disabled: busy ? '' : null,
          'aria-label': `${dateRange(w.start, w.end)}${w.status === 'en_opcion' ? ` · ${t('En opción')}` : busy ? ` · ${t('Ocupado')}` : ''}`,
          onclick: () => toggle(w, button),
        }, el('strong', null, `${dayNumber(w.start)}–${dayNumber(w.end)}`), availabilityChip(w.status)) as HTMLButtonElement;
        return button;
      }))));
    replace(host, staleAt ? staleNote(staleAt) : null,
      section(t('¿Qué fines de semana te vienen bien?'), { id: 'datesCalendar' },
        el('p', null, t('Marca uno o varios, de viernes a domingo. Puedes cambiarlos cuando quieras.')),
        note, legend(), count,
        fbMark(el('div', { class: 'orgcalendar' }, ...months), 'organizers.fechas.calendario.marcar', 'Marcar fines de semana')),
      el('div', { class: 'orgsave' }, el('div', { class: 'orgsavestate', id: 'datesSaveState' }, saves.field('fechas').element)));
  }

  function legend(): HTMLElement {
    return el('ul', { class: 'orglegend' },
      el('li', null, el('span', { class: 'chip small warn' }, t('En opción')), ' ', t('Hay una prerreserva; puedes marcarla igualmente.')),
      el('li', null, el('span', { class: 'chip small trash' }, t('Ocupado')), ' ', t('No se puede elegir.')));
  }

  void load();
  (host as HTMLElement & { destroy?: () => void }).destroy = () => {
    alive = false;
    window.removeEventListener('online', resume);
    if (timer) void save();
  };
  return host;
}
