/**
 * Accesos · Agentes (Bloque 2, MUELA-085 «Grupos por app»): un grupo por app, lo peor primero, con su resumen («1 vence:
 * quedan 5 días · 1 sin usar»). La caducidad, con `deadlineText`. Las revocadas, plegadas al final.
 * - Cada clave va **en un solo grupo** (PERDIDAS §2): el de su app si solo entra en una; si entra en varias, en «Varias
 *   apps», con las apps escritas. Revocar la corta en todas, y la confirmación lo dice.
 * - Sin red: la última lista de la sesión, y «Revocar» con el motivo (`bindOnline`).
 */
import { bindOnline, confirmDialog, deadlineInfo, deadlineText, el, formatDate, icon, plural, relativeTime, renderGroups, replace, toast, type Tone } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { ROLE_LABELS, type AdminApi, type AgentKey, type CatalogApp } from '../app/admin.ts';
import type { Usage } from '@ikisai/ui-kit';
import { appShort, NEEDS_NETWORK, offlineNote, type AccessState } from './access-common.ts';
import { fbIgnoreWithin } from './feedback.ts';

const SOON_DAYS = 14;

/** Tono de una clave viva: caducada (alerta), caduca en dos semanas (aviso), sin usar (aviso suave: `ok` con texto). */
export function keyTone(k: AgentKey, now = new Date()): Tone | null {
  if (k.revokedAt) return null;
  if (k.expiresAt) {
    const info = deadlineInfo(k.expiresAt, { now });
    if (info.overdue) return 'alert';
    if (info.unit === 'minutes' ? info.amount <= SOON_DAYS * 1440 : info.amount <= SOON_DAYS) return 'warn';
  }
  return null;
}

/** El grupo de una clave: la app en la que entra, o «Varias apps». */
export function keyGroup(k: AgentKey): string {
  const apps = [...new Set(k.memberships.map((m) => m.app))];
  return apps.length === 1 ? apps[0]! : apps.length ? 'varias' : 'ninguna';
}

/** «1 vence: quedan 5 días · 1 sin usar», o «2 claves en uso». */
export function groupSummary(keys: AgentKey[], now = new Date()): string {
  const expired = keys.filter((k) => keyTone(k, now) === 'alert');
  const soon = keys.filter((k) => keyTone(k, now) === 'warn').sort((a, b) => a.expiresAt!.localeCompare(b.expiresAt!));
  const unused = keys.filter((k) => !k.lastUsedAt).length;
  const parts = [
    expired.length ? plural(expired.length, 'caducada', 'caducadas') : null,
    soon.length ? `${soon.length} ${soon.length === 1 ? 'vence' : 'vencen'}: ${deadlineInfo(soon[0]!.expiresAt!, { now }).left}` : null,
    unused ? `${unused} sin usar` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : plural(keys.length, 'clave en uso', 'claves en uso');
}

export async function mountAgents(body: HTMLElement, admin: AdminApi, state: AccessState, usage: Usage): Promise<void> {
  let catalog: CatalogApp[] = admin.cached.catalog ?? [];
  const list = el('div', { id: 'agentList', 'data-feedback-id': 'central.accesos.agentes.lista', 'data-feedback-label': 'Claves de agentes' });
  const note = el('div', { 'data-feedback-id': 'central.accesos.agentes.aviso', 'data-feedback-label': 'Aviso de agentes' });
  replace(body, el('p', { class: 'muted' }, 'Las claves las emite el propietario de cada app. Revocar una clave la corta en todas las apps y revoca sus propuestas abiertas.'), note, list);
  let binds: Array<() => void> = [];
  state.cleanups.push(() => { for (const b of binds) b(); });

  const appsOf = (k: AgentKey) => k.memberships.map((m) => `${appShort(catalog, m.app)} (${ROLE_LABELS[m.role]})`).join(', ') || 'sin accesos';

  function row(k: AgentKey): HTMLElement {
    const tone = keyTone(k);
    const revoke = k.revokedAt ? null : el('button', { class: 'danger small', type: 'button', 'aria-label': `Revocar: ${k.name}`, 'data-feedback-id': 'central.accesos.agentes.revocar', 'data-feedback-label': 'Revocar clave', onclick: () => void doRevoke(k) }, 'Revocar');
    if (revoke) binds.push(bindOnline(revoke, { reason: NEEDS_NETWORK }));
    return el('li', { class: `agentrow${tone ? ` ${tone}` : ''}`, 'data-key': k.keyId, 'data-feedback-id': 'central.accesos.agentes.fila', 'data-feedback-label': 'Clave de agente' },
      el('div', null,
        el('strong', null, icon('bot', 16), ' ', k.name), el('span', { class: 'muted', 'data-feedback-ignore': '' }, ` · …${k.hint}`),
        el('div', { class: 'muted small' }, [
          appsOf(k),
          k.lastUsedAt ? `usada ${relativeTime(k.lastUsedAt)}` : 'sin usar',
          k.revokedAt ? null : k.expiresAt ? deadlineText(k.expiresAt, { prefix: 'Caduca el' }) : 'sin caducidad',
        ].filter(Boolean).join(' · '))),
      k.revokedAt ? el('span', { class: 'chip alert' }, `Revocada ${formatDate(k.revokedAt, 'short')}`) : revoke);
  }

  function paint(keys: AgentKey[]): void {
    for (const b of binds) b();
    binds = [];
    const alive = keys.filter((k) => !k.revokedAt);
    const revoked = keys.filter((k) => k.revokedAt);
    const by = new Map<string, AgentKey[]>();
    for (const k of alive) by.set(keyGroup(k), [...(by.get(keyGroup(k)) ?? []), k]);
    const order = [...catalog.map((a) => a.id), 'varias', 'ninguna'];
    const groups = [...by.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([key, items]) => ({
      key, items, summary: groupSummary(items),
      title: key === 'varias' ? 'Varias apps' : key === 'ninguna' ? 'Sin accesos' : appShort(catalog, key),
      medal: { name: key === 'varias' ? 'Varias apps' : appShort(catalog, key) },
      // Con pocas claves, todos abiertos; con muchas, solo los que piden algo (lo de `renderGroups`).
      ...(alive.length <= 8 ? { open: true } : {}),
      feedbackId: 'central.accesos.agentes.grupo',
    }));
    replace(list,
      groups.length
        ? fbIgnoreWithin(renderGroups<AgentKey>({ label: 'Claves por app', groups, toneOf: (k) => keyTone(k), worstFirst: true, row }).element, '.medal-disc')
        : el('p', { class: 'empty hint' }, 'No hay claves de agentes activas.'),
      revoked.length ? el('details', { class: 'ctl-revoked', 'data-feedback-id': 'central.accesos.agentes.revocadas', 'data-feedback-label': 'Claves revocadas' },
        el('summary', null, `Revocadas (${revoked.length})`), el('ul', { class: 'list' }, ...revoked.map(row))) : null);
  }

  async function doRevoke(k: AgentKey): Promise<void> {
    const others = k.memberships.length > 1 ? ` (${appsOf(k)})` : '';
    if (!(await confirmDialog({ title: `¿Revocar la clave de «${k.name}»?`, text: `El agente deja de poder entrar en todas las apps${others}. No se puede deshacer: habría que emitir otra clave.`, confirmLabel: 'Revocar', danger: true }))) return;
    try {
      const out = await usage.run('central.accesos.agentes.revocar', () => admin.revokeAgent(k.keyId));
      toast(out.proposalsRevoked ? `Clave revocada y ${plural(out.proposalsRevoked, 'propuesta cerrada', 'propuestas cerradas')}.` : 'Clave revocada.');
      await load();
    } catch (e) { toast(describeError(e)); }
  }

  async function load(): Promise<void> {
    try {
      const [keys, apps] = await Promise.all([admin.agents(), admin.catalog().catch(() => catalog)]);
      catalog = apps;
      replace(note);
      if (state.alive) paint(keys);
    } catch (e) {
      replace(note, navigator.onLine ? el('p', { class: 'formerror', 'data-feedback-id': 'central.accesos.agentes.error', 'data-feedback-label': 'Error de agentes' }, describeError(e)) : offlineNote(admin.cached.agents?.at));
      // Sin leerlas, el aviso dice por qué (MUELA-085, C6): nada de «No hay claves».
      if (state.alive) { if (admin.cached.agents) paint(admin.cached.agents.items); else replace(list); }
    }
  }
  await load();
}
