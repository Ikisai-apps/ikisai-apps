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
 * - **notas con hora** («Llego en el tren de las 17:20»): las suyas se añaden y se borran desde el panel del día;
 * - **la familia** (varias personas en la cuenta; O4 §2.3): una estancia nueva es para todos por defecto, con casillas
 *   para quitar a alguien, y «Separar» deja a unas personas con otras fechas (`portal_stay_split`).
 *
 * Para cualquier huésped, los **retiros abiertos** (Booking §26.1): visibles, vivos y sin precio, con su resumen en el
 * panel del día y **«Apuntarme»** (§26.3): una sugerencia a Booking para todas las personas de la cuenta por defecto, con
 * casillas para quitar a alguien y un mensaje opcional. Después, su estado: enviada (con «Retirar»), con el organizador,
 * aceptada o descartada (con el comentario).
 */
import { confirmDialog, createCalendar, daysBetween, el, icon, openSheet, replace, toast, type CalendarDayInfo, type CalendarEvent } from '@ikisai/ui-kit';
import type { Suggestion } from '@ikisai/sync-client';
import { describeError, isNetworkError, online } from '../app/client.ts';
import { localeTag, t } from '../app/i18n.ts';
import { dateRange } from '../app/labels.ts';
import { madridInstant, madridParts, type JoinPerson, type OpenRetreat, type OutsiderApi, type Stay, type StayNote, type StayPerson } from '../app/outsider.ts';
import { retreatsFor, whenOf, type Person, type Retreat, type Roster, type Selection } from '../app/roster.ts';
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
  /** Retiros abiertos a huéspedes del rango visible (Booking §26.1). */
  openRetreats?: (range: { from: string; to: string }) => Promise<OpenRetreat[]>;
  /** «Apuntarme» (Booking §26.3). */
  join?: {
    /** Quién puede ir: las personas de la cuenta (o el titular). */
    persons(): JoinPerson[];
    /** Sus «Apuntarme» por retiro. */
    mine(): Promise<Map<string, Suggestion>>;
    send(retreat: OpenRetreat, people: JoinPerson[], message: string | null): Promise<void>;
    withdraw(id: string): Promise<void>;
  };
}

const STAY_PREFIX = 'estancia:';
const OPEN_PREFIX = 'abierto:';

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
  let open = new Map<string, OpenRetreat>();
  let joins = new Map<string, Suggestion>();
  /** La familia: las personas de la cuenta, si son más de una (sin retiros, solo el titular y no se pregunta). */
  const family: Person[] = roster.persons.length > 1 ? roster.persons : [];

  /** «Estancia» y, si no es de toda la familia, para quién. */
  function stayTitle(stay: Stay): string {
    const names = stay.persons.map((p) => p.name).filter(Boolean);
    return family.length && names.length && names.length < family.length ? `${t('calendar.stay')} · ${names.join(', ')}` : t('calendar.stay');
  }

  async function events(range: { from: string; to: string }): Promise<CalendarEvent[]> {
    const [, opened, mine] = await Promise.all([
      out ? out.stays(range).then((loaded) => { stays = new Map(loaded.value.items.map((s) => [s.id, s])); }).catch((error) => { if (!isNetworkError(error)) toast(describeError(error)); }) : null,
      actions.openRetreats ? actions.openRetreats(range) : [],
      actions.join ? actions.join.mine() : new Map<string, Suggestion>(),
    ]);
    joins = mine as Map<string, Suggestion>;
    // Los abiertos en los que ya tiene una entrada salen como suyos, no repetidos.
    open = new Map((opened as OpenRetreat[]).filter((o) => !o.joined && o.start_date && !byId.has(o.reservation_id)).map((o) => [o.reservation_id, o]));
    return [
      ...retreatEvents,
      ...[...stays.values()].map((s) => ({
        id: `${STAY_PREFIX}${s.id}`, title: stayTitle(s), abbr: stayTitle(s), start: s.from, end: s.to, layer: 'stay',
        ...(s.clash ? { badge: '⚠', status: 'clash' } : {}),
      })),
      ...[...open.values()].map((o) => ({ id: `${OPEN_PREFIX}${o.reservation_id}`, title: o.title, abbr: o.title, start: o.start_date!, end: o.end_date ?? o.start_date!, layer: 'open' })),
    ];
  }

  /** Hoja con una casilla por persona; devuelve las marcadas (o null si se cierra). */
  function pickPersons(title: string, people: Array<{ key: string; name: string }>, checked: boolean, extra: HTMLElement[] = [], okLabel = t('calendar.stayForOk')): Promise<{ keys: string[]; form: HTMLFormElement } | null> {
    return new Promise((resolve) => {
      let done = false;
      const boxes = people.map((p) => el('input', { type: 'checkbox', value: p.key, checked: checked ? '' : null, id: `who-${p.key.replace(/[^a-z0-9]/gi, '')}` }) as HTMLInputElement);
      const form = el('form', { class: 'gform', id: 'whoForm', onsubmit: (event: Event) => {
        event.preventDefault();
        const keys = boxes.filter((b) => b.checked).map((b) => b.value);
        if (!keys.length) { boxes[0]?.focus(); return; }
        done = true;
        void sheet.close(true);
        resolve({ keys, form });
      } },
      el('fieldset', { class: 'gchoices', id: 'whoList' }, el('legend', null, t('calendar.stayFor')),
        ...people.map((p, i) => el('label', { class: 'gswitch' }, boxes[i]!, el('span', null, p.name || t('picker.unknown'))))),
      ...extra,
      el('button', { type: 'submit', class: 'primary wide', id: 'whoOk', 'data-feedback-id': 'guests.calendario.estancia.personas', 'data-feedback-label': 'Para quién es' }, okLabel)) as HTMLFormElement;
      const sheet = openSheet({ title, body: form, onClose: () => { if (!done) resolve(null); } });
    });
  }

  /** Personas de la familia con su clave de Booking (la crea al unir sus fichas si aún no la tiene). */
  async function withKeys(chosen: Person[]): Promise<StayPerson[]> {
    return Promise.all(chosen.map(async (p) => {
      if (!p.personKey) p.personKey = (await out!.personLink(p.guestIds)).person_key;
      return { person_key: p.personKey, name: p.name };
    }));
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
    // Estancia nueva con la familia: para todos por defecto, con casillas para quitar a alguien.
    let persons: StayPerson[] | null = null;
    if (!previous && family.length) {
      const picked = await pickPersons(t('calendar.stayForTitle'), family, true);
      if (!picked) { await calendar.refresh(); return; }
      try { persons = await withKeys(family.filter((p) => picked.keys.includes(p.key))); } catch (error) { toast(describeError(error)); return; }
    }
    try {
      const saved = await out.saveStay({ id, from: range.from, to: range.to, ...(previous ? { expectedRevision: previous.revision } : {}), ...(persons ? { persons } : {}) });
      toast(saved.clash ? t('outsider.clashSaved') : previous ? t('calendar.stayMoved') : t('calendar.staySaved'));
    } catch (error) {
      toast(isNetworkError(error) ? t('outsider.needsNetwork') : describeError(error));
    }
    await calendar.refresh();
  }

  /** «Separar»: unas personas de la estancia pasan a otra, con sus fechas y la misma cama. */
  async function splitStay(stay: Stay): Promise<void> {
    if (!out) return;
    const from = el('input', { type: 'date', id: 'splitFrom', value: stay.from }) as HTMLInputElement;
    const to = el('input', { type: 'date', id: 'splitTo', value: stay.to }) as HTMLInputElement;
    const picked = await pickPersons(t('calendar.staySplitTitle'), stay.persons.map((p) => ({ key: p.person_key, name: p.name })), false, [
      el('div', { class: 'gfield-row' },
        el('div', { class: 'gfield' }, el('label', { for: 'splitFrom' }, t('calendar.splitFrom')), from),
        el('div', { class: 'gfield' }, el('label', { for: 'splitTo' }, t('calendar.splitTo')), to)),
    ]);
    if (!picked) return;
    if (picked.keys.length >= stay.persons.length) { toast(t('calendar.splitAll')); return; }
    if (!online()) { toast(t('outsider.needsNetwork')); return; }
    try {
      await out.splitStay({ id: stay.id, person_keys: picked.keys, from: from.value, to: to.value });
      toast(t('calendar.staySplit'));
    } catch (error) {
      toast(describeError(error));
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

  /** «Apuntarme»: para quién (todos por defecto) y un mensaje opcional; se envía como sugerencia a Booking. */
  async function join(o: OpenRetreat): Promise<void> {
    if (!actions.join) return;
    if (!online()) { toast(t('outsider.needsNetwork')); return; }
    const people = actions.join.persons();
    const message = el('textarea', { id: 'joinMessage', rows: '3', maxlength: '500' }) as HTMLTextAreaElement;
    const picked = await pickPersons(t('calendar.joinTitle', { title: o.title }), people.map((p, i) => ({ key: `p${i}`, name: p.name })), true, [
      el('p', { class: 'muted small' }, dateRange(o.start_date, o.end_date)),
      el('div', { class: 'gfield' }, el('label', { for: 'joinMessage' }, t('calendar.joinMessage')), message),
    ], people.length > 1 ? t('calendar.joinOkMany') : t('calendar.joinOk'));
    if (!picked) return;
    try {
      await actions.join.send(o, people.filter((_, i) => picked.keys.includes(`p${i}`)), message.value.trim() || null);
      toast(t('calendar.joinSent'));
    } catch (error) {
      toast(isNetworkError(error) ? t('outsider.needsNetwork') : describeError(error));
    }
    await calendar.refresh();
  }

  async function withdrawJoin(s: Suggestion): Promise<void> {
    if (!actions.join) return;
    const ok = await confirmDialog({ title: t('calendar.joinWithdrawTitle'), text: t('calendar.joinWithdrawText'), confirmLabel: t('calendar.joinWithdraw') });
    if (!ok) return;
    try { await actions.join.withdraw(s.id); toast(t('calendar.joinWithdrawn')); } catch (error) { toast(describeError(error)); }
    await calendar.refresh();
  }

  /** Estado de su «Apuntarme» en un retiro abierto, o el botón para apuntarse. */
  function joinState(o: OpenRetreat): HTMLElement | null {
    if (!actions.join) return null;
    const req = o.request;
    const s = joins.get(o.reservation_id);
    const comment = (text: string | null | undefined) => (text ? el('p', { class: 'small muted' }, t('calendar.joinComment', { comment: text })) : null);
    if (req) {
      const key = req.status === 'aceptada' ? 'calendar.joinAccepted' : req.status === 'descartada' ? 'calendar.joinRejected' : 'calendar.joinOrganizer';
      return el('div', { class: 'gjoin', dataset: { state: req.status } }, el('p', { class: 'small' }, el('strong', null, t(key))), comment(req.comment));
    }
    if (s?.status === 'pending') {
      return el('div', { class: 'gjoin', dataset: { state: 'pendiente' } },
        el('p', { class: 'small' }, el('strong', null, t('calendar.joinPending'))),
        el('button', { type: 'button', class: 'ghost small', 'data-feedback-id': 'guests.calendario.apuntarme.retirar', 'data-feedback-label': 'Retirar «Apuntarme»', onclick: () => void withdrawJoin(s) }, t('calendar.joinWithdraw')));
    }
    return el('div', { class: 'gjoin', dataset: { state: s?.status === 'rejected' ? 'descartada' : 'libre' } },
      s?.status === 'rejected' ? el('p', { class: 'small' }, el('strong', null, t('calendar.joinRejected'))) : null,
      s?.status === 'rejected' ? comment(s.comment) : null,
      el('button', { type: 'button', class: 'primary small', 'data-feedback-id': 'guests.calendario.apuntarme', 'data-feedback-label': 'Apuntarme', onclick: () => void join(o) }, t('calendar.join')));
  }

  /** Retiros abiertos del día: título, fechas, resumen (sin precio) y «Apuntarme». */
  function openOfDay(dayEvents: CalendarEvent[]): HTMLElement[] {
    return dayEvents.filter((e) => e.layer === 'open').map((e) => open.get(e.id.slice(OPEN_PREFIX.length))).filter((o): o is OpenRetreat => Boolean(o))
      .map((o) => el('div', { class: 'gday-open', dataset: { open: o.reservation_id } },
        el('p', { class: 'small' }, el('strong', null, o.title), ` · ${dateRange(o.start_date, o.end_date)}`),
        o.summary ? el('p', { class: 'small gtext' }, o.summary) : null,
        joinState(o) ?? el('p', { class: 'muted small' }, t('calendar.openSoon'))));
  }

  /** Lo de la app en el panel del día: retiros abiertos y, con nivel outsider, sus estancias, «Añadir nota» y sus notas. */
  function renderDay(day: string, dayEvents: CalendarEvent[]): HTMLElement | null {
    const opened = openOfDay(dayEvents);
    if (!out) return opened.length ? el('div', { class: 'gday', id: 'dayActions' }, ...opened) : null;
    const dayStays = dayEvents.filter((e) => e.layer === 'stay').map((e) => stays.get(e.id.slice(STAY_PREFIX.length))).filter((s): s is Stay => Boolean(s));
    const myNotes = [...notes.values()].filter((n) => n.mine && madridParts(n.at).day === day);
    return fbIgnore(el('div', { class: 'gday', id: 'dayActions' },
      ...opened,
      ...dayStays.map((s) => el('div', { class: 'gday-stay', dataset: { stay: s.id } },
        el('p', { class: 'small' }, el('strong', null, dateRange(s.from, s.to)), stayText(s) ? ` · ${stayText(s)}` : ''),
        s.persons.length ? el('p', { class: 'small muted gday-who' }, t('calendar.stayWho', { names: s.persons.map((p) => p.name).join(', ') })) : null,
        s.clash ? el('p', { class: 'small gwarn' }, icon('warn', 14), ' ', t('outsider.clash')) : null,
        s.source === 'guest' ? el('div', { class: 'btnrow' },
          el('button', { type: 'button', class: 'ghost small', 'data-feedback-id': 'guests.calendario.estancia.fechas', 'data-feedback-label': 'Cambiar fechas',
            onclick: () => calendar.selectRange({ from: s.from, to: s.to, eventId: `${STAY_PREFIX}${s.id}` }) }, t('calendar.stayDates')),
          s.persons.length > 1 ? el('button', { type: 'button', class: 'ghost small', 'data-feedback-id': 'guests.calendario.estancia.separar', 'data-feedback-label': 'Separar a alguien',
            onclick: () => void splitStay(s) }, t('calendar.staySplitButton')) : null,
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
      ...(actions.openRetreats ? [{ id: 'open', label: t('calendar.open'), color: '#3a6ea5', style: 'outline' as const }] : []),
    ],
    legend: Boolean(out || actions.openRetreats),
    ...(out ? { shadeLegend: t('calendar.someone') } : {}),
    events,
    ...(out || actions.openRetreats ? { agenda: { renderDay: (day: string, dayEvents: CalendarEvent[]) => renderDay(day, dayEvents) } } : {}),
    ...(out ? {
      dayInfo,
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
