/**
 * «Mis retiros» (`#/retiros`, API.md §9.17 a y c): los retiros de la cuenta por momento (en curso, próximos y pasados),
 * con el estado de la reserva y la etiqueta de equipo; los cancelados se abren en solo lectura. Con dirección, debajo,
 * «Todos los retiros» con un buscador, y la vista de un retiro sin ficha (`mountDirectionRetreat`): su programa y
 * «Apuntarme» en los vivos.
 */
import type { Suggestion } from '@ikisai/sync-client';
import { confirmDialog, el, icon, replace, toast } from '@ikisai/ui-kit';
import type { PortalRole } from '../app/api.ts';
import { describeError, errorCode } from '../app/client.ts';
import type { DirectionRetreat } from '../app/direction.ts';
import { formatDate, t } from '../app/i18n.ts';
import { hhmm } from '../app/labels.ts';
import type { ProgramItem } from '../app/portal.ts';
import { entriesFor, whenOf, type Retreat, type Roster, type Selection, type When } from '../app/roster.ts';
import { failure, loading, staleNote } from './common.ts';
import { retreatState, shortRange } from './frame.ts';

export interface RetreatsOptions {
  href(retreat: Retreat): string;
  /** A quién toca un retiro con «Todos», si no es de todos. */
  who(retreat: Retreat): string;
  /** Sus «Apuntarme» pendientes (O4b). */
  requests(): Promise<Map<string, Suggestion>>;
  /** Solo con dirección. */
  direction: null | {
    list(): Promise<{ value: DirectionRetreat[]; at: string; stale: boolean } | null>;
    href(reservationId: string): string;
  };
}

interface Row {
  id: string; title: string | null; start: string | null; end: string | null; status: string | null;
  role: PortalRole | null; who: string; href: string; extra?: string | null;
}

const ORDER: When[] = ['during', 'before', 'after'];
const GROUP_LABEL: Record<When, string> = { during: 'retreats.now', before: 'retreats.next', after: 'retreats.past' };

/** Estado de la reserva en texto («Confirmado», «Cancelado · solo lectura»…); vacío si no se conoce. */
export function statusText(status: string | null | undefined): string {
  return status && ['pre_reservada', 'confirmada', 'en_ejecucion', 'cerrada', 'cancelada', 'perdida'].includes(status) ? t(`status.${status}`) : '';
}

/** Etiqueta de una ficha de equipo: «Organizas», «Equipo» o «Dirección» (§9.17 d). */
export function roleText(role: PortalRole | null | undefined): string {
  return role ? t(`role.${role}`) : '';
}

function retreatRow(row: Row, today: string): HTMLElement {
  const moment = retreatState({ start: row.start, end: row.end }, today).text;
  const cancelled = row.status === 'cancelada' || row.status === 'perdida';
  return el('li', null, el('a', {
    class: `card gcard gretreat${cancelled ? ' gretreat-off' : ''}`, href: row.href, dataset: { reservation: row.id, ...(row.status ? { status: row.status } : {}) },
    'data-feedback-id': 'guests.retiros.lista.abrir', 'data-feedback-label': 'Abrir un retiro',
  },
  el('span', { class: 'gretreat-text' },
    el('strong', null, row.title ?? t('picker.unknown')),
    el('span', { class: 'small' }, [shortRange(row.start, row.end), moment].filter(Boolean).join(' · ')),
    el('span', { class: 'gtags' },
      statusText(row.status) ? el('span', { class: 'chip small gstatus' }, statusText(row.status)) : null,
      row.role ? el('span', { class: 'chip small grole' }, roleText(row.role)) : null,
      row.who ? el('span', { class: 'chip small' }, row.who) : null,
      row.extra ? el('span', { class: 'chip small' }, row.extra) : null)),
  icon('chevronRight', 16)));
}

/** Por momento: en curso, próximos (el más cercano primero) y pasados (el más reciente primero); sin fecha, al final. */
function grouped(rows: Row[], today: string, prefix: string): HTMLElement[] {
  const by = new Map<When, Row[]>(ORDER.map((w) => [w, []]));
  for (const row of rows) by.get(row.start ? whenOf(row, today) : 'before')!.push(row);
  by.get('before')!.sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999'));
  by.get('after')!.sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''));
  return ORDER.filter((w) => by.get(w)!.length).map((w) => el('section', { class: 'gretreats-group', id: `${prefix}-${w}` },
    el('h3', null, t(GROUP_LABEL[w])),
    el('ul', { class: 'gretreats' }, ...by.get(w)!.map((row) => retreatRow(row, today)))));
}

export function mountRetreats(main: HTMLElement, roster: Roster, selection: Selection, today: string, options: RetreatsOptions, header: HTMLElement | null): () => void {
  let alive = true;
  const mine: Row[] = roster.retreats.filter((r) => entriesFor(r, selection).length).map((r) => ({
    id: r.reservation_id, title: r.title, start: r.start, end: r.end, status: r.status,
    role: entriesFor(r, selection).map((e) => e.guest?.portal_role ?? null).find(Boolean) ?? null,
    who: options.who(r), href: options.href(r),
  }));
  const requests = el('div', { id: 'retreatsRequests' });
  const all = el('div', { id: 'retreatsAll' });
  replace(main,
    header,
    el('div', { class: 'pagehead' }, el('h2', null, t('retreats.title'))),
    mine.length ? el('div', { id: 'retreatsMine' }, ...grouped(mine, today, 'mine')) : el('p', { class: 'card gcard muted', id: 'retreatsEmpty' }, t('retreats.empty')),
    requests,
    all);

  // «Apuntarme» pendientes que aún no son retiros de la cuenta.
  void options.requests().then((map) => {
    if (!alive) return;
    const known = new Set(mine.map((r) => r.id));
    const pending = [...map.entries()].filter(([id, s]) => !known.has(id) && s.status === 'pending');
    if (!pending.length) return;
    replace(requests, el('section', { class: 'gretreats-group' }, el('h3', null, t('retreats.requests')),
      el('ul', { class: 'gretreats' }, ...pending.map(([id, s]) => el('li', { dataset: { reservation: id } }, el('p', { class: 'card gcard gretreat' },
        el('span', { class: 'gretreat-text' }, el('strong', null, String(s.detail?.title ?? s.summary ?? '')),
          el('span', { class: 'gtags' }, el('span', { class: 'chip small' }, t('retreats.requested'))))))))));
  });

  if (options.direction) {
    const direction = options.direction;
    replace(all, loading());
    void direction.list().then((loaded) => {
      if (!alive) return;
      if (!loaded) { replace(all); return; }
      const rows: Row[] = loaded.value.map((r) => ({
        id: r.reservation_id, title: r.title, start: r.start_date, end: r.end_date, status: r.status, role: null, who: '',
        href: direction.href(r.reservation_id), extra: r.joined ? t('retreats.inside') : null,
      }));
      const results = el('div', { id: 'retreatsAllList' });
      const search = el('input', {
        type: 'search', id: 'retreatsSearch', class: 'input', placeholder: t('retreats.search'), 'aria-label': t('retreats.search'), autocomplete: 'off',
        'data-feedback-id': 'guests.retiros.todos.buscar', 'data-feedback-label': 'Buscar un retiro',
        oninput: () => paint(),
      }) as HTMLInputElement;
      const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const paint = () => {
        const q = fold(search.value.trim());
        const shown = q ? rows.filter((r) => fold(r.title ?? '').includes(q)) : rows;
        replace(results, ...(shown.length ? grouped(shown, today, 'all') : [el('p', { class: 'muted', id: 'retreatsNone' }, t('retreats.noneMatch'))]));
      };
      paint();
      replace(all, el('section', { class: 'gretreats-all' },
        el('h2', null, t('retreats.all')),
        loaded.stale ? staleNote(loaded.at) : null,
        el('p', { class: 'small' }, t('retreats.allIntro')),
        search, results));
    });
  }

  return () => { alive = false; };
}

export interface DirectionRetreatOptions {
  reservationId: string;
  today: string;
  list(): Promise<{ value: DirectionRetreat[]; at: string; stale: boolean } | null>;
  program(reservationId: string): Promise<{ value: { items: ProgramItem[] }; at: string; stale: boolean } | null>;
  /** Se apunta y abre su ficha. */
  join(retreat: DirectionRetreat): Promise<void>;
  back: string;
}

/** Un retiro sin ficha, visto por dirección: cabecera, franja, «Apuntarme» si está vivo y su programa. */
export function mountDirectionRetreat(main: HTMLElement, options: DirectionRetreatOptions): () => void {
  let alive = true;
  replace(main, loading());
  void Promise.all([options.list(), options.program(options.reservationId).catch(() => null)]).then(([loaded, program]) => {
    if (!alive) return;
    const retreat = loaded?.value.find((r) => r.reservation_id === options.reservationId);
    if (!retreat) { replace(main, failure(Object.assign(new Error('fuera'), { code: 'OUT_OF_SCOPE' }))); return; }
    let busy = false;
    const joinButton = retreat.joinable && !retreat.joined ? el('button', {
      type: 'button', class: 'primary', id: 'directionJoin', 'data-feedback-id': 'guests.retiros.direccion.apuntarme', 'data-feedback-label': 'Apuntarme como dirección',
      onclick: async () => {
        if (busy) return;
        const ok = await confirmDialog({ title: t('retreats.joinTitle', { title: retreat.title ?? '' }), text: t('retreats.joinText'), confirmLabel: t('retreats.join') });
        if (!ok || !alive) return;
        busy = true;
        try {
          await options.join(retreat);
          toast(t('retreats.joinDone', { title: retreat.title ?? '' }));
        } catch (error) {
          const code = errorCode(error);
          toast(code === 'RESERVATION_NOT_OPEN' ? t('retreats.notOpen') : code === 'RESERVATION_NOT_CONFIRMED' ? t('retreats.notConfirmed') : describeError(error));
        } finally {
          busy = false;
        }
      },
    }, t('retreats.join')) : null;
    const items = [...(program?.value.items ?? [])].sort((a, b) => a.day.localeCompare(b.day) || (a.starts_at ?? '').localeCompare(b.starts_at ?? ''));
    const days = [...new Set(items.map((i) => i.day))];
    replace(main,
      el('a', { class: 'backlink', href: options.back, id: 'back', 'data-feedback-id': 'guests.retiros.direccion.volver', 'data-feedback-label': 'Volver a Mis retiros' }, icon('chevronLeft', 16), t('retreats.title')),
      loaded?.stale ? staleNote(loaded.at) : null,
      el('div', { class: 'card gcard', id: 'directionRetreat', dataset: { reservation: retreat.reservation_id } },
        el('h2', { id: 'retreatTitle' }, retreat.title ?? t('picker.unknown')),
        el('p', { class: 'small' }, [shortRange(retreat.start_date, retreat.end_date), retreatState({ start: retreat.start_date, end: retreat.end_date }, options.today).text].filter(Boolean).join(' · ')),
        statusText(retreat.status) ? el('p', { class: 'gtags' }, el('span', { class: 'chip small gstatus' }, statusText(retreat.status))) : null),
      retreat.joined ? null : el('p', { class: 'banner warn', id: 'directionBand', role: 'status' }, t('direction.band')),
      joinButton,
      el('section', { id: 'directionProgram' },
        el('h3', null, t('direction.program')),
        days.length ? el('div', null, ...days.map((day) => el('section', { class: 'gprogram-day' },
          el('h4', null, formatDate(day, { weekday: 'long', day: 'numeric', month: 'long' })),
          el('ul', { class: 'gprogram' }, ...items.filter((i) => i.day === day).map((i) => el('li', null,
            el('strong', null, [hhmm(i.starts_at), hhmm(i.ends_at)].filter(Boolean).join('–')), ' ', i.title, i.place ? el('span', { class: 'small' }, ` · ${i.place}`) : null))))))
          : el('p', { class: 'muted', id: 'directionNoProgram' }, t('direction.noProgram'))));
  });
  return () => { alive = false; };
}
