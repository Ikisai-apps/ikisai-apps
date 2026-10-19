/**
 * Asistentes (API.md §9.4; pasada única, zona 3), de arriba abajo:
 * - las solicitudes para apuntarse, enteras (`joins.ts`);
 * - «Cómo van tus asistentes» en cifras y las plazas del retiro, una por persona con su anillo y su etapa escrita;
 * - «Lo que falta, persona a persona»: grupos fijos (sin enlace, sin abrir, faltan datos, falta firmar y completos) con su
 *   recuento, y en cada fila su porqué y la acción que toca («Enviar su enlace» o «Recordar»).
 * Las plazas, las filas y la hoja rápida llevan nombres y alergias: van fuera de las capturas de «Ayuda y sugerencias».
 */
import { el, icon, listRow, openSheet, renderGroups, renderMedal, renderStats, replace, type Stat } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import { guestComplete, guestState, linksByGuest, linkText, reasonOf, stageOf, STAGE_GROUPS, STAGE_RING, type GuestTexts, type Stage } from '../app/guests-state.ts';
import { dayLabel, missingText, restrictionText } from '../app/labels.ts';
import { groupReminder, personReminder } from '../app/texts.ts';
import { copyText, fbIgnore, fbMark, needsNet } from './common.ts';
import { issued, rowFlushPending, sendGuestLink } from './guest-link.ts';
import type { RetreatData } from './retreat.ts';
import { pendingJoins, renderJoinRequests } from './joins.ts';
import type { ViewContext } from './shell.ts';

const TEXTS: GuestTexts = { t, day: dayLabel, missing: missingText };
const MAX_FREE_SEATS = 60;

export function renderGuestList(ctx: ViewContext, reservationId: string, data: RetreatData, reload: () => void): HTMLElement {
  const { navigate, usage } = ctx;
  const list = data.guests.value;
  const host = el('div', { id: 'guests', 'data-feedback-id': 'organizers.asistentes.lista', 'data-feedback-label': 'Asistentes' }) as HTMLElement & { destroy?: () => void };
  /** Botones atados a la red: se sueltan al repintar o al salir de la pestaña. */
  const releases: Array<() => void> = [];
  host.destroy = () => { for (const off of releases.splice(0)) off(); };
  // Solicitudes para apuntarse (Booking §26.3), encima de todo y sin cambios.
  const joins = renderJoinRequests(ctx, reservationId, data, reload);
  if (!list.confirmed) {
    replace(host, joins, el('div', { class: 'empty', id: 'guestsNotConfirmed' }, el('strong', null, t('Aún no puedes añadir asistentes')), el('p', null, t('Podrás añadir a tus asistentes cuando la reserva esté confirmada.'))));
    return host;
  }
  const retreat = data.detail.value;
  const linksKnown = data.links !== null;
  const links = linksByGuest(data.links?.value.items);
  const items = list.items.map((g) => {
    const link = links.get(g.id);
    return { g, link, stage: stageOf(g, link, list.mode, linksKnown) };
  });
  type Item = (typeof items)[number];
  const n = items.length;
  const complete = items.filter((x) => x.stage === 'completo').length;
  const incomplete = list.items.filter((g) => !guestComplete(g, list.mode)).length;
  const seats = retreat.final_guests ?? retreat.expected_guests;
  const groupTitle = (stage: Stage) => t(STAGE_GROUPS.find((x) => x.key === stage)!.title);

  // --- Acción de cada persona: «Enviar su enlace» (necesita red) o «Recordar» (copia, sin red) -------------------------
  function sendButton(x: Item, after?: () => void): HTMLButtonElement {
    const b = fbMark(el('button', { type: 'button', class: 'primary', 'data-act': 'sinenlace' }, t('Enviar su enlace')) as HTMLButtonElement,
      'organizers.asistentes.lista.enviar_enlace', 'Enviar su enlace');
    b.onclick = () => void (async () => {
      b.disabled = true;
      try {
        const ok = await sendGuestLink(ctx, {
          reservationId, guest: x.g, detail: retreat, mode: list.mode, link: x.link, feedback: 'fila',
          flushPending: () => rowFlushPending(ctx, reservationId, x.g),
        });
        if (ok) { after?.(); reload(); }
      } finally { b.disabled = false; }
    })();
    return b;
  }
  function remindButton(x: Item): HTMLButtonElement {
    const state = guestState(x.g, list.mode, TEXTS);
    return fbMark(el('button', {
      type: 'button', class: 'ghost', 'data-act': 'recordar',
      onclick: () => void usage.run('organizers.asistentes.lista.recordar', () => copyText(
        personReminder(x.g.display_name, retreat, x.g.missing, list.mode === 'ses' && !x.g.signed, issued.get(x.g.id)),
        t('Recordatorio para {nombre} copiado.', { nombre: x.g.display_name }))),
      'aria-label': `${t('Recordar')}: ${x.g.display_name} · ${state.detail}`,
    }, t('Recordar')) as HTMLButtonElement, 'organizers.asistentes.lista.recordar', 'Recordar');
  }
  /** La acción de la fila, o nada si está completo. Va envuelta para que Intro o Espacio no abran la ficha (fallo del kit). */
  function action(x: Item, bind: Array<() => void>, after?: () => void): HTMLElement | null {
    if (x.stage === 'completo') return null;
    if (x.stage === 'sinenlace') {
      const b = sendButton(x, after);
      const wrap = el('span', { class: 'orgrow-act', onkeydown: (e: Event) => e.stopPropagation() }, b);
      bind.push(needsNet(ctx, b));
      return wrap;
    }
    return el('span', { class: 'orgrow-act', onkeydown: (e: Event) => e.stopPropagation() }, remindButton(x));
  }

  // --- Hoja rápida de una plaza -------------------------------------------------------------------------------------
  function openQuick(x: Item): void {
    const state = guestState(x.g, list.mode, TEXTS);
    const bound: Array<() => void> = [];
    const restrictions = x.g.restrictions.map((r) => restrictionText({ ...r, severity: null }));
    const sheet = openSheet({
      title: x.g.display_name,
      panelAttrs: { id: 'guestQuick', 'data-feedback-ignore': '' },
      body: fbIgnore(el('div', { class: 'orgquick' },
        el('p', { class: 'chips' }, el('span', { class: `chip status ${state.tone}` }, state.label), el('span', { class: 'chip' }, groupTitle(x.stage))),
        el('p', null, reasonOf(x.stage, x.g, x.link, list.mode, TEXTS)),
        el('p', { class: 'muted small' }, linkText(x.link, TEXTS)),
        restrictions.length
          ? el('div', null, el('strong', null, t('Alimentación')), el('ul', { class: 'plainlist' }, ...restrictions.map((text) => el('li', null, text))))
          : null)),
      foot: el('div', { class: 'choices' },
        action(x, bound, () => void sheet.close(true)),
        el('button', { type: 'button', class: 'ghost', onclick: () => { void sheet.close(true); navigate(`#/retiro/${reservationId}/asistentes/${x.g.id}`); } }, t('Abrir la ficha'))),
      onClose: () => { for (const off of bound.splice(0)) off(); },
    });
  }

  // --- Cifras y plazas ----------------------------------------------------------------------------------------------
  const stats: Stat[] = [
    { value: `${complete}/${n}`, label: t('completos'), tone: n && complete === n ? 'ok' : null },
    { value: n - complete, label: t('por completar'), tone: n - complete ? 'warn' : 'ok' },
  ];
  if (seats != null) stats.push({ value: t('{a} de {b}', { a: n, b: seats }), label: t('plazas con nombre') });
  const summary = fbMark(el('section', { id: 'guestSummary', class: 'orgguest-summary' }, renderStats(stats, { label: t('Cómo van tus asistentes') })),
    'organizers.asistentes.lista.resumen', 'Resumen de asistentes');

  const free = seats != null ? Math.min(MAX_FREE_SEATS, Math.max(0, seats - n)) : 0;
  const legendGroups = STAGE_GROUPS.filter((s) => items.some((x) => x.stage === s.key));
  const seatGrid = n || free ? fbIgnore(el('div', { class: 'orgseats' },
    el('ul', { class: 'orgseat-legend' },
      ...legendGroups.map((s) => {
        const count = items.filter((x) => x.stage === s.key).length;
        return el('li', { class: `orgseat-key orgseat-${s.key}` }, el('span', { class: 'orgseat-swatch', 'aria-hidden': 'true' }), `${t(s.title)} · ${count}`);
      }),
      free ? el('li', { class: 'orgseat-key orgseat-free' }, el('span', { class: 'orgseat-swatch', 'aria-hidden': 'true' }), `${t('Libre')} · ${free}`) : null),
    el('ul', { id: 'guestSeats', class: 'orgseat-grid', 'aria-label': t('Plazas del retiro') },
      ...items.map((x) => el('li', null, el('button', {
        type: 'button', class: `orgseat orgseat-${x.stage}`, 'data-guest': x.g.id, 'aria-label': `${x.g.display_name} · ${groupTitle(x.stage)}`,
        onclick: () => openQuick(x),
      },
      el('span', { class: 'orgseat-ring', style: `--p:${STAGE_RING[x.stage]}` }, renderMedal({ name: x.g.display_name, size: 44 })),
      el('span', { class: 'orgseat-name', 'aria-hidden': 'true' }, x.g.display_name.split(/\s+/)[0] ?? x.g.display_name),
      x.g.restrictions.length ? el('span', { class: 'orgseat-food' }, icon('chef', 14), el('span', { class: 'vh' }, t('Con requisitos de alimentación'))) : null))),
      ...Array.from({ length: free }, () => el('li', { class: 'orgseat-free', 'aria-label': t('Plaza libre') },
        el('span', { class: 'orgseat-plus', 'aria-hidden': 'true' }, '+'), el('span', { class: 'orgseat-name', 'aria-hidden': 'true' }, t('Libre'))))))) : null;

  const waitingPeople = pendingJoins(data.joinRequests).reduce((sum, j) => sum + j.persons.length, 0);
  const waiting = waitingPeople ? el('p', { class: 'orgseat-waiting' }, waitingPeople === 1
    ? t('1 persona espera plaza: decide arriba en «Solicitudes para apuntarse».')
    : t('{n} personas esperan plaza: decide arriba en «Solicitudes para apuntarse».', { n: waitingPeople })) : null;

  // --- Lo que falta, persona a persona ------------------------------------------------------------------------------
  const rows = fbIgnore(el('div', { id: 'guestRows' }));
  if (!n) {
    replace(rows, el('div', { class: 'empty' }, el('strong', null, t('Aún no has añadido a nadie')), el('p', null, t('Añade a tus asistentes y envía a cada uno su enlace personal para que completen sus datos.'))));
  } else {
    const groups = STAGE_GROUPS.map((s) => ({
      key: s.key, title: t(s.title), summary: t(s.summary), items: items.filter((x) => x.stage === s.key),
      ...(s.key === 'completo' ? { open: false } : {}),
    })).filter((grp) => grp.items.length);
    const tone = new Map(STAGE_GROUPS.map((s) => [s.key, s.tone]));
    const view = renderGroups<Item>({
      label: t('Asistentes por lo que les falta'),
      groups,
      toneOf: (x) => tone.get(x.stage),
      row: (x) => {
        const act = action(x, releases);
        const row = listRow({
          id: x.g.id,
          title: x.g.display_name,
          meta: [reasonOf(x.stage, x.g, x.link, list.mode, TEXTS), linkText(x.link, TEXTS)],
          chips: [el('span', { class: `chip small ${guestState(x.g, list.mode, TEXTS).tone}` }, guestState(x.g, list.mode, TEXTS).label)],
          label: t('Abrir la ficha de {nombre}', { nombre: x.g.display_name }),
          onClick: () => navigate(`#/retiro/${reservationId}/asistentes/${x.g.id}`),
          actions: act ? [act] : [],
        });
        row.dataset.stage = x.stage;
        return row;
      },
    });
    replace(rows,
      linksKnown ? null : el('p', { class: 'muted', id: 'guestLinksUnknown' }, t('No se ha podido leer el estado de los enlaces.')),
      view.element);
  }

  replace(host,
    joins,
    n ? summary : null,
    seatGrid,
    waiting,
    el('h3', { class: 'orgguests-title' }, t('Lo que falta, persona a persona')),
    el('div', { class: 'btnrow orgtools' },
      el('button', { type: 'button', class: 'primary', id: 'addGuest', 'data-feedback-id': 'organizers.asistentes.lista.anadir', 'data-feedback-label': 'Añadir asistente', onclick: () => navigate(`#/retiro/${reservationId}/asistentes/nuevo`) }, t('Añadir asistente')),
      incomplete ? el('button', {
        type: 'button', class: 'ghost', id: 'groupReminder', 'data-feedback-id': 'organizers.asistentes.lista.recordatorio_grupo', 'data-feedback-label': 'Copiar recordatorio para el grupo',
        onclick: () => void usage.run('organizers.asistentes.recordatorio_grupo', () => copyText(groupReminder(retreat, incomplete), t('Recordatorio copiado. Pégalo en vuestro grupo.'))),
      }, t('Copiar recordatorio para el grupo')) : null),
    rows);
  return host;
}

