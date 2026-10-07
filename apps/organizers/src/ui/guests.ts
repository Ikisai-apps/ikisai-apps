/**
 * Asistentes (API.md §9.4): lista con estado y enlace, filtros, «Añadir asistente» y recordatorio del grupo (sin nombres).
 */
import { el, listRow, replace } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import type { PortalGuest, PortalLink } from '../app/api.ts';
import { dayLabel, missingText } from '../app/labels.ts';
import { groupReminder } from '../app/texts.ts';
import { copyText, fbIgnore } from './common.ts';
import { guestComplete, type RetreatData } from './retreat.ts';
import type { ViewContext } from './shell.ts';

type Filter = 'todos' | 'faltan' | 'completos';
let lastFilter: Filter = 'todos';

/** Estado de un asistente: etiqueta, tono del chip y detalle. */
export function guestState(g: PortalGuest, mode: string): { label: string; tone: 'ok' | 'warn' | 'pending'; detail: string } {
  if (g.missing.length) return { label: t('Faltan datos'), tone: 'warn', detail: t('Falta: {datos}', { datos: missingText(g.missing) }) };
  if (mode === 'ses' && !g.signed) return { label: t('Falta la firma'), tone: 'pending', detail: t('La hará {nombre} al abrir su enlace o al llegar', { nombre: g.display_name }) };
  return { label: t('Completo'), tone: 'ok', detail: t('Todo listo') };
}

/** Último enlace vivo de cada asistente (los revocados no cuentan). */
export function linksByGuest(links: PortalLink[] | undefined): Map<string, PortalLink> {
  const out = new Map<string, PortalLink>();
  for (const link of links ?? []) {
    const guest = link.scope.guest_id;
    if (!guest || link.revokedAt) continue;
    const prev = out.get(guest);
    if (!prev || prev.createdAt < link.createdAt) out.set(guest, link);
  }
  return out;
}

export function linkText(link: PortalLink | undefined): string {
  if (!link) return t('Enlace sin enviar');
  if (link.lastUsedAt) return t('Lo abrió el {fecha}', { fecha: dayLabel(link.lastUsedAt) });
  return t('Enlace enviado el {fecha}', { fecha: dayLabel(link.createdAt) });
}

export function renderGuestList(ctx: ViewContext, reservationId: string, data: RetreatData, _reload: () => void): HTMLElement {
  const { navigate, usage } = ctx;
  const list = data.guests.value;
  const host = el('div', { id: 'guests', 'data-feedback-id': 'organizers.asistentes.lista', 'data-feedback-label': 'Asistentes' });
  if (!list.confirmed) {
    replace(host, el('div', { class: 'empty', id: 'guestsNotConfirmed' }, el('strong', null, t('Aún no puedes añadir asistentes')), el('p', null, t('Podrás añadir a tus asistentes cuando la reserva esté confirmada.'))));
    return host;
  }
  const links = linksByGuest(data.links?.value.items);
  const incomplete = list.items.filter((g) => !guestComplete(g, list.mode)).length;
  const retreat = data.detail.value;
  const rows = el('div', { id: 'guestRows' });
  const filters = el('div', { class: 'segmented', role: 'tablist', 'aria-label': t('Filtrar asistentes'), 'data-feedback-id': 'organizers.asistentes.lista.filtro', 'data-feedback-label': 'Filtro' });

  function paint(): void {
    const visible = list.items.filter((g) => lastFilter === 'todos' || (lastFilter === 'completos') === guestComplete(g, list.mode));
    const counts: Record<Filter, number> = { todos: list.items.length, faltan: incomplete, completos: list.items.length - incomplete };
    replace(filters, ...(['todos', 'faltan', 'completos'] as Filter[]).map((f) => el('button', {
      type: 'button', role: 'tab', id: `filter-${f}`, class: lastFilter === f ? 'on' : '', 'aria-selected': lastFilter === f ? 'true' : 'false',
      onclick: () => { lastFilter = f; paint(); },
    }, `${f === 'todos' ? t('Todos') : f === 'faltan' ? t('Faltan datos') : t('Completos')} (${counts[f]})`)));
    if (!list.items.length) {
      replace(rows, el('div', { class: 'empty' }, el('strong', null, t('Aún no has añadido a nadie')), el('p', null, t('Añade a tus asistentes y envía a cada uno su enlace personal para que completen sus datos.'))));
      return;
    }
    replace(rows, fbIgnore(el('div', { class: 'list', role: 'list', 'aria-label': t('Asistentes') },
      ...visible.map((g) => {
        const state = guestState(g, list.mode);
        return listRow({
          id: g.id,
          title: g.display_name,
          meta: [state.detail, linkText(links.get(g.id))],
          chips: [el('span', { class: `chip small ${state.tone}` }, state.label)],
          label: t('Abrir la ficha de {nombre}', { nombre: g.display_name }),
          onClick: () => navigate(`#/retiro/${reservationId}/asistentes/${g.id}`),
        });
      }))));
  }

  replace(host,
    el('div', { class: 'btnrow orgtools' },
      el('button', { type: 'button', class: 'primary', id: 'addGuest', 'data-feedback-id': 'organizers.asistentes.lista.anadir', 'data-feedback-label': 'Añadir asistente', onclick: () => navigate(`#/retiro/${reservationId}/asistentes/nuevo`) }, t('Añadir asistente')),
      incomplete ? el('button', {
        type: 'button', class: 'ghost', id: 'groupReminder', 'data-feedback-id': 'organizers.asistentes.lista.recordatorio_grupo', 'data-feedback-label': 'Copiar recordatorio para el grupo',
        onclick: () => void usage.run('organizers.asistentes.recordatorio_grupo', () => copyText(groupReminder(retreat, incomplete), t('Recordatorio copiado. Pégalo en vuestro grupo.'))),
      }, t('Copiar recordatorio para el grupo')) : null),
    list.items.length ? filters : null,
    rows);
  paint();
  return host;
}
