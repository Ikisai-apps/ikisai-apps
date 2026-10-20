/**
 * «Ikisai», la información de la casa para el outsider (MUELA-066, tanda 31; ruta `#/outsider/info`). Sustituye a la
 * Información práctica del retiro, que para quien vive cerca y pasa temporadas en la casa no tenía sentido:
 * - **Según el momento** (`duringOf`, con el día de Madrid): en la casa («Estás en la casa hasta el sábado, 17», llamar, tu
 *   cama), antes de venir («Llegas el martes, 20 (en 5 días)», cómo llegar, tu cama, aparcamiento) o sin estancia (nueva
 *   estancia, cómo llegar, tu cama habitual). Cada acceso abre su tarjeta o su sitio.
 * - **La guía en tarjetas** (En la casa · Al llegar), con la primera frase a la vista; los textos son los de Central
 *   (`info.*`). Los textos propios de la casa (`house.*`: comidas, frigorífico, aseos, wifi, lavandería, al irte), con su
 *   sitio, llegarán cuando Central los publique (petición de la tanda 31).
 * - **El plano de la casa**, dentro (el plano del centro de Central mientras no haya dibujo de zonas), el lugar y el contacto.
 * Se lee sin conexión (copia guardada); «Nueva estancia» necesita red y se desactiva con su motivo.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { bindOnline, el, icon, replace, type IconName } from '@ikisai/ui-kit';
import { commonText, contactPhone, INFO_KEYS } from '../app/common-texts.ts';
import { formatDate, t } from '../app/i18n.ts';
import type { MyStays, OutsiderApi, Stay } from '../app/outsider.ts';
import type { PortalReads } from '../app/portal.ts';
import { backLink, centralText, fbMark, staleNote } from './common.ts';
import { contactCard, placeCard } from './guide.ts';
import { todayMadrid } from './home.ts';
import { stayText } from './outsider.ts';
import { verEnPlano } from './plan.ts';

/** La estancia en la que está hoy (día de Madrid, el de salida incluido), o null. Función pura. */
export function duringOf(stays: Stay[], today = todayMadrid()): Stay | null {
  return stays.find((s) => s.from <= today && today <= s.to) ?? null;
}

export interface HouseOptions {
  api: OutsiderApi;
  reads: PortalReads;
  client: SyncClient;
  back: string;
  newStay(): void;
}

type InfoKey = (typeof INFO_KEYS)[number];
const GROUPS: Array<{ id: string; title: string; keys: InfoKey[] }> = [
  { id: 'o-casa', title: 'house.atHouse', keys: ['info.rules', 'info.facilities'] },
  { id: 'o-llegar', title: 'house.arriving', keys: ['info.arrival', 'info.parking', 'info.bring'] },
];
const ICONS: Record<InfoKey, IconName> = { 'info.arrival': 'pin', 'info.parking': 'pin', 'info.facilities': 'home', 'info.rules': 'info', 'info.bring': 'check' };

export function mountHouse(main: HTMLElement, options: HouseOptions): () => void {
  let alive = true;
  let unbind: (() => void) | null = null;

  function openCard(key: InfoKey): void {
    const card = main.querySelector<HTMLDetailsElement>(`details[data-key="${key}"]`);
    if (!card) return;
    card.open = true;
    card.scrollIntoView({ block: 'start' });
    card.querySelector('summary')?.focus();
  }

  function paint(data: MyStays | null, staleAt: string | null): void {
    unbind?.();
    unbind = null;
    const today = todayMadrid();
    const items = data?.items ?? [];
    const now = duringOf(items, today);
    const next = now ? null : [...items].filter((s) => s.from > today).sort((a, b) => a.from.localeCompare(b.from))[0] ?? null;
    const bedStay = now ?? next;
    const bedText = now ? stayText(now) : next ? stayText(next) : data?.default_bed ? [data.default_bed.space_name, data.default_bed.bed_label].filter(Boolean).join(' · ') : '';
    const phone = contactPhone();
    const day = (d: string) => formatDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
    const inDays = next ? Math.round((Date.parse(`${next.from}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) : 0;
    const has = (k: InfoKey) => Boolean(commonText(k));
    const tile = (ic: IconName, title: string, sub: string, action: { href?: string; onclick?: () => void }, id?: string) => {
      const children = [el('span', { class: 'ghouse-ico', 'aria-hidden': 'true' }, icon(ic, 20)), el('span', null, el('strong', null, title), sub ? el('span', { class: 'small' }, sub) : null)];
      return action.href
        ? el('a', { class: 'ghouse-tile', href: action.href, ...(id ? { id } : {}) }, ...children)
        : el('button', { type: 'button', class: 'ghouse-tile', ...(id ? { id } : {}), onclick: action.onclick }, ...children);
    };
    const bedTile = bedText ? tile('bed', next || now ? t('house.yourBed') : t('house.usualBed'), bedText, { onclick: () => { const plan = main.querySelector<HTMLDetailsElement>('#oiPlan'); if (plan) { plan.open = true; plan.scrollIntoView({ block: 'start' }); } } }) : null;
    let tiles: Array<HTMLElement | null>;
    if (now) {
      tiles = [phone ? tile('help', t('house.callTeam'), phone, { href: `tel:${phone.replace(/\s+/g, '')}` }, 'oiCall') : null, bedTile,
        has('info.rules') ? tile('info', t('info.rules'), '', { onclick: () => openCard('info.rules') }) : null];
    } else if (next) {
      tiles = [has('info.arrival') ? tile('pin', t('house.howToGet'), '', { onclick: () => openCard('info.arrival') }) : null, bedTile,
        has('info.parking') ? tile('pin', t('info.parking'), '', { onclick: () => openCard('info.parking') }) : null];
    } else {
      const newStay = tile('calendar', t('outsider.newStay'), t('house.pickDays'), { onclick: () => options.newStay() }, 'oiNewStay');
      unbind = bindOnline(newStay, { client: options.client, reason: t('outsider.needsNetwork') });
      tiles = [newStay, has('info.arrival') ? tile('pin', t('house.howToGet'), '', { onclick: () => openCard('info.arrival') }) : null, bedTile];
    }
    const groups = GROUPS.map((g) => ({ ...g, cards: (now ? g.keys : g.id === 'o-llegar' ? g.keys : g.keys).map((k) => {
      const text = commonText(k);
      if (!text) return null;
      const first = text.body.split(/\n+/).map((x) => x.trim()).find(Boolean)?.replace(/\*\*/g, '') ?? '';
      return el('details', { class: 'ghouse-card', 'data-key': k, 'data-feedback-id': 'guests.outsider.casa.tarjeta', 'data-feedback-label': 'Tarjeta de la guía de la casa' },
        el('summary', null, el('span', { class: 'ghouse-ico', 'aria-hidden': 'true' }, icon(ICONS[k], 20)), el('span', { class: 'ghouse-cardtext' }, el('strong', null, text.title ?? t(k)), el('span', { class: 'small' }, first))),
        centralText(text.body, text.spanishOnly));
    }).filter((x): x is NonNullable<typeof x> => Boolean(x)) })).filter((g) => g.cards.length);
    // En la casa, lo de la casa primero; antes de venir, cómo llegar.
    if (!now) groups.reverse();

    replace(main,
      backLink(options.back),
      staleAt ? staleNote(staleAt) : null,
      el('div', { class: 'pagehead ghouse-head' }, el('span', { class: 'ghouse-ico big', 'aria-hidden': 'true' }, icon('home', 26)),
        el('div', null, el('h2', { id: 'outsiderTitle' }, 'Ikisai'), el('p', { class: 'muted' }, t('house.intro')))),
      el('section', { class: `ghouse-moment ${now ? 'st-now' : next ? 'st-next' : 'st-none'}`, id: 'oiStay', 'data-feedback-id': 'guests.outsider.casa.momento', 'data-feedback-label': 'Según el momento' },
        el('p', { class: 'glabel' }, now ? t('house.nowLabel') : next ? t('house.beforeLabel') : t('house.noneLabel')),
        el('h3', null, now ? t('house.nowTitle', { day: day(now.to) }) : next ? t('house.nextTitle', { day: day(next.from), count: inDays }) : t('house.noneTitle')),
        el('div', { class: 'ghouse-tiles' }, ...tiles)),
      groups.length
        ? el('div', { id: 'infoSections' }, ...groups.map((g) => el('section', { class: 'gsec', id: g.id, 'aria-labelledby': `${g.id}H` },
          el('h3', { class: 'gsec-head', id: `${g.id}H` }, t(g.title)), el('div', { class: 'ghouse-grid' }, ...g.cards))))
        : el('p', { class: 'card gcard muted', id: 'infoSoon' }, t('info.soon')),
      el('section', { class: 'gsec ghouse-plan', id: 'o-plano', 'aria-labelledby': 'o-planoH' },
        el('h3', { class: 'gsec-head', id: 'o-planoH' }, t('house.plan')),
        verEnPlano({ place: bedText || null, whole: true, spaceId: bedStay ? bedStay.resource_bed_id ?? bedStay.resource_space_id ?? null : data?.default_bed ? data.default_bed.resource_bed_id ?? data.default_bed.resource_space_id ?? null : null, match: bedStay ? { space: bedStay.space_name, bed: bedStay.bed_label } : data?.default_bed ? { space: data.default_bed.space_name, bed: data.default_bed.bed_label } : null, label: t('house.planWhere'), id: 'oiPlan', reads: options.reads, mark: (n) => fbMark(n, 'guests.outsider.casa.plano', 'El plano de la casa') })),
      placeCard({ reads: options.reads }),
      contactCard(Boolean(now)));
  }

  paint(null, null);
  void options.api.stays().then((loaded) => { if (alive) paint(loaded.value, loaded.stale ? loaded.at : null); }).catch(() => undefined);
  return () => { alive = false; unbind?.(); };
}
