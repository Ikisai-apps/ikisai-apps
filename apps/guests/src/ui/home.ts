/**
 * Resumen del retiro (API.md §9.3; MUELA-012 con los ajustes de VG y el consolidado 071, tanda 31). De arriba abajo:
 * 1. **Cuadro del retiro**: saludo, título, fechas con el momento («Faltan 2 días», «Día 2 de 3 · sábado 17», «Terminó
 *    ayer») y las horas de llegada y salida a la vista. Durante, «Necesito ayuda» y «Llamar»; después, «Gracias por
 *    venir», «Cuéntanos qué tal» y el próximo retiro. La imagen va en la portada de la cabecera, no aquí.
 * 2. **Paso a paso** (`renderSteps` del kit): solo lo pendiente, lo siguiente en grande y lo hecho en una línea pequeña;
 *    sin pendientes, antes, «¡Todo listo!»; durante y después, nada. La familia junta, un bloque por persona.
 * 3. **Horario del retiro**: pestañas de día del kit y cada día como agenda por horas (`renderHourAgenda`) con las comidas
 *    dentro, lo pasado plegado, la raya de ahora y «Ver en el plano» en lo de ahora y lo siguiente.
 * 4. **Mensaje del organizador** y **«Tu estancia»**: tu habitación en el plano y cuadros con icono (menú, habitación,
 *    preguntas, cómo llegar, materiales, ayuda y próximo retiro).
 * Sin red, todo se lee de la copia; lo que se rellena se guarda en el móvil. Solo «Guarda tu acceso» necesita red y se
 * desactiva con su motivo (`bindOnline`).
 */
import type { SyncClient } from '@ikisai/sync-client';
import { bindOnline, createDayTabs, el, icon, renderHourAgenda, renderSteps, replace, type HourItem, type IconName, type StepItem } from '@ikisai/ui-kit';
import { signsOwnEntry } from '@ikisai/domain-booking';
import type { MyGuest } from '../app/api.ts';
import { contactPhone } from '../app/common-texts.ts';
import { audienceOf, itemsFor } from '../app/audience.ts';
import type { GuestContext } from '../app/context.ts';
import { formatDate, localeTag, t } from '../app/i18n.ts';
import { dateRange, hhmm, missingText } from '../app/labels.ts';
import type { Lodging, Menu, ProgramItem } from '../app/portal.ts';
import { roleText } from './retreats.ts';
import { fbIgnore, fbMark, staleNote } from './common.ts';
import { shortRange } from './frame.ts';
import { choiceOpen } from './lodging.ts';
import type { Modules } from './nav.ts';
import { verEnPlano } from './plan.ts';
import { endOfItem, nextMeal, nowMadrid } from './program.ts';
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

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);

export interface HomeActions {
  /** Base de la ficha de la persona (`#/p/<id>`): sus datos, alimentación y firma. */
  base: string;
  /** Base del retiro que se ve (`#/p/<id>` o, con la familia junta, `#/r/<reserva>`): sus secciones. */
  retreatBase?: string;
  /** La familia junta (O4a): lo que falta de cada una, con su nombre. La primera es `ctx`. */
  family?: Array<{ ctx: GuestContext; base: string }>;
  /** Módulos del organizador visibles ahora (fases 4 y 5); sin ellos, Inicio de la fase 1. */
  modules?: Modules;
  /** El próximo retiro de la cuenta (después de este). */
  nextRetreat?: { title: string | null; start: string | null; end: string | null; href: string } | null;
  client?: SyncClient;
  openHelp(start?: 'place' | 'event'): void;
  openAccess(): void;
  openInstall(): void;
}

interface Extras { questionsPending: number; questionsAll: number; chooseRoom: { chosen: boolean; until: string | null } | null }
interface Task { id: string; route: string; icon: IconName; title: string; status: string; done: boolean; action: string; minutes: number }

export function mountHome(main: HTMLElement, ctx: GuestContext, actions: HomeActions): () => void {
  const mods = actions.modules;
  const people = actions.family && actions.family.length > 1 ? actions.family : [{ ctx, base: actions.base }];
  const family = people.length > 1;
  const retreatBase = actions.retreatBase ?? actions.base;
  const extras = new Map<string, Extras>(people.map((p) => [p.ctx.grant.guest_id, { questionsPending: 0, questionsAll: 0, chooseRoom: null }]));
  let program: ProgramItem[] = [];
  let menu: Menu | null = null;
  let lodging: Lodging | null = null;
  let materials = 0;
  let placeName: string | null = null;
  let selectedDay: string | null = null;
  let alive = true;
  let unbindAccess: (() => void) | null = null;

  async function loadExtras(): Promise<void> {
    const r = ctx.grant.reservation_id;
    const [prog, men, lod, mats, place] = await Promise.all([
      mods?.program ? ctx.reads.program(r).catch(() => null) : null,
      mods?.menu ? ctx.reads.menu(r, ctx.grant.guest_id).catch(() => null) : null,
      mods?.lodging ? ctx.reads.lodging(ctx.grant.guest_id).catch(() => null) : null,
      mods?.materials ? ctx.reads.materials(r).catch(() => null) : null,
      ctx.reads.place().catch(() => null),
      ...people.map(async ({ ctx: c }) => {
        const [questions, room] = await Promise.all([
          mods?.questions ? c.reads.questions(c.grant.reservation_id, c.grant.guest_id).catch(() => null) : null,
          mods?.lodging ? c.reads.lodging(c.grant.guest_id).catch(() => null) : null,
        ]);
        const x = extras.get(c.grant.guest_id)!;
        const open = questions ? questions.value.items.filter((q) => q.open) : [];
        x.questionsAll = open.length;
        x.questionsPending = open.filter((q) => q.required && !answered(q)).length;
        // «Elige tu habitación» solo con la elección de Booking abierta (Booking §23.1).
        x.chooseRoom = room && choiceOpen(room.value) ? { chosen: Boolean(room.value.mine), until: room.value.choose_until ?? null } : null;
      }),
    ]);
    if (!alive) return;
    // Solo lo que toca a alguien de quien mira (`audience`, MUELA-065).
    program = itemsFor(prog?.value.items ?? [], audiencePeople());
    menu = men?.value ?? null;
    lodging = lod?.value ?? null;
    materials = mats?.value.items.length ?? 0;
    placeName = place?.value.name ?? null;
    paint();
  }

  /** Cuadro del retiro: saludo, título, fechas con el momento, horas, y lo propio de durante y después. */
  function head(guest: MyGuest, moment: Moment): HTMLElement {
    const { reservation: r } = guest;
    const today = todayMadrid();
    const arrival = hhmm(r.arrival_time);
    const departure = hhmm(r.departure_time);
    const names = people.map((p) => String(p.ctx.guest().fields.first_name ?? '')).filter(Boolean);
    const phone = contactPhone();
    let chip = '';
    if (moment === 'before' && r.start_date) {
      const n = daysBetween(today, r.start_date);
      chip = n <= 0 ? t('home2.startsToday') : t('home2.countdown', { count: n });
    } else if (moment === 'during' && r.start_date && r.end_date) {
      chip = `${t('home2.dayOf', { n: daysBetween(r.start_date, today) + 1, total: daysBetween(r.start_date, r.end_date) + 1 })} · ${formatDate(today, { weekday: 'long', day: 'numeric' })}`;
    } else if (moment === 'after' && r.end_date) {
      chip = t('home2.ended', { count: daysBetween(r.end_date, today) });
    }
    const next = actions.nextRetreat;
    return el('header', { class: 'ghead gpass', id: 'homeHead', 'data-feedback-id': 'guests.inicio.retiro', 'data-feedback-label': 'Tu retiro' },
      fbIgnore(el('p', { class: 'gpass-hello', id: 'hello' }, t('home.hello', { name: family ? new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(names) : String(guest.fields.first_name ?? '') }))),
      el('h2', { id: 'retreatTitle', tabindex: '-1' }, r.title),
      el('p', { id: 'retreatDates' }, dateRange(r.start_date, r.end_date), chip ? el('span', { class: 'chip gpass-chip' }, chip) : null),
      arrival || departure ? el('p', { class: 'gpass-times', id: 'retreatTimes' }, icon('history', 14), ' ',
        [arrival ? t('home.arrival', { time: arrival }) : null, departure ? t('home.departure', { time: departure }) : null].filter(Boolean).join(' · ')) : null,
      moment === 'during' ? el('div', { class: 'gpass-help' },
        el('button', { type: 'button', class: 'primary', id: 'urgentHelp', 'data-feedback-id': 'guests.inicio.ayuda.urgente', 'data-feedback-label': 'Necesito ayuda', onclick: () => actions.openHelp('place') }, icon('help', 18), t('home.needHelp')),
        phone ? el('a', { class: 'ghost', href: `tel:${phone.replace(/\s+/g, '')}`, id: 'callIkisai', 'data-feedback-id': 'guests.inicio.contacto.llamar', 'data-feedback-label': 'Llamar a Ikisai' }, t('home.call', { phone })) : null) : null,
      moment === 'after' ? el('div', { class: 'gpass-after', id: 'after', 'data-feedback-id': 'guests.inicio.despues', 'data-feedback-label': 'Después del retiro' },
        el('h3', null, t('home.thanks')),
        el('p', null, t('home.thanksText')),
        el('button', { type: 'button', class: 'primary', id: 'tellUs', 'data-feedback-id': 'guests.inicio.despues.opinion', 'data-feedback-label': 'Cuéntanos qué tal', onclick: () => actions.openHelp('event') }, t('home.tellUs')),
        next ? el('a', { class: 'gpass-next', id: 'nextRetreat', href: next.href, 'data-feedback-id': 'guests.inicio.despues.proximo', 'data-feedback-label': 'Tu próximo retiro' },
          icon('calendar', 18),
          el('span', null, el('span', { class: 'glabel' }, t('home2.nextRetreat')), el('strong', null, next.title ?? ''),
            el('span', { class: 'small' }, [shortRange(next.start, next.end), next.start ? t('home2.inDays', { count: Math.max(0, daysBetween(today, next.start)) }) : null].filter(Boolean).join(' · '))),
          icon('chevronRight', 16)) : null) : null);
  }

  /** Paso a paso de una persona (`renderSteps`), con los ids de siempre en cada tarea (`#task-<id><sufijo>`). */
  function steps(tasks: Task[], base: string, suffix: string, title: string | null, readyText: string | null): HTMLElement {
    const items: StepItem[] = tasks.map((task) => ({
      id: task.id, title: task.title, done: task.done, stateText: task.status, action: task.action, minutes: task.done ? null : task.minutes, icon: task.icon, href: `${base}/${task.route}`,
    }));
    const box = renderSteps({ items, ...(title ? { title } : {}), readyText, feedbackId: 'guests.inicio.pendientes' });
    for (const task of tasks) {
      const link = box.querySelector<HTMLElement>(`a[href="${CSS.escape(`${base}/${task.route}`)}"]`);
      if (link) { link.id = `task-${task.id}${suffix}`; link.classList.toggle('done', task.done); if (task.done) link.title = `${task.title} · ${task.status}`; }
    }
    box.querySelector('.step-readytext')?.setAttribute('id', 'seeYou');
    box.id = `tasks${suffix}`;
    return box;
  }

  function audiencePeople() {
    return people.map(({ ctx: c }) => ({ guestId: c.grant.guest_id, minor: c.guest().fields.is_minor === true, name: String(c.guest().fields.first_name ?? '').trim() }));
  }
  /** Con la familia, «Para Leo» si la actividad no es de todos. */
  function forWhom(i: ProgramItem): string | null {
    if (!family) return null;
    const all = audiencePeople();
    const who = audienceOf(i, all);
    return who.length < all.length ? t('program.onlyFor', { names: new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(who.map((p) => p.name)) }) : null;
  }

  /** Lo del día: actividades y comidas, ordenadas por hora, con su estado si el día es hoy. */
  function dayItems(day: string, today: string, now: string, moment: Moment): HourItem[] {
    const isToday = day === today && moment === 'during';
    const acts = program.filter((i) => i.day === day && i.starts_at).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!));
    const meals = (menu?.services ?? []).filter((s) => s.date === day && s.time).sort((a, b) => a.time!.localeCompare(b.time!));
    type Row = { at: string; item: HourItem; end: string };
    const rows: Row[] = [
      ...acts.map((i) => ({ at: hhmm(i.starts_at)!, end: endOfItem(i, acts), item: {
        id: `act-${i.id}`, time: hhmm(i.starts_at)!, end: hhmm(i.ends_at), title: i.title,
        sub: [forWhom(i), i.place, i.public_note].filter(Boolean).join(' · ') || null, kind: i.kind, state: 'later' as HourItem['state'],
      } })),
      ...meals.map((s) => ({ at: hhmm(s.time)!, end: '', item: {
        id: `meal-${s.service_id ?? `${s.date}-${s.type}`}`, time: hhmm(s.time)!, title: t(`menu.${s.type}`),
        sub: s.dishes.map((d) => d.name).join(' · ') || null, kind: 'meal', state: 'later' as HourItem['state'],
      } })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    if (!isToday) return rows.map((r) => r.item);
    // Hoy: lo terminado plegado; «ahora» con la regla de la actividad sin hora de fin; lo siguiente, la primera que empieza.
    let nowSet = false;
    let nextSet = false;
    for (const r of rows) {
      const meal = r.item.kind === 'meal';
      const ended = meal ? r.at < now : r.end <= now;
      if (ended) { r.item.state = 'done'; continue; }
      if (!meal && r.at <= now && !nowSet) { r.item.state = 'now'; nowSet = true; continue; }
      if (r.at > now && !nextSet && !meal) { r.item.state = 'next'; nextSet = true; }
    }
    return rows.map((r) => r.item);
  }

  /** Horario del retiro: pestañas de día y agenda por horas. Sin programa ni menú, no sale. */
  function schedule(moment: Moment): HTMLElement | null {
    const days = [...new Set([...program.map((i) => i.day), ...(menu?.services ?? []).map((s) => s.date)])].sort();
    if (!days.length) return null;
    const today = todayMadrid();
    const now = nowMadrid();
    if (!selectedDay || !days.includes(selectedDay)) {
      selectedDay = days.includes(today) ? today : moment === 'after' ? days[days.length - 1]! : days[0]!;
    }
    const panel = el('div', { class: 'gsched-day', id: 'scheduleDay', role: 'tabpanel' });
    const paintDay = () => {
      const day = selectedDay!;
      const isToday = day === today && moment === 'during';
      const items = dayItems(day, today, now, moment);
      const nowItem = items.find((i) => i.state === 'now');
      const nextItem = items.find((i) => i.state === 'next');
      // «Ver en el plano» en lo de ahora y lo siguiente, si tienen sitio.
      for (const [item, id] of [[nowItem, 'nowPlan'], [nextItem, 'nextPlan']] as const) {
        if (!item) continue;
        const act = program.find((p) => `act-${p.id}` === item.id);
        if (act?.place) item.extra = verEnPlano({ place: act.place, spaceId: act.resource_space_id ?? null, id, reads: ctx.reads, mark: (n) => fbMark(n, 'guests.inicio.horario.plano', 'Ver en el plano') });
      }
      const agenda = renderHourAgenda({ label: t('home2.schedule'), items, now: isToday ? now : null, emptyText: t('program.empty') });
      if (isToday) {
        if (nowItem) agenda.querySelector(`[data-id="${CSS.escape(nowItem.id)}"]`)?.setAttribute('id', 'todayNow');
        if (nextItem) agenda.querySelector(`[data-id="${CSS.escape(nextItem.id)}"]`)?.setAttribute('id', 'todayNext');
        const meal = nextMeal(menu ?? { status: null, services: [] }, day, now);
        if (meal) agenda.querySelector(`[data-id="${CSS.escape(`meal-${meal.service_id ?? `${meal.date}-${meal.type}`}`)}"]`)?.setAttribute('id', 'todayMeal');
      }
      replace(panel,
        el('h3', { class: 'gsched-title', id: isToday ? 'today' : 'scheduleTitle' },
          isToday ? `${t('home.today')} · ${formatDate(day, { weekday: 'long', day: 'numeric' })}` : formatDate(day, { weekday: 'long', day: 'numeric', month: 'long' })),
        agenda);
    };
    const tabs = createDayTabs({ days, selected: selectedDay, today, panelId: 'scheduleDay', label: t('home2.days'),
      count: (d) => program.filter((i) => i.day === d).length, onSelect: (d) => { selectedDay = d; paintDay(); } });
    tabs.element.id = 'scheduleDays';
    fbMark(tabs.element, 'guests.inicio.horario.dias', 'Elegir día del horario');
    paintDay();
    return el('section', { class: 'gschedule', id: 'schedule', 'aria-label': t('home2.schedule'), 'data-feedback-id': 'guests.inicio.horario', 'data-feedback-label': 'Horario del retiro' },
      days.length > 1 ? el('p', { class: 'glabel' }, t('home2.days')) : null, days.length > 1 ? tabs.element : null, panel);
  }

  /** «Tu estancia»: tu habitación en el plano y los cuadros con icono. */
  function panel(moment: Moment, extrasOf: Extras): HTMLElement {
    const room = lodging?.mine ? [lodging.mine.space_name, lodging.mine.bed_label].filter(Boolean).join(' · ') : null;
    const meal = menu ? nextMeal(menu) : null;
    const tile = (attrs: { id: string; href?: string; onclick?: () => void; icon: IconName; title: string; sub: string; done?: boolean }, mark: (n: HTMLElement) => HTMLElement) => mark(attrs.href
      ? el('a', { class: `gtile${attrs.done ? ' done' : ''}`, href: attrs.href, id: attrs.id }, el('span', { class: 'gtile-ico', 'aria-hidden': 'true' }, icon(attrs.icon, 20)), el('strong', null, attrs.title), el('span', { class: 'small' }, attrs.sub))
      : el('button', { type: 'button', class: 'gtile', id: attrs.id, onclick: attrs.onclick }, el('span', { class: 'gtile-ico', 'aria-hidden': 'true' }, icon(attrs.icon, 20)), el('strong', null, attrs.title), el('span', { class: 'small' }, attrs.sub)));
    const next = actions.nextRetreat;
    return el('section', { class: 'gpanel', id: 'panel', 'data-feedback-id': 'guests.inicio.estancia', 'data-feedback-label': 'Tu estancia' },
      el('h3', null, t('home2.panel')),
      !room && lodging && mods?.lodging ? whyNote('roomPlanWhy', t('lodging.none')) : null,
      room ? verEnPlano({ place: room, spaceId: lodging?.mine?.resource_bed_id ?? lodging?.mine?.resource_space_id ?? null, match: { space: lodging?.mine?.space_name, bed: lodging?.mine?.bed_label }, label: t('home2.yourRoomPlan', { room }), id: 'roomPlan', reads: ctx.reads, mark: (n) => fbMark(n, 'guests.inicio.estancia.plano', 'Tu habitación en el plano') }) : null,
      el('div', { class: 'gtiles', id: 'retreatTiles' },
        mods?.menu ? tile({ id: 'openMenu', href: `${retreatBase}/menu`, icon: 'chef', title: t('nav.menu'), sub: meal ? `${t(`menu.${meal.type}`)}${meal.time ? ` · ${hhmm(meal.time)}` : ''}` : t('home2.menuSub') }, (n) => fbMark(n, 'guests.inicio.estancia.menu', 'Menú')) : null,
        mods?.lodging && moment !== 'before' ? tile({ id: 'myRoom', href: `${retreatBase}/alojamiento`, icon: 'bed', title: t('home2.yourRoom'), sub: room ?? t('home2.roomNone') }, (n) => fbMark(n, 'guests.inicio.estancia.habitacion', 'Tu habitación')) : null,
        mods?.questions && !family && extrasOf.questionsAll > 0 && extrasOf.questionsPending === 0 && moment !== 'after'
          ? tile({ id: 'openQuestions', href: `${actions.base}/preguntas`, icon: 'help', title: t('questions.title'), sub: t('home2.questionsDone'), done: true }, (n) => fbMark(n, 'guests.inicio.estancia.preguntas', 'Preguntas de tu organizador')) : null,
        tile({ id: 'openInfo', href: `${actions.base}/info`, icon: 'pin', title: t('home2.howToGet'), sub: placeName ?? t('home.infoText') }, (n) => fbMark(n, 'guests.inicio.info.abrir', 'Información práctica')),
        mods?.materials ? tile({ id: 'openMaterials', href: `${actions.base}/materiales`, icon: 'attach', title: t('home2.yourMaterials'), sub: materials ? t('home2.materialsCount', { count: materials }) : t('materials.intro') }, (n) => fbMark(n, 'guests.inicio.materiales.abrir', 'Materiales')) : null,
        tile({ id: 'openHelp', onclick: () => actions.openHelp(), icon: 'help', title: t('home.help'), sub: t('home2.helpSub') }, (n) => fbMark(n, 'guests.inicio.ayuda.abrir', 'Ayuda y sugerencias')),
        moment === 'after' && next ? tile({ id: 'nextRetreatTile', href: next.href, icon: 'calendar', title: t('home2.nextRetreat'), sub: `${next.title ?? ''} · ${shortRange(next.start, next.end)}` }, (n) => fbMark(n, 'guests.inicio.estancia.proximo', 'Tu próximo retiro')) : null));
  }

  function paint(): void {
    const guest = ctx.guest();
    const moment = momentOf(guest);
    const lists = people.map((p) => ({ ...p, tasks: pending(p.ctx.guest(), extras.get(p.ctx.grant.guest_id)!) }));
    const allDone = lists.every((l) => l.tasks.every((task) => task.done));
    const message = ctx.experience()?.organizer_message;
    const stale = people.map((p) => p.ctx.staleAt()).find(Boolean);
    const seeYou = moment === 'before' && guest.reservation.start_date ? t('home.seeYou', { date: dateRange(guest.reservation.start_date, null) }) : null;

    let todo: HTMLElement | null = null;
    if (!family) {
      const tasks = lists[0]!.tasks;
      const show = tasks.length && (tasks.some((x) => !x.done) || moment === 'before');
      todo = tasks.length ? el('section', { class: 'gsteps', id: 'todo', hidden: show ? null : '', 'data-feedback-id': 'guests.inicio.pendientes', 'data-feedback-label': 'Lo que te falta' },
        steps(tasks, actions.base, '', null, seeYou)) : null;
    } else {
      const anyPending = lists.some((l) => l.tasks.some((x) => !x.done));
      todo = el('section', { class: 'gsteps', id: 'todoFamily', hidden: anyPending || moment === 'before' ? null : '', 'data-feedback-id': 'guests.inicio.pendientes', 'data-feedback-label': 'Lo que le falta a cada persona' },
        allDone && seeYou ? el('p', { id: 'seeYou' }, seeYou) : null,
        ...lists.map((l) => {
          const name = String(l.ctx.guest().fields.first_name ?? '') || t('picker.unknown');
          const left = l.tasks.filter((x) => !x.done).length;
          const suffix = `-${l.ctx.grant.guest_id.slice(0, 8)}`;
          const role = roleText(l.ctx.guest().portal_role);
          return fbIgnore(el('div', { class: `gperson${left ? '' : ' gperson-done'}`, dataset: { guest: l.ctx.grant.guest_id } },
            role ? el('p', { class: 'gtags' }, el('span', { class: 'chip small grole' }, `${name} · ${role}`)) : null,
            left ? null : el('p', { class: 'small gperson-ready' }, icon('check', 12), ' ', t('home2.personDone', { name })),
            steps(l.tasks, l.base, suffix, left ? t('home2.personLeft', { name, count: left }) : null, null)));
        }));
    }

    const access = el('button', { type: 'button', class: 'ghost', id: 'saveAccess', 'data-feedback-id': 'guests.acceso.guardar.abrir', 'data-feedback-label': 'Guarda tu acceso', onclick: actions.openAccess }, icon('lock', 16), t('access.title'));
    const offline = actions.client && actions.client.status().network === 'offline';
    replace(main,
      stale ? staleNote(stale) : null,
      offline ? el('p', { class: 'small goffline', id: 'resumenOffline', role: 'status' }, icon('offline', 14), ' ', t('home2.offline')) : null,
      head(guest, moment),
      todo,
      mods ? schedule(moment) : null,
      message?.text ? el('section', { class: 'card gcard', id: 'organizerMessage', 'data-feedback-id': 'guests.inicio.mensaje', 'data-feedback-label': 'Mensaje del organizador' },
        el('h3', null, t('home.organizerMessage')), el('p', { class: 'gtext' }, message.text)) : null,
      panel(moment, extras.get(ctx.grant.guest_id)!),
      allDone ? el('div', { class: 'gsuggest', id: 'suggest' },
        access,
        el('button', { type: 'button', class: 'ghost', id: 'install', 'data-feedback-id': 'guests.app.instalar.abrir', 'data-feedback-label': 'Instalar la app', onclick: actions.openInstall }, icon('download', 16), t('install.title'))) : null,
    );
    // «Guarda tu acceso» necesita red: sin ella, desactivado con su motivo.
    unbindAccess?.();
    unbindAccess = allDone ? bindOnline(access, { ...(actions.client ? { client: actions.client } : {}), reason: t('home2.needsNetwork') }) : null;
  }

  paint();
  if (mods) void loadExtras();
  else void ctx.reads.place().then((p) => { if (alive && p) { placeName = p.value.name; paint(); } }).catch(() => undefined);
  const offs = people.map((p) => p.ctx.onChange((reason) => { if (reason === 'guest') paint(); }));
  // La línea de sin red se repinta al cambiar la red (el botón lo lleva `bindOnline`).
  let wasOffline = actions.client?.status().network === 'offline';
  const offStatus = actions.client?.onStatus((s) => { const off = s.network === 'offline'; if (alive && off !== wasOffline) { wasOffline = off; paint(); } });
  return () => { alive = false; for (const off of offs) off(); offStatus?.(); unbindAccess?.(); };
}

/** Minutos orientativos de cada tarea (MUELA-012). */
const MINUTES: Record<string, number> = { data: 3, diet: 2, sign: 1, questions: 2, room: 2 };

/**
 * Pendientes según el modo (API.md §9.3): datos (salvo `ninguno`), alimentación y, en `ses`, la firma. Con los módulos del
 * organizador (§13): sus preguntas obligatorias sin responder y la elección de habitación abierta.
 */
function pending(guest: MyGuest, extras: Extras): Task[] {
  const tasks: Task[] = [];
  const task = (x: Omit<Task, 'minutes'>) => tasks.push({ ...x, minutes: MINUTES[x.id] ?? 2 });
  if (guest.mode !== 'ninguno') {
    const missing = guest.missing;
    task({ id: 'data', route: 'datos', icon: 'user', title: t('home.data'), done: missing.length === 0, action: t('home2.go.data'),
      status: missing.length === 0 ? t('home.dataDone') : t('home.dataMissing', { count: missing.length, list: missingText(missing.slice(0, 3)) }) });
  }
  task({ id: 'diet', route: 'alimentacion', icon: 'chef', title: t('home.diet'), done: Boolean(guest.diet_reviewed_at), action: t('home2.go.diet'),
    status: guest.diet_reviewed_at ? t('home.dietDone') : t('home.dietTodo') });
  if (guest.mode === 'ses') {
    const own = guest.reservation.start_date ? signsOwnEntry({ birth_date: guest.fields.birth_date as string | null, is_minor: guest.fields.is_minor === true }, guest.reservation.start_date) : true;
    task({ id: 'sign', route: 'firma', icon: 'edit', title: own ? t('home.sign') : t('home.signCompanion'), done: guest.signed, action: t('home2.go.sign'),
      status: guest.signed ? t('home.signDone') : guest.missing.length ? t('home.signAfterData') : t('home.signTodo') });
  }
  if (extras.questionsPending > 0) {
    task({ id: 'questions', route: 'preguntas', icon: 'help', title: t('questions.title'), done: false, action: t('home2.go.questions'), status: t('home.questionsPending', { count: extras.questionsPending }) });
  }
  if (extras.chooseRoom) {
    task({ id: 'room', route: 'alojamiento', icon: 'bed', title: t('home.room'), done: extras.chooseRoom.chosen, action: t('home2.go.room'),
      status: extras.chooseRoom.chosen ? t('home.roomDone') : extras.chooseRoom.until ? t('home.roomUntil', { date: formatDate(extras.chooseRoom.until) }) : t('home.roomTodo') });
  }
  return tasks;
}
