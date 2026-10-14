/**
 * Inicio (API.md §9.3): qué retiro es, cuándo, qué me falta y qué puedo consultar. Cambia según el momento: antes, durante
 * («Hoy en Ikisai» con «Necesito ayuda» y el teléfono) y después («Gracias por venir»).
 */
import { el, icon, replace } from '@ikisai/ui-kit';
import { signsOwnEntry } from '@ikisai/domain-booking';
import type { MyGuest } from '../app/api.ts';
import { contactPhone } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { formatDate, localeTag, t } from '../app/i18n.ts';
import { dateRange, hhmm, missingText } from '../app/labels.ts';
import { card, fbIgnore, staleNote } from './common.ts';
import { choiceOpen } from './lodging.ts';
import type { Modules } from './nav.ts';
import { todayCard } from './program.ts';
import { answered } from './questions.ts';

export type Moment = 'before' | 'during' | 'after';

/** Día de hoy en Madrid (AAAA-MM-DD). */
export function todayMadrid(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
}

export function momentOf(guest: MyGuest, today = todayMadrid()): Moment {
  const { start_date: start, end_date: end } = guest.reservation;
  if (start && today < start) return 'before';
  if (end && today > end) return 'after';
  return start ? 'during' : 'before';
}

export interface HomeActions {
  base: string;
  /**
   * La familia junta (O4a, «Todos» en un retiro con varias personas de la cuenta): lo que falta de cada una, con su nombre,
   * en tarjetas seguidas. La primera es `ctx`. Sin esto, solo la persona de `ctx`, como antes.
   */
  family?: Array<{ ctx: GuestContext; base: string }>;
  /** Módulos del organizador visibles ahora (fases 4 y 5); sin ellos, Inicio de la fase 1. */
  modules?: Modules;
  openHelp(start?: 'place' | 'event'): void;
  openAccess(): void;
  openInstall(): void;
}

export function mountHome(main: HTMLElement, ctx: GuestContext, actions: HomeActions): () => void {
  const mods = actions.modules;
  const people = actions.family && actions.family.length > 1 ? actions.family : [{ ctx, base: actions.base }];
  const family = people.length > 1;
  /** Lo que llega de otras apps (preguntas sin responder, elección de habitación): por persona, se pinta cuando llega. */
  const extras = new Map<string, Extras>(people.map((p) => [p.ctx.grant.guest_id, { questionsPending: 0, chooseRoom: null }]));
  /** «Hoy» (programa y menú del retiro): común a toda la familia. */
  let todayItems: HTMLElement[] = [];
  let alive = true;

  async function loadExtras(): Promise<void> {
    const [today] = await Promise.all([
      momentOf(ctx.guest()) === 'during' && mods ? todayCard(ctx, mods.program, mods.menu).catch(() => []) : [],
      ...people.map(async ({ ctx: c }) => {
        const [questions, room] = await Promise.all([
          mods?.questions ? c.reads.questions(c.grant.reservation_id, c.grant.guest_id).catch(() => null) : null,
          mods?.lodging ? c.reads.lodging(c.grant.guest_id).catch(() => null) : null,
        ]);
        const x = extras.get(c.grant.guest_id)!;
        x.questionsPending = questions ? questions.value.items.filter((q) => q.required && q.open && !answered(q)).length : 0;
        // «Elige tu habitación» solo con la elección de Booking abierta (Booking §23.1).
        x.chooseRoom = room && choiceOpen(room.value) ? { chosen: Boolean(room.value.mine), until: room.value.choose_until ?? null } : null;
      }),
    ]);
    if (!alive) return;
    todayItems = today as HTMLElement[];
    paint();
  }

  function taskList(tasks: Task[], base: string, suffix: string): HTMLElement {
    return el('ul', { class: 'gtasks', id: `tasks${suffix}` }, ...tasks.map((task) => el('li', null,
      el('a', {
        href: `${base}/${task.route}`, class: `gtask${task.done ? ' done' : ''}`, id: `task-${task.id}${suffix}`,
        'data-feedback-id': 'guests.inicio.pendientes.abrir', 'data-feedback-label': 'Abrir pendiente',
      },
      el('span', { class: 'gtask-icon', 'aria-hidden': 'true' }, icon(task.done ? 'check' : task.icon, 18)),
      el('span', { class: 'gtask-text' }, el('strong', null, task.title), el('span', { class: 'muted small' }, task.status)),
      icon('chevronRight', 16)))));
  }

  function paint(): void {
    const guest = ctx.guest();
    const moment = momentOf(guest);
    const { reservation } = guest;
    const arrival = hhmm(reservation.arrival_time);
    const departure = hhmm(reservation.departure_time);
    const lists = people.map((p) => ({ ...p, tasks: pending(p.ctx.guest(), extras.get(p.ctx.grant.guest_id)!) }));
    const tasks = lists[0]!.tasks;
    const message = ctx.experience()?.organizer_message;
    const allDone = lists.every((l) => l.tasks.every((task) => task.done));
    const phone = contactPhone();
    const stale = people.map((p) => p.ctx.staleAt()).find(Boolean);
    const names = people.map((p) => String(p.ctx.guest().fields.first_name ?? '')).filter(Boolean);
    const seeYou = allDone && moment === 'before' && reservation.start_date ? el('p', { id: 'seeYou' }, t('home.seeYou', { date: dateRange(reservation.start_date, null) })) : null;

    replace(main,
      stale ? staleNote(stale) : null,
      el('header', { class: 'ghead', id: 'homeHead', 'data-feedback-id': 'guests.inicio.retiro', 'data-feedback-label': 'Tu retiro' },
        fbIgnore(el('p', { class: 'muted', id: 'hello' }, t('home.hello', { name: family ? new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(names) : String(guest.fields.first_name ?? '') }))),
        el('h2', { id: 'retreatTitle' }, reservation.title),
        el('p', { id: 'retreatDates' }, dateRange(reservation.start_date, reservation.end_date)),
        arrival || departure ? el('p', { class: 'muted', id: 'retreatTimes' }, [arrival ? t('home.arrival', { time: arrival }) : null, departure ? t('home.departure', { time: departure }) : null].filter(Boolean).join(' · ')) : null),
      message?.text ? card({ id: 'organizerMessage', 'data-feedback-id': 'guests.inicio.mensaje', 'data-feedback-label': 'Mensaje del organizador' },
        el('h3', null, t('home.organizerMessage')), el('p', { class: 'gtext' }, message.text)) : null,
      moment === 'during' ? card({ id: 'today', 'data-feedback-id': 'guests.inicio.hoy', 'data-feedback-label': 'Hoy en Ikisai' },
        el('h3', null, t('home.today')),
        ...todayItems,
        el('div', { class: 'btnrow' },
          el('button', { type: 'button', class: 'primary', id: 'urgentHelp', 'data-feedback-id': 'guests.inicio.ayuda.urgente', 'data-feedback-label': 'Necesito ayuda', onclick: () => actions.openHelp('place') }, icon('help', 18), t('home.needHelp')),
          phone ? el('a', { class: 'ghost', href: `tel:${phone.replace(/\s+/g, '')}`, id: 'callIkisai', 'data-feedback-id': 'guests.inicio.contacto.llamar', 'data-feedback-label': 'Llamar a Ikisai' }, t('home.call', { phone })) : null)) : null,
      moment === 'after' ? card({ id: 'after', 'data-feedback-id': 'guests.inicio.despues', 'data-feedback-label': 'Después del retiro' },
        el('h3', null, t('home.thanks')),
        el('p', null, t('home.thanksText')),
        el('button', { type: 'button', class: 'primary', id: 'tellUs', 'data-feedback-id': 'guests.inicio.despues.opinion', 'data-feedback-label': 'Cuéntanos qué tal', onclick: () => actions.openHelp('event') }, t('home.tellUs'))) : null,
      !family && tasks.length ? card({ id: 'todo', 'data-feedback-id': 'guests.inicio.pendientes', 'data-feedback-label': 'Lo que te falta' },
        el('h3', null, allDone ? t('home.allDone') : t('home.todo')),
        seeYou,
        taskList(tasks, actions.base, '')) : null,
      // La familia junta: una tarjeta por persona, con su nombre (preparación de O4 §2.3).
      family ? el('div', { id: 'todoFamily' }, seeYou, ...lists.map((l) => fbIgnore(card({ class: 'card gcard gperson', 'data-guest': l.ctx.grant.guest_id, 'data-feedback-id': 'guests.inicio.pendientes', 'data-feedback-label': 'Lo que le falta a cada persona' },
        el('h3', null, String(l.ctx.guest().fields.first_name ?? '') || t('picker.unknown'), ' · ', l.tasks.every((task) => task.done) ? t('home.allDone') : t('home.todo')),
        taskList(l.tasks, l.base, `-${l.ctx.grant.guest_id.slice(0, 8)}`))))) : null,
      el('div', { class: 'gcards' },
        el('a', { class: 'card gcard glink', href: `${actions.base}/info`, id: 'openInfo', 'data-feedback-id': 'guests.inicio.info.abrir', 'data-feedback-label': 'Información práctica' },
          icon('info', 20), el('span', null, el('strong', null, t('home.info')), el('span', { class: 'muted small' }, t('home.infoText')))),
        mods?.materials ? el('a', { class: 'card gcard glink', href: `${actions.base}/materiales`, id: 'openMaterials', 'data-feedback-id': 'guests.inicio.materiales.abrir', 'data-feedback-label': 'Materiales' },
          icon('attach', 20), el('span', null, el('strong', null, t('materials.title')), el('span', { class: 'muted small' }, t('materials.intro')))) : null,
        el('button', { type: 'button', class: 'card gcard glink', id: 'openHelp', 'data-feedback-id': 'guests.inicio.ayuda.abrir', 'data-feedback-label': 'Ayuda y sugerencias', onclick: () => actions.openHelp() },
          icon('help', 20), el('span', null, el('strong', null, t('home.help')), el('span', { class: 'muted small' }, t('home.helpText'))))),
      allDone ? el('div', { class: 'gsuggest', id: 'suggest' },
        el('button', { type: 'button', class: 'ghost', id: 'saveAccess', 'data-feedback-id': 'guests.acceso.guardar.abrir', 'data-feedback-label': 'Guarda tu acceso', onclick: actions.openAccess }, icon('lock', 16), t('access.title')),
        el('button', { type: 'button', class: 'ghost', id: 'install', 'data-feedback-id': 'guests.app.instalar.abrir', 'data-feedback-label': 'Instalar la app', onclick: actions.openInstall }, icon('download', 16), t('install.title'))) : null,
    );
  }

  paint();
  if (mods) void loadExtras();
  const offs = people.map((p) => p.ctx.onChange((reason) => { if (reason === 'guest') paint(); }));
  return () => { alive = false; for (const off of offs) off(); };
}

interface Extras { questionsPending: number; chooseRoom: { chosen: boolean; until: string | null } | null }
interface Task { id: string; route: string; icon: 'user' | 'chef' | 'edit' | 'lock' | 'help' | 'bed'; title: string; status: string; done: boolean }

/**
 * Pendientes según el modo (API.md §9.3): datos (salvo `ninguno`), alimentación y, en `ses`, la firma. Con los módulos del
 * organizador (§13): sus preguntas obligatorias sin responder y la elección de habitación abierta.
 */
function pending(guest: MyGuest, extras: Extras): Task[] {
  const tasks: Task[] = [];
  if (guest.mode !== 'ninguno') {
    const missing = guest.missing;
    tasks.push({ id: 'data', route: 'datos', icon: 'user', title: t('home.data'), done: missing.length === 0,
      status: missing.length === 0 ? t('home.dataDone') : t('home.dataMissing', { count: missing.length, list: missingText(missing.slice(0, 3)) }) });
  }
  tasks.push({ id: 'diet', route: 'alimentacion', icon: 'chef', title: t('home.diet'), done: Boolean(guest.diet_reviewed_at),
    status: guest.diet_reviewed_at ? t('home.dietDone') : t('home.dietTodo') });
  if (guest.mode === 'ses') {
    const own = guest.reservation.start_date ? signsOwnEntry({ birth_date: guest.fields.birth_date as string | null, is_minor: guest.fields.is_minor === true }, guest.reservation.start_date) : true;
    tasks.push({ id: 'sign', route: 'firma', icon: 'edit', title: own ? t('home.sign') : t('home.signCompanion'), done: guest.signed,
      status: guest.signed ? t('home.signDone') : guest.missing.length ? t('home.signAfterData') : t('home.signTodo') });
  }
  if (extras.questionsPending > 0) {
    tasks.push({ id: 'questions', route: 'preguntas', icon: 'help', title: t('questions.title'), done: false, status: t('home.questionsPending', { count: extras.questionsPending }) });
  }
  if (extras.chooseRoom) {
    tasks.push({ id: 'room', route: 'alojamiento', icon: 'bed', title: t('home.room'), done: extras.chooseRoom.chosen,
      status: extras.chooseRoom.chosen ? t('home.roomDone') : extras.chooseRoom.until ? t('home.roomUntil', { date: formatDate(extras.chooseRoom.until) }) : t('home.roomTodo') });
  }
  return tasks;
}
