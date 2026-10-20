/**
 * Pestaña Outsider (O4b; MUELA-028 con el consolidado 071, tanda 31), para quien tiene nivel de casa `outsider`:
 * - **Tu estancia**: la que está en curso o la próxima, con su cama («Ver en el plano», dentro, con el plano del centro),
 *   las fechas y, si coincide con un retiro, el aviso (decisión del usuario: aviso, no bloqueo). «Otras estancias (N)» a un
 *   toque. Sin estancias, la cama habitual. «Nueva estancia» abre la hoja de llegada y salida del calendario.
 * - **Tus días en la casa**: un día de la estancia por tarjeta (o los próximos tres si no hay estancia) con la comida y la
 *   cena, y «Sugerir aquí» en cada hueco, con el día y el servicio ya puestos (sugerencia `plato_casa` a Food que aprueba
 *   cocina). Los platos de casa saldrán cuando Food publique su lectura (FD2). Debajo, «Otro día u otra comida» abre el
 *   formulario de siempre (cualquier día desde hoy y las seis comidas; PERDIDAS §1).
 * - **Mis propuestas**, plegado: los platos (Food) y los «Apuntarme» (Booking), con «Retirar».
 * Sin red, «Nueva estancia», «Sugerir aquí» y el formulario se desactivan con su motivo (`bindOnline`); lo demás se lee.
 * «Mis tareas» llega cuando Tasks publique el rol outsider.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { bindOnline, createProposalList, createSuggestionSource, el, icon, replace, toast } from '@ikisai/ui-kit';
import { SERVICE_TYPES, type ServiceType } from '@ikisai/domain-food';
import { describeError, isNetworkError, online } from '../app/client.ts';
import { formatDate, t } from '../app/i18n.ts';
import { hhmm } from '../app/labels.ts';
import type { PortalReads } from '../app/portal.ts';
import type { HouseMenu, MyStays, OutsiderApi, Stay } from '../app/outsider.ts';
import { failure, fbIgnore, fbMark, loading, staleNote } from './common.ts';
import { todayMadrid } from './home.ts';
import { verEnPlano } from './plan.ts';
import { allergens } from './program.ts';

export interface OutsiderActions {
  api: OutsiderApi;
  client: SyncClient;
  /** Abre la hoja de una estancia nueva (en el calendario). */
  newStay(): void;
  infoHash: string;
  /** Para el plano del centro en «Ver en el plano». */
  reads?: PortalReads | null;
}

/** La estancia en curso o la próxima (noches `[from, to)`: la de hoy sigue en curso el día de salida). */
export function currentStay(stays: Stay[], today = todayMadrid()): Stay | null {
  return [...stays].filter((s) => s.to >= today).sort((a, b) => a.from.localeCompare(b.from))[0] ?? null;
}

export function stayText(stay: Pick<Stay, 'space_name' | 'zone' | 'bed_label'>): string {
  return [stay.space_name, stay.bed_label, stay.zone].filter(Boolean).join(' · ');
}

const DAY = 86_400_000;
/** «Martes, 20 de octubre»: solo la primera letra en mayúscula (no «De Octubre»). */
const upperFirst = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const plus = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const SLOTS = ['comida', 'cena'] as const satisfies readonly ServiceType[];

export function mountOutsider(main: HTMLElement, header: HTMLElement | null, actions: OutsiderActions): () => void {
  let alive = true;
  let data: MyStays | null = null;
  /** El menú de casa (FD2): lo que hay en cada hueco de «Tus días». */
  let house: HouseMenu | null = null;
  let staleAt: string | null = null;
  /** Hueco con el formulario abierto («<día>:<servicio>»). */
  let openSlot: string | null = null;
  const unbinds: Array<() => void> = [];
  /** Los de los días se sueltan al repintar los días. */
  const dayUnbinds: Array<() => void> = [];
  const needsNet = <T extends HTMLElement>(button: T, into = unbinds): T => { into.push(bindOnline(button, { client: actions.client, reason: t('outsider.needsNetwork') })); return button; };
  const stayBox = el('div', { id: 'outsiderStay' }, loading());
  const days = el('div', { class: 'goutdays', id: 'outsiderMeals' });
  // «Mis propuestas»: los platos sugeridos (Food) y los «Apuntarme» (Booking), juntos.
  const sources = { food: createSuggestionSource(actions.client, { scope: 'mine', app: 'food' }), booking: createSuggestionSource(actions.client, { scope: 'mine', app: 'booking' }) };
  const mine = {
    list: async () => (await Promise.all([sources.food.list(), sources.booking.list().catch(() => [])])).flat(),
    withdraw: (item: Parameters<typeof sources.food.withdraw>[0]) => (item.app === 'booking' ? sources.booking : sources.food).withdraw(item),
  };
  const proposals = createProposalList({
    mode: 'mine', source: mine, onWithdraw: mine.withdraw,
    kinds: { plato_casa: { label: t('outsider.dishKind'), icon: 'chef' }, apuntarme: { label: t('outsider.joinKind'), icon: 'calendar' } },
    title: t('outsider.mine'), emptyText: t('outsider.mineEmpty'), feedbackId: 'guests.outsider.propuestas',
  });
  proposals.element.id = 'outsiderProposals';

  async function suggest(name: string, date: string, service: ServiceType, button: HTMLButtonElement): Promise<boolean> {
    const dish = name.trim();
    if (!dish) return false;
    if (!online()) { toast(t('outsider.needsNetwork')); return false; }
    button.disabled = true;
    try {
      await actions.api.suggestDish({ name: dish, date, service },
        t('outsider.dishSummary', { name: dish, service: t(`menu.${service}`), date: formatDate(date, { day: 'numeric', month: 'long' }) }));
      toast(t('outsider.dishSent'));
      await proposals.refresh();
      return true;
    } catch (error) {
      toast(isNetworkError(error) ? t('outsider.needsNetwork') : describeError(error));
      return false;
    } finally {
      button.disabled = false;
    }
  }

  function paintStay(): void {
    const today = todayMadrid();
    const stay = data ? currentStay(data.items) : null;
    const others = data ? data.items.filter((s) => s !== stay && s.to >= today).sort((a, b) => a.from.localeCompare(b.from)) : [];
    const offline = actions.client.status().network === 'offline';
    const bed = stay ? stayText(stay) : '';
    replace(stayBox,
      staleAt ? staleNote(staleAt) : null,
      offline ? el('p', { class: 'small goffline', id: 'outsiderOffline', role: 'status' }, icon('offline', 14), ' ', t('outsider.offline')) : null,
      stay
        ? el('div', null,
          el('p', { class: 'glodging-room', id: 'outsiderStayRoom' }, icon('bed', 20), ' ', el('strong', null, bed || t('outsider.noBed'))),
          el('p', { class: 'muted', id: 'outsiderStayDates' }, t(stay.from <= today ? 'outsider.stayNow' : 'outsider.stayNext', { from: formatDate(stay.from, { day: 'numeric', month: 'long' }), to: formatDate(stay.to, { day: 'numeric', month: 'long' }) })),
          stay.clash ? el('p', { class: 'banner warn', id: 'outsiderClash', role: 'status' }, icon('warn', 16), ' ', t('outsider.clash')) : null,
          bed ? verEnPlano({ place: bed, label: t('outsider.yourBed', { bed }), id: 'outsiderPlan', reads: actions.reads ?? null, mark: (n) => fbMark(n, 'guests.outsider.estancia.plano', 'Tu cama en el plano') }) : null)
        : el('p', { class: 'muted', id: 'outsiderNoStay' }, t('outsider.noStay')),
      !stay && data?.default_bed ? el('p', { class: 'muted small', id: 'outsiderDefaultBed' }, t('outsider.defaultBed', { bed: stayText({ space_name: data.default_bed.space_name, bed_label: data.default_bed.bed_label, zone: null }) })) : null,
      others.length ? el('details', { class: 'gothers', 'data-feedback-id': 'guests.outsider.estancia.otras', 'data-feedback-label': 'Otras estancias' },
        el('summary', null, t('outsider.otherStays', { count: others.length })),
        el('ul', null, ...others.map((s) => el('li', null, el('strong', null, `${formatDate(s.from, { day: 'numeric', month: 'short' })} – ${formatDate(s.to, { day: 'numeric', month: 'short' })}`),
          ` · ${stayText(s) || t('outsider.noBed')}`, s.source === 'staff' ? el('span', { class: 'small' }, ` · ${t('outsider.byTeam')}`) : null)))) : null);
    paintDays(stay);
  }

  /** Los servicios del menú de casa de ese día y esa comida. */
  const servicesOf = (day: string, service: string) => (house?.services ?? []).filter((s) => s.date === day && s.type === service && s.dishes.length);
  /** Junto al nombre de la comida: su hora, o «aún no hay nada». */
  function slotNote(day: string, service: string): HTMLElement {
    const found = servicesOf(day, service);
    const time = found.map((s) => hhmm(s.time)).find(Boolean);
    return el('span', { class: 'small' }, found.length ? (time ?? '') : t('outsider.nothingYet'));
  }
  /** Los platos del hueco, cada uno con su línea de alérgenos de #597 (también «sin revisar por cocina»). */
  function slotDishes(day: string, service: string): HTMLElement | null {
    const dishes = servicesOf(day, service).flatMap((s) => s.dishes);
    if (!dishes.length) return null;
    return el('ul', { class: 'goutdishes' }, ...dishes.map((d) => el('li', null, el('span', null, d.name), allergens(d))));
  }

  /** Un día por tarjeta, con la comida y la cena (lo que hay, del menú de casa) y «Sugerir aquí» desde hoy. */
  function paintDays(stay: Stay | null): void {
    for (const off of dayUnbinds.splice(0)) off();
    const today = todayMadrid();
    const list: string[] = [];
    if (stay) for (let d = stay.from; d <= stay.to && list.length < 31; d = plus(d, 1)) list.push(d);
    else for (let i = 0; i < 3; i++) list.push(plus(today, i));
    replace(days,
      el('h3', { class: 'gsub' }, stay ? t('outsider.yourDays') : t('outsider.nextDays')),
      el('p', { class: 'small' }, t('outsider.dishIntro')),
      ...list.map((d) => el('article', { class: `card gcard goutday${d === today ? ' today' : ''}`, dataset: { day: d } },
        el('h4', null, upperFirst(formatDate(d, { weekday: 'long', day: 'numeric', month: 'long' })), d === today ? el('span', { class: 'chip small' }, t('outsider.today')) : null),
        ...SLOTS.map((service) => {
          const key = `${d}:${service}`;
          const isOpen = openSlot === key;
          const canSuggest = d >= today;
          const input = el('input', { type: 'text', id: `dish-${key}`, maxlength: '160', autocomplete: 'off', 'aria-label': t('outsider.dishFor', { service: t(`menu.${service}`).toLowerCase(), day: formatDate(d, { weekday: 'long', day: 'numeric' }) }) }) as HTMLInputElement;
          const send = el('button', { type: 'submit', class: 'primary small', 'data-feedback-id': 'guests.outsider.plato.sugerir', 'data-feedback-label': 'Sugerir un plato' }, t('outsider.dishSend')) as HTMLButtonElement;
          return el('div', { class: 'goutslot', dataset: { service } },
            el('div', { class: 'goutslot-head' }, el('strong', null, t(`menu.${service}`)), slotNote(d, service),
              canSuggest ? needsNet(el('button', { type: 'button', class: 'ghost small', 'aria-expanded': String(isOpen), 'data-feedback-id': 'guests.outsider.plato.hueco', 'data-feedback-label': 'Sugerir aquí',
                onclick: () => { openSlot = isOpen ? null : key; paintStay(); if (!isOpen) (main.querySelector(`#dish-${CSS.escape(key)}`) as HTMLElement | null)?.focus(); } }, isOpen ? t('outsider.cancel') : t('outsider.suggestHere')), dayUnbinds) : null),
            slotDishes(d, service),
            isOpen ? el('form', { class: 'goutinline', onsubmit: (e: Event) => { e.preventDefault(); void suggest(input.value, d, service, send).then((ok) => { if (ok) { openSlot = null; paintStay(); } }); } }, input, send) : null);
        }))),
      otherForm());
  }

  /** «Otro día u otra comida»: el formulario de siempre (cualquier día desde hoy y las seis comidas). */
  function otherForm(): HTMLElement {
    const name = el('input', { id: 'dishName', type: 'text', maxlength: '160', autocomplete: 'off', required: '' }) as HTMLInputElement;
    const date = el('input', { id: 'dishDate', type: 'date', value: todayMadrid(), min: todayMadrid() }) as HTMLInputElement;
    const service = el('select', { id: 'dishService' }, ...SERVICE_TYPES.map((type) => el('option', { value: type, selected: type === 'comida' ? '' : null }, t(`menu.${type}`)))) as HTMLSelectElement;
    const send = needsNet(el('button', { type: 'submit', class: 'primary', id: 'dishSend', 'data-feedback-id': 'guests.outsider.plato.sugerir_otro', 'data-feedback-label': 'Sugerir un plato para otro día' }, t('outsider.dishSend')) as HTMLButtonElement, dayUnbinds);
    return el('details', { class: 'gothers', id: 'outsiderOtherDay', 'data-feedback-id': 'guests.outsider.plato.otro_dia', 'data-feedback-label': 'Otro día u otra comida' },
      el('summary', null, t('outsider.otherDay')),
      el('form', { class: 'gform', id: 'dishForm', onsubmit: (event: Event) => {
        event.preventDefault();
        if (!name.value.trim() || !date.value) { name.focus(); return; }
        void suggest(name.value, date.value, service.value as ServiceType, send).then((ok) => { if (ok) name.value = ''; });
      } },
      el('div', { class: 'gfield' }, el('label', { for: 'dishName' }, t('outsider.dishName')), name),
      el('div', { class: 'gfield gfield-row' },
        el('div', { class: 'gfield' }, el('label', { for: 'dishDate' }, t('outsider.dishDate')), date),
        el('div', { class: 'gfield' }, el('label', { for: 'dishService' }, t('outsider.dishService')), service)),
      send));
  }

  /** El menú de casa: si falla, los huecos siguen con «aún no hay nada» y se puede sugerir igual. */
  async function loadHouse(): Promise<void> {
    try {
      const loaded = await actions.api.houseMenu();
      if (!alive) return;
      house = loaded.value;
      paintDays(data ? currentStay(data.items) : null);
    } catch { /* sin menú de casa: lo de siempre */ }
  }

  async function loadStay(): Promise<void> {
    try {
      const loaded = await actions.api.stays();
      if (!alive) return;
      data = loaded.value;
      staleAt = loaded.stale ? loaded.at : null;
      paintStay();
    } catch (error) {
      if (alive) replace(stayBox, failure(error, () => void loadStay()));
    }
  }

  const newStay = needsNet(el('button', { type: 'button', class: 'ghost', id: 'newStay', 'data-feedback-id': 'guests.outsider.estancia.nueva', 'data-feedback-label': 'Nueva estancia', onclick: () => actions.newStay() }, icon('calendar', 16), t('outsider.newStay')));
  replace(main,
    header,
    el('div', { class: 'pagehead' }, el('h2', { id: 'outsiderTitle' }, t('outsider.title')), el('p', { class: 'muted' }, t('outsider.intro'))),
    fbIgnore(el('section', { class: 'card gcard', id: 'outsiderLodging', 'data-feedback-id': 'guests.outsider.estancia', 'data-feedback-label': 'Tu estancia' },
      el('h3', null, t('outsider.stay')),
      stayBox,
      el('div', { class: 'btnrow' },
        newStay,
        el('a', { class: 'ghost', href: actions.infoHash, id: 'outsiderInfo', 'data-feedback-id': 'guests.outsider.info.abrir', 'data-feedback-label': 'Ikisai, la información de la casa' }, icon('home', 16), t('outsider.house'))))),
    days,
    el('details', { class: 'gothers gmine', 'data-feedback-id': 'guests.outsider.propuestas.abrir', 'data-feedback-label': 'Mis propuestas' },
      el('summary', null, t('outsider.mine')), proposals.element));
  paintDays(null);
  void loadStay();
  void loadHouse();
  // La línea de sin red se repinta solo al cambiar la red (los botones los lleva `bindOnline`).
  let network = actions.client.status().network;
  const offStatus = actions.client.onStatus((st) => { if (alive && data && st.network !== network) { network = st.network; paintStay(); } });
  return () => { alive = false; proposals.destroy(); offStatus(); for (const off of [...unbinds.splice(0), ...dayUnbinds.splice(0)]) off(); };
}
