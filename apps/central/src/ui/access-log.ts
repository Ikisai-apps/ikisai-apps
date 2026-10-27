/**
 * Accesos · Registro (Bloque 2, MUELA-085 «Por persona», con lo que se conserva de §1 y §2 de PERDIDAS_central_bloque2):
 * - Arriba, **«Lo grave»**: claves revocadas, cuentas desactivadas y accesos quitados (`only=grave`, P12).
 * - **Por persona** (por defecto): un grupo por cuenta con su línea de tiempo, abierto si tiene algo grave. Una entrada sale
 *   en el grupo de quien lo hizo y en el de a quien afecta.
 * - **Por fecha**, la de antes, a un toque: todo junto, por día, para ver qué pasó en una franja.
 * - Chips de app y de tipo, selector de persona (filtra en el núcleo: `user`, P12) y «Cargar más» de 50 en 50 en las dos.
 * - Cada línea con su día y su hora («lun 19 oct, 10:42»): es un registro de seguridad.
 * - X1 de Tasks (FB_2026_073): `#/accesos/registro?app=<app>` abre ya filtrado por esa app y «Por fecha» (la lista corrida,
 *   la más reciente arriba), sin cambiar la vista que recuerda el dispositivo; en cada línea, quién lo hizo con su tipo
 *   (persona o agente) y a qué afecta (la persona, o la clave o la propuesta por su nombre); el ciclo de las propuestas de
 *   agentes con sus palabras y su tono; «Ver anteriores».
 */
import { bindOnline, el, relativeTime, renderAccessLog, renderGroups, replace, type AccessLogEntry, type Tone } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { EVENT_LABELS, EVENT_TONES, ROLE_LABELS, type AccessEvent, type AdminApi, type Account, type CatalogApp, type Role } from '../app/admin.ts';
import { appShort, dayAndTime, offlineNote, type AccessState } from './access-common.ts';
import { fbIgnoreWithin } from './feedback.ts';

type LogView = 'persona' | 'fecha';
type Kind = 'accesos' | 'claves' | 'propuestas' | 'cuenta';
const KIND_LABELS: Record<Kind, string> = { accesos: 'Accesos', claves: 'Claves', propuestas: 'Propuestas', cuenta: 'Cuenta' };
const VIEW_KEY = 'ikisai-central-registro-vista';

/** El evento que cuenta (Core anota contraseña, desactivación y nombre como `member_changed` con el detalle en `meta.event`). */
export function eventOf(e: AccessEvent): string {
  const meta = e.meta ?? {};
  return e.event === 'member_changed' && typeof meta.event === 'string' ? meta.event : e.event;
}

/** Lo grave (la misma regla que el núcleo para `only=grave`): claves revocadas, desactivaciones y accesos quitados. */
export function isGrave(e: AccessEvent): boolean {
  const event = eventOf(e);
  return event === 'key_revoked' || event === 'account_disabled' || e.meta?.removed === true;
}

export function kindOf(e: AccessEvent): Kind {
  const event = eventOf(e);
  if (event.startsWith('key_')) return 'claves';
  if (event.startsWith('proposal_')) return 'propuestas';
  if (event === 'member_changed' || event === 'member_invited') return 'accesos';
  return 'cuenta';
}

/** Cuentas a las que toca una entrada: quien lo hizo y a quien afecta (sin repetir). */
export function peopleOf(e: AccessEvent): string[] {
  const target = typeof e.meta?.userId === 'string' ? e.meta.userId : null;
  return [...new Set([e.actorId, target].filter((x): x is string => !!x))];
}

/** `?app=tasks` del enlace de otra app (X1): la app con la que abrir el registro, o '' si no viene o no es un id válido. */
export function appFromHash(hash: string): string {
  const value = new URLSearchParams(hash.split('?')[1] ?? '').get('app') ?? '';
  return /^[a-z][a-z0-9_]{0,31}$/.test(value) ? value : '';
}

export async function mountLog(body: HTMLElement, admin: AdminApi, state: AccessState): Promise<void> {
  let items: AccessEvent[] = [];
  let nextBefore: number | null = null;
  // Desde otra app (X1): ya filtrado por ella y en la lista corrida; la vista que recuerda el dispositivo no cambia.
  const fromApp = appFromHash(location.hash);
  let app = fromApp;
  let user = '';
  const kinds = new Set<Kind>();
  let view: LogView = fromApp ? 'fecha' : (() => { try { return localStorage.getItem(VIEW_KEY) === 'fecha' ? 'fecha' : 'persona'; } catch { return 'persona'; } })();
  let catalog: CatalogApp[] = admin.cached.catalog ?? [];
  let accounts: Account[] = admin.cached.accounts?.items ?? [];
  const names = new Map<string, string>(accounts.map((a) => [a.userId, a.displayName || a.email || 'Cuenta']));

  const grave = el('section', { class: 'ctl-grave', id: 'logGrave', 'aria-label': 'Lo grave', 'data-feedback-id': 'central.accesos.registro.grave', 'data-feedback-label': 'Lo grave' });
  const host = el('div', { id: 'accessLog', 'data-feedback-id': 'central.accesos.registro.entradas', 'data-feedback-label': 'Registro de accesos' });
  const loaded = el('p', { class: 'hint', id: 'logLoaded', 'aria-live': 'polite' });
  const more = el('button', { class: 'ghost', type: 'button', id: 'logMore', 'data-feedback-id': 'central.accesos.registro.cargar_mas', 'data-feedback-label': 'Ver anteriores', hidden: true, onclick: () => void load(false) }, 'Ver anteriores') as HTMLButtonElement;
  state.cleanups.push(bindOnline(more, { reason: 'El registro se lee en el momento: necesita conexión.' }));
  const filter = el('select', { id: 'logApp', 'data-field-id': 'central.accesos.log_app', 'aria-label': 'App', 'data-feedback-id': 'central.accesos.registro.filtro_app', 'data-feedback-label': 'Filtro por app', onchange: (e: Event) => { app = (e.target as HTMLSelectElement).value; void load(true); } },
    el('option', { value: '' }, 'Todas las apps')) as HTMLSelectElement;
  const person = el('select', { id: 'logPerson', 'data-field-id': 'central.accesos.log_person', 'aria-label': 'Persona', 'data-feedback-id': 'central.accesos.registro.persona', 'data-feedback-label': 'Selector de persona', onchange: (e: Event) => { user = (e.target as HTMLSelectElement).value; void load(true); } },
    el('option', { value: '' }, 'Todas las personas')) as HTMLSelectElement;
  const viewButton = (value: LogView, label: string) => el('button', { type: 'button', dataset: { view: value }, 'aria-pressed': String(view === value), class: view === value ? 'on' : '', onclick: () => setView(value) }, label);
  const viewBar = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Cómo verlo', id: 'logView', 'data-feedback-id': 'central.accesos.registro.vista', 'data-feedback-label': 'Por persona o por fecha' },
    viewButton('persona', 'Por persona'), viewButton('fecha', 'Por fecha'));
  const kindChips = el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'Tipo', id: 'logKinds' });
  replace(body,
    grave,
    el('div', { class: 'toolbar', 'data-feedback-id': 'central.accesos.registro.barra', 'data-feedback-label': 'Barra del registro' }, viewBar, filter, person),
    kindChips, host, loaded, more);

  const agents = new Set<string>(accounts.filter((a) => a.kind === 'agent').map((a) => a.userId));
  function fillSelectors(): void {
    for (const a of catalog) if (!filter.querySelector(`option[value="${a.id}"]`)) filter.append(el('option', { value: a.id }, appShort(catalog, a.id)));
    if (app && filter.querySelector(`option[value="${app}"]`)) filter.value = app;
    for (const a of accounts) if (a.kind === 'agent') agents.add(a.userId);
    for (const a of accounts) names.set(a.userId, a.displayName || a.email || 'Cuenta');
    const sorted = [...accounts].sort((a, b) => (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '', 'es'));
    for (const a of sorted) if (!person.querySelector(`option[value="${a.userId}"]`)) person.append(el('option', { value: a.userId }, `${a.displayName || a.email || 'Cuenta'}${a.kind === 'agent' ? ' (agente)' : ''}`));
  }
  fillSelectors();
  try {
    [catalog, accounts] = await Promise.all([admin.catalog(), admin.accounts()]);
    fillSelectors();
  } catch { /* sin red: el registro lo dirá */ }

  const appLabel = (id: string | null) => (id ? appShort(catalog, id) : 'Todas');
  const nameOf = (id: string) => names.get(id) ?? 'otra cuenta';

  function label(e: AccessEvent): string {
    const meta = e.meta ?? {};
    const event = eventOf(e);
    const detail = typeof meta.role === 'string' ? ` · ${ROLE_LABELS[meta.role as Role] ?? meta.role}` : meta.removed === true ? ' · quitado' : '';
    return `${EVENT_LABELS[event] ?? event}${detail} · ${appLabel(e.app)}`;
  }
  /** Quien lo hizo es un agente: su cuenta lo es, o actuó con una clave. */
  const isAgent = (e: AccessEvent) => !!e.actorId && (agents.has(e.actorId) || !!e.keyId);
  /** A qué afecta: la persona, o la clave o la propuesta por su nombre (`meta.name`). */
  const targetOf = (e: AccessEvent): string | undefined => {
    const meta = e.meta ?? {};
    return typeof meta.userId === 'string' ? nameOf(meta.userId) : typeof meta.name === 'string' && meta.name.trim() ? meta.name : undefined;
  };
  const toneOf = (e: AccessEvent): Tone | undefined => (isGrave(e) ? 'alert' : EVENT_TONES[eventOf(e)]);
  function entry(e: AccessEvent): AccessLogEntry {
    return {
      at: e.at,
      label: label(e),
      actor: e.actorId ? names.get(e.actorId) ?? 'otra cuenta' : 'Sistema',
      actorKind: isAgent(e) ? 'agent' : 'person',
      target: targetOf(e),
      tone: toneOf(e),
    };
  }
  /** Una línea de la línea de tiempo: qué, quién o sobre quién, y su día y hora (con «hace…» al lado). */
  function line(e: AccessEvent, owner: string | null): HTMLElement {
    const meta = e.meta ?? {};
    const target = typeof meta.userId === 'string' ? meta.userId : null;
    const actor = e.actorId ? (e.actorId === owner ? null : `${names.get(e.actorId) ?? 'otra cuenta'}${isAgent(e) ? ' (agente)' : ''}`) : 'Sistema';
    const about = target ? (target !== owner ? `a ${nameOf(target)}` : null) : targetOf(e) ? `sobre «${targetOf(e)}»` : null;
    const who = [actor ? `por ${actor}` : null, about].filter(Boolean).join(' ');
    const tone = toneOf(e);
    return el('li', { class: `ctl-logline${tone ? ` ${tone}` : ''}`, dataset: { event: eventOf(e) } },
      el('span', { class: 'ctl-logwhat' }, label(e)),
      el('span', { class: 'ctl-logmeta', 'data-feedback-ignore': '' }, [who, `${dayAndTime(e.at)} · ${relativeTime(e.at)}`].filter(Boolean).join(' · ')));
  }

  const shown = () => items.filter((e) => !kinds.size || kinds.has(kindOf(e)));

  function paintKinds(): void {
    const chip = (k: Kind) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(kinds.has(k)), 'data-feedback-id': 'central.accesos.registro.tipo', 'data-feedback-label': 'Filtro por tipo',
      onclick: () => { if (kinds.has(k)) kinds.delete(k); else kinds.add(k); paintKinds(); paint(); } }, KIND_LABELS[k]);
    replace(kindChips, ...(['accesos', 'claves', 'propuestas', 'cuenta'] as Kind[]).map(chip));
  }

  function paint(): void {
    const list = shown();
    if (view === 'fecha') {
      // Por fecha (la de antes): `renderAccessLog` agrupa por día y pone la hora de cada cosa bajo su día.
      replace(host, fbIgnoreWithin(renderAccessLog({ entries: list.map(entry), emptyText: 'Sin accesos registrados.' }), '.al-actor, .al-target'));
    } else {
      const by = new Map<string, AccessEvent[]>();
      for (const e of list) {
        const who = peopleOf(e);
        for (const id of who.length ? who : ['sistema']) by.set(id, [...(by.get(id) ?? []), e]);
      }
      const keys = user ? [user] : [...by.keys()];
      const groups = keys.filter((k) => by.has(k)).map((k) => {
        const events = by.get(k)!;
        const graves = events.filter(isGrave).length;
        return {
          key: k, title: k === 'sistema' ? 'Sistema' : nameOf(k), items: events,
          medal: { name: k === 'sistema' ? 'Sistema' : nameOf(k) },
          summary: [`${events.length} ${events.length === 1 ? 'entrada' : 'entradas'}`, graves ? `${graves} ${graves === 1 ? 'grave' : 'graves'}` : null, `la última, ${dayAndTime(events[0]!.at)}`].filter(Boolean).join(' · '),
          open: graves > 0 || !!user || keys.length <= 3,
          feedbackId: 'central.accesos.registro.grupo',
        };
      });
      replace(host, groups.length
        ? fbIgnoreWithin(renderGroups<AccessEvent>({ label: 'Registro por persona', groups, toneOf: (e): Tone | null => (isGrave(e) ? 'alert' : null), worstFirst: true, row: (e) => line(e, null) }).element, '.worst-title strong, .medal-disc')
        : el('p', { class: 'hint' }, 'Sin accesos registrados.'));
    }
    loaded.textContent = items.length ? (nextBefore === null ? `${items.length} ${items.length === 1 ? 'entrada' : 'entradas'}: no hay más.` : `Las últimas ${items.length} entradas. «Ver anteriores» trae las de antes.`) : '';
  }

  function setView(next: LogView): void {
    if (next === view) return;
    view = next;
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* sin almacenamiento */ }
    for (const b of viewBar.querySelectorAll<HTMLButtonElement>('button')) { const on = b.dataset.view === view; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); }
    paint();
  }

  async function loadGrave(): Promise<void> {
    try {
      const out = await admin.accessLog({ grave: true, ...(app ? { app } : {}), ...(user ? { user } : {}), limit: 5 });
      if (!state.alive) return;
      replace(grave, out.items.length
        ? [el('h3', { class: 'sectionlabel' }, 'Lo grave'), el('ul', { class: 'list ctl-loglines' }, ...out.items.map((e) => line(e, null)))]
        : []);
    } catch { replace(grave); }
  }

  async function load(reset: boolean): Promise<void> {
    if (reset) { items = []; nextBefore = null; }
    more.disabled = true;
    if (reset) void loadGrave();
    try {
      const out = await admin.accessLog({ ...(app ? { app } : {}), ...(user ? { user } : {}), ...(nextBefore ? { before: nextBefore } : {}), limit: 50 });
      items = [...items, ...out.items];
      nextBefore = out.hasMore ? out.nextBefore : null;
      if (!state.alive) return;
      paint();
      more.hidden = nextBefore === null;
    } catch (e) {
      replace(host, navigator.onLine ? el('p', { class: 'formerror', 'data-feedback-id': 'central.accesos.registro.error', 'data-feedback-label': 'Error del registro' }, describeError(e)) : offlineNote());
    } finally {
      more.disabled = false;
    }
  }
  paintKinds();
  await load(true);
}
