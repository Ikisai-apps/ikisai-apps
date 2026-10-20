/**
 * Programa (API.md §13.2, dueño Booking) y menú (§13.3, dueño Food), rediseño de la tanda 31:
 * - **Programa «Ahora y lo siguiente»** (MUELA-025, pieza del kit `renderNow`): lo de ahora en grande con su barra y
 *   «Quedan…» (sin hora de fin: «Hasta 19:00 · Meditación»), lo siguiente con su cuenta atrás, «Hoy, más tarde» plegado
 *   (cada actividad se despliega con el mismo detalle) y lo ya hecho tras «Ver lo ya hecho». Los otros días, al pie, con
 *   las pestañas del kit. Antes del retiro, «Empieza en N días». Cada lugar con «Ver en el plano» y cada comida con
 *   «Ver el menú». Cada persona ve solo lo suyo (`audience`, MUELA-065). La familia junta ve lo de ahora y, debajo, el
 *   día **en una columna por persona**: lo común a todo el ancho, lo de alguien en su columna y «Libre» en las demás;
 *   los menores, con aro y «menor» en texto.
 * - **Menú «La carta»** (MUELA-034, con la familia de 065 y la corrección de seguridad 078): la próxima comida abierta y
 *   las demás plegadas; filtros de dieta; la línea de cocina con «Cambiar». En cada plato, **siempre** sus alérgenos
 *   declarados (#597) y, **encima**, el cruce con lo que indicó cada persona que lo ve (`crossRestriction` de Food, G13),
 *   con su nombre si es la familia. Nunca «apto». Con la familia, «Lo que vigilar, persona a persona» si algo coincide.
 * Guardados en la caché para verlos sin cobertura.
 */
import { crossRestriction, type Allergen, type Recipe } from '@ikisai/domain-food';
import { createDayTabs, el, icon, renderMedal, renderNow, replace, type NowBlock, type NowRow } from '@ikisai/ui-kit';
import type { Restriction } from '../app/api.ts';
import { audienceOf, itemsFor, type AudiencePerson } from '../app/audience.ts';
import type { GuestContext } from '../app/context.ts';
import { formatDate, localeTag, t } from '../app/i18n.ts';
import { hhmm, restrictionLabel, severityLabel } from '../app/labels.ts';
import type { Dish, Menu, ProgramItem } from '../app/portal.ts';
import { failure, fbIgnore, fbMark, loading, staleNote } from './common.ts';
import { todayMadrid } from './home.ts';
import { verEnPlano } from './plan.ts';

/** Hora actual en Madrid (HH:MM). */
export function nowMadrid(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

const range = (from: string | null, to: string | null) => (from ? (to ? `${hhmm(from)}–${hhmm(to)}` : hhmm(from)!) : t('program.allDay'));
const mins = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** «1 h 30 min», «2 h», «45 min». */
function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? t('time.hours', { count: h }) : null, m || !h ? t('time.minutes', { count: m }) : null].filter(Boolean).join(' ');
}

/**
 * Fin de una actividad del día: su hora de fin o, sin ella, el inicio de la siguiente que empieza después (regla de VG,
 * MUELA-012 y 025); si no hay ninguna, el final del día.
 */
export function endOfItem(item: ProgramItem, sameDay: ProgramItem[]): string {
  const end = hhmm(item.ends_at);
  if (end) return end;
  const start = hhmm(item.starts_at) ?? '00:00';
  const next = sameDay.map((i) => hhmm(i.starts_at)).filter((s): s is string => Boolean(s) && s! > start).sort()[0];
  return next ?? '24:00';
}

/** Lo que está pasando y lo siguiente de hoy (la regla de la actividad sin hora de fin, en `endOfItem`). */
export function nowAndNext(items: ProgramItem[], day = todayMadrid(), now = nowMadrid()): { current: ProgramItem | null; next: ProgramItem | null } {
  const today = items.filter((i) => i.day === day && i.starts_at).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!));
  const current = [...today].reverse().find((i) => hhmm(i.starts_at)! <= now && endOfItem(i, today) > now) ?? null;
  const next = today.find((i) => hhmm(i.starts_at)! > now) ?? null;
  return { current, next };
}

/** Próxima comida de hoy según el menú. */
export function nextMeal(menu: Menu, day = todayMadrid(), now = nowMadrid()): Menu['services'][number] | null {
  return menu.services.filter((s) => s.date === day && (!s.time || hhmm(s.time)! >= now)).sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'))[0] ?? null;
}

function daysOf<T>(list: T[], key: (x: T) => string): string[] {
  return [...new Set(list.map(key))].sort();
}

/** Pestañas de días del kit (`createDayTabs`, U5), con «hoy» en hora de Madrid. */
function dayTabs(days: string[], selected: string, onPick: (day: string) => void, id: string, panelId: string, count?: (day: string) => number): HTMLElement {
  const tabs = createDayTabs({ days, selected, today: todayMadrid(), onSelect: onPick, panelId, ...(count ? { count } : {}) });
  tabs.element.id = id;
  return tabs.element;
}

/** Caras de la familia junta, con sus nombres, encima del Programa y del Menú. */
function familyLine(ctxs: GuestContext[]): HTMLElement | null {
  if (ctxs.length < 2) return null;
  const names = ctxs.map((c) => String(c.guest().fields.first_name ?? '').trim() || t('menu.noName'));
  return fbIgnore(el('p', { class: 'gfamily' },
    el('span', { class: 'gfaces', 'aria-hidden': 'true' }, ...names.map((name) => renderMedal({ name, size: 28 }))),
    el('span', null, t('family.together', { names: new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(names) }))));
}

export interface ProgramOptions {
  /** Base de las secciones del retiro (para «Ver el menú»). */
  retreatBase: string;
  /** Con la familia junta, todas sus fichas (la primera es la de las lecturas). */
  family?: GuestContext[];
}

export function mountProgram(main: HTMLElement, ctx: GuestContext, options: ProgramOptions): () => void {
  let alive = true;
  replace(main, loading());
  void ctx.reads.program(ctx.grant.reservation_id).then((loaded) => {
    if (!alive) return;
    const family = options.family && options.family.length > 1 ? options.family : [ctx];
    const people: Array<AudiencePerson & { name: string }> = family.map((c) => ({
      guestId: c.grant.guest_id, minor: c.guest().fields.is_minor === true, name: String(c.guest().fields.first_name ?? '').trim() || t('menu.noName'),
    }));
    const together = people.length > 1;
    // Solo lo que toca a alguien de quien mira (Booking ya no manda lo de otras familias).
    const items = itemsFor(loaded?.value.items ?? [], people);
    const days = daysOf(items, (i) => i.day);
    const names = (list: Array<{ name: string }>) => new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(list.map((x) => x.name));
    /** Con la familia, a quién toca si no es a todos («Para Leo»). */
    const forWhom = (i: ProgramItem) => {
      const who = audienceOf(i, people);
      return together && who.length < people.length ? el('p', { class: 'small gfor' }, icon('user', 14), ' ', t('program.onlyFor', { names: names(people.filter((p) => who.includes(p))) })) : null;
    };
    const head = el('div', { class: 'pagehead' }, el('h2', null, t('program.title')));
    if (!days.length) { replace(main, head, el('p', { class: 'card gcard muted', id: 'programEmpty' }, t('program.empty'))); return; }
    const today = todayMadrid();
    let selected = days.includes(today) ? today : days[0]!;
    const list = el('div', { id: 'programList', role: 'tabpanel' });
    const plan = (i: ProgramItem, id?: string) => verEnPlano({ place: i.place, spaceId: i.resource_space_id ?? null, reads: ctx.reads, ...(id ? { id } : {}), mark: (n) => fbMark(n, 'guests.programa.plano.abrir', 'Ver en el plano') });
    const menuLink = (i: ProgramItem) => (i.kind === 'comida'
      ? el('a', { class: 'glink-inline', href: `${options.retreatBase}/menu`, 'data-feedback-id': 'guests.programa.menu.abrir', 'data-feedback-label': 'Ver el menú' }, icon('chef', 16), t('program.seeMenu'))
      : null);
    const detail = (i: ProgramItem, when: boolean, planId?: string) => el('div', { class: 'gslot-detail' },
      forWhom(i),
      when ? el('p', { class: 'small' }, i.ends_at ? range(i.starts_at, i.ends_at) : i.starts_at ? t('program.noEnd', { time: hhmm(i.starts_at)! }) : t('program.allDay')) : null,
      el('div', { class: 'glinks' }, plan(i, planId), menuLink(i)),
      i.public_note ? el('p', { class: 'small gtext' }, i.public_note) : null);

    const paint = () => {
      const now = nowMadrid();
      const dayItems = items.filter((i) => i.day === selected).sort((a, b) => (a.starts_at ?? '').localeCompare(b.starts_at ?? ''));
      const timed = dayItems.filter((i) => i.starts_at);
      const isToday = selected === today;
      const { current, next } = isToday ? nowAndNext(items, today, now) : { current: null, next: null };
      let hero: NowBlock | null = null;
      if (current) {
        const start = hhmm(current.starts_at)!;
        const end = endOfItem(current, timed);
        const after = timed.find((i) => hhmm(i.starts_at)! >= end && i !== current);
        hero = {
          label: current.ends_at ? `${t('program.now')} · ${range(current.starts_at, current.ends_at)}` : `${t('program.now')} · ${t('program.since', { time: start })}`,
          title: current.title, medal: { name: current.title },
          progress: (mins(now) - mins(start)) / Math.max(1, mins(end) - mins(start)),
          left: current.ends_at ? t('program.left', { time: duration(mins(end) - mins(now)) })
            : after ? t('program.until', { time: hhmm(after.starts_at)!, title: after.title }) : t('program.untilEnd'),
          body: detail(current, false, 'nowPlan'),
        };
      } else if (today < days[0]! && selected === days[0]) {
        // Antes del retiro: «Empieza en N días» con la primera actividad.
        const first = timed[0];
        const n = Math.round((Date.parse(`${days[0]}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
        if (first) hero = { label: t('program.startsIn', { count: n }), title: first.title, medal: { name: first.title },
          body: el('div', null, el('p', { class: 'small' }, `${formatDate(first.day)} · ${hhmm(first.starts_at)}`), plan(first, 'nowPlan')) };
      }
      const nextBlock: NowBlock | null = next ? {
        label: `${t('program.next')} · ${t('program.inTime', { time: duration(mins(hhmm(next.starts_at)!) - mins(now)) })}`,
        title: `${hhmm(next.starts_at)} · ${next.title}`, medal: { name: next.title }, body: detail(next, true, 'nextPlan'),
      } : null;
      const rest: NowRow[] = dayItems.filter((i) => i !== current && i !== next && !(hero && !current && i === timed[0])).map((i) => {
        const done = isToday && Boolean(i.starts_at) && endOfItem(i, timed) <= now;
        return { id: i.id, time: range(i.starts_at, i.ends_at), title: i.title, medal: { name: i.title }, state: done ? 'done' : 'later', body: () => detail(i, false) };
      });
      if (together) {
        // La familia: lo de ahora arriba (si hoy hay algo) y el día entero en columnas, una por persona.
        const top = hero || nextBlock ? renderNow({ now: hero, next: nextBlock, rest: [], feedbackId: 'guests.programa.ahora' }) : null;
        replace(list, top, columns(dayItems, isToday ? { current, now, timed } : null));
        return;
      }
      const box = renderNow({ now: hero, next: nextBlock, rest, restTitle: isToday ? t('program.later') : formatDate(selected, { weekday: 'long', day: 'numeric', month: 'long' }),
        emptyText: t('program.emptyDay'), feedbackId: 'guests.programa.ahora' });
      // Lo que se toca de cada fila (abrir el detalle) lleva su clase por tipo, como antes.
      for (const row of box.querySelectorAll<HTMLElement>('.now-fold')) {
        const item = dayItems.find((i) => i.id === row.dataset.id);
        if (item) row.closest('li')?.classList.add('gslot', `kind-${item.kind}`);
      }
      replace(list, box);
    };
    /** El día en una columna por persona (MUELA-065, alternativa 2): tabla con sus papeles para lectores de pantalla. */
    const columns = (dayItems: ProgramItem[], live: { current: ProgramItem | null; now: string; timed: ProgramItem[] } | null) => {
      const state = (i: ProgramItem) => (!live ? '' : i === live.current ? ' now' : i.starts_at && endOfItem(i, live.timed) <= live.now ? ' done' : '');
      const cell = (i: ProgramItem, cls: string) => el('details', { class: `gcols-cell ${cls}${state(i)} kind-${i.kind}`, role: 'cell', dataset: { id: i.id } },
        el('summary', null, el('strong', null, i.title), i.place ? el('span', { class: 'small' }, i.place) : null),
        detail(i, false));
      return el('div', { class: 'gcols', id: 'programCols', role: 'table', style: `--n:${people.length}`, 'aria-label': t('program.byPerson'),
        'data-feedback-id': 'guests.programa.columnas', 'data-feedback-label': 'El día, persona a persona' },
        el('div', { class: 'gcols-row gcols-head', role: 'row' },
          el('span', { class: 'gcols-time', role: 'columnheader' }, t('program.time')),
          ...people.map((p) => el('span', { class: `gcols-name${p.minor ? ' minor' : ''}`, role: 'columnheader', dataset: { guest: p.guestId } },
            el('span', { class: 'gcols-face', 'aria-hidden': 'true' }, renderMedal({ name: p.name, size: 28 })),
            el('span', null, p.name, p.minor ? el('span', { class: 'small' }, ` · ${t('program.minor')}`) : null)))),
        ...(dayItems.length ? dayItems.map((i) => {
          const who = audienceOf(i, people);
          return el('div', { class: 'gcols-row', role: 'row', dataset: { item: i.id } },
            el('span', { class: 'gcols-time', role: 'rowheader' }, i.starts_at ? range(i.starts_at, i.ends_at) : t('program.allDay')),
            ...(who.length === people.length
              ? [cell(i, 'all')]
              : people.map((p) => (who.includes(p) ? cell(i, 'mine') : el('span', { class: 'gcols-cell free', role: 'cell' }, t('program.free'))))));
        }) : [el('p', { class: 'hint gcols-empty' }, t('program.emptyDay'))]));
    };
    const tabs = days.length > 1 ? dayTabs(days, selected, (d) => { selected = d; paint(); }, 'programDays', 'programList', (d) => items.filter((i) => i.day === d).length) : null;
    if (tabs) fbMark(tabs, 'guests.programa.dias.elegir', 'Elegir día');
    replace(main, loaded?.stale ? staleNote(loaded.at) : null, head, familyLine(options.family ?? []), list,
      tabs ? el('div', { class: 'gotherdays' }, el('p', { class: 'glabel' }, t('program.otherDays')), tabs) : null);
    paint();
  }).catch((error) => { if (alive) replace(main, failure(error)); });
  return () => { alive = false; };
}

// ---------------------------------------------------------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------------------------------------------------------

const allergenName = (code: string) => (t(`allergen.${code}`) === `allergen.${code}` ? code : t(`allergen.${code}`));

/**
 * La línea de alérgenos de cada plato (#597, tanda 26): **siempre** los declarados; si cocina aún no revisó la receta,
 * se dice («sin revisar por cocina»), también cuando no declara ninguno: sin revisar no es «sin alérgenos».
 */
export function allergens(d: Pick<Dish, 'allergens' | 'allergens_checked'>): HTMLElement | null {
  const list = (d.allergens ?? []).map(allergenName).join(', ');
  if (d.allergens_checked) return list ? el('span', { class: 'small gallergens' }, t('menu.allergens', { list })) : null;
  return el('span', { class: 'small gallergens', dataset: { checked: 'no' } }, list ? t('menu.allergensUnchecked', { list }) : t('menu.allergensUncheckedNone'));
}

/** Quien come: su nombre (solo con la familia junta) y lo que indicó en su alimentación. */
interface Eater { guestId: string; name: string | null; base: string; restrictions: Restriction[] }

/** Dietas: se ven en las etiquetas del plato; el cruce plato a plato es para alergias, intolerancias y preferencias. */
const DIETS = new Set(['vegetariano', 'vegano', 'sin_gluten', 'sin_lactosa']);
const WARN = new Set(['alergia', 'intolerancia']);
/** El portal no trae ingredientes: el cruce mira lo declarado y el texto del plato. */
const NO_INGREDIENTS = { ingredientNames: [], recipeIngredientNames: new Map<string, string[]>() };

/** El plato del portal con lo que necesita la función común de cruce de Food (`crossRestriction`). */
function asRecipe(d: Dish, i: number): Recipe {
  return { id: d.menu_item_id ?? `plato-${i}`, name: d.name, public_name: null, public_description: d.description ?? null,
    allergens: (d.allergens ?? []) as Allergen[], allergens_checked: Boolean(d.allergens_checked), diet_tags: d.diet_tags ?? [] } as unknown as Recipe;
}

interface Hit { eater: Eater; what: string; warn: boolean; detail: string }

/** Los cruces de un plato con cada persona (G13): lo declarado avisa siempre, esté revisada o no la receta. */
function hitsOf(d: Dish, i: number, eaters: Eater[]): Hit[] {
  const recipe = asRecipe(d, i);
  const seen = new Set<string>();
  return eaters.flatMap((p) => p.restrictions.filter((r) => r.subject?.trim() && !DIETS.has(r.restriction_type)).flatMap((r) => {
    const hit = crossRestriction(r.subject!, recipe, NO_INGREDIENTS);
    if (!hit) return [];
    const what = hit.declared ? allergenName(hit.declared) : r.subject!.trim();
    if (seen.has(`${p.guestId}|${what}`)) return [];
    seen.add(`${p.guestId}|${what}`);
    const warn = WARN.has(r.restriction_type);
    const kind = restrictionLabel(r.restriction_type).toLowerCase();
    const detail = warn && r.severity ? t('menu.severity', { type: kind, severity: severityLabel(r.severity).toLowerCase() }) : kind;
    return [{ eater: p, what, warn, detail }];
  }));
}

/**
 * El aviso de un plato, encima de su línea de alérgenos (MUELA-078): «⚠ Lleva frutos de cáscara, que nos indicaste
 * (alergia grave). Pregunta en cocina.»; con la familia, con el nombre de cada persona. Nunca «apto».
 */
function crossings(hits: Hit[], named: boolean): HTMLElement | null {
  const lines = hits.map((h) => {
    const name = h.eater.name || t('menu.noName');
    const text = h.warn ? (named ? t('menu.crossWarn', { name, what: h.what, detail: h.detail }) : t('menu.crossWarnMine', { what: h.what, detail: h.detail }))
      : (named ? t('menu.crossInfo', { name, what: h.what }) : t('menu.crossInfoMine', { what: h.what }));
    return el('span', { class: `small gcross${h.warn ? ' warn' : ''}`, dataset: { guest: h.eater.guestId, kind: h.warn ? 'aviso' : 'preferencia' } }, text);
  });
  return lines.length ? fbIgnore(el('span', { class: 'gcrossings' }, ...lines)) : null;
}

function dish(d: Dish, i: number, ctx: GuestContext, hits: Hit[], named: boolean): HTMLElement {
  // Foto del plato (Food #332): solo la miniatura, por `portal-files`, cuando llega (URL de 5 minutos).
  const photo = d.photo_thumb_file_id ? el('img', { class: 'gdish-photo', alt: '', loading: 'lazy', hidden: true }) as HTMLImageElement : null;
  if (photo && d.photo_thumb_file_id) {
    void ctx.reads.fileUrl(d.photo_thumb_file_id).then(({ url }) => { photo.src = url; photo.hidden = false; }).catch(() => undefined);
  }
  const tags = (d.diet_tags ?? []).map((tag) => (t(`diet.${tag}`) === `diet.${tag}` ? tag : t(`diet.${tag}`)));
  return el('li', { class: `gdish${hits.some((h) => h.warn) ? ' gdish-flag' : ''}` },
    photo,
    el('strong', null, d.name),
    d.description ? el('span', { class: 'muted small' }, d.description) : null,
    tags.length ? el('span', { class: 'gtags' }, ...tags.map((tag) => el('span', { class: 'chip small' }, tag))) : null,
    crossings(hits, named),
    allergens(d));
}

type Filter = 'vegano' | 'vegetariano' | 'sin_gluten' | 'mine';

/**
 * Menú del retiro. Con la familia junta (`ctxs` de varias personas del mismo retiro), lo que tiene registrado cocina y el
 * cruce de cada plato van **por persona y con su nombre** (G13): nunca solo la primera.
 */
export function mountMenu(main: HTMLElement, ctxs: GuestContext[], notice: HTMLElement | null, bases?: string[]): () => void {
  let alive = true;
  const ctx = ctxs[0]!;
  replace(main, loading());
  void ctx.reads.menu(ctx.grant.reservation_id, ctx.grant.guest_id).then((loaded) => {
    if (!alive) return;
    const menu = loaded?.value ?? { status: null, services: [] };
    const named = ctxs.length > 1;
    const eaters: Eater[] = ctxs.map((c, i) => ({ guestId: c.grant.guest_id, name: named ? String(c.guest().fields.first_name ?? '').trim() || null : null,
      base: bases?.[i] ?? `#/p/${c.grant.guest_id}`, restrictions: c.guest().restrictions }));
    const head = el('div', { class: 'pagehead' }, el('h2', null, t('menu.title')),
      menu.status === 'provisional' ? el('p', { class: 'chip small', id: 'menuProvisional' }, t('menu.provisional')) : null);
    const days = daysOf(menu.services, (s) => s.date);
    if (!days.length) { replace(main, head, familyLine(ctxs), el('p', { class: 'card gcard muted', id: 'menuEmpty' }, t('menu.empty')), notice); return; }

    // Lo que tiene registrado cocina, persona a persona (sin promesas clínicas, API.md §13.3), con «Cambiar».
    const listOf = (rs: Restriction[]) => rs.map((r) => r.subject ?? restrictionLabel(r.restriction_type).toLowerCase()).join(', ');
    const change = (base: string) => el('a', { class: 'glink-inline gchange', href: `${base}/alimentacion`, 'data-feedback-id': 'guests.menu.cocina.cambiar', 'data-feedback-label': 'Cambiar lo que indicaste' }, t('menu.change'));
    const had = eaters.filter((p) => p.restrictions.length);
    const kitchen = named
      ? fbIgnore(el('div', { class: 'banner gkitchen', id: 'menuKitchen' }, el('p', { class: 'gkitchen-title' }, icon('chef', 18), ' ', t('menu.kitchenFamily')),
        el('ul', null, ...eaters.map((p) => el('li', { dataset: { guest: p.guestId } }, renderMedal({ name: p.name ?? '·', size: 28 }),
          el('span', null, p.restrictions.length ? t('menu.kitchenHasOf', { name: p.name || t('menu.noName'), list: listOf(p.restrictions) }) : t('menu.kitchenNothing', { name: p.name || t('menu.noName') })),
          change(p.base))))))
      : had.length ? fbIgnore(el('p', { class: 'banner gkitchen', id: 'menuKitchen' }, icon('chef', 18), ' ', el('span', { dataset: { guest: eaters[0]!.guestId } }, t('menu.kitchenHas', { list: listOf(eaters[0]!.restrictions) })), change(eaters[0]!.base)))
        : null;

    const watches = eaters.some((p) => p.restrictions.some((r) => WARN.has(r.restriction_type)));
    const filters = new Set<Filter>();
    let selected = days.includes(todayMadrid()) ? todayMadrid() : days[0]!;
    const list = el('div', { id: 'menuList', role: 'tabpanel' });
    const watch = el('div', { id: 'familyWatchHost' });
    const count = el('p', { class: 'small gmenu-count', role: 'status' });
    const passes = (d: Dish, i: number) => [...filters].every((f) => (f === 'mine'
      ? Boolean(d.allergens_checked) && !hitsOf(d, i, eaters).some((h) => h.warn)
      : (d.diet_tags ?? []).includes(f) || (f === 'vegetariano' && (d.diet_tags ?? []).includes('vegano'))));
    const filterBar = el('div', { class: 'gfilters', role: 'group', 'aria-label': t('menu.filters') },
      ...(['vegano', 'vegetariano', 'sin_gluten', ...(watches ? ['mine'] : [])] as Filter[]).map((f) => el('button', {
        type: 'button', 'aria-pressed': 'false', dataset: { filter: f }, 'data-feedback-id': 'guests.menu.filtro.cambiar', 'data-feedback-label': 'Filtrar platos',
        onclick: (e: Event) => { if (filters.has(f)) filters.delete(f); else filters.add(f); (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(filters.has(f))); paint(); },
      }, f === 'mine' ? (named ? t('menu.filterMineFamily') : t('menu.filterMine')) : t(`diet.${f}`))));

    const paint = () => {
      const today = todayMadrid();
      const now = nowMadrid();
      const services = menu.services.filter((s) => s.date === selected).sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'));
      const open = selected === today ? nextMeal(menu, today, now) ?? null : services[0] ?? null;
      let shown = 0;
      let total = 0;
      const dayHits: Array<{ eater: Eater; dish: string; service: string; what: string }> = [];
      const unchecked: string[] = [];
      const body = (s: Menu['services'][number]) => {
        const dishes = s.dishes.map((d, i) => ({ d, i, hits: hitsOf(d, i, eaters) }));
        total += dishes.length;
        const visible = dishes.filter(({ d, i }) => passes(d, i));
        shown += visible.length;
        return el('div', null,
          visible.length ? el('ul', { class: 'gdishes' }, ...visible.map(({ d, i, hits }) => dish(d, i, ctx, hits, named))) : el('p', { class: 'muted small' }, t('menu.noneFiltered')),
          el('details', { class: 'gallall', 'data-feedback-id': 'guests.menu.alergenos.abrir', 'data-feedback-label': 'Todos los alérgenos de esta comida' },
            el('summary', null, t('menu.allAllergens')),
            el('ul', { class: 'small' }, ...s.dishes.map((d) => el('li', null, el('strong', null, d.name), ': ', allergens(d)?.textContent ?? t('menu.noneDeclared')))),
            el('p', { class: 'small' }, t('menu.ask'))));
      };
      const blocks = services.map((s) => {
        const dishes = s.dishes.map((d, i) => ({ d, i, hits: hitsOf(d, i, eaters) }));
        for (const { d, hits } of dishes) {
          for (const h of hits.filter((x) => x.warn)) dayHits.push({ eater: h.eater, dish: d.name, service: t(`menu.${s.type}`), what: h.what });
          if (!d.allergens_checked && had.length) unchecked.push(d.name);
        }
        const hit = dishes.some(({ hits }) => hits.some((h) => h.warn));
        const anyUnchecked = had.length > 0 && s.dishes.some((d) => !d.allergens_checked);
        const title = el('h3', null, t(`menu.${s.type}`), s.time ? el('span', { class: 'muted small' }, ` · ${hhmm(s.time)}`) : null);
        if (s === open) {
          const until = selected === today && s.time ? mins(hhmm(s.time)!) - mins(now) : null;
          return el('section', { class: 'card gcard gservice gmeal-open', id: 'menuNext' },
            el('p', { class: 'glabel' }, selected === today ? (until && until > 0 ? `${t('menu.nextMeal')} · ${t('program.inTime', { time: duration(until) })}` : t('menu.nextMeal')) : t('menu.firstMeal')),
            title, body(s));
        }
        const past = selected === today && Boolean(s.time) && hhmm(s.time)! < now;
        const fold = el('details', { class: `card gcard gservice gmeal-fold${past ? ' gmeal-past' : ''}`, 'data-feedback-id': 'guests.menu.comida.abrir', 'data-feedback-label': 'Abrir una comida' },
          el('summary', null,
            el('span', { class: 'gmeal-head' }, el('strong', null, t(`menu.${s.type}`), s.time ? ` · ${hhmm(s.time)}` : ''), past ? el('span', { class: 'chip small' }, t('menu.served')) : null),
            el('span', { class: 'muted small gmeal-names' }, s.dishes.map((d) => d.name).join(' · ')),
            hit ? el('span', { class: 'small gcross warn' }, icon('warn', 14), ' ', t('menu.foldHit')) : null,
            anyUnchecked ? el('span', { class: 'small gmeal-unchecked' }, icon('warn', 14), ' ', t('menu.foldUnchecked')) : null)) as HTMLDetailsElement;
        let filled = false;
        fold.addEventListener('toggle', () => { if (fold.open && !filled) { filled = true; fold.append(body(s)); } });
        // Las plegadas también cuentan para el recuento de los filtros.
        total += s.dishes.length;
        shown += s.dishes.filter((d, i) => passes(d, i)).length;
        return fold;
      });
      replace(list, ...blocks);
      count.textContent = filters.size ? `${t('menu.count', { shown, total })}${filters.has('mine') ? ` ${t('menu.countMine')}` : ''}` : '';
      count.hidden = !filters.size;
      // Familia: «Lo que vigilar, persona a persona», solo si algo coincide ese día.
      if (named && dayHits.length) {
        const calm = eaters.filter((p) => !dayHits.some((h) => h.eater === p)).map((p) => p.name || t('menu.noName'));
        replace(watch, fbIgnore(el('section', { class: 'card gcard gwatch', id: 'familyWatch', 'aria-label': t('menu.watchTitle') },
          el('p', { class: 'glabel' }, t('menu.watchTitle')),
          calm.length ? el('p', { class: 'small' }, t('menu.watchCalm', { names: new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(calm) })) : null,
          el('ul', null, ...eaters.filter((p) => dayHits.some((h) => h.eater === p)).map((p) => el('li', { class: 'gwatch-person', dataset: { guest: p.guestId } },
            renderMedal({ name: p.name ?? '·', size: 44 }),
            el('div', null, el('strong', null, p.name || t('menu.noName')),
              el('ul', { class: 'gwatch-list' }, ...dayHits.filter((h) => h.eater === p).map((h) => el('li', null, icon('warn', 14), el('span', null, el('strong', null, h.dish), ` · ${h.service} `, t('menu.contains', { what: h.what }))))))))),
          unchecked.length ? el('p', { class: 'small gmeal-unchecked' }, icon('warn', 14), ' ', t('menu.watchUnchecked', { list: [...new Set(unchecked)].join(', ') })) : null)));
      } else replace(watch);
    };
    const tabs = dayTabs(days, selected, (d) => { selected = d; paint(); }, 'menuDays', 'menuList');
    fbMark(tabs, 'guests.menu.dias.elegir', 'Elegir día del menú');
    replace(main, loaded?.stale ? staleNote(loaded.at) : null, head, familyLine(ctxs), kitchen, tabs, filterBar, count, watch, list, notice);
    paint();
  }).catch((error) => { if (alive) replace(main, failure(error)); });
  return () => { alive = false; };
}
