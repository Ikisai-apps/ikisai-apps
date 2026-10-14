/**
 * Calendario de la persona (O4a y O4b; kit 0.33, `createCalendar` con capas): sus retiros, pasados y futuros, en un mes
 * de lunes a domingo. Tocar un retiro abre su pestaña. Con «Todos», un retiro que no es de todos lleva el nombre de a
 * quién toca. Debajo, la lista de todos los retiros con sus fechas: así se llega a uno lejano sin pasar meses, y se lee
 * bien con un lector de pantalla.
 *
 * Con nivel de casa `outsider` (O4b; Booking §26), además:
 * - **sus estancias** (capa propia): se crean eligiendo días (llegada y salida), se cambian de fechas y se quitan desde
 *   el panel del día. Si coinciden con un retiro, se avisa; nunca se bloquea (decisión del usuario);
 * - **«Hay alguien del staff»**: días rayados, sin nombres;
 * - **notas con hora** («Llego en el tren de las 17:20»): las suyas se añaden y se borran desde el panel del día.
 */
import { confirmDialog, createCalendar, daysBetween, el, icon, openSheet, replace, toast, type CalendarDayInfo, type CalendarEvent } from '@ikisai/ui-kit';
import { describeError, isNetworkError, online } from '../app/client.ts';
import { localeTag, t } from '../app/i18n.ts';
import { dateRange } from '../app/labels.ts';
import { madridInstant, madridParts, type OutsiderApi, type Stay, type StayNote } from '../app/outsider.ts';
import { retreatsFor, whenOf, type Retreat, type Roster, type Selection } from '../app/roster.ts';
import { fbIgnore } from './common.ts';
import { todayMadrid } from './home.ts';
import { stayText } from './outsider.ts';

export interface CalendarActions {
  href(retreat: Retreat): string;
  navigate(hash: string): void;
  /** Nombres de a quién toca un retiro si no es de todos (vacío si es de todos). */
  who(retreat: Retreat): string;
  /** Con nivel de casa `outsider`: estancias, presencia del staff y notas. */
  outsider?: OutsiderApi;
  /** Entrar directamente en «elegir días» para una estancia nueva (`#/calendario/nueva`). */
  newStay?: boolean;
}

const STAY_PREFIX = 'estancia:';

export function mountCalendar(main: HTMLElement, roster: Roster, selection: Selection, actions: CalendarActions, header: HTMLElement | null): () => void {
  const list = retreatsFor(roster, selection);
  const byId = new Map(list.map((r) => [r.reservation_id, r]));
  const out = actions.outsider ?? null;
  const retreatEvents: CalendarEvent[] = list.filter((r) => r.start).map((r) => {
    const who = actions.who(r);
    const title = `${r.title ?? t('picker.unknown')}${who ? ` · ${who}` : ''}`;
    return { id: r.reservation_id, title, abbr: title, start: r.start!, end: r.end ?? r.start!, layer: 'mine' };
  });
  let stays = new Map<string, Stay>();
  let notes = new Map<string, StayNote>();

  async function events(range: { from: string; to: string }): Promise<CalendarEvent[]> {
    if (!out) return retreatEvents;
    try {
      const loaded = await out.stays(range);
      stays = new Map(loaded.value.items.map((s) => [s.id, s]));
    } catch (error) {
      if (!isNetworkError(error)) toast(describeError(error));
    }
    return [...retreatEvents, ...[...stays.values()].map((s) => ({
      id: `${STAY_PREFIX}${s.id}`, title: t('calendar.stay'), abbr: t('calendar.stay'), start: s.from, end: s.to, layer: 'stay',
      ...(s.clash ? { badge: '⚠', status: 'clash' } : {}),
    }))];
  }

  async function dayInfo(range: { from: string; to: string }): Promise<Record<string, CalendarDayInfo>> {
    if (!out) return {};
    const [presence, loadedNotes] = await Promise.all([out.presence(range).catch(() => null), out.notes(range).catch(() => null)]);
    notes = new Map((loadedNotes?.value.items ?? []).map((n) => [n.id, n]));
    const info: Record<string, CalendarDayInfo> = {};
    for (const p of presence?.value.items ?? []) if (p.present) info[p.date] = { shaded: true, shadeLabel: t('calendar.someone') };
    for (const n of notes.values()) {
      const { day, time } = madridParts(n.at);
      const entry = (info[day] ??= {});
      (entry.notes ??= []).push({ id: n.id, time, text: n.text, author: n.mine ? t('calendar.noteMine') : t('calendar.noteStaff') });
    }
    return info;
  }

  async function saveStay(range: { from: string; to: string; eventId?: string }): Promise<void> {
    if (!out) return;
    if (!online()) { toast(t('outsider.needsNetwork')); return; }
    const id = range.eventId?.startsWith(STAY_PREFIX) ? range.eventId.slice(STAY_PREFIX.length) : crypto.randomUUID();
    const previous = stays.get(id);
    try {
      const saved = await out.saveStay({ id, from: range.from, to: range.to, ...(previous ? { expectedRevision: previous.revision } : {}) });
      toast(saved.clash ? t('outsider.clashSaved') : previous ? t('calendar.stayMoved') : t('calendar.staySaved'));
    } catch (error) {
      toast(isNetworkError(error) ? t('outsider.needsNetwork') : describeError(error));
    }
    await calendar.refresh();
  }

  async function removeStay(stay: Stay): Promise<void> {
    if (!out) return;
    const ok = await confirmDialog({ title: t('calendar.stayRemoveTitle'), text: t('calendar.stayRemoveText', { dates: dateRange(stay.from, stay.to) }), confirmLabel: t('calendar.stayRemove') });
    if (!ok) return;
    try { await out.removeStay(stay.id, stay.revision); toast(t('calendar.stayRemoved')); } catch (error) { toast(describeError(error)); }
    await calendar.refresh();
  }

  function addNote(day: string): void {
    if (!out) return;
    const time = el('input', { type: 'time', id: 'noteTime', value: '18:00' }) as HTMLInputElement;
    const text = el('textarea', { id: 'noteText', rows: '3', maxlength: '500' }) as HTMLTextAreaElement;
    const save = el('button', { type: 'submit', class: 'primary wide', id: 'noteSave', 'data-feedback-id': 'guests.calendario.nota.guardar', 'data-feedback-label': 'Guardar nota' }, t('calendar.noteSave')) as HTMLButtonElement;
    const sheet = openSheet({
      title: t('calendar.noteTitle', { day: dateRange(day, null) }),
      body: el('form', { class: 'gform', id: 'noteForm', onsubmit: async (event: Event) => {
        event.preventDefault();
        if (!text.value.trim()) { text.focus(); return; }
        if (!online()) { toast(t('outsider.needsNetwork')); return; }
        save.disabled = true;
        try {
          await out.saveNote({ id: crypto.randomUUID(), at: madridInstant(day, time.value || '00:00'), text: text.value.trim() });
          void sheet.close(true);
          toast(t('calendar.noteSaved'));
          await calendar.refresh();
        } catch (error) {
          toast(describeError(error));
          save.disabled = false;
        }
      } },
      el('div', { class: 'gfield' }, el('label', { for: 'noteTime' }, t('calendar.noteTime')), time),
      el('div', { class: 'gfield' }, el('label', { for: 'noteText' }, t('calendar.noteText')), text),
      save),
    });
  }

  async function removeNote(note: StayNote): Promise<void> {
    if (!out) return;
    try { await out.removeNote(note.id, note.revision); toast(t('calendar.noteRemoved')); } catch (error) { toast(describeError(error)); }
    await calendar.refresh();
  }

  /** Lo del outsider en el panel del día: sus estancias, «Añadir nota» y borrar sus notas. */
  function renderDay(day: string, dayEvents: CalendarEvent[]): HTMLElement | null {
    if (!out) return null;
    const dayStays = dayEvents.filter((e) => e.layer === 'stay').map((e) => stays.get(e.id.slice(STAY_PREFIX.length))).filter((s): s is Stay => Boolean(s));
    const myNotes = [...notes.values()].filter((n) => n.mine && madridParts(n.at).day === day);
    return fbIgnore(el('div', { class: 'gday', id: 'dayActions' },
      ...dayStays.map((s) => el('div', { class: 'gday-stay', dataset: { stay: s.id } },
        el('p', { class: 'small' }, el('strong', null, dateRange(s.from, s.to)), stayText(s) ? ` · ${stayText(s)}` : ''),
        s.clash ? el('p', { class: 'small gwarn' }, icon('warn', 14), ' ', t('outsider.clash')) : null,
        s.source === 'guest' ? el('div', { class: 'btnrow' },
          el('button', { type: 'button', class: 'ghost small', 'data-feedback-id': 'guests.calendario.estancia.fechas', 'data-feedback-label': 'Cambiar fechas',
            onclick: () => calendar.selectRange({ from: s.from, to: s.to, eventId: `${STAY_PREFIX}${s.id}` }) }, t('calendar.stayDates')),
          el('button', { type: 'button', class: 'ghost small', 'data-feedback-id': 'guests.calendario.estancia.quitar', 'data-feedback-label': 'Quitar estancia',
            onclick: () => void removeStay(s) }, t('calendar.stayRemove'))) : el('p', { class: 'muted small' }, t('calendar.stayByStaff')))),
      ...myNotes.map((n) => el('p', { class: 'small gday-note', dataset: { note: n.id } }, `${madridParts(n.at).time} · ${n.text} `,
        el('button', { type: 'button', class: 'linkbtn', 'data-feedback-id': 'guests.calendario.nota.borrar', 'data-feedback-label': 'Borrar nota', onclick: () => void removeNote(n) }, t('calendar.noteRemove')))),
      el('div', { class: 'btnrow' },
        el('button', { type: 'button', class: 'ghost small', id: 'addNote', 'data-feedback-id': 'guests.calendario.nota.nueva', 'data-feedback-label': 'Añadir nota', onclick: () => addNote(day) }, icon('plus', 16), t('calendar.noteAdd')))));
  }

  const calendar = createCalendar({
    label: t('calendar.title'),
    feedbackId: 'guests.calendario',
    viewSwitch: false,
    locale: localeTag(),
    date: todayMadrid(),
    layers: [
      { id: 'mine', label: t('calendar.mine'), color: 'var(--accent)' },
      ...(out ? [{ id: 'stay', label: t('calendar.stays'), color: '#8a5fb0' }] : []),
    ],
    legend: Boolean(out),
    ...(out ? { shadeLegend: t('calendar.someone') } : {}),
    events,
    ...(out ? {
      dayInfo,
      agenda: { renderDay: (day: string, dayEvents: CalendarEvent[]) => renderDay(day, dayEvents) },
      select: {
        label: t('calendar.staySave'),
        minDays: 2,
        maxDays: 181,
        describe: (r: { from: string; to: string }) => t('calendar.nights', { count: daysBetween(r.from, r.to) }),
        onSelect: (r: { from: string; to: string; eventId?: string }) => saveStay(r),
      },
    } : {}),
    onSelectEvent: (event) => {
      const r = byId.get(event.id);
      if (r) actions.navigate(actions.href(r));
    },
  });
  calendar.element.id = 'calendar';
  const today = todayMadrid();
  const when = { before: t('calendar.before'), during: t('calendar.during'), after: t('calendar.after') };
  const label = (r: Retreat) => when[whenOf(r, today)];
  replace(main,
    header,
    el('div', { class: 'pagehead' }, el('h2', null, t('calendar.title'))),
    out ? el('div', { class: 'btnrow gcal-tools' },
      el('button', { type: 'button', class: 'primary', id: 'calendarNewStay', 'data-feedback-id': 'guests.calendario.estancia.nueva', 'data-feedback-label': 'Nueva estancia', onclick: () => calendar.selectRange() }, icon('plus', 16), t('outsider.newStay'))) : null,
    calendar.element,
    el('section', { class: 'gcalendar-list', 'aria-labelledby': 'calendarListTitle' },
      el('h3', { id: 'calendarListTitle' }, t('calendar.list')),
      list.length
        ? fbIgnore(el('div', { class: 'gcards', id: 'calendarList' }, ...list.map((r) => el('a', {
          class: 'card gcard glink', href: actions.href(r), dataset: { reservation: r.reservation_id },
          'data-feedback-id': 'guests.calendario.retiro.abrir', 'data-feedback-label': 'Abrir retiro',
        }, icon('calendar', 20), el('span', null,
          el('strong', null, r.title ?? t('picker.unknown')),
          el('span', { class: 'muted small' }, [dateRange(r.start, r.end), label(r), actions.who(r)].filter(Boolean).join(' · ')))))))
        : el('p', { class: 'card gcard muted', id: 'calendarEmpty' }, t('calendar.empty'))));
  if (out && actions.newStay) requestAnimationFrame(() => calendar.selectRange());
  return () => calendar.destroy();
}
