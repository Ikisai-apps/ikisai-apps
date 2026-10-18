import type { SyncClient } from '@ikisai/sync-client';
import { el, icon, openSheet, replace, toast, type Sheet, type Usage } from '@ikisai/ui-kit';
import { formatKpi, formatPeriod, groupBySection, stateSummary, validateOperations, type KpiState } from '@ikisai/domain-central';
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
const APP_NAMES: Record<string, string> = { central: 'Central', booking: 'Booking', invoices: 'Finance', tasks: 'Tasks', food: 'Food', resources: 'Recursos' };
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
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Panel de dirección (C01; API.md §7.2): KPIs que publica cada app, con su estado frente a los objetivos.
 * Solo agregados. Sin red se pinta la última lectura guardada en el dispositivo, con su hora.
 */
export function mountDashboard(host: HTMLElement, client: SyncClient, isAdmin: boolean, usage: Usage): () => void {
  let alive = true;
  // Copia por cuenta: en un dispositivo compartido, nadie ve lo que leyó otra cuenta (p. ej. importes del owner).
  const cacheKey = CACHE_PREFIX + (client.bootstrap()?.profile.userId ?? 'anon');
  const foldedKey = FOLDED_PREFIX + (client.bootstrap()?.profile.userId ?? 'anon');
  const folded = readFolded(foldedKey);
  const body = el('div', { class: 'kpigroups', 'data-feedback-id': 'central.direccion.indicadores', 'data-feedback-label': 'Indicadores por app' });
  const meta = el('p', { class: 'muted small', id: 'dashboardMeta', 'data-feedback-id': 'central.direccion.estado', 'data-feedback-label': 'Estado de actualización' });
  replace(host, el('section', { class: 'dashboard', id: 'dashboard', 'data-feedback-id': 'central.direccion.panel', 'data-feedback-label': 'Panel de dirección' },
    el('div', { class: 'blockhead', 'data-feedback-id': 'central.direccion.cabecera', 'data-feedback-label': 'Cabecera del panel' }, el('h3', null, 'Dirección'),
      el('button', { class: 'iconbtn', type: 'button', 'data-feedback-id': 'central.direccion.actualizar', 'data-feedback-label': 'Actualizar indicadores', 'aria-label': 'Actualizar indicadores', title: 'Actualizar', onclick: () => void load() }, icon('sync', 18))),
    meta, body));

  function card(i: DashboardItem): HTMLElement {
    const external = i.link && !i.link.startsWith(location.origin) ? i.link : null;
    const hash = i.link && i.link.startsWith('https://central.ikisai.com/') ? i.link.slice('https://central.ikisai.com/'.length) : null;
    const content = [
      el('span', { class: 'kpilabel' }, i.label),
      el('strong', { class: 'kpivalue' }, formatKpi(i.value, i.unit)),
      el('span', { class: 'muted small' }, [formatPeriod(i.period), i.target !== null ? `objetivo ${formatKpi(i.target, i.unit)}` : ''].filter(Boolean).join(' · ')),
      i.state ? el('span', { class: `chip kpistate ${i.state === 'critico' ? 'alert' : i.state === 'atencion' ? 'warn' : 'ok'}` }, STATE_LABELS[i.state]) : null,
    ];
    const target = isAdmin ? el('button', { class: 'linkbtn kpitarget', type: 'button', 'aria-label': `Objetivo de ${i.label}`, 'data-feedback-id': 'central.direccion.kpi.objetivo', 'data-feedback-label': 'Objetivo del indicador', onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); openTarget(i); } }, icon('settings', 14), 'Objetivo') : null;
    const attrs = { class: `kpicard state-${i.state ?? 'none'}`, 'data-kpi': i.kpi, 'data-feedback-id': 'central.direccion.kpi.tarjeta', 'data-feedback-label': 'Tarjeta de indicador' };
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
    const content = el('div', { class: 'kpigroupbody', id: `kpis-${app}`, hidden: isFolded },
      ...groupBySection(items).map((s) => [
        s.title ? el('div', { class: 'kpisection', 'data-feedback-id': 'central.direccion.grupo.tema', 'data-feedback-label': 'Tema de indicadores' }, s.title) : null,
        el('div', { class: 'kpigrid', 'data-feedback-id': 'central.direccion.grupo.tarjetas', 'data-feedback-label': 'Rejilla de indicadores' }, ...s.items.map(card))]));
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
      el('span', { class: 'sectionlabel' }, name), summary(items), icon('chevronDown', 18));
    box.append(head, content);
    return box;
  }

  function paint(d: Dashboard, fromCache: boolean): void {
    const groups = new Map<string, DashboardItem[]>();
    for (const i of d.items) groups.set(i.app, [...(groups.get(i.app) ?? []), i]);
    replace(body, ...[...groups].map(([app, items]) => group(app, items)));
    const time = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date(d.computedAt));
    const waiting = d.unavailable.filter((a) => a !== 'central').map((a) => APP_NAMES[a] ?? a);
    meta.textContent = [fromCache ? `Sin conexión: datos del ${time}` : `Actualizado ${time}`,
      waiting.length ? `Aún sin indicadores: ${waiting.join(', ')}` : ''].filter(Boolean).join(' · ');
  }

  async function load(): Promise<void> {
    if (!navigator.onLine) { const cached = readCache(cacheKey); if (cached) paint(cached, true); else meta.textContent = 'Sin conexión: los indicadores se leen de cada app.'; return; }
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

  function openTarget(i: DashboardItem): void {
    void (async () => {
      const rows = await client.list(T.kpiTargets);
      const current = rows.find((r) => r.kpi === i.kpi && r.period === '*') as Record<string, any> | undefined;
      let sheet: Sheet | null = null;
      const num = (id: string, v: unknown) => el('input', { id, type: 'number', step: 'any', inputmode: 'decimal', value: v === null || v === undefined ? '' : String(v) }) as HTMLInputElement;
      const target = fbMark(num('k-target', current?.target), 'central.direccion.objetivo.objetivo', 'Objetivo');
      const warn = fbMark(num('k-warn', current?.warn_at), 'central.direccion.objetivo.atencion', 'Umbral de atención');
      const critical = fbMark(num('k-critical', current?.critical_at), 'central.direccion.objetivo.critico', 'Umbral crítico');
      const direction = el('select', { id: 'k-direction', 'data-feedback-id': 'central.direccion.objetivo.sentido', 'data-feedback-label': 'Sentido' },
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

  const cached = readCache(cacheKey);
  if (cached) paint(cached, !navigator.onLine);
  void load();
  return () => { alive = false; };
}
