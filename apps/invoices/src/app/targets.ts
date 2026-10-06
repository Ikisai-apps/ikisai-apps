/** Destinos de asignación (API.md §6.2, §7.2): búsqueda con red y caché local de los últimos usados para trabajar sin red. */
import type { SyncClient } from '@ikisai/sync-client';
import { TARGET_KINDS } from '@ikisai/domain-invoices';

export interface TargetChoice {
  app: 'tasks' | 'booking' | 'food';
  kind: string;
  id: string;
  code: string | null;
  label: string;
  path: string[];
  revision: number | null;
  archived: boolean;
}

const RECENT_KEY = 'ikisai-invoices-recent-targets';
const RECENT_MAX = 50;

export function recentTargets(): TargetChoice[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as TargetChoice[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function rememberTarget(target: TargetChoice): void {
  try {
    const list = recentTargets().filter((t) => !(t.app === target.app && t.kind === target.kind && t.id === target.id));
    list.unshift(target);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // sin almacenamiento local: no pasa nada
  }
}

export function forgetTarget(target: Pick<TargetChoice, 'app' | 'kind' | 'id'>): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentTargets().filter((t) => !(t.app === target.app && t.kind === target.kind && t.id === target.id))));
  } catch {
    // ignorar
  }
}

/** Busca destinos en la otra app con la sesión del usuario (requiere red). */
export async function searchTargets(client: SyncClient, app: TargetChoice['app'], query: string, kind?: string | null): Promise<TargetChoice[]> {
  const params = new URLSearchParams({ q: query });
  if (kind) params.set('kind', kind);
  const out = await client.api<{ items: TargetChoice[] }>(`/targets/${app}?${params}`);
  return out.items;
}

/** Revisión actual de un destino, para la obsolescencia por comparación (§7.3). */
export async function resolveTarget(client: SyncClient, app: TargetChoice['app'], kind: string, id: string): Promise<TargetChoice> {
  return client.api<TargetChoice>(`/targets/${app}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
}

export function kindsFor(app: string): readonly string[] {
  return TARGET_KINDS[app as keyof typeof TARGET_KINDS] ?? [];
}

export const KIND_LABELS: Record<string, string> = {
  area: 'Área', project: 'Proyecto', task: 'Tarea', purchase_request: 'Solicitud de compra',
  reservation: 'Reserva', event: 'Evento',
  ingredient: 'Ingrediente', equipment: 'Maquinaria',
  unassigned: 'Sin asignar', operating_expense: 'Gasto de explotación', investment: 'Inversión',
};

export function targetLabel(t: { path?: string[]; label: string }): string {
  return t.path?.length ? `${t.path.join(' › ')} › ${t.label}` : t.label;
}

export type TargetFreshness = 'ok' | 'changed' | 'missing' | 'unknown';

const freshnessCache = new Map<string, { at: number; value: TargetFreshness }>();
const FRESHNESS_TTL = 5 * 60_000;

/**
 * Obsolescencia por comparación (API.md §7.3): compara la revisión guardada con la actual del destino.
 * Solo con red; los resultados se guardan unos minutos para no consultar en cada repintado.
 */
export async function checkTargetFreshness(client: SyncClient, allocation: { target_app: string; target_kind: string; target_id: string | null; target_revision: number | null }): Promise<TargetFreshness> {
  if (allocation.target_app === 'general' || !allocation.target_id || !navigator.onLine) return 'unknown';
  const key = `${allocation.target_app}:${allocation.target_kind}:${allocation.target_id}`;
  const cached = freshnessCache.get(key);
  if (cached && Date.now() - cached.at < FRESHNESS_TTL) return cached.value;
  let value: TargetFreshness = 'unknown';
  try {
    const current = await resolveTarget(client, allocation.target_app as TargetChoice['app'], allocation.target_kind, allocation.target_id);
    value = current.archived ? 'missing' : allocation.target_revision !== null && current.revision !== null && current.revision !== allocation.target_revision ? 'changed' : 'ok';
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'TARGET_NOT_FOUND' || code === 'NOT_FOUND') value = 'missing';
  }
  freshnessCache.set(key, { at: Date.now(), value });
  return value;
}

export const FRESHNESS_LABELS: Record<TargetFreshness, string> = { ok: '', changed: 'destino cambiado', missing: 'destino desaparecido', unknown: '' };
