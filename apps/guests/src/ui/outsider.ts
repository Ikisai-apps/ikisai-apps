/**
 * Pestaña Outsider (O4b; preparación de O4 §2.2): para quien tiene nivel de casa `outsider` (`profile.houseLevel`).
 * - **Tu estancia:** la que está en curso o la próxima, con su habitación y cama; si coincide con un retiro, el aviso
 *   (decisión del usuario: aviso, no bloqueo). Sin estancias, la cama habitual. «Nueva estancia» abre el calendario
 *   para elegir los días.
 * - **Comidas:** «Sugerir un plato» para el menú de casa (Food, sugerencia `plato_casa` que aprueba cocina) y «Mis
 *   propuestas» (`createSuggestionSource` del kit 0.34, modo `mine`), con los platos y los «Apuntarme» (Booking).
 * - **Cómo llegar:** la información práctica.
 * «Mis tareas» llega cuando Tasks publique el rol outsider; el menú de casa, cuando Food publique su lectura de portal.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { createProposalList, createSuggestionSource, el, icon, replace, toast } from '@ikisai/ui-kit';
import { SERVICE_TYPES, type ServiceType } from '@ikisai/domain-food';
import { describeError, isNetworkError, online } from '../app/client.ts';
import { formatDate, t } from '../app/i18n.ts';
import type { MyStays, OutsiderApi, Stay } from '../app/outsider.ts';
import { card, failure, fbIgnore, loading, staleNote } from './common.ts';
import { todayMadrid } from './home.ts';

export interface OutsiderActions {
  api: OutsiderApi;
  client: SyncClient;
  /** Abre el calendario para elegir los días de una estancia nueva. */
  newStay(): void;
  infoHash: string;
}

/** La estancia en curso o la próxima (noches `[from, to)`: la de hoy sigue en curso el día de salida). */
export function currentStay(stays: Stay[], today = todayMadrid()): Stay | null {
  return [...stays].filter((s) => s.to >= today).sort((a, b) => a.from.localeCompare(b.from))[0] ?? null;
}

export function stayText(stay: Pick<Stay, 'space_name' | 'zone' | 'bed_label'>): string {
  return [stay.space_name, stay.bed_label, stay.zone].filter(Boolean).join(' · ');
}

export function mountOutsider(main: HTMLElement, header: HTMLElement | null, actions: OutsiderActions): () => void {
  let alive = true;
  const stayBox = el('div', { id: 'outsiderStay' }, loading());
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

  function paintStay(data: MyStays, staleAt: string | null): void {
    const stay = currentStay(data.items);
    const today = todayMadrid();
    replace(stayBox,
      staleAt ? staleNote(staleAt) : null,
      stay
        ? el('div', null,
          el('p', { class: 'glodging-room', id: 'outsiderStayRoom' }, icon('bed', 20), ' ', el('strong', null, stayText(stay) || t('outsider.noBed'))),
          el('p', { class: 'muted', id: 'outsiderStayDates' }, t(stay.from <= today ? 'outsider.stayNow' : 'outsider.stayNext', { from: formatDate(stay.from, { day: 'numeric', month: 'long' }), to: formatDate(stay.to, { day: 'numeric', month: 'long' }) })),
          stay.clash ? el('p', { class: 'banner warn', id: 'outsiderClash', role: 'status' }, icon('warn', 16), ' ', t('outsider.clash')) : null)
        : el('p', { class: 'muted', id: 'outsiderNoStay' }, t('outsider.noStay')),
      !stay && data.default_bed ? el('p', { class: 'muted small', id: 'outsiderDefaultBed' }, t('outsider.defaultBed', { bed: stayText({ space_name: data.default_bed.space_name, bed_label: data.default_bed.bed_label, zone: null }) })) : null);
  }

  async function loadStay(): Promise<void> {
    try {
      const loaded = await actions.api.stays();
      if (alive) paintStay(loaded.value, loaded.stale ? loaded.at : null);
    } catch (error) {
      if (alive) replace(stayBox, failure(error, () => void loadStay()));
    }
  }

  // «Sugerir un plato»: nombre, día y servicio. Sin red no se finge que se envió.
  const name = el('input', { id: 'dishName', type: 'text', maxlength: '160', autocomplete: 'off', required: '' }) as HTMLInputElement;
  const date = el('input', { id: 'dishDate', type: 'date', value: todayMadrid(), min: todayMadrid() }) as HTMLInputElement;
  const service = el('select', { id: 'dishService' }, ...SERVICE_TYPES.map((type) => el('option', { value: type, selected: type === 'comida' ? '' : null }, t(`menu.${type}`)))) as HTMLSelectElement;
  const send = el('button', { type: 'submit', class: 'primary', id: 'dishSend', 'data-feedback-id': 'guests.outsider.plato.sugerir', 'data-feedback-label': 'Sugerir un plato' }, t('outsider.dishSend')) as HTMLButtonElement;
  const form = el('form', { class: 'gform', id: 'dishForm', onsubmit: (event: Event) => { event.preventDefault(); void suggest(); } },
    el('div', { class: 'gfield' }, el('label', { for: 'dishName' }, t('outsider.dishName')), name),
    el('div', { class: 'gfield gfield-row' },
      el('div', { class: 'gfield' }, el('label', { for: 'dishDate' }, t('outsider.dishDate')), date),
      el('div', { class: 'gfield' }, el('label', { for: 'dishService' }, t('outsider.dishService')), service)),
    send);

  async function suggest(): Promise<void> {
    const dish = name.value.trim();
    if (!dish || !date.value) { name.focus(); return; }
    if (!online()) { toast(t('outsider.needsNetwork')); return; }
    send.disabled = true;
    try {
      const type = service.value as ServiceType;
      await actions.api.suggestDish({ name: dish, date: date.value, service: type },
        t('outsider.dishSummary', { name: dish, service: t(`menu.${type}`), date: formatDate(date.value, { day: 'numeric', month: 'long' }) }));
      name.value = '';
      toast(t('outsider.dishSent'));
      await proposals.refresh();
    } catch (error) {
      toast(isNetworkError(error) ? t('outsider.needsNetwork') : describeError(error));
    } finally {
      send.disabled = false;
    }
  }

  replace(main,
    header,
    el('div', { class: 'pagehead' }, el('h2', { id: 'outsiderTitle' }, t('outsider.title')), el('p', { class: 'muted' }, t('outsider.intro'))),
    fbIgnore(card({ id: 'outsiderLodging', 'data-feedback-id': 'guests.outsider.estancia', 'data-feedback-label': 'Tu estancia' },
      el('h3', null, t('outsider.stay')),
      stayBox,
      el('div', { class: 'btnrow' },
        el('button', { type: 'button', class: 'ghost', id: 'newStay', 'data-feedback-id': 'guests.outsider.estancia.nueva', 'data-feedback-label': 'Nueva estancia', onclick: () => actions.newStay() }, icon('calendar', 16), t('outsider.newStay')),
        el('a', { class: 'ghost', href: actions.infoHash, id: 'outsiderInfo', 'data-feedback-id': 'guests.outsider.info.abrir', 'data-feedback-label': 'Cómo llegar' }, icon('pin', 16), t('outsider.howToGet'))))),
    card({ id: 'outsiderMeals', 'data-feedback-id': 'guests.outsider.comidas', 'data-feedback-label': 'Comidas' },
      el('h3', null, t('outsider.meals')),
      el('p', { class: 'muted small' }, t('outsider.dishIntro')),
      form),
    proposals.element);
  void loadStay();
  return () => { alive = false; proposals.destroy(); };
}
