/**
 * Inicio (API.md §9.3): qué retiro es, cuándo, qué me falta y qué puedo consultar. Cambia según el momento: antes, durante
 * («Hoy en Ikisai» con «Necesito ayuda» y el teléfono) y después («Gracias por venir»).
 */
import { el, icon, replace } from '@ikisai/ui-kit';
import { signsOwnEntry } from '@ikisai/domain-booking';
import type { MyGuest } from '../app/api.ts';
import { contactPhone } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { formatDate, t } from '../app/i18n.ts';
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
  /** Módulos del organizador visibles ahora (fases 4 y 5); sin ellos, Inicio de la fase 1. */
  modules?: Modules;
  openHelp(start?: 'place' | 'event'): void;
  openAccess(): void;
  openInstall(): void;
}

export function mountHome(main: HTMLElement, ctx: GuestContext, actions: HomeActions): () => void {
  const mods = actions.modules;
  /** Lo que llega de otras apps (preguntas sin responder, elección de habitación, «Hoy»): se pinta cuando llega. */
  const extras: Extras = { questionsPending: 0, chooseRoom: null, today: [] };
  let alive = true;

  async function loadExtras(): Promise<void> {
    const guest = ctx.guest();
    const lodging = ctx.experience()?.modules.lodging;
    const [questions, room, today] = await Promise.all([
      mods?.questions ? ctx.reads.questions(ctx.grant.reservation_id, ctx.grant.guest_id).catch(() => null) : null,
      mods?.lodging && (lodging?.capability === 'choose' || lodging?.capability === 'request') && choiceOpen(lodging.choose_until)
        ? ctx.reads.lodging(ctx.grant.reservation_id, ctx.grant.guest_id).catch(() => null) : null,
      momentOf(guest) === 'during' && mods ? todayCard(ctx, mods.program, mods.menu).catch(() => []) : [],
    ]);
    if (!alive) return;
    extras.questionsPending = questions ? questions.value.items.filter((q) => q.required && q.open && !answered(q)).length : 0;
    extras.chooseRoom = room ? { chosen: Boolean(room.value.mine), until: lodging?.choose_until ?? null } : null;
    extras.today = today;
    paint();
  }

  function paint(): void {
    const guest = ctx.guest();
    const moment = momentOf(guest);
    const { reservation } = guest;
    const arrival = hhmm(reservation.arrival_time);
    const departure = hhmm(reservation.departure_time);
    const tasks = pending(guest, extras);
    const message = ctx.experience()?.organizer_message;
    const allDone = tasks.every((task) => task.done);
    const phone = contactPhone();

    replace(main,
      ctx.staleAt() ? staleNote(ctx.staleAt()!) : null,
      el('header', { class: 'ghead', id: 'homeHead', 'data-feedback-id': 'guests.inicio.retiro', 'data-feedback-label': 'Tu retiro' },
        fbIgnore(el('p', { class: 'muted', id: 'hello' }, t('home.hello', { name: String(guest.fields.first_name ?? '') }))),
        el('h2', { id: 'retreatTitle' }, reservation.title),
        el('p', { id: 'retreatDates' }, dateRange(reservation.start_date, reservation.end_date)),
        arrival || departure ? el('p', { class: 'muted', id: 'retreatTimes' }, [arrival ? t('home.arrival', { time: arrival }) : null, departure ? t('home.departure', { time: departure }) : null].filter(Boolean).join(' · ')) : null),
      message?.text ? card({ id: 'organizerMessage', 'data-feedback-id': 'guests.inicio.mensaje', 'data-feedback-label': 'Mensaje del organizador' },
        el('h3', null, t('home.organizerMessage')), el('p', { class: 'gtext' }, message.text)) : null,
      moment === 'during' ? card({ id: 'today', 'data-feedback-id': 'guests.inicio.hoy', 'data-feedback-label': 'Hoy en Ikisai' },
        el('h3', null, t('home.today')),
        ...extras.today,
        el('div', { class: 'btnrow' },
          el('button', { type: 'button', class: 'primary', id: 'urgentHelp', 'data-feedback-id': 'guests.inicio.ayuda.urgente', 'data-feedback-label': 'Necesito ayuda', onclick: () => actions.openHelp('place') }, icon('help', 18), t('home.needHelp')),
          phone ? el('a', { class: 'ghost', href: `tel:${phone.replace(/\s+/g, '')}`, id: 'callIkisai', 'data-feedback-id': 'guests.inicio.contacto.llamar', 'data-feedback-label': 'Llamar a Ikisai' }, t('home.call', { phone })) : null)) : null,
      moment === 'after' ? card({ id: 'after', 'data-feedback-id': 'guests.inicio.despues', 'data-feedback-label': 'Después del retiro' },
        el('h3', null, t('home.thanks')),
        el('p', null, t('home.thanksText')),
        el('button', { type: 'button', class: 'primary', id: 'tellUs', 'data-feedback-id': 'guests.inicio.despues.opinion', 'data-feedback-label': 'Cuéntanos qué tal', onclick: () => actions.openHelp('event') }, t('home.tellUs'))) : null,
      tasks.length ? card({ id: 'todo', 'data-feedback-id': 'guests.inicio.pendientes', 'data-feedback-label': 'Lo que te falta' },
        el('h3', null, allDone ? t('home.allDone') : t('home.todo')),
        allDone && moment === 'before' && reservation.start_date ? el('p', { id: 'seeYou' }, t('home.seeYou', { date: dateRange(reservation.start_date, null) })) : null,
        el('ul', { class: 'gtasks', id: 'tasks' }, ...tasks.map((task) => el('li', null,
          el('a', {
            href: `${actions.base}/${task.route}`, class: `gtask${task.done ? ' done' : ''}`, id: `task-${task.id}`,
            'data-feedback-id': 'guests.inicio.pendientes.abrir', 'data-feedback-label': 'Abrir pendiente',
          },
          el('span', { class: 'gtask-icon', 'aria-hidden': 'true' }, icon(task.done ? 'check' : task.icon, 18)),
          el('span', { class: 'gtask-text' }, el('strong', null, task.title), el('span', { class: 'muted small' }, task.status)),
          icon('chevronRight', 16)))))) : null,
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
  const off = ctx.onChange((reason) => { if (reason === 'guest') paint(); });
  return () => { alive = false; off(); };
}

interface Extras { questionsPending: number; chooseRoom: { chosen: boolean; until: string | null } | null; today: HTMLElement[] }
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
