/**
 * Propuesta de Ikisai (fase 2 y 3, API.md §13.3; Booking B12 y #610; pasada única, zona 2). Decisión del usuario (7-10-2026): el
 * organizador **no acepta** desde el portal. Ve la propuesta vigente (la aceptada o la enviada más reciente) con sus
 * líneas, condiciones y tramos de cancelación, y puede pulsar «Quiero confirmar» o enviar un comentario: las dos cosas
 * avisan al comercial y quedan con su estado.
 * - Las versiones anteriores (sustituidas y caducadas) van plegadas y siempre marcadas; solo la vigente lleva acciones.
 * - «Comparar versiones»: línea a línea y al pie (`app/proposal-state.ts`).
 * - Precio: siempre «precio medio por persona · el total entre N personas», nunca un «por persona» suelto.
 * - Los botones que avisan a Ikisai necesitan red (`bindOnline`).
 */
import { bindOnline, confirmDialog, el, fieldAttrs, openSheet, replace, toast } from '@ikisai/ui-kit';
import type { PortalProposal, PortalRequest } from '../app/api.ts';
import { describeError } from '../app/client.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { commonText, textParagraphs } from '../app/common-texts.ts';
import { dateRange, dayLabel } from '../app/labels.ts';
import { compareVersions, proposalVersions, type LineChange } from '../app/proposal-state.ts';
import { averagePrice } from '../app/quote.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

const REQUEST_STATUS: Record<string, string> = { enviada: L('Enviada'), vista: L('Vista por Ikisai'), respondida: L('Respondida') };
const REQUEST_KIND: Record<string, string> = { quiere_confirmar: L('Quiero confirmar'), comentario: L('Comentario') };
/** Unidades de las tarifas de Booking, en lenguaje claro. */
const UNIT_LABELS: Record<string, string> = {
  persona_noche: L('por persona y noche'), persona_dia: L('por persona y día'), dia: L('por día'), noche: L('por noche'), estancia: L('por estancia'),
};

const day = (date: string) => dayLabel(`${date.slice(0, 10)}T12:00:00Z`);
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const minusDays = (date: string, days: number) => { const x = new Date(`${date.slice(0, 10)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - days); return x.toISOString().slice(0, 10); };

type View = 'budget' | 'compare';

export function renderProposal(ctx: ViewContext, reservationId: string): HTMLElement {
  const host = el('div', { id: 'proposal', 'data-feedback-id': 'organizers.propuesta', 'data-feedback-label': 'Propuesta' }, loading());
  let alive = true;
  let view: View = 'budget';
  let compareWith: number | null = null;
  /** Ataduras a la red de los botones de esta pintura: se sueltan al repintar y al salir. */
  let offline: Array<() => void> = [];
  let last: { proposals: PortalProposal[]; requests: PortalRequest[]; staleAt: string | null } | null = null;
  const money = (n: number | string) => i18n.formatMoney(Number(n));
  const needsNet = <T extends HTMLElement>(button: T): T => {
    offline.push(bindOnline(button, { client: ctx.client, reason: t('Sin conexión: para avisar a Ikisai necesitas red.'), retry: () => void load() }));
    return button;
  };
  const release = () => { for (const off of offline) off(); offline = []; };

  async function load(): Promise<void> {
    try {
      // Con historial (Booking #610). Sin red y sin copia con historial (la primera vez), la lectura de siempre, que sí la tiene.
      const proposalsRead = ctx.api.proposals(reservationId, { history: true })
        .catch((error: unknown) => ctx.api.proposals(reservationId).catch(() => { throw error; }));
      const [proposals, requests] = await Promise.all([proposalsRead, ctx.api.myRequests(reservationId)]);
      if (!alive) return;
      last = { proposals: proposals.value.items, requests: requests.value.items, staleAt: (proposals.stale && proposals.at) || (requests.stale && requests.at) || null };
      paint();
    } catch (error) {
      if (alive) { release(); replace(host, failure(error, () => void load())); }
    }
  }

  async function send(kind: 'quiere_confirmar' | 'comentario', proposalId: string | null, message: string | null): Promise<boolean> {
    try {
      const ask = () => ctx.api.request(reservationId, { kind, proposal_id: proposalId, message });
      if (kind === 'quiere_confirmar') await ctx.usage.run('organizers.propuesta.quiero_confirmar', ask);
      else await ctx.usage.run('organizers.propuesta.comentario', ask);
      toast(kind === 'quiere_confirmar' ? t('Hecho. El equipo de Ikisai te contactará para confirmar.') : t('Comentario enviado a Ikisai.'));
      void load();
      return true;
    } catch (error) {
      toast(describeError(error));
      return false;
    }
  }

  function commentSheet(proposalId: string | null): void {
    const area = el('textarea', { ...fieldAttrs({ id: 'organizers.propuesta.comentario', label: 'Comentario sobre la propuesta', entity: 'booking.portal_requests', prop: 'message', type: 'text', sensitivity: 'internal' }), id: 'commentText', rows: '5', maxlength: '2000', placeholder: t('Escribe tu comentario o tu pregunta sobre la propuesta.') }) as HTMLTextAreaElement;
    const sendButton = el('button', { type: 'button', class: 'primary', id: 'sendComment', onclick: async () => {
      const text = area.value.trim();
      if (!text) { area.focus(); return; }
      if (await send('comentario', proposalId, text)) void sheet.close(true);
    } }, t('Enviar'));
    const sheet = openSheet({
      title: t('Comentario sobre la propuesta'),
      body: el('label', { class: 'field' }, el('span', null, t('Tu comentario')), area),
      foot: el('div', { class: 'btnrow' }, sendButton),
    });
  }

  const personsText = (n: number) => (n === 1 ? t('1 persona') : t('{n} personas', { n }));
  const averageText = (total: number | string, persons: number | null) => {
    const average = averagePrice(total, persons);
    return average === null ? null : t('Precio medio por persona: {importe} · el total entre {n} personas', { importe: money(average), n: persons ?? 0 });
  };
  const lineDetail = (l: PortalProposal['lines'][number]) => {
    const discount = Number(l.discount_pct) ? ` · −${i18n.formatNumber(Number(l.discount_pct))} %` : '';
    if (l.unit === 'porcentaje') return ` · ${i18n.formatNumber(Number(l.unit_amount))} %${discount}`;
    const unit = UNIT_LABELS[l.unit] ? ` ${t(UNIT_LABELS[l.unit]!)}` : '';
    return ` · ${i18n.formatNumber(Number(l.quantity))} × ${money(l.unit_amount)}${unit}${discount}`;
  };

  /** La tarjeta de una versión. Solo la vigente y solo si está enviada lleva acciones. */
  function proposalCard(p: PortalProposal, options: { current: boolean; requests: PortalRequest[] }): HTMLElement {
    const accepted = p.status === 'aceptada';
    const c = p.conditions;
    const old = p.status === 'sustituida' || p.status === 'caducada';
    const expired = p.status === 'enviada' && !!p.valid_until && p.valid_until.slice(0, 10) < todayLocal();
    const average = p.persons ? averageText(p.total, p.persons) : null;
    const asked = options.current ? options.requests.find((r) => r.kind === 'quiere_confirmar' && r.proposal_id === p.id) : undefined;
    const tiers = !c?.text && c?.tiers.length ? c.tiers : [];
    const withDates = tiers.length > 0 && !!p.start_date;
    const precios = fbMark(el('table', { class: 'orgquote' }, el('tbody', null, ...p.lines.map((l) => el('tr', null,
      el('td', null, l.description, el('span', { class: 'muted small' }, lineDetail(l))),
      el('td', { class: 'num' }, l.amount === null ? '' : money(l.amount)))))), 'organizers.propuesta.precios', 'Los precios de esta propuesta');
    let actions: HTMLElement | null = null;
    if (options.current && p.status === 'enviada') {
      const want = asked
        ? el('p', { id: 'wantSent', class: 'orgwantsent', role: 'status' }, el('strong', null, t('Has pedido confirmar el {fecha}', { fecha: dayLabel(asked.created_at) })), ' ',
          el('span', null, t('Ikisai te contactará para cerrar la reserva y la señal.')))
        : needsNet(fbMark(el('button', { type: 'button', class: 'primary', id: 'wantConfirm', onclick: async () => {
          if (await confirmDialog({ title: t('¿Quieres confirmar el retiro?'), text: t('Avisaremos al equipo de Ikisai, que te contactará para cerrar la reserva y la señal. Aún no se cobra nada.'), confirmLabel: t('Quiero confirmar') })) {
            await send('quiere_confirmar', p.id, null);
          }
        } }, t('Quiero confirmar')), 'organizers.propuesta.quiero_confirmar', 'Quiero confirmar'));
      actions = el('div', { class: 'btnrow orgtools' }, want,
        needsNet(fbMark(el('button', { type: 'button', class: 'ghost', id: 'sendCommentOpen', onclick: () => commentSheet(p.id) }, t('Enviar un comentario')), 'organizers.propuesta.comentario', 'Enviar un comentario')));
    }
    const card = section(accepted ? t('Propuesta aceptada') : t('Propuesta de Ikisai'), { class: 'card orgcard orgproposal', ...(options.current ? { id: `proposal-${p.version}` } : {}) },
      el('p', { class: 'chips' },
        p.status === 'sustituida' ? el('span', { class: 'chip status' }, t('Sustituida'))
          : p.status === 'caducada' ? el('span', { class: 'chip status' }, t('Caducada'))
            : el('span', { class: `chip status ${accepted ? 'ok' : 'warn'}` }, accepted ? t('Aceptada') : t('Pendiente de confirmar')),
        el('span', { class: 'muted small' }, ` ${t('Versión {n}', { n: p.version })}`),
        p.nature === 'orientativa' ? el('span', { class: 'chip small' }, t('Orientativa')) : null,
        expired && !old ? el('span', { class: 'chip small warn' }, t('Plazo vencido el {fecha}', { fecha: day(p.valid_until!) })) : null),
      el('p', null, dateRange(p.start_date, p.end_date), p.persons ? ` · ${personsText(p.persons)}` : ''),
      el('dl', { class: 'kv orgtotals' },
        el('dt', null, c?.prices_include_vat === false ? t('Total') : t('Total con IVA incluido')), el('dd', { class: 'proposalTotal' }, money(p.total)),
        el('dt', null, t('de los que IVA ({n} %)', { n: i18n.formatNumber(Number(c?.vat_rate ?? 0)) })), el('dd', null, money(p.vat_amount)),
        el('dt', null, t('Señal para reservar')), el('dd', null, money(p.deposit_amount)),
        p.valid_until ? el('dt', null, t('Válida hasta')) : null, p.valid_until ? el('dd', null, day(p.valid_until)) : null),
      average ? el('p', options.current ? { id: 'proposalAverage', class: 'muted' } : { class: 'muted' }, average) : null,
      el('h4', null, t('Los precios de esta propuesta')),
      precios,
      el('p', { class: 'muted small' }, t('Cada tarifa tiene su precio; el total sale de multiplicarlo por personas, noches o días.')),
      p.includes ? el('p', null, el('strong', null, t('Incluye: ')), p.includes) : null,
      p.excludes ? el('p', null, el('strong', null, t('No incluye: ')), p.excludes) : null,
      // El texto llega de Booking con las cifras ya resueltas (#358): se pinta tal cual y nunca se calculan fechas. Los
      // tramos, solo si no hay texto; con el día de llegada, cada uno con su «hasta el».
      c ? el('details', { class: 'orgconditions' }, el('summary', null, t('Condiciones y cancelación')),
        c.text ? el('div', { class: 'orgconditions-text' }, ...textParagraphs(c.text)) : null,
        tiers.length ? el('ul', { class: 'plainlist small' }, ...tiers.map((tier) => el('li', null,
          tier.min_days_before === 0
            ? t('Menos días: se devuelve el {pct} % de la señal', { pct: i18n.formatNumber(Number(tier.deposit_refund_pct)) })
            : t('Con {dias} días o más de antelación: se devuelve el {pct} % de la señal', { dias: tier.min_days_before, pct: i18n.formatNumber(Number(tier.deposit_refund_pct)) }),
          withDates && tier.min_days_before > 0 ? ` ${t('(hasta el {fecha})', { fecha: day(minusDays(p.start_date!, tier.min_days_before)) })}` : ''))) : null,
        withDates ? el('p', { class: 'muted small' }, t('Fechas calculadas con el día de llegada.')) : null) : null,
      actions);
    return card;
  }

  function previousBlock(previous: PortalProposal[], requests: PortalRequest[]): HTMLElement | null {
    if (!previous.length) return null;
    return fbMark(el('details', { id: 'proposalPrevious', class: 'card orgcard orgprevious-all' },
      el('summary', null, t('Versiones anteriores ({n})', { n: previous.length })),
      ...previous.map((p) => el('details', { class: 'orgprevious', id: `proposal-${p.version}` },
        el('summary', null, p.status === 'sustituida'
          ? (p.superseded_by_version ? t('Versión anterior · sustituida por la {n}', { n: p.superseded_by_version }) : t('Versión {v} · Sustituida', { v: p.version }))
          : p.status === 'caducada' ? t('Versión {v} · Caducada', { v: p.version }) : t('Versión {n}', { n: p.version })),
        proposalCard(p, { current: false, requests })))),
    'organizers.propuesta.anteriores', 'Versiones anteriores');
  }

  const changeText = (change: LineChange) => {
    if (change === 'nueva') return t('nueva');
    if (change === 'quitada') return t('quitada');
    if (change === null) return '';
    if (change === 0) return money(0);
    return change > 0 ? `+${money(change)}` : `−${money(-change)}`;
  };

  function compareView(all: PortalProposal[], current: PortalProposal | null): HTMLElement {
    const a = current ?? all[0]!;
    const others = all.filter((p) => p !== a);
    const heading = el('h3', { tabindex: '-1', class: 'orgviewhead' });
    if (!others.length) {
      heading.textContent = t('Comparar versiones');
      return el('section', { id: 'proposalCompare', class: 'card orgcard' }, heading,
        el('p', { class: 'muted' }, t('Solo hay una versión: cuando Ikisai te mande otra, verás aquí lo que cambia.')));
    }
    const b = others.find((p) => p.version === compareWith) ?? others.find((p) => p.version < a.version) ?? others[0]!;
    heading.textContent = t('Versión {a} frente a versión {b}', { a: a.version, b: b.version });
    const cmp = compareVersions(a, b);
    const num = (v: number | null) => (v === null ? '—' : money(v));
    const people = (v: number | null) => (v === null ? '—' : i18n.formatNumber(v));
    const foot = (label: string, x: string, y: string, change: string) => el('tr', { class: 'orgcompare-foot' }, el('th', { scope: 'row' }, label), el('td', { class: 'num' }, x), el('td', { class: 'num' }, y), el('td', { class: 'num' }, change));
    const diff = (x: number | null, y: number | null) => (x === null || y === null ? '' : changeText(Math.round((x - y) * 100) / 100));
    const picker = others.length >= 2 ? el('label', { class: 'field' }, el('span', null, t('Comparar con')),
      el('select', { ...fieldAttrs({ id: 'organizers.propuesta.comparar', label: 'Comparar con', type: 'select', sensitivity: 'internal', confirm: 'none' }), id: 'compareWith', onchange: (e: Event) => { compareWith = Number((e.target as HTMLSelectElement).value); paint(); (host.querySelector('#compareWith') as HTMLElement | null)?.focus(); } },
        ...others.map((p) => el('option', { value: String(p.version), selected: p === b ? '' : null }, t('Versión {n}', { n: p.version }))))) : null;
    return el('section', { id: 'proposalCompare', class: 'card orgcard' }, heading, picker,
      el('div', { role: 'region', tabindex: '0', 'aria-label': t('Versión {a} frente a versión {b}', { a: a.version, b: b.version }), class: 'orgscrollx' },
        el('table', { class: 'orgquote orgcompare' },
          el('thead', null, el('tr', null, el('th', { scope: 'col' }, t('Concepto')), el('th', { scope: 'col', class: 'num' }, `v${a.version}`), el('th', { scope: 'col', class: 'num' }, `v${b.version}`), el('th', { scope: 'col', class: 'num' }, t('Cambio')))),
          el('tbody', null, ...cmp.lines.map((l) => el('tr', null, el('td', null, l.label), el('td', { class: 'num' }, num(l.a)), el('td', { class: 'num' }, num(l.b)), el('td', { class: 'num' }, changeText(l.change))))),
          el('tfoot', null,
            foot(t('Total'), money(cmp.total.a), money(cmp.total.b), diff(cmp.total.a, cmp.total.b)),
            foot(t('Señal'), money(cmp.deposit.a), money(cmp.deposit.b), diff(cmp.deposit.a, cmp.deposit.b)),
            foot(t('Personas'), people(cmp.persons.a), people(cmp.persons.b), cmp.persons.a !== null && cmp.persons.b !== null && cmp.persons.a !== cmp.persons.b ? `${cmp.persons.a > cmp.persons.b ? '+' : '−'}${Math.abs(cmp.persons.a - cmp.persons.b)}` : ''),
            foot(t('Fechas'), dateRange(cmp.dates.a.start, cmp.dates.a.end), dateRange(cmp.dates.b.start, cmp.dates.b.end), ''),
            foot(t('Precio medio por persona'), num(cmp.average.a), num(cmp.average.b), diff(cmp.average.a, cmp.average.b))))),
      el('div', { class: 'btnrow' }, el('button', { type: 'button', class: 'ghost', id: 'compareBack', onclick: () => setView('budget') }, t('Volver al presupuesto'))));
  }

  function setView(next: View): void {
    view = next;
    paint();
    const target = host.querySelector<HTMLElement>(next === 'compare' ? '#proposalCompare .orgviewhead' : '.orgproposal h3');
    target?.setAttribute('tabindex', '-1');
    target?.focus();
  }

  function paint(): void {
    if (!last) return;
    release();
    const { proposals, requests, staleAt } = last;
    const { current, previous } = proposalVersions(proposals);
    const all = current ? [current, ...previous] : previous;
    const mine = requests.length ? section(t('Lo que has enviado a Ikisai'), { id: 'myRequests' },
      el('ul', { class: 'plainlist orgmine' }, ...requests.map((r) => el('li', null,
        el('span', { class: `chip small ${r.status === 'respondida' ? 'ok' : r.status === 'vista' ? '' : 'warn'}` }, t(REQUEST_STATUS[r.status] ?? r.status)), ' ',
        el('strong', null, t(REQUEST_KIND[r.kind] ?? r.kind)), ` · ${dayLabel(r.created_at)}`,
        r.message ? el('p', { class: 'small', 'data-feedback-ignore': '' }, r.message) : null)))) : null;
    if (!current) {
      replace(host, staleAt ? staleNote(staleAt) : null,
        el('div', { class: 'empty', id: 'noProposal' }, el('strong', null, t('Aún no tienes propuesta')),
          el('p', null, t('Cuando el equipo de Ikisai te envíe la propuesta, la verás aquí. Mientras, puedes escribirnos.')),
          needsNet(el('button', { type: 'button', class: 'ghost', id: 'sendCommentOpen', onclick: () => commentSheet(null) }, t('Enviar un comentario')))),
        previousBlock(previous, requests),
        mine);
      return;
    }
    const views = all.length >= 2 ? el('div', { class: 'segmented orgpropviews', role: 'group', 'aria-label': t('Vista de la propuesta') },
      fbMark(el('button', { type: 'button', id: 'propViewBudget', class: view === 'budget' ? 'on' : '', 'aria-pressed': String(view === 'budget'), onclick: () => setView('budget') }, t('El presupuesto')), 'organizers.propuesta.vista.presupuesto', 'El presupuesto'),
      fbMark(el('button', { type: 'button', id: 'propViewCompare', class: view === 'compare' ? 'on' : '', 'aria-pressed': String(view === 'compare'), onclick: () => setView('compare') }, t('Comparar versiones ({n})', { n: all.length })), 'organizers.propuesta.vista.comparar', 'Comparar versiones')) : null;
    const intro = current.status === 'aceptada'
      ? t('La aceptación la cierra el equipo de Ikisai contigo.')
      : `${t('La aceptación la cierra el equipo de Ikisai contigo.')} ${commonText('organizers.proposal_note').body}`;
    replace(host, staleAt ? staleNote(staleAt) : null,
      el('p', { class: 'muted' }, intro),
      views,
      ...(view === 'compare'
        ? [compareView(all, current)]
        : [proposalCard(current, { current: true, requests }), previousBlock(previous, requests)]),
      mine);
  }

  void load();
  (host as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; release(); };
  return host;
}
