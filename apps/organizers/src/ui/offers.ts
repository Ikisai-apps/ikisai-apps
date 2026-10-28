/**
 * Pestaña «Ofertas» (fase 5, API.md §16.2 y §16.3; pasada única, zona 3): lo que el organizador vende a sus asistentes.
 * Solo para él: nunca se ve en Guests y Ikisai no cobra nada de esto. De arriba abajo:
 * - el cartel al momento (publicación, historia o A4) con «Guardar JPG» y «Más opciones» (la hoja de siempre);
 * - la cuenta del retiro: lo que te queda, los ingresos previstos y los gastos (solo lo contratado con Ikisai y lo que
 *   escribas), en el dispositivo;
 * - tus ofertas, guardadas en `organizers.offers` (espejo local), con «Esperas vender» en − / +.
 * Las caducadas siguen sumando en las cuentas, con su marca y su aviso; en el cartel no salen nunca. Los toques de − / +
 * se agrupan: se guarda una vez, 700 ms después del último.
 */
import { confirmDialog, el, fieldAttrs, icon, openSheet, replace, toast } from '@ikisai/ui-kit';
import type { RowOperation } from '@ikisai/sync-client';
import type { ReservationDetail } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { describeError, errorCode } from '../app/client.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { todayMadrid } from '../app/journey.ts';
import { dateRange, dayLabel } from '../app/labels.ts';
import { isExpired, isUpcoming, offersStateOf } from '../app/offers-state.ts';
import { fileIdOf, nextPosition, rowsOf, save, TABLES, watch, type Row } from '../app/own.ts';
import { drawPoster, POSTER_SIZES, posterImage, type PosterContent, type PosterFormat, type PosterTemplate } from '../app/poster.ts';
import { fbMark, loading } from './common.ts';
import type { ViewContext } from './shell.ts';

const money = (n: number | string) => i18n.formatMoney(Number(n));
/** Con su signo escrito: «+4.500,00 €», «−2.800,00 €». */
const plus = (n: number) => `+${money(n)}`;
const minus = (n: number) => `−${money(Math.abs(n))}`;
const day = (date: string) => dayLabel(`${date.slice(0, 10)}T12:00:00Z`);
const TEMPLATES: Array<[PosterTemplate, string]> = [['foto', L('Foto de fondo')], ['banda', L('Foto arriba')], ['liso', L('Sin foto')]];
const FORMATS: Array<[PosterFormat, string]> = [['a4', L('A4 para imprimir o PDF')], ['cuadrado', L('Cuadrado para redes')], ['vertical', L('Vertical para historias')]];
const QUICK_FORMATS: Array<[PosterFormat, string]> = [['cuadrado', L('Publicación')], ['vertical', L('Historia')], ['a4', L('A4')]];
/** Espera tras el último toque de − / + antes de guardar. */
const SAVE_DELAY = 700;
/** Como mucho, archivos de los materiales que se miran para el cartel (como hoy). */
const MAX_FILES = 12;

type Venue = { name: string | null; address: string | null };

export function renderOffers(ctx: ViewContext, reservationId: string, detail: ReservationDetail): HTMLElement {
  const host = el('div', { id: 'offers', 'data-feedback-id': 'organizers.ofertas', 'data-feedback-label': 'Ofertas' }, loading()) as HTMLElement & { destroy?: () => void };
  let alive = true;
  let painted = false;
  let offers: Row[] = [];
  let other = '';
  const otherKey = `offers-other:${reservationId}`;
  const contracted = detail.contract ? Number(detail.contract.total) || 0 : null;
  const seats = detail.final_guests ?? detail.expected_guests;
  const api = <T,>(path: string) => ctx.client.api<T>(path);

  // --- Toques de − / +: valor local hasta guardarlo una vez --------------------------------------------------------
  const pendingExpected = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const expectedOf = (o: Row): number | null => (pendingExpected.has(o.id) ? pendingExpected.get(o.id)! : o.expected == null ? null : Number(o.expected));
  const stateNow = () => offersStateOf(offers.map((o): Row => ({ ...o, expected: expectedOf(o) })), todayMadrid(), contracted, seats, Number(other || 0));

  // --- Cartel al momento -------------------------------------------------------------------------------------------
  let format: PosterFormat = 'cuadrado';
  /** El lugar de Central (X3: nombre y dirección del lugar, nunca el domicilio fiscal), una vez por montaje. */
  const venue: Promise<string> = ctx.api.readAny<{ rows?: Venue[]; items?: Venue[] }>('central.portal_place_projection')
    .then((x) => { const v = (x.value.rows ?? x.value.items ?? [])[0]; return v ? [v.name, v.address].filter(Boolean).join(' · ') : ''; })
    .catch(() => '');
  let place = '';
  let images: { background: HTMLImageElement | null; logo: HTMLImageElement | null } = { background: null, logo: null };
  const preview = el('canvas', { id: 'posterPreview', class: 'orgposter-canvas', 'aria-label': t('Vista previa del cartel') }) as HTMLCanvasElement;
  const formats = fbMark(el('div', { id: 'posterFormats', class: 'orgposter-formats', role: 'group', 'aria-label': t('Formato') }), 'organizers.ofertas.cartel.formato', 'Formato del cartel');
  const posterOffers = () => stateNow().posterOffers.map((o) => ({ name: String(o.name), price: money(o.price as number), includes: (o.includes as string | null) ?? null }));
  const content = (over: Partial<PosterContent> = {}): PosterContent => ({
    title: detail.title, dates: dateRange(detail.start_date, detail.end_date), place: place || 'Ikisai', offers: posterOffers(), note: null,
    logo: images.logo, background: images.background, ...over,
  });
  function drawPreview(): void {
    if (!alive) return;
    drawPoster(preview, content(), images.background ? 'foto' : 'liso', format);
    const [w, h] = POSTER_SIZES[format];
    preview.style.aspectRatio = `${w} / ${h}`;
  }
  function paintFormats(): void {
    replace(formats, ...QUICK_FORMATS.map(([f, text]) => el('button', {
      type: 'button', class: 'softbtn', 'data-format': f, 'aria-pressed': String(f === format),
      onclick: () => { format = f; paintFormats(); drawPreview(); },
    }, t(text))));
  }
  /** Primero sin foto, al momento; después, una sola vez por montaje, el lugar, la primera foto y el logotipo. */
  async function loadPosterExtras(): Promise<void> {
    place = await venue;
    drawPreview();
    const materials = await rowsOf(ctx.client, TABLES.materials, reservationId);
    const files = materials.filter((m) => m.kind === 'file' && fileIdOf(m.file_id)).slice(0, MAX_FILES);
    const logoRow = files.find((m) => m.is_logo);
    const logo = logoRow ? await posterImage(api, ctx.userId, fileIdOf(logoRow.file_id)!) : null;
    let background: HTMLImageElement | null = null;
    for (const m of files.filter((x) => !x.is_logo)) {
      background = await posterImage(api, ctx.userId, fileIdOf(m.file_id)!);
      if (background) break;
    }
    images = { background, logo };
    drawPreview();
  }
  const posterSection = fbMark(el('section', { class: 'card orgcard orgposter-quick', id: 'offersPoster' },
    el('p', { class: 'orgkicker' }, t('Tu cartel, al momento')),
    el('div', { class: 'orgposter' }, preview),
    formats,
    el('div', { class: 'choices left' },
      fbMark(el('button', { type: 'button', class: 'primary', id: 'posterQuickJpg', onclick: () => { ctx.usage.track('organizers.ofertas.cartel_jpg'); savePoster(preview, detail); } }, icon('image', 16), ' ', t('Guardar JPG')),
        'organizers.ofertas.cartel.jpg', 'Guardar JPG'),
      el('button', { type: 'button', class: 'ghost', id: 'posterOpen', onclick: () => void openPoster(format) }, t('Más opciones'))),
    el('p', { class: 'muted small' }, t('Las ofertas marcadas salen en el cartel; las caducadas, nunca.'))), 'organizers.ofertas.cartel', 'Cartel');

  // --- La cuenta del retiro ----------------------------------------------------------------------------------------
  const accountTop = el('div', { class: 'orgacct-top' });
  const accountTotal = el('ul', { class: 'orgacct-rows' });
  const otherInput = el('input', { ...fieldAttrs({ id: 'organizers.ofertas.otros_ingresos', storage: 'device', label: 'Otros ingresos', type: 'number', sensitivity: 'internal', confirm: 'none' }), type: 'number', min: '0', step: 'any', inputmode: 'decimal', id: 'offersOther', placeholder: '0',
    // Al escribir solo se repinta la cuenta (ni la lista ni el cartel).
    oninput: (e: Event) => { other = (e.target as HTMLInputElement).value; void cache.saveDraft(ctx.userId, otherKey, other); paintAccount(); } }) as HTMLInputElement;
  const bar = (value: number, max: number, kind: 'in' | 'out') => el('span', { class: `orgacct-bar ${kind}`, 'aria-hidden': 'true' },
    el('span', { style: `width:${max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0}%` }));
  function paintAccount(): void {
    const { m } = stateNow();
    const max = Math.max(m.revenue, m.cost);
    const line = !offers.length ? t('Sin ofertas aún.')
      : m.cost <= 0 ? t('Aún no hay gastos que cubrir: Ikisai no está contratado y no has puesto otros gastos.')
        : m.breakEven === null ? t('Pon cuántas esperas vender para ver cuándo cubres gastos.')
          : t('Cubres gastos a partir de {n} asistentes; esperas {a}.', { n: m.breakEven, a: m.attendees });
    replace(accountTop,
      el('div', { class: 'orgacct-res' }, el('span', null, t('Te queda')), el('b', { id: 'offersMargin', class: m.margin < 0 ? 'neg' : '' }, m.margin < 0 ? minus(m.margin) : money(m.margin))),
      el('p', { class: 'small orgacct-line', id: 'offersLine' }, line),
      el('ul', { class: 'orgacct-rows' },
        el('li', null, el('span', null, t('Ingresos previstos')), el('b', { id: 'offersRevenue' }, plus(m.revenue)), bar(m.revenue, max, 'in')),
        el('li', null, el('span', null, t('Ikisai')),
          contracted !== null ? el('b', null, minus(contracted)) : el('span', { class: 'small' }, t('sin contratar: el margen no lo incluye')),
          contracted ? bar(contracted, max, 'out') : null)),
      contracted !== null ? el('p', { class: 'muted small' }, t('Con lo contratado con Ikisai: {importe}.', { importe: money(contracted) })) : null);
    replace(accountTotal, el('li', { class: 'orgacct-total' }, el('span', null, t('Gastos (Ikisai y otros)')), el('b', { id: 'offersCost' }, minus(m.cost)), bar(m.cost, max, 'out')));
  }
  const calcSection = fbMark(el('section', { class: 'card orgcard orgacct', id: 'offersCalc' },
    el('p', { class: 'orgkicker' }, t('Tu cuenta del retiro')),
    accountTop,
    el('label', { class: 'field' }, el('span', null, t('Otros gastos (viajes, materiales…)')), otherInput),
    accountTotal,
    el('p', { class: 'muted small' }, t('Ingresos = precio de cada oferta × las que esperas vender. Esto no sale de tu dispositivo.'))), 'organizers.ofertas.calculadora', 'Tu calculadora');

  // --- Tus ofertas -------------------------------------------------------------------------------------------------
  const listBody = el('div', { class: 'orgoffers' });
  const cards = new Map<string, () => void>();
  function offerCard(o: Row): HTMLElement {
    const today = todayMadrid();
    const expired = isExpired(o, today);
    const upcoming = isUpcoming(o, today);
    const name = String(o.name);
    const cap = o.capacity == null ? null : Number(o.capacity);
    const count = el('span', { class: 'orgoffer-count', 'aria-live': 'polite' });
    const capBar = cap ? el('span', { class: 'orgoffer-cap', role: 'img' }, el('span')) : null;
    const less = el('button', { type: 'button', class: 'orgstep', 'data-step': '-', 'aria-label': t('Una menos: {nombre}', { nombre: name }), onclick: () => step(o, -1) }, '−') as HTMLButtonElement;
    const more = el('button', { type: 'button', class: 'orgstep', 'data-step': '+', 'aria-label': t('Una más: {nombre}', { nombre: name }), onclick: () => step(o, 1) }, '+') as HTMLButtonElement;
    const update = () => {
      const v = expectedOf(o) ?? 0;
      count.textContent = cap ? t('Esperas vender {a} de {b}', { a: v, b: cap }) : t('Esperas vender {n}', { n: v });
      if (capBar && cap) {
        capBar.setAttribute('aria-label', t('Esperas vender {a} de {b} plazas', { a: v, b: cap }));
        (capBar.firstChild as HTMLElement).style.width = `${Math.min(100, Math.round((v / cap) * 100))}%`;
      }
      less.disabled = v <= 0;
      more.disabled = cap !== null && v >= cap;
    };
    update();
    cards.set(o.id, update);
    const poster = el('input', { ...fieldAttrs({ id: 'organizers.ofertas.en_cartel', label: 'En el cartel', entity: 'organizers.offers', prop: 'on_poster', type: 'toggle', sensitivity: 'internal' }), type: 'checkbox', checked: o.on_poster && !expired ? '' : null, disabled: expired ? '' : null,
      onchange: (e: Event) => void setPoster(o, (e.target as HTMLInputElement).checked) });
    const chip = expired ? el('span', { class: 'chip warn' }, t('Caducada'))
      : upcoming ? el('span', { class: 'chip' }, t('Desde el {fecha}', { fecha: day(String(o.available_from)) }))
        : el('span', { class: 'chip ok' }, t('A la venta'));
    return el('article', { class: `orgitem orgoffer${expired ? ' expired' : ''}`, 'data-offer': o.id },
      el('button', { type: 'button', class: 'orgitem-main orgoffer-main', 'aria-label': t('Editar {nombre}', { nombre: name }), onclick: () => edit(o) },
        el('span', { class: 'orgoffer-head' }, el('strong', null, name), el('span', { class: 'orgoffer-price' }, money(o.price as number))),
        o.includes ? el('span', { class: 'muted small orgoffer-includes' }, String(o.includes)) : null,
        el('span', { class: 'chips' }, chip, o.available_until && !expired ? el('span', { class: 'chip' }, t('Hasta el {fecha}', { fecha: day(String(o.available_until)) })) : null)),
      capBar,
      fbMark(el('div', { class: 'orgoffer-steps' }, less, count, more), 'organizers.ofertas.entrada.esperadas', 'Las que esperas vender'),
      fbMark(el('label', { class: 'field check orgoffer-poster' }, poster, el('span', null, t('En el cartel'))), 'organizers.ofertas.entrada.cartel', 'En el cartel'));
  }
  function paintList(): void {
    const s = stateNow();
    cards.clear();
    replace(listBody,
      s.over ? el('p', { class: 'banner warn', id: 'offersOver' }, t('Ofreces {a} plazas y el retiro tiene {b}: sobran {n}.', { a: s.offered, b: seats ?? 0, n: s.over })) : null,
      s.expired.length ? el('p', { class: 'banner info', id: 'offersExpired' }, s.expired.length === 1
        ? t('1 oferta caducada sigue sumando en tus cuentas: cámbiale la fecha o quítala.')
        : t('{n} ofertas caducadas siguen sumando en tus cuentas: cámbiales la fecha o quítalas.', { n: s.expired.length })) : null,
      offers.length ? el('div', { class: 'orgitems' }, ...offers.map(offerCard))
        : el('p', { class: 'muted', id: 'offersEmpty' }, t('Aún no has creado ofertas. Por ejemplo: «Estándar», «Habitación doble» o «Inscripción anticipada».')));
  }
  const listSection = fbMark(el('section', { class: 'card orgcard', id: 'offersList' },
    el('h3', null, t('Tus ofertas')),
    el('p', { class: 'muted small' }, t('Lo que ofreces a tus asistentes y a qué precio. Solo lo ves tú: tus asistentes no lo ven en su enlace e Ikisai no cobra nada de esto.')),
    listBody,
    el('div', { class: 'choices left' }, el('button', { type: 'button', class: 'primary', id: 'offersAdd', onclick: () => edit(null) }, icon('plus', 16), ' ', t('Nueva oferta')))),
  'organizers.ofertas.lista', 'Tus ofertas');

  function step(o: Row, delta: number): void {
    const cap = o.capacity == null ? null : Number(o.capacity);
    const v = Math.max(0, (expectedOf(o) ?? 0) + delta);
    pendingExpected.set(o.id, cap !== null ? Math.min(cap, v) : v);
    // Solo esa oferta y la cuenta; el cartel no cambia (no lleva cifras de venta).
    cards.get(o.id)?.();
    paintAccount();
    const previous = timers.get(o.id);
    if (previous) clearTimeout(previous);
    timers.set(o.id, setTimeout(() => void flushExpected(o.id), SAVE_DELAY));
  }
  /** Guarda una vez lo tocado, con la revisión de la fila releída justo antes. */
  async function flushExpected(id: string): Promise<void> {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    if (!pendingExpected.has(id)) return;
    const value = pendingExpected.get(id)!;
    try {
      const rows = await rowsOf(ctx.client, TABLES.offers, reservationId);
      const row = rows.find((r) => r.id === id);
      if (row && (row.expected == null ? null : Number(row.expected)) !== value) {
        await ctx.usage.run('organizers.ofertas.esperadas', () => save(ctx.client, [{ op: 'update', table: TABLES.offers, id, expectedRevision: row.revision, fields: { expected: value } }], rows));
      }
      if (pendingExpected.get(id) === value) pendingExpected.delete(id);
    } catch (e) {
      pendingExpected.delete(id);
      toast(errorCode(e) === 'VERSION_CONFLICT' ? t('Otra persona cambió esta oferta: revisa la cifra.') : describeError(e));
      void load();
    }
  }
  const flushAll = () => { for (const id of [...pendingExpected.keys()]) void flushExpected(id); };
  const onHidden = () => { if (document.visibilityState === 'hidden') flushAll(); };
  document.addEventListener('visibilitychange', onHidden);

  async function setPoster(o: Row, on: boolean): Promise<void> {
    try {
      const rows = await rowsOf(ctx.client, TABLES.offers, reservationId);
      const row = rows.find((r) => r.id === o.id) ?? o;
      await ctx.usage.run('organizers.ofertas.guardar', () => save(ctx.client, [{ op: 'update', table: TABLES.offers, id: row.id, expectedRevision: row.revision, fields: { on_poster: on } }], rows));
    } catch (e) {
      toast(describeError(e));
      void load();
    }
  }

  function paint(): void {
    // Si el foco estaba en un − / +, vuelve al mismo botón tras repintar.
    const active = document.activeElement as HTMLElement | null;
    const focusStep = active?.dataset.step ? { offer: active.closest<HTMLElement>('[data-offer]')?.dataset.offer, step: active.dataset.step } : null;
    if (!painted) {
      otherInput.value = other;
      paintFormats();
      replace(host, posterSection, calcSection, listSection);
      painted = true;
      void loadPosterExtras();
    }
    paintList();
    paintAccount();
    drawPreview();
    if (focusStep?.offer) host.querySelector<HTMLElement>(`[data-offer="${CSS.escape(focusStep.offer)}"] [data-step="${focusStep.step === '-' ? '-' : '+'}"]`)?.focus();
  }

  function edit(row: Row | null): void {
    const input = (id: string, type: string, value: unknown, attrs: Record<string, string | null> = {}) =>
      el('input', { type, id, value: value == null ? '' : String(value), ...attrs, /* data-field-id y demás: los pone fieldAttrs, con literales, en cada llamada */ }) as HTMLInputElement;
    const name = input('of-name', 'text', row?.name, { maxlength: '120', required: '', ...fieldAttrs({ id: 'organizers.ofertas.nombre', label: 'Nombre de la oferta', entity: 'organizers.offers', prop: 'name', type: 'text', sensitivity: 'internal' }) });
    const price = input('of-price', 'number', row?.price, { min: '0', step: '0.01', inputmode: 'decimal', required: '', ...fieldAttrs({ id: 'organizers.ofertas.precio', label: 'Precio de la oferta', entity: 'organizers.offers', prop: 'price', type: 'number', sensitivity: 'internal' }) });
    const description = el('textarea', { ...fieldAttrs({ id: 'organizers.ofertas.descripcion', label: 'Descripción de la oferta', entity: 'organizers.offers', prop: 'description', type: 'text', sensitivity: 'internal' }), id: 'of-description', rows: '2', maxlength: '600' }, String(row?.description ?? '')) as HTMLTextAreaElement;
    const includes = el('textarea', { ...fieldAttrs({ id: 'organizers.ofertas.incluye', label: 'Qué incluye', entity: 'organizers.offers', prop: 'includes', type: 'text', sensitivity: 'internal' }), id: 'of-includes', rows: '2', maxlength: '600', placeholder: t('Alojamiento, comidas, talleres…') }, String(row?.includes ?? '')) as HTMLTextAreaElement;
    const capacity = input('of-capacity', 'number', row?.capacity, { min: '0', step: '1', inputmode: 'numeric', ...fieldAttrs({ id: 'organizers.ofertas.plazas', label: 'Plazas', entity: 'organizers.offers', prop: 'capacity', type: 'number', sensitivity: 'internal' }) });
    const expected = input('of-expected', 'number', row ? expectedOf(row) : null, { min: '0', step: '1', inputmode: 'numeric', ...fieldAttrs({ id: 'organizers.ofertas.previstas', label: 'Personas previstas', entity: 'organizers.offers', prop: 'expected', type: 'number', sensitivity: 'internal' }) });
    const from = input('of-from', 'date', row?.available_from, fieldAttrs({ id: 'organizers.ofertas.desde', label: 'Disponible desde', entity: 'organizers.offers', prop: 'available_from', type: 'date', sensitivity: 'internal' }));
    const until = input('of-until', 'date', row?.available_until, fieldAttrs({ id: 'organizers.ofertas.hasta', label: 'Disponible hasta', entity: 'organizers.offers', prop: 'available_until', type: 'date', sensitivity: 'internal' }));
    const poster = el('input', { ...fieldAttrs({ id: 'organizers.ofertas.en_cartel', label: 'En el cartel', entity: 'organizers.offers', prop: 'on_poster', type: 'toggle', sensitivity: 'internal' }), type: 'checkbox', id: 'of-poster', checked: row ? (row.on_poster ? '' : null) : '' }) as HTMLInputElement;
    const error = el('p', { class: 'error', role: 'alert', id: 'of-error' });
    const int = (v: string) => (v === '' ? null : Math.max(0, Math.round(Number(v))));
    const sheet = openSheet({
      title: row ? t('Oferta') : t('Nueva oferta'),
      panelAttrs: { id: 'offerSheet' },
      body: el('form', { id: 'offerForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        el('label', { class: 'field' }, el('span', null, t('Nombre')), name),
        el('label', { class: 'field' }, el('span', null, t('Precio por asistente')), price),
        el('label', { class: 'field' }, el('span', null, t('Qué incluye (opcional)')), includes),
        el('label', { class: 'field' }, el('span', null, t('Descripción (opcional)')), description),
        el('div', { class: 'orggrid' },
          el('label', { class: 'field' }, el('span', null, t('Plazas (opcional)')), capacity),
          el('label', { class: 'field' }, el('span', null, t('Cuántas esperas vender')), expected),
          el('label', { class: 'field' }, el('span', null, t('Disponible desde')), from),
          el('label', { class: 'field' }, el('span', null, t('Disponible hasta')), until)),
        el('label', { class: 'field check' }, poster, el('span', null, t('Sale en el cartel'))),
        error),
      foot: el('div', { class: 'choices' },
        row ? el('button', { type: 'button', class: 'ghost danger', id: 'of-delete', onclick: () => void remove() }, t('Quitar')) : null,
        el('button', { type: 'submit', class: 'primary', form: 'offerForm', id: 'of-save' }, t('Guardar'))),
    });
    async function submit(): Promise<void> {
      if (price.value === '' || !(Number(price.value) >= 0)) { error.textContent = t('Pon el precio.'); return; }
      if (from.value && until.value && until.value < from.value) { error.textContent = t('Revisa la fecha.'); return; }
      const fields: Record<string, unknown> = {
        name: name.value.trim(), price: Math.round(Number(price.value) * 100) / 100, description: description.value.trim() || null, includes: includes.value.trim() || null,
        capacity: int(capacity.value), expected: int(expected.value), available_from: from.value || null, available_until: until.value || null, on_poster: poster.checked,
      };
      // Lo escrito en la hoja manda sobre un − / + aún sin guardar.
      if (row) { const timer = timers.get(row.id); if (timer) clearTimeout(timer); timers.delete(row.id); pendingExpected.delete(row.id); }
      const current = row ? (await rowsOf(ctx.client, TABLES.offers, reservationId)).find((r) => r.id === row.id) ?? row : null;
      const op: RowOperation = current
        ? { op: 'update', table: TABLES.offers, id: current.id, expectedRevision: current.revision, fields }
        : { op: 'insert', table: TABLES.offers, id: crypto.randomUUID(), fields: { reservation_id: reservationId, position: nextPosition(offers), ...fields } };
      try {
        await ctx.usage.run('organizers.ofertas.guardar', () => save(ctx.client, [op], current ? [current] : offers));
        await sheet.close(true);
        await load();
      } catch (e) {
        const code = (e as { code?: string; details?: { field?: string } });
        error.textContent = code.code === 'INVALID_FIELDS' && code.details?.field === 'name' ? t('Ponle un nombre.') : describeError(e);
      }
    }
    async function remove(): Promise<void> {
      if (!row || !(await confirmDialog({ title: t('¿Quitar esta oferta?'), confirmLabel: t('Quitar'), danger: true }))) return;
      try {
        const timer = timers.get(row.id);
        if (timer) clearTimeout(timer);
        timers.delete(row.id);
        pendingExpected.delete(row.id);
        const current = (await rowsOf(ctx.client, TABLES.offers, reservationId)).find((r) => r.id === row.id) ?? row;
        await ctx.usage.run('organizers.ofertas.quitar', () => save(ctx.client, [{ op: 'delete', table: TABLES.offers, id: current.id, expectedRevision: current.revision }], [current]));
        await sheet.close(true);
        await load();
      } catch (e) { error.textContent = describeError(e); }
    }
  }

  // --- «Más opciones»: la hoja del cartel de siempre, en el formato elegido -----------------------------------------
  async function openPoster(initial: PosterFormat): Promise<void> {
    const materials = await rowsOf(ctx.client, TABLES.materials, reservationId);
    // Imágenes: el logotipo y las fotos ya subidas (los PDF no sirven de fondo).
    const files = materials.filter((m) => m.kind === 'file' && fileIdOf(m.file_id));
    const found: Array<{ row: Row; url: string }> = [];
    await Promise.all(files.slice(0, MAX_FILES).map(async (m) => {
      try {
        const meta = await ctx.client.api<{ url: string; mime: string }>(`/files/${fileIdOf(m.file_id)}`);
        if (meta.mime.startsWith('image/')) found.push({ row: m, url: meta.url });
      } catch { /* sin red o archivo no disponible: no se ofrece */ }
    }));
    // En el orden de los materiales (las llamadas terminan en cualquier orden).
    const images = files.map((m) => found.find((f) => f.row.id === m.id)).filter((x): x is { row: Row; url: string } => !!x);
    const logoEntry = images.find((i) => i.row.is_logo) ?? null;
    const backgrounds = images.filter((i) => !i.row.is_logo);
    let template: PosterTemplate = backgrounds.length ? 'foto' : 'liso';
    let format: PosterFormat = initial;
    let background = backgrounds[0] ?? null;
    const img = (entry: { row: Row; url: string } | null) => (entry ? posterImage(api, ctx.userId, fileIdOf(entry.row.file_id)!, entry.url) : Promise.resolve(null));
    const placeText = await venue;
    const placeInput = el('input', { ...fieldAttrs({ id: 'organizers.ofertas.cartel.lugar', storage: 'none', label: 'Lugar del cartel', type: 'text', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'poster-place', maxlength: '160', value: placeText || 'Ikisai', oninput: () => void draw() }) as HTMLInputElement;
    const note = el('input', { ...fieldAttrs({ id: 'organizers.ofertas.cartel.nota', storage: 'none', label: 'Nota del cartel', type: 'text', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'poster-note', maxlength: '160', placeholder: t('Plazas limitadas · reserva en…'), oninput: () => void draw() }) as HTMLInputElement;
    const canvas = el('canvas', { id: 'posterCanvas', class: 'orgposter-canvas', 'aria-label': t('Vista previa del cartel') }) as HTMLCanvasElement;
    const choose = <T extends string>(id: string, pairs: Array<[T, string]>, current: T, set: (v: T) => void, field: Record<string, string | null>) => el('select', { ...field, /* data-field-id y demás: los pone fieldAttrs, con literales, en cada llamada */ id,
      onchange: (e: Event) => { set((e.target as HTMLSelectElement).value as T); void draw(); } }, ...pairs.map(([v, l]) => el('option', { value: v, selected: v === current ? '' : null }, t(l))));
    const backgroundSelect = backgrounds.length > 1 ? el('label', { class: 'field' }, el('span', null, t('Foto')),
      el('select', { ...fieldAttrs({ id: 'organizers.ofertas.cartel.foto', storage: 'none', label: 'Foto del cartel', type: 'select', sensitivity: 'internal', confirm: 'none' }), id: 'poster-background', onchange: (e: Event) => { background = backgrounds.find((b) => b.row.id === (e.target as HTMLSelectElement).value) ?? background; void draw(); } },
        ...backgrounds.map((b) => el('option', { value: b.row.id }, String(b.row.title))))) : null;
    async function drawAt(f: PosterFormat): Promise<void> {
      drawPoster(canvas, content({
        place: placeInput.value.trim() || 'Ikisai', note: note.value.trim() || null,
        logo: await img(logoEntry), background: template === 'liso' ? null : await img(background),
      }), template, f);
      const [w, h] = POSTER_SIZES[f];
      canvas.style.aspectRatio = `${w} / ${h}`;
    }
    const draw = () => drawAt(format);
    openSheet({
      title: t('Cartel'),
      panelAttrs: { id: 'posterSheet' },
      body: el('div', { id: 'posterBody' },
        el('div', { class: 'orggrid' },
          el('label', { class: 'field' }, el('span', null, t('Diseño')), choose('poster-template', TEMPLATES, template, (v) => { template = v; }, fieldAttrs({ id: 'organizers.ofertas.cartel.diseno', storage: 'none', label: 'Diseño del cartel', type: 'select', sensitivity: 'internal', confirm: 'none' }))),
          el('label', { class: 'field' }, el('span', null, t('Formato')), choose('poster-format', FORMATS, format, (v) => { format = v; }, fieldAttrs({ id: 'organizers.ofertas.cartel.formato', storage: 'none', label: 'Formato del cartel', type: 'select', sensitivity: 'internal', confirm: 'none' }))),
          backgroundSelect),
        el('label', { class: 'field' }, el('span', null, t('Lugar')), placeInput),
        el('label', { class: 'field' }, el('span', null, t('Línea final (opcional)')), note),
        backgrounds.length ? null : el('p', { class: 'muted small' }, t('Sube una foto en «Experiencia» › «Materiales» para usarla de fondo, y marca tu logotipo para que salga arriba.')),
        el('div', { class: 'orgposter' }, canvas)),
      foot: el('div', { class: 'choices' },
        el('button', { type: 'button', class: 'ghost', id: 'posterPdf', onclick: () => { ctx.usage.track('organizers.ofertas.cartel_pdf'); void printPoster(canvas, drawAt, format); } }, icon('download', 16), ' ', t('PDF / imprimir')),
        el('button', { type: 'button', class: 'primary', id: 'posterJpg', onclick: () => { ctx.usage.track('organizers.ofertas.cartel_jpg'); savePoster(canvas, detail); } }, icon('image', 16), ' ', t('Guardar JPG'))),
    });
    await draw();
  }

  async function load(): Promise<void> {
    try {
      offers = await rowsOf(ctx.client, TABLES.offers, reservationId);
      if (!painted) {
        const stored = await cache.draft<string>(ctx.userId, otherKey);
        if (typeof stored === 'string') other = stored;
      }
      // Mientras se escribe en la cuenta no se repinta (perdería el foco); el − / + local no lo pisa nadie.
      if (alive && !(host.contains(document.activeElement) && typing())) paint();
    } catch (error) {
      if (alive) toast(describeError(error));
    }
  }
  const off = watch(ctx.client, [TABLES.offers], () => { if (alive) void load(); });
  void load();
  host.destroy = () => {
    flushAll();
    alive = false;
    off();
    document.removeEventListener('visibilitychange', onHidden);
  };
  return host;
}

/** Descarga el cartel dibujado como JPG («cartel-{título}.jpg»). */
function savePoster(canvas: HTMLCanvasElement, detail: Pick<ReservationDetail, 'title'>): void {
  canvas.toBlob((blob) => {
    if (!blob) { toast(t('No se ha podido crear la imagen.')); return; }
    const a = el('a', { href: URL.createObjectURL(blob), download: `cartel-${slugOf(detail.title)}.jpg` }) as HTMLAnchorElement;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }, 'image/jpeg', 0.9);
}

/** El PDF es el A4: si se está viendo otro formato, se dibuja en A4 para imprimir y se vuelve al elegido. */
async function printPoster(canvas: HTMLCanvasElement, drawAt: (format: PosterFormat) => Promise<void>, current: PosterFormat): Promise<void> {
  await drawAt('a4');
  const src = canvas.toDataURL('image/jpeg', 0.92);
  await drawAt(current);
  const style = el('style', { id: 'posterPrintStyle' }, '@page{size:A4;margin:0}@media print{html.orgprinting body>*:not(.orgposter-print){display:none!important}.orgposter-print{display:block!important}.orgposter-print img{width:210mm;height:297mm;display:block}}.orgposter-print{display:none}');
  const sheetEl = el('div', { class: 'orgposter-print' }, el('img', { src, alt: '' }));
  document.head.append(style); document.body.append(sheetEl);
  document.documentElement.classList.add('orgprinting');
  const done = () => { document.documentElement.classList.remove('orgprinting'); style.remove(); sheetEl.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  await new Promise((r) => setTimeout(r, 50));
  window.print();
  setTimeout(done, 60_000);
}

/** Foco en un campo de texto (no en un botón, una casilla o un desplegable). */
export const typing = (): boolean => {
  const a = document.activeElement as HTMLInputElement | null;
  return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(a.type)));
};

const slugOf = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'retiro';
