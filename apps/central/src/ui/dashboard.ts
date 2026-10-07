import type { SyncClient } from '@ikisai/sync-client';
import { el, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { formatKpi, formatPeriod, validateOperations, type KpiState } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';

interface DashboardItem {
  app: string; kpi: string; label: string; value: number | null; unit: string; period: string; periodStart: string | null; periodEnd: string | null;
  direction: 'up' | 'down' | null; link: string | null; computedAt: string; target: number | null; state: KpiState;
}
interface Dashboard { computedAt: string; items: DashboardItem[]; unavailable: string[] }

const CACHE_PREFIX = 'ikisai-central-dashboard-v1:';
const APP_NAMES: Record<string, string> = { central: 'Central', booking: 'Booking', invoices: 'Finance', tasks: 'Tasks', food: 'Food' };
const STATE_LABELS: Record<string, string> = { ok: 'En objetivo', atencion: 'Atención', critico: 'Crítico' };

function readCache(key: string): Dashboard | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as Dashboard : null; } catch { return null; }
}
function writeCache(key: string, d: Dashboard): void {
  try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* sin almacenamiento: se pinta igual */ }
}

/**
 * Panel de dirección (C01; API.md §7.2): KPIs que publica cada app, con su estado frente a los objetivos.
 * Solo agregados. Sin red se pinta la última lectura guardada en el dispositivo, con su hora.
 */
export function mountDashboard(host: HTMLElement, client: SyncClient, isAdmin: boolean): () => void {
  let alive = true;
  // Copia por cuenta: en un dispositivo compartido, nadie ve lo que leyó otra cuenta (p. ej. importes del owner).
  const cacheKey = CACHE_PREFIX + (client.bootstrap()?.profile.userId ?? 'anon');
  const body = el('div', { class: 'kpigroups' });
  const meta = el('p', { class: 'muted small', id: 'dashboardMeta' });
  replace(host, el('section', { class: 'dashboard', id: 'dashboard' },
    el('div', { class: 'blockhead' }, el('h3', null, 'Dirección'),
      el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Actualizar indicadores', title: 'Actualizar', onclick: () => void load() }, icon('sync', 18))),
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
    const target = isAdmin ? el('button', { class: 'linkbtn kpitarget', type: 'button', 'aria-label': `Objetivo de ${i.label}`, onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); openTarget(i); } }, icon('settings', 14), 'Objetivo') : null;
    const attrs = { class: `kpicard state-${i.state ?? 'none'}`, 'data-kpi': i.kpi };
    if (hash) return el('a', { ...attrs, href: hash.startsWith('#') ? hash : `#${hash}` }, ...content, target);
    if (external) return el('a', { ...attrs, href: external, target: '_blank', rel: 'noopener' }, ...content, target);
    return el('div', attrs, ...content, target);
  }

  function paint(d: Dashboard, fromCache: boolean): void {
    const groups = new Map<string, DashboardItem[]>();
    for (const i of d.items) groups.set(i.app, [...(groups.get(i.app) ?? []), i]);
    replace(body, ...[...groups].map(([app, items]) => el('div', { class: 'kpigroup' },
      el('div', { class: 'sectionlabel' }, APP_NAMES[app] ?? app), el('div', { class: 'kpigrid' }, ...items.map(card)))));
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
      const target = num('k-target', current?.target);
      const warn = num('k-warn', current?.warn_at);
      const critical = num('k-critical', current?.critical_at);
      const direction = el('select', { id: 'k-direction' },
        el('option', { value: 'up', selected: (current?.direction ?? i.direction ?? 'up') === 'up' }, 'Más es mejor'),
        el('option', { value: 'down', selected: (current?.direction ?? i.direction) === 'down' }, 'Menos es mejor')) as HTMLSelectElement;
      const error = el('p', { class: 'formerror', role: 'alert' });
      const value = (input: HTMLInputElement) => (input.value === '' ? null : Number(input.value.replace(',', '.')));
      const save = el('button', { class: 'primary', type: 'button', id: 'saveTarget', onclick: async () => {
        const fields = { kpi: i.kpi, period: '*', target: value(target), warn_at: value(warn), critical_at: value(critical), direction: direction.value };
        const operations = current
          ? [{ op: 'update' as const, table: T.kpiTargets, id: String(current.id), expectedRevision: Number(current.revision), fields }]
          : [{ op: 'insert' as const, table: T.kpiTargets, id: crypto.randomUUID(), fields }];
        const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' });
        if (issue) { error.textContent = issue.message; return; }
        try {
          await client.commit(operations);
          await client.sync().catch(() => {});
          toast('Objetivo guardado.');
          await sheet?.close(true);
          await load();
        } catch (e) { error.textContent = describeError(e); }
      } }, 'Guardar');
      sheet = openSheet({ title: 'Objetivo', meta: i.label,
        body: el('div', null,
          el('p', { class: 'muted small' }, 'Con «menos es mejor», el estado pasa a atención o crítico por encima del umbral; con «más es mejor», por debajo.'),
          el('label', { class: 'field' }, el('span', null, 'Sentido'), direction),
          el('label', { class: 'field' }, el('span', null, 'Objetivo'), target),
          el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Umbral de atención'), warn), el('label', { class: 'field' }, el('span', null, 'Umbral crítico'), critical)),
          error),
        foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), save], initialFocus: target });
    })();
  }

  const cached = readCache(cacheKey);
  if (cached) paint(cached, !navigator.onLine);
  void load();
  return () => { alive = false; };
}
