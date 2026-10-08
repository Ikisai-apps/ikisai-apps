/**
 * Pestaña «Ofertas» (fase 5, API.md §16.2 y §16.3): lo que el organizador vende a sus asistentes. Solo para él: nunca
 * se ve en Guests y Ikisai no cobra nada de esto.
 * - Ofertas (precio, qué incluye, plazas y cuántas espera vender), guardadas en `organizers.offers` (espejo local).
 * - Calculadora: ingresos por oferta frente a lo contratado con Ikisai y otros gastos (solo en el dispositivo).
 * - Cartel en PDF (A4) o JPG para redes, dibujado en el dispositivo con plantillas fijas.
 */
import { confirmDialog, el, icon, openSheet, replace, toast } from '@ikisai/ui-kit';
import type { RowOperation } from '@ikisai/sync-client';
import type { ReservationDetail } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { describeError } from '../app/client.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { dateRange } from '../app/labels.ts';
import { fileIdOf, nextPosition, rowsOf, save, TABLES, watch, type Row } from '../app/own.ts';
import { drawPoster, loadImage, POSTER_SIZES, type PosterFormat, type PosterTemplate } from '../app/poster.ts';
import { offersMargin } from '../app/quote.ts';
import { fbMark, loading, section } from './common.ts';
import type { ViewContext } from './shell.ts';

const money = (n: number | string) => i18n.formatMoney(Number(n));
const TEMPLATES: Array<[PosterTemplate, string]> = [['foto', L('Foto de fondo')], ['banda', L('Foto arriba')], ['liso', L('Sin foto')]];
const FORMATS: Array<[PosterFormat, string]> = [['a4', L('A4 para imprimir o PDF')], ['cuadrado', L('Cuadrado para redes')], ['vertical', L('Vertical para historias')]];

export function renderOffers(ctx: ViewContext, reservationId: string, detail: ReservationDetail): HTMLElement {
  const host = el('div', { id: 'offers', 'data-feedback-id': 'organizers.ofertas', 'data-feedback-label': 'Ofertas' }, loading());
  let alive = true;
  let offers: Row[] = [];
  let other = '';
  const otherKey = `offers-other:${reservationId}`;
  const contracted = detail.contract ? Number(detail.contract.total) || 0 : null;

  function paint(): void {
    const list = offers.map((o) => el('div', { class: 'orgitem', 'data-offer': o.id },
      el('button', { type: 'button', class: 'orgitem-main', onclick: () => edit(o) },
        icon('tag', 18),
        el('span', null,
          el('strong', null, String(o.name)),
          el('span', { class: 'muted small' }, ` · ${money(o.price as number)}`,
            o.expected != null ? ` · ${t('espera vender {n}', { n: Number(o.expected) })}` : '',
            o.capacity != null ? ` · ${t('{n} plazas', { n: Number(o.capacity) })}` : '',
            o.on_poster ? '' : ` · ${t('fuera del cartel')}`)))));
    const results = el('dl', { class: 'kv orgtotals', id: 'offersResults' });
    const paintResults = () => {
      const r = offersMargin(offers.map((o) => ({ price: o.price as number, expected: o.expected as number | null })), contracted ?? 0, Number(other || 0));
      replace(results,
        el('dt', null, t('Ingresos previstos')), el('dd', { id: 'offersRevenue' }, money(r.revenue)),
        el('dt', null, t('Asistentes previstos')), el('dd', null, String(r.attendees)),
        el('dt', null, t('Gastos (Ikisai y otros)')), el('dd', null, money(r.cost)),
        el('dt', null, t('Margen')), el('dd', { id: 'offersMargin', class: r.margin < 0 ? 'danger-text' : '' }, money(r.margin)),
        el('dt', null, t('Punto de equilibrio')), el('dd', null, r.breakEven === null ? '—' : (r.breakEven === 1 ? t('1 asistente') : t('{n} asistentes', { n: r.breakEven }))));
    };
    replace(host,
      el('p', { class: 'muted' }, t('Lo que ofreces a tus asistentes y a qué precio. Solo lo ves tú: tus asistentes no lo ven en su enlace e Ikisai no cobra nada de esto.')),
      fbMark(section(t('Tus ofertas'), { id: 'offersList' },
        list.length ? el('div', { class: 'orgitems' }, ...list) : el('p', { class: 'muted', id: 'offersEmpty' }, t('Aún no has creado ofertas. Por ejemplo: «Estándar», «Habitación doble» o «Inscripción anticipada».')),
        el('div', { class: 'choices left' }, el('button', { type: 'button', class: 'ghost', id: 'offersAdd', onclick: () => edit(null) }, icon('plus', 16), ' ', t('Nueva oferta')))), 'organizers.ofertas.lista', 'Tus ofertas'),
      fbMark(section(t('Tu calculadora (privada)'), { id: 'offersCalc' },
        el('p', { class: 'muted small' }, contracted !== null
          ? t('Con lo contratado con Ikisai: {importe}.', { importe: money(contracted) })
          : t('Aún no hay precio contratado con Ikisai: el margen no lo incluye.')),
        el('label', { class: 'field' }, el('span', null, t('Otros gastos (viajes, materiales…)')),
          el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', id: 'offersOther', value: other, placeholder: '0',
            oninput: (e: Event) => { other = (e.target as HTMLInputElement).value; void cache.saveDraft(ctx.userId, otherKey, other); paintResults(); } })),
        results,
        el('p', { class: 'muted small' }, t('Ingresos = precio de cada oferta × las que esperas vender. Esto no sale de tu dispositivo.'))), 'organizers.ofertas.calculadora', 'Tu calculadora'),
      fbMark(section(t('Cartel'), { id: 'offersPoster' },
        el('p', { class: 'muted small' }, t('Un cartel con el título, las fechas, el lugar y las ofertas marcadas, para imprimir o compartir en redes.')),
        el('button', { type: 'button', class: 'primary', id: 'posterOpen', onclick: () => void openPoster() }, icon('image', 16), ' ', t('Crear cartel'))), 'organizers.ofertas.cartel', 'Cartel'));
    paintResults();
  }

  function edit(row: Row | null): void {
    const input = (id: string, type: string, value: unknown, attrs: Record<string, string> = {}) =>
      el('input', { type, id, value: value == null ? '' : String(value), ...attrs }) as HTMLInputElement;
    const name = input('of-name', 'text', row?.name, { maxlength: '120', required: '' });
    const price = input('of-price', 'number', row?.price, { min: '0', step: '0.01', inputmode: 'decimal', required: '' });
    const description = el('textarea', { id: 'of-description', rows: '2', maxlength: '600' }, String(row?.description ?? '')) as HTMLTextAreaElement;
    const includes = el('textarea', { id: 'of-includes', rows: '2', maxlength: '600', placeholder: t('Alojamiento, comidas, talleres…') }, String(row?.includes ?? '')) as HTMLTextAreaElement;
    const capacity = input('of-capacity', 'number', row?.capacity, { min: '0', step: '1', inputmode: 'numeric' });
    const expected = input('of-expected', 'number', row?.expected, { min: '0', step: '1', inputmode: 'numeric' });
    const from = input('of-from', 'date', row?.available_from);
    const until = input('of-until', 'date', row?.available_until);
    const poster = el('input', { type: 'checkbox', id: 'of-poster', checked: row ? (row.on_poster ? '' : null) : '' }) as HTMLInputElement;
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
      const op: RowOperation = row
        ? { op: 'update', table: TABLES.offers, id: row.id, expectedRevision: row.revision, fields }
        : { op: 'insert', table: TABLES.offers, id: crypto.randomUUID(), fields: { reservation_id: reservationId, position: nextPosition(offers), ...fields } };
      try {
        await ctx.usage.run('organizers.ofertas.guardar', () => save(ctx.client, [op], offers));
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
        await ctx.usage.run('organizers.ofertas.quitar', () => save(ctx.client, [{ op: 'delete', table: TABLES.offers, id: row.id, expectedRevision: row.revision }]));
        await sheet.close(true);
        await load();
      } catch (e) { error.textContent = describeError(e); }
    }
  }

  // --- Cartel ---------------------------------------------------------------------------------------------------------
  async function openPoster(): Promise<void> {
    const materials = await rowsOf(ctx.client, TABLES.materials, reservationId);
    // Imágenes: el logotipo y las fotos ya subidas (los PDF no sirven de fondo).
    const files = materials.filter((m) => m.kind === 'file' && fileIdOf(m.file_id));
    const images: Array<{ row: Row; url: string }> = [];
    await Promise.all(files.slice(0, 12).map(async (m) => {
      try {
        const meta = await ctx.client.api<{ url: string; mime: string }>(`/files/${fileIdOf(m.file_id)}`);
        if (meta.mime.startsWith('image/')) images.push({ row: m, url: meta.url });
      } catch { /* sin red o archivo no disponible: no se ofrece */ }
    }));
    const logoEntry = images.find((i) => i.row.is_logo) ?? null;
    const backgrounds = images.filter((i) => !i.row.is_logo);
    let template: PosterTemplate = backgrounds.length ? 'foto' : 'liso';
    let format: PosterFormat = 'a4';
    let background = backgrounds[0] ?? null;
    const cacheImg = new Map<string, HTMLImageElement | null>();
    const img = async (entry: { url: string } | null) => {
      if (!entry) return null;
      if (!cacheImg.has(entry.url)) cacheImg.set(entry.url, await loadImage(entry.url).catch(() => null));
      return cacheImg.get(entry.url) ?? null;
    };
    const place = el('input', { type: 'text', id: 'poster-place', maxlength: '120', value: 'Ikisai', oninput: () => void draw() }) as HTMLInputElement;
    const note = el('input', { type: 'text', id: 'poster-note', maxlength: '160', placeholder: t('Plazas limitadas · reserva en…'), oninput: () => void draw() }) as HTMLInputElement;
    const canvas = el('canvas', { id: 'posterCanvas', class: 'orgposter-canvas', 'aria-label': t('Vista previa del cartel') }) as HTMLCanvasElement;
    const choose = <T extends string>(id: string, pairs: Array<[T, string]>, current: T, set: (v: T) => void) => el('select', { id,
      onchange: (e: Event) => { set((e.target as HTMLSelectElement).value as T); void draw(); } }, ...pairs.map(([v, l]) => el('option', { value: v, selected: v === current ? '' : null }, t(l))));
    const backgroundSelect = backgrounds.length > 1 ? el('label', { class: 'field' }, el('span', null, t('Foto')),
      el('select', { id: 'poster-background', onchange: (e: Event) => { background = backgrounds.find((b) => b.row.id === (e.target as HTMLSelectElement).value) ?? background; void draw(); } },
        ...backgrounds.map((b) => el('option', { value: b.row.id }, String(b.row.title))))) : null;
    async function draw(): Promise<void> {
      const content = {
        title: detail.title,
        dates: dateRange(detail.start_date, detail.end_date),
        place: place.value.trim() || 'Ikisai',
        offers: offers.filter((o) => o.on_poster).map((o) => ({ name: String(o.name), price: money(o.price as number), includes: (o.includes as string | null) ?? null })),
        note: note.value.trim() || null,
        logo: await img(logoEntry),
        background: template === 'liso' ? null : await img(background),
      };
      drawPoster(canvas, content, template, format);
      const [w, h] = POSTER_SIZES[format];
      canvas.style.aspectRatio = `${w} / ${h}`;
    }
    openSheet({
      title: t('Cartel'),
      panelAttrs: { id: 'posterSheet' },
      body: el('div', { id: 'posterBody' },
        el('div', { class: 'orggrid' },
          el('label', { class: 'field' }, el('span', null, t('Diseño')), choose('poster-template', TEMPLATES, template, (v) => { template = v; })),
          el('label', { class: 'field' }, el('span', null, t('Formato')), choose('poster-format', FORMATS, format, (v) => { format = v; })),
          backgroundSelect),
        el('label', { class: 'field' }, el('span', null, t('Lugar')), place),
        el('label', { class: 'field' }, el('span', null, t('Línea final (opcional)')), note),
        backgrounds.length ? null : el('p', { class: 'muted small' }, t('Sube una foto en «Experiencia» › «Materiales» para usarla de fondo, y marca tu logotipo para que salga arriba.')),
        el('div', { class: 'orgposter' }, canvas)),
      foot: el('div', { class: 'choices' },
        el('button', { type: 'button', class: 'ghost', id: 'posterPdf', onclick: () => { ctx.usage.track('organizers.ofertas.cartel_pdf'); void printPoster(); } }, icon('download', 16), ' ', t('PDF / imprimir')),
        el('button', { type: 'button', class: 'primary', id: 'posterJpg', onclick: () => { ctx.usage.track('organizers.ofertas.cartel_jpg'); savePoster(); } }, icon('image', 16), ' ', t('Guardar JPG'))),
    });
    await draw();

    function savePoster(): void {
      canvas.toBlob((blob) => {
        if (!blob) { toast(t('No se ha podido crear la imagen.')); return; }
        const a = el('a', { href: URL.createObjectURL(blob), download: `cartel-${slugOf(detail.title)}.jpg` }) as HTMLAnchorElement;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      }, 'image/jpeg', 0.9);
    }
    async function printPoster(): Promise<void> {
      // El PDF es el A4: si se está viendo otro formato, se dibuja en A4 para imprimir y se vuelve al elegido.
      const previous = format;
      format = 'a4'; await draw();
      const src = canvas.toDataURL('image/jpeg', 0.92);
      format = previous; await draw();
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
  }

  async function load(): Promise<void> {
    try {
      offers = await rowsOf(ctx.client, TABLES.offers, reservationId);
      const stored = await cache.draft<string>(ctx.userId, otherKey);
      if (typeof stored === 'string') other = stored;
      // Mientras se escribe en la calculadora no se repinta (perdería el foco).
      if (alive && !(host.contains(document.activeElement) && typing())) paint();
    } catch (error) {
      if (alive) toast(describeError(error));
    }
  }
  const off = watch(ctx.client, [TABLES.offers], () => { if (alive) void load(); });
  void load();
  (host as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; off(); };
  return host;
}

/** Foco en un campo de texto (no en un botón, una casilla o un desplegable). */
export const typing = (): boolean => {
  const a = document.activeElement as HTMLInputElement | null;
  return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(a.type)));
};

const slugOf = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'retiro';
