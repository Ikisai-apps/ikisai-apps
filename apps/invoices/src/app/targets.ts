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
  area: 'Área', project: 'Proyecto', task: 'Tarea',
  reservation: 'Reserva', event: 'Evento',
  ingredient: 'Ingrediente', equipment: 'Maquinaria',
  unassigned: 'Sin asignar', operating_expense: 'Gasto de explotación', investment: 'Inversión',
};

export function targetLabel(t: { path?: string[]; label: string }): string {
  return t.path?.length ? `${t.path.join(' › ')} › ${t.label}` : t.label;
}
