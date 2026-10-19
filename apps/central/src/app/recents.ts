/**
 * Recientes del menú lateral (MUELA-013): lo último que abrió esta cuenta en este dispositivo (una obligación, una
 * persona, una decisión…). Comodidad de quien mira, por cuenta y dispositivo: se guarda en `localStorage` y se borra al
 * cerrar sesión. Solo los de Central: los de otras apps piden un dato entre apps que aún no existe.
 */

export type RecentKind = 'obligacion' | 'documento' | 'persona' | 'decision' | 'articulo' | 'pantalla';
export interface Recent { hash: string; title: string; kind: RecentKind; at: string }

const PREFIX = 'ikisai-central-recents-v1:';
const MAX = 8;

const key = (userId: string | null | undefined) => PREFIX + (userId ?? 'anon');

export function readRecents(userId: string | null | undefined): Recent[] {
  try {
    const raw = localStorage.getItem(key(userId));
    const list = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(list) ? list.filter((r): r is Recent => !!r && typeof r.hash === 'string' && typeof r.title === 'string') : [];
  } catch { return []; }
}

/** Apunta lo que se acaba de abrir (sin repetir la misma ruta) y devuelve la lista nueva. */
export function rememberRecent(userId: string | null | undefined, entry: Omit<Recent, 'at'>): Recent[] {
  const list = [{ ...entry, at: new Date().toISOString() }, ...readRecents(userId).filter((r) => r.hash !== entry.hash)].slice(0, MAX);
  try { localStorage.setItem(key(userId), JSON.stringify(list)); } catch { /* sin almacenamiento: el menú queda sin recientes */ }
  return list;
}

/** Al cerrar sesión: nadie más en este dispositivo ve lo que abrió esta cuenta. */
export function clearRecents(userId: string | null | undefined): void {
  try { localStorage.removeItem(key(userId)); } catch { /* nada que borrar */ }
}

export const RECENT_KIND_LABELS: Record<RecentKind, string> = {
  obligacion: 'Obligación', documento: 'Documento', persona: 'Persona', decision: 'Decisión', articulo: 'Artículo', pantalla: 'Pantalla',
};

/** «hace 5 min», «hace 2 h», «ayer», «hace 3 días». */
export function agoText(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'ayer' : `hace ${days} días`;
}
