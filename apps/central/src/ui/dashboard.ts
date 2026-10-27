import type { SyncClient } from '@ikisai/sync-client';
import { el, icon, openSheet, replace, toast, type Sheet, type Usage } from '@ikisai/ui-kit';
import { collapseSeries, formatKpi, formatPeriod, groupBySection, seriesLength, stateSummary, validateOperations, type KpiState } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import { fbMark } from './feedback.ts';

interface DashboardItem {
  app: string; kpi: string; label: string; value: number | null; unit: string; period: string; periodStart: string | null; periodEnd: string | null;
  direction: 'up' | 'down' | null; link: string | null; computedAt: string; target: number | null; state: KpiState;
}
interface Dashboard { computedAt: string; items: DashboardItem[]; unavailable: string[] }

const CACHE_PREFIX = 'ikisai-central-dashboard-v1:';
/** Grupos plegados, por cuenta y dispositivo (R7): comodidad de quien mira, no estado compartido. */
const FOLDED_PREFIX = 'ikisai-central-dashboard-folded-v1:';
export const APP_NAMES: Record<string, string> = { central: 'Central', booking: 'Booking', invoices: 'Finance', tasks: 'Tasks', food: 'Food', resources: 'Recursos', guests: 'Guests', organizers: 'Organizers' };
const STATE_LABELS: Record<string, string> = { ok: 'En objetivo', atencion: 'Atención', critico: 'Crítico' };

function readCache(key: string): Dashboard | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as Dashboard : null; } catch { return null; }
}
function writeCache(key: string, d: Dashboard): void {
  try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* sin almacenamiento: se pinta igual */ }
}
function readFolded(key: string): Set<string> {
  try { const raw = localStorage.getItem(key); const list = raw ? JSON.parse(raw) as unknown : []; return new Set(Array.isArray(list) ? list.map(String) : []); } catch { return new Set(); }
}
function writeFolded(key: string, folded: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...folded])); } catch { /* sin almacenamiento: el plegado dura lo que la pantalla */ }
}
/**
 * Resumen por app de la última lectura guardada (para el menú lateral, sin red ni petición): cuántos indicadores tiene
 * cada app y cuántos están en crítico o en atención. Sin copia guardada, vacío.
 */
export function dashboardSummary(userId: string | null | undefined): Array<{ app: string; name: string; total: number; critical: number; attention: number }> {
  const d = readCache(CACHE_PREFIX + (userId ?? 'anon'));
  if (!d) return [];
  const apps = new Map<string, DashboardItem[]>();
  for (const i of d.items) apps.set(i.app, [...(apps.get(i.app) ?? []), i]);
  return [...apps].map(([app, items]) => {
    const shown = collapseSeries(items).map((c) => c.shown);
    const s = stateSummary(shown);
    return { app, name: APP_NAMES[app] ?? app, total: shown.length, critical: s.critico, attention: s.atencion };
  });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const stateClass = (s: KpiState) => (s === 'critico' ? 'alert' : s === 'atencion' ? 'warn' : 'ok');

/**
 * Regla de ceros (Bloque 2, MUELA-076 con §2 de PERDIDAS): solo se pliega un indicador a cero que está en objetivo o no
 * tiene objetivo. Un cero en crítico o en atención (0 € cobrados, 0 reservas con objetivo) se ve siempre.
 */
export const foldableZero = (i: { value: number | null; state: KpiState }) => i.value === 0 && (i.state === 'ok' || i.state === null);

/** «Meses pasados» y «Previsión» (076): los avisos de los periodos de antes y de después del que enseña la tarjeta. */
function periodNotes(series: DashboardItem[], shown: DashboardItem): HTMLElement[] {
  const monthly = /^\d{4}-\d{2}$/.test(shown.period);
  const note = (label: string, list: DashboardItem[]) => {
    const s = stateSummary(list);
    if (!s.critico && !s.atencion) return null;
    return el('span', { class: 'small kpiothers' }, `${label}: ${[s.critico ? plural(s.critico, 'crítico', 'críticos') : '', s.atencion ? `${s.atencion} en atención` : ''].filter(Boolean).join(' · ')}`);
  };
  return [
    note(monthly ? 'Meses pasados' : 'Periodos pasados', series.filter((s) => s !== shown && s.period < shown.period)),
    note('Previsión', series.filter((s) => s !== shown && s.period > shown.period)),
  ].filter((x): x is HTMLElement => !!x);
}

/** Barras de la serie (solo dibujo; los valores se leen en la hoja). Sin valor, hueco; el periodo de la tarjeta, resaltado. */
function sparkline(series: DashboardItem[], shown: DashboardItem): HTMLElement {
  const values = series.map((s) => (s.value !== null && Number.isFinite(s.value) ? Math.max(0, s.value) : null));
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const bars = values.map((v, k) => {
    if (v === null) return '';
    const h = max > 0 ? Math.max(1, (v / max) * 22) : 1;
    return `<rect x="${k * 6 + 1}" y="${(24 - h).toFixed(1)}" width="4" height="${h.toFixed(1)}" rx="1" class="${series[k] === shown ? 'on' : ''}"/>`;
  }).join('');
  const box = el('span', { class: 'kpispark', 'aria-hidden': 'true' });
  box.innerHTML = `<svg viewBox="0 0 ${series.length * 6} 24" preserveAspectRatio="none">${bars}</svg>`;
  return box;
}

/**
 * Panel de dirección (C01; API.md §7.2): KPIs que publica cada app, con su estado frente a los objetivos.
 * Solo agregados. Sin red se pinta la última lectura guardada en el dispositivo, con su hora, en una línea discreta sin
 * rojo («Indicadores del 14 oct, 11:40»): el «Sin conexión» en rojo lo dice una vez el menú lateral (MUELA-013). Los
 * indicadores se guardan aparte y pueden ser más antiguos que el resto de la app.
 * `focusApp`: abre ese grupo y baja hasta él (desde el menú); `''`, baja al panel.
 * `onData`: lo que enseña cada tarjeta (el periodo en curso de cada indicador), para la cola de Inicio (089).
 * Bloque 2 (MUELA-076): chips «N críticos» y «N en atención» que filtran, la regla de ceros («Ver k a cero») y, para quien
 * administra, «Ajustar objetivos» además del «Objetivo» de cada tarjeta.
 */
export function mountDashboard(host: HTMLElement, client: SyncClient, isAdmin: boolean, usage: Usage, focusApp: string | null = null,
  onData?: (items: Array<Pick<DashboardItem, 'app' | 'kpi' | 'label' | 'state' | 'value' | 'unit' | 'period' | 'link'>>) => void): () => void {
  let alive = true;
  // Copia por cuenta: en un dispositivo compartido, nadie ve lo que leyó otra cuenta (p. ej. importes del owner).
  const cacheKey = CACHE_PREFIX + (client.bootstrap()?.profile.userId ?? 'anon');
  const foldedKey = FOLDED_PREFIX + (client.bootstrap()?.profile.userId ?? 'anon');
  const folded = readFolded(foldedKey);
  const body = el('div', { class: 'kpigroups', 'data-feedback-id': 'central.direccion.indicadores', 'data-feedback-label': 'Indicadores por app' });
  const meta = el('p', { class: 'muted small', id: 'dashboardMeta', 'data-feedback-id': 'central.direccion.estado', 'data-feedback-label': 'Estado de actualización' });
  const chips = el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'Filtrar indicadores', id: 'kpiChips' });
  let filter: 'critico' | 'atencion' | null = null;
  let last: Dashboard | null = null;
  let lastFromCache = false;
  const zerosOpen = new Set<string>();
  replace(host, el('section', { class: 'dashboard', id: 'dashboard', 'data-feedback-id': 'central.direccion.panel', 'data-feedback-label': 'Panel de dirección' },
    el('div', { class: 'blockhead', 'data-feedback-id': 'central.direccion.cabecera', 'data-feedback-label': 'Cabecera del panel' }, el('h3', null, 'Dirección'),
      el('a', { class: 'softbtn btnlike', href: '#/direccion/semana', id: 'openWeekly', 'data-feedback-id': 'central.direccion.revision_semanal', 'data-feedback-label': 'Revisión semanal' }, icon('list', 16), 'Revisión semanal'),
      isAdmin ? el('button', { class: 'linkbtn', type: 'button', id: 'adjustTargets', 'data-feedback-id': 'central.direccion.ajustar_objetivos', 'data-feedback-label': 'Ajustar objetivos', onclick: () => openTargets() }, icon('settings', 16), 'Ajustar objetivos') : null,
      el('button', { class: 'iconbtn', type: 'button', 'data-feedback-id': 'central.direccion.actualizar', 'data-feedback-label': 'Actualizar indicadores', 'aria-label': 'Actualizar indicadores', title: 'Actualizar', onclick: () => void load() }, icon('sync', 18))),
    meta, chips, body));

  /** Tarjeta de un indicador. Con serie (varios periodos), el periodo en curso, sus barras, los avisos de los demás periodos y «Ver». */
  function card(i: DashboardItem, series: DashboardItem[] = [i]): HTMLElement {
    const external = i.link && !i.link.startsWith(location.origin) ? i.link : null;
    const hash = i.link && i.link.startsWith('https://central.ikisai.com/') ? i.link.slice('https://central.ikisai.com/'.length) : null;
    const others = series.filter((s) => s !== i);
    const content = [
      el('span', { class: 'kpilabel' }, i.label),
      el('strong', { class: 'kpivalue' }, formatKpi(i.value, i.unit)),
      el('span', { class: 'muted small' }, [formatPeriod(i.period), i.target !== null ? `objetivo ${formatKpi(i.target, i.unit)}` : ''].filter(Boolean).join(' · ')),
      i.state ? el('span', { class: `chip kpistate ${stateClass(i.state)}` }, STATE_LABELS[i.state]) : null,
      others.length ? sparkline(series, i) : null,
      // Nada se esconde: si un mes pasado o uno previsto está en crítico o en atención, la tarjeta lo dice.
      ...periodNotes(series, i),
      others.length ? el('button', { class: 'linkbtn kpiseries', type: 'button', 'aria-label': `Ver ${seriesLength(series)} de ${i.label}`, 'data-feedback-id': 'central.direccion.kpi.serie', 'data-feedback-label': 'Ver la serie del indicador',
        onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); openSeries(i, series); } }, icon('list', 14), `Ver ${seriesLength(series)}`) : null,
    ];
    const target = isAdmin ? el('button', { class: 'linkbtn kpitarget', type: 'button', 'aria-label': `Objetivo de ${i.label}`, 'data-feedback-id': 'central.direccion.kpi.objetivo', 'data-feedback-label': 'Objetivo del indicador', onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); openTarget(i); } }, icon('settings', 14), 'Objetivo') : null;
    const zero = foldableZero(i);
    const attrs = { class: `kpicard state-${i.state ?? 'none'}${zero ? ' kpizero' : ''}`, 'data-kpi': i.kpi, 'data-feedback-id': 'central.direccion.kpi.tarjeta', 'data-feedback-label': 'Tarjeta de indicador' };
    if (hash) return el('a', { ...attrs, href: hash.startsWith('#') ? hash : `#${hash}` }, ...content, target);
    if (external) return el('a', { ...attrs, href: external, target: '_blank', rel: 'noopener' }, ...content, target);
    return el('div', attrs, ...content, target);
  }

  /** Resumen de la cabecera: lo que está en crítico o en atención; si no hay nada, cuántos indicadores tiene. */
  function summary(items: DashboardItem[]): HTMLElement {
    const s = stateSummary(items);
    if (!s.critico && !s.atencion) return el('span', { class: 'muted small kpisummary' }, plural(s.total, 'indicador', 'indicadores'));
    return el('span', { class: 'chips kpisummary' },
      s.critico ? el('span', { class: 'chip kpistate alert' }, plural(s.critico, 'crítico', 'críticos')) : null,
      s.atencion ? el('span', { class: 'chip kpistate warn' }, `${s.atencion} en atención`) : null);
  }

  /** Un grupo por app (R7): cabecera que pliega, con su resumen; dentro, los temas de `KPI_SECTIONS` con su subtítulo. */
  function group(app: string, items: DashboardItem[]): HTMLElement {
    const name = APP_NAMES[app] ?? app;
    const isFolded = folded.has(app);
    // Una tarjeta por indicador: las series (un valor por mes) se recogen en la suya.
    const collapsed = collapseSeries(items);
    const seriesOf = new Map(collapsed.map((c) => [c.shown, c.series]));
    const zeros = collapsed.filter((c) => foldableZero(c.shown)).length;
    const showZeros = zerosOpen.has(app) || !!filter;
    const zerosBtn = zeros ? el('button', { type: 'button', class: 'linkbtn kpizeros', 'aria-expanded': String(zerosOpen.has(app)), 'data-feedback-id': 'central.direccion.grupo.ceros', 'data-feedback-label': 'Ver los indicadores a cero',
      onclick: () => { if (zerosOpen.has(app)) zerosOpen.delete(app); else zerosOpen.add(app); if (last) paint(last, lastFromCache); } }, zerosOpen.has(app) ? 'Ocultar los que están a cero' : `Ver ${zeros} a cero ›`) : null;
    const visible = (i: DashboardItem) => (!filter || i.state === filter) && (showZeros || !foldableZero(i));
    const content = el('div', { class: 'kpigroupbody', id: `kpis-${app}`, hidden: isFolded },
      ...groupBySection(collapsed.map((c) => c.shown)).map((s) => {
        const cards = s.items.map((i) => { const c = card(i, seriesOf.get(i)); if (!visible(i)) c.hidden = true; return c; });
        const shown = s.items.filter(visible).length;
        return [
          s.title ? el('div', { class: 'kpisection', hidden: !!filter && !shown, 'data-feedback-id': 'central.direccion.grupo.tema', 'data-feedback-label': 'Tema de indicadores' }, s.title) : null,
          s.title && !shown && !filter ? el('p', { class: 'muted small kpiallzero' }, 'Todo a cero.') : null,
          el('div', { class: 'kpigrid', 'data-feedback-id': 'central.direccion.grupo.tarjetas', 'data-feedback-label': 'Rejilla de indicadores' }, ...cards)];
      }),
      filter ? null : zerosBtn);
    const box = el('div', { class: `kpigroup${isFolded ? ' folded' : ''}`, 'data-app': app, 'data-feedback-id': 'central.direccion.grupo.app', 'data-feedback-label': `Indicadores de ${name}` });
    const head = el('button', { class: 'kpigrouphead', type: 'button', 'aria-expanded': String(!isFolded), 'aria-controls': `kpis-${app}`,
      'aria-label': `${isFolded ? 'Desplegar' : 'Plegar'} ${name}`, 'data-feedback-id': 'central.direccion.grupo.plegar', 'data-feedback-label': 'Plegar o desplegar el grupo',
      onclick: () => {
        const now = !folded.has(app);
        if (now) folded.add(app); else folded.delete(app);
        writeFolded(foldedKey, folded);
        box.classList.toggle('folded', now);
        content.hidden = now;
        head.setAttribute('aria-expanded', String(!now));
        head.setAttribute('aria-label', `${now ? 'Desplegar' : 'Plegar'} ${name}`);
      } },
      el('span', { class: 'sectionlabel' }, name), summary(collapsed.map((c) => c.shown)),
      zeros && !filter ? el('span', { class: 'muted small kpizerocount' }, `· ${zeros} a cero`) : null, icon('chevronDown', 18));
    box.append(head, content);
    if (filter && !collapsed.some((c) => c.shown.state === filter)) box.hidden = true;
    return box;
  }

  function paintChips(shown: DashboardItem[]): void {
    const s = stateSummary(shown);
    if (filter && !s[filter]) filter = null;
    const chip = (value: 'critico' | 'atencion', text: string) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(filter === value), dataset: { state: value },
      'data-feedback-id': 'central.direccion.filtro', 'data-feedback-label': 'Filtrar indicadores', onclick: () => { filter = filter === value ? null : value; if (last) paint(last, lastFromCache); } }, text);
    replace(chips, s.critico ? chip('critico', plural(s.critico, 'crítico', 'críticos')) : null, s.atencion ? chip('atencion', `${s.atencion} en atención`) : null);
    chips.hidden = !s.critico && !s.atencion;
  }

  function paint(d: Dashboard, fromCache: boolean): void {
    last = d;
    lastFromCache = fromCache;
    const groups = new Map<string, DashboardItem[]>();
    for (const i of d.items) groups.set(i.app, [...(groups.get(i.app) ?? []), i]);
    const shown = collapseSeries(d.items).map((c) => c.shown);
    paintChips(shown);
    replace(body, ...[...groups].map(([app, items]) => group(app, items)));
    onData?.(shown);
    const time = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date(d.computedAt));
    const waiting = d.unavailable.filter((a) => a !== 'central').map((a) => APP_NAMES[a] ?? a);
    meta.textContent = [fromCache ? `Indicadores del ${time}` : `Actualizado ${time}`,
      waiting.length ? `Aún sin indicadores: ${waiting.join(', ')}` : ''].filter(Boolean).join(' · ');
  }

  async function load(): Promise<void> {
    if (!navigator.onLine) { const cached = readCache(cacheKey); if (cached) paint(cached, true); else meta.textContent = 'Los indicadores se leen de cada app cuando hay conexión.'; return; }
    try {
      const d = await client.api<Dashboard>('/dashboard');
      if (!alive) return;
      writeCache(cacheKey, d);
      paint(d, false);
    } catch (error) {
      const cached = readCache(cacheKey);
      if (cached) paint(cached, true);
      meta.textContent = `${meta.textContent ? meta.textContent + ' · ' : ''}${describeError(error)}`;
    }
  }

  /** La serie entera de un indicador, del periodo más antiguo al más nuevo, con su valor y su estado. */
  function openSeries(i: DashboardItem, series: DashboardItem[]): void {
    openSheet({ title: i.label, meta: seriesLength(series),
      body: el('ul', { class: 'kpiserieslist', 'data-feedback-id': 'central.direccion.serie.lista', 'data-feedback-label': 'Valores de la serie' },
        ...series.map((s) => el('li', { class: `kpiseriesrow${s === i ? ' current' : ''}`, 'data-period': s.period },
          el('span', { class: 'kpiseriesperiod' }, formatPeriod(s.period), s === i ? el('span', { class: 'muted small' }, ' · en la tarjeta') : null),
          el('strong', { class: 'kpiseriesvalue' }, formatKpi(s.value, s.unit)),
          s.state ? el('span', { class: `chip kpistate ${stateClass(s.state)}` }, STATE_LABELS[s.state]) : null))),
      panelAttrs: { 'data-feedback-id': 'central.direccion.serie.hoja', 'data-feedback-label': 'Serie del indicador' },
      closeAttrs: { 'data-feedback-id': 'central.direccion.serie.cerrar', 'data-feedback-label': 'Cerrar' } });
  }

  /** «Ajustar objetivos» (076): la lista de indicadores por app, cada uno con su «Objetivo». Sigue también en cada tarjeta. */
  function openTargets(): void {
    if (!last) return;
    let sheet: Sheet | null = null;
    const groups = new Map<string, DashboardItem[]>();
    for (const i of collapseSeries(last.items).map((c) => c.shown)) groups.set(i.app, [...(groups.get(i.app) ?? []), i]);
    sheet = openSheet({ title: 'Ajustar objetivos',
      body: el('div', { id: 'targetsList', 'data-feedback-id': 'central.direccion.objetivos.lista', 'data-feedback-label': 'Indicadores y objetivos' },
        ...[...groups].flatMap(([app, items]) => [el('h4', { class: 'sectionlabel' }, APP_NAMES[app] ?? app),
          el('ul', { class: 'list' }, ...items.map((i) => el('li', { class: 'agentrow', 'data-kpi': i.kpi },
            el('div', null, el('strong', null, i.label), el('div', { class: 'muted small' }, [formatKpi(i.value, i.unit), i.target !== null ? `objetivo ${formatKpi(i.target, i.unit)}` : 'sin objetivo', i.state ? STATE_LABELS[i.state] : ''].filter(Boolean).join(' · '))),
            el('button', { type: 'button', class: 'ghost small', 'aria-label': `Objetivo de ${i.label}`, 'data-feedback-id': 'central.direccion.objetivos.objetivo', 'data-feedback-label': 'Objetivo del indicador',
              onclick: () => { void sheet?.close(true); openTarget(i); } }, 'Objetivo'))))])),
      panelAttrs: { 'data-feedback-id': 'central.direccion.objetivos', 'data-feedback-label': 'Ajustar objetivos' },
      closeAttrs: { 'data-feedback-id': 'central.direccion.objetivos.cerrar', 'data-feedback-label': 'Cerrar' } });
  }

  function openTarget(i: DashboardItem): void {
    void (async () => {
      const rows = await client.list(T.kpiTargets);
      const current = rows.find((r) => r.kpi === i.kpi && r.period === '*') as Record<string, any> | undefined;
      let sheet: Sheet | null = null;
      const num = (id: string, v: unknown) => el('input', { id, type: 'number', step: 'any', inputmode: 'decimal', value: v === null || v === undefined ? '' : String(v) }) as HTMLInputElement;
      const target = fbMark(num('k-target', current?.target), 'central.direccion.objetivo.objetivo', 'Objetivo');
      const warn = fbMark(num('k-warn', current?.warn_at), 'central.direccion.objetivo.atencion', 'Umbral de atención');
      const critical = fbMark(num('k-critical', current?.critical_at), 'central.direccion.objetivo.critico', 'Umbral crítico');
      const direction = el('select', { id: 'k-direction', 'data-field-id': 'central.inicio.direction', 'data-field-entity': 'central.kpi_targets', 'data-field-prop': 'direction', 'data-feedback-id': 'central.direccion.objetivo.sentido', 'data-feedback-label': 'Sentido' },
        el('option', { value: 'up', selected: (current?.direction ?? i.direction ?? 'up') === 'up' }, 'Más es mejor'),
        el('option', { value: 'down', selected: (current?.direction ?? i.direction) === 'down' }, 'Menos es mejor')) as HTMLSelectElement;
      const error = el('p', { class: 'formerror', role: 'alert', 'data-feedback-id': 'central.direccion.objetivo.error', 'data-feedback-label': 'Error del formulario' });
      const value = (input: HTMLInputElement) => (input.value === '' ? null : Number(input.value.replace(',', '.')));
      const save = el('button', { class: 'primary', type: 'button', id: 'saveTarget', 'data-feedback-id': 'central.direccion.objetivo.guardar', 'data-feedback-label': 'Guardar', onclick: async () => {
        const fields = { kpi: i.kpi, period: '*', target: value(target), warn_at: value(warn), critical_at: value(critical), direction: direction.value };
        const operations = current
          ? [{ op: 'update' as const, table: T.kpiTargets, id: String(current.id), expectedRevision: Number(current.revision), fields }]
          : [{ op: 'insert' as const, table: T.kpiTargets, id: crypto.randomUUID(), fields }];
        const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' });
        if (issue) { error.textContent = issue.message; return; }
        try {
          await usage.run('central.direccion.objetivo.guardar', () => client.commit(operations));
          await client.sync().catch(() => {});
          toast('Objetivo guardado.');
          await sheet?.close(true);
          await load();
        } catch (e) { error.textContent = describeError(e); }
      } }, 'Guardar');
      sheet = openSheet({ title: 'Objetivo', meta: i.label,
        body: el('div', { 'data-feedback-id': 'central.direccion.objetivo.formulario', 'data-feedback-label': 'Objetivo del indicador' },
          el('p', { class: 'muted small' }, 'Con «menos es mejor», el estado pasa a atención o crítico por encima del umbral; con «más es mejor», por debajo.'),
          el('label', { class: 'field' }, el('span', null, 'Sentido'), direction),
          el('label', { class: 'field' }, el('span', null, 'Objetivo'), target),
          el('div', { class: 'fieldrow', 'data-feedback-id': 'central.direccion.objetivo.umbrales', 'data-feedback-label': 'Umbrales' }, el('label', { class: 'field' }, el('span', null, 'Umbral de atención'), warn), el('label', { class: 'field' }, el('span', null, 'Umbral crítico'), critical)),
          error),
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.direccion.objetivo.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save], initialFocus: target });
    })();
  }

  // Desde el menú: el grupo de esa app, abierto y a la vista.
  if (focusApp) folded.delete(focusApp);
  const reveal = () => {
    if (focusApp === null) return;
    const target = focusApp ? body.querySelector<HTMLElement>(`.kpigroup[data-app="${CSS.escape(focusApp)}"]`) : null;
    (target ?? host).scrollIntoView({ block: 'start' });
  };
  const cached = readCache(cacheKey);
  if (cached) { paint(cached, !navigator.onLine); reveal(); }
  void load().then(() => { if (!cached) reveal(); });
  return () => { alive = false; };
}
