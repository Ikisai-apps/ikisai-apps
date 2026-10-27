/**
 * Accesos · Cuentas (Bloque 2, MUELA-085 «Cuadrícula cuentas × apps», con las reglas de §2 de PERDIDAS_central_bloque2):
 * - Una fila por cuenta y una columna por app; cada casilla dice P, E, L u O y se toca para cambiarla en una hoja. En los
 *   portales (Guests y Organizers) dice el alcance: Todos (ámbito «todos», el de dirección), Huésped u Organiza.
 * - La cabecera marca la app con un solo propietario o ninguno, y una nota lo dice; la casilla y la ficha lo avisan antes
 *   de que el núcleo devuelva LAST_OWNER.
 * - Chips (en una fila que se desliza): Nunca han entrado, Desactivadas, Por revisar y por rol. Buscador y «Mostrar agentes».
 * - «Por revisar» con el arreglo en la fila: «Usar «…»» (nombre de la ficha) o «Enlazar» (sin ficha).
 * - «Nunca ha entrado» frente a «Desactivada» (texto, icono y borde; el nombre, tachado).
 * - Hoja de la casilla: Propietario, Editor, Lector y «Sin acceso». Outsider solo se enseña; lo que da el nivel de casa va
 *   bloqueado («se cambia en Personas»); a un agente, ni Propietario ni Central; tu propia casilla de Central, bloqueada.
 *   «Quitar acceso» y «Hacer propietario» confirman; cada cambio, con «Deshacer» (devuelve el rol y los ámbitos de antes).
 * - Ficha de la cuenta: solo las apps donde entra y «Añadir app (n)»; lo de siempre (contraseña temporal, desactivar,
 *   «Ve datos reservados», ficha de Personas).
 * Todo necesita red: sin ella, la última lista de la sesión y los botones con el motivo.
 */
import {
  bindOnline, confirmDialog, el, formatDate, icon, openSheet, plural, relativeTime, replace, toast, toastWithAction, type Sheet,
} from '@ikisai/ui-kit';
import type { SyncClient } from '@ikisai/sync-client';
import { HOUSE_LEVEL_LABELS, PORTAL_CELL_LABELS, PORTAL_CELL_TEXT, portalCell, type HouseGrant, type HouseLevel } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import { accountIssue, isStaffAccount, syncAccountName } from '../app/account-names.ts';
import { describeScopes, grantFor, ROLE_LABELS, type Account, type AccountMembership, type AdminApi, type CatalogApp, type Role } from '../app/admin.ts';
import type { Usage } from '@ikisai/ui-kit';
import {
  appShort, levelsActive, loadPeopleLite, NEEDS_NETWORK, newPersonFields, offlineNote, ROLE_LETTERS, showSecret, type AccessState, type PersonLite,
} from './access-common.ts';
import { fbIgnoreWithin, fbMark } from './feedback.ts';

type Chip = 'todas' | 'nunca' | 'desactivadas' | 'revisar' | 'owner' | 'editor' | 'reader';
const CHIP_LABELS: Record<Chip, string> = { todas: 'Todas', nunca: 'Nunca han entrado', desactivadas: 'Desactivadas', revisar: 'Por revisar', owner: 'Propietarios', editor: 'Editores', reader: 'Lectores' };
const HAND_ROLES: Role[] = ['owner', 'editor', 'reader'];

/** Cuentas que administran una app (humanas y activas): con una sola o ninguna, la cabecera y la casilla avisan. */
export function ownersOf(accounts: readonly Account[], app: string): Account[] {
  return accounts.filter((a) => a.kind !== 'agent' && !a.disabled && a.memberships.some((m) => m.app === app && m.role === 'owner'));
}

/** Los roles que se pueden dar a mano en esa casilla (PERDIDAS §2): a un agente, ni Propietario ni Central. */
export function rolesFor(account: Pick<Account, 'kind'>, app: string): Role[] {
  if (account.kind === 'agent') return app === 'central' ? [] : ['editor', 'reader'];
  return HAND_ROLES;
}

export async function mountAccounts(body: HTMLElement, admin: AdminApi, client: SyncClient, me: string, state: AccessState, navigate: (hash: string) => void, usage: Usage): Promise<void> {
  let catalog: CatalogApp[] = admin.cached.catalog ?? [];
  let accounts: Account[] = admin.cached.accounts?.items ?? [];
  let grants: HouseGrant[] = admin.cached.grants ?? [];
  let people: PersonLite[] = [];
  let query = '';
  let showAgents = false;
  let chip: Chip = 'todas';
  /** Si la lista se ha leído alguna vez en esta sesión: sin leerla no se puede decir que no hay cuentas. */
  let read = admin.cached.accounts !== undefined;
  const personOf = (a: Account) => people.find((p) => p.user_id === a.userId) ?? null;
  /** Lo que hay que arreglar en una cuenta del equipo: sin ficha, o con un nombre distinto del de su ficha. */
  const issueOf = (a: Account) => accountIssue(a, catalog, people);
  const nameOf = (a: Account) => a.displayName || a.email || 'Sin nombre';
  const membership = (a: Account, app: string) => a.memberships.find((m) => m.app === app) ?? null;
  const onlyOwner = (a: Account, app: string) => { const o = ownersOf(accounts, app); return o.length === 1 && o[0]!.userId === a.userId; };

  const list = el('div', { class: 'ctl-gridbox', id: 'accountList', 'aria-label': 'Cuentas', 'data-feedback-id': 'central.accesos.cuentas.lista', 'data-feedback-label': 'Cuadrícula de cuentas' });
  const note = el('div', { 'data-feedback-id': 'central.accesos.cuentas.aviso', 'data-feedback-label': 'Aviso de cuentas' });
  const issues = el('div', { 'data-feedback-id': 'central.accesos.cuentas.por_revisar', 'data-feedback-label': 'Cuentas por revisar' });
  const owners = el('div', { 'data-feedback-id': 'central.accesos.cuentas.propietarios', 'data-feedback-label': 'Apps con un solo propietario' });
  const chips = el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'Filtrar cuentas', id: 'accountChips' });
  const search = el('input', { type: 'search', id: 'accountSearch', 'data-feedback-id': 'central.accesos.cuentas.buscar', 'data-feedback-label': 'Buscar cuenta', placeholder: 'Buscar por nombre o correo', 'aria-label': 'Buscar cuenta',
    oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); paint(); } });
  const agentsToggle = el('label', { class: 'check' },
    el('input', { type: 'checkbox', id: 'showAgents', 'data-feedback-id': 'central.accesos.cuentas.mostrar_agentes', 'data-feedback-label': 'Mostrar agentes', onchange: (e: Event) => { showAgents = (e.target as HTMLInputElement).checked; paint(); } }),
    el('span', null, 'Mostrar agentes'));
  const goInvite = el('button', { class: 'primary', type: 'button', id: 'goInvite', 'data-feedback-id': 'central.accesos.cuentas.alta', 'data-feedback-label': 'Alta de cuenta', onclick: () => navigate('#/accesos/alta') }, icon('plus', 18), 'Alta');
  replace(body, el('div', { class: 'toolbar', 'data-feedback-id': 'central.accesos.cuentas.barra', 'data-feedback-label': 'Barra de cuentas' }, search, agentsToggle, goInvite), note, issues, owners, chips, list);
  state.cleanups.push(bindOnline(goInvite, { client, reason: 'El alta se hace en el momento: necesita conexión.' }));

  const matchesChip = (a: Account, c: Chip) => c === 'todas' ? true
    : c === 'nunca' ? !a.lastSignInAt
      : c === 'desactivadas' ? !!a.disabled
        : c === 'revisar' ? issueOf(a) !== null
          : a.memberships.some((m) => m.role === c);
  const base = () => accounts.filter((a) => showAgents || a.kind !== 'agent');

  function paintChips(): void {
    const all = base();
    const make = (c: Chip) => {
      const n = all.filter((a) => matchesChip(a, c)).length;
      if (c !== 'todas' && !n && chip !== c) return null;
      return el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(chip === c), dataset: { chip: c }, 'data-feedback-id': 'central.accesos.cuentas.filtro', 'data-feedback-label': 'Filtro de cuentas',
        onclick: () => { chip = chip === c && c !== 'todas' ? 'todas' : c; paint(); paintIssues(); } }, `${CHIP_LABELS[c]} (${n})`);
    };
    replace(chips, ...(Object.keys(CHIP_LABELS) as Chip[]).map(make));
  }

  /** Nota de propietarios: apps con uno solo o ninguno. */
  function paintOwners(): void {
    const single = catalog.map((app) => ({ app, list: ownersOf(accounts, app.id) })).filter((x) => x.list.length <= 1);
    if (!read || !single.length) { replace(owners); return; }
    replace(owners, el('p', { class: 'note', id: 'ownerNote' }, icon('warn', 16), ' ',
      single.map((x) => x.list.length ? `${appShort(catalog, x.app.id)} tiene un solo propietario (${nameOf(x.list[0]!)})` : `${appShort(catalog, x.app.id)} no tiene propietario`).join(' · '),
      '. Antes de quitárselo, haz propietario a otra cuenta.'));
  }

  function cell(a: Account, app: CatalogApp): HTMLElement {
    const m = membership(a, app.id);
    const derived = m ? grantFor(grants, a.userId, app.id, m.role) : null;
    const scoped = m ? describeScopes(app.id, m.scopes) : null;
    const lone = m?.role === 'owner' && onlyOwner(a, app.id);
    const locked = !!derived || (a.userId === me && app.id === 'central') || (a.kind === 'agent' && app.id === 'central' && !m);
    // Portal: el alcance en palabras (encargo de VG del 26-10); los ámbitos de cada retiro se editan en la app.
    const reach = app.kind === 'portal' ? portalCell(app.id, m) : null;
    const what = reach ? PORTAL_CELL_TEXT[reach] : m ? ROLE_LABELS[m.role] : 'sin acceso';
    return el('td', null, el('button', {
      type: 'button', class: `ctl-cell${m ? ` role-${m.role}` : ' none'}${app.kind === 'portal' ? ' portal' : ''}${derived ? ' derived' : ''}${lone ? ' lone' : ''}${locked ? ' locked' : ''}`, dataset: { app: app.id, ...(reach ? { reach } : {}) },
      'aria-label': `${nameOf(a)} en ${appShort(catalog, app.id)}: ${what}${derived ? ', por nivel de casa' : ''}${lone ? ', único propietario' : ''}${scoped ? `, ${scoped}` : ''}. Cambiar`,
      title: derived ? 'Lo da el nivel de casa: se cambia en Personas' : scoped ?? '',
      'data-feedback-id': 'central.accesos.cuentas.casilla', 'data-feedback-label': 'Casilla de acceso', onclick: () => openCell(a, app),
    }, reach ? PORTAL_CELL_LABELS[reach] : m ? ROLE_LETTERS[m.role] : '·', scoped && !reach ? el('span', { class: 'ctl-cellmark', 'aria-hidden': 'true' }, '*') : null, derived ? icon('lock', 12) : null));
  }

  function nameCell(a: Account): HTMLElement {
    const issue = issueOf(a);
    const person = personOf(a);
    const status = a.disabled ? el('span', { class: 'chip alert ctl-state' }, icon('lock', 14), 'Desactivada')
      : !a.lastSignInAt && a.kind !== 'agent' ? el('span', { class: 'chip ctl-state ctl-never' }, icon('history', 14), 'Nunca ha entrado') : null;
    const fix = issue === 'nombre' && person
      ? el('button', { type: 'button', class: 'linkbtn', 'data-feedback-id': 'central.accesos.cuentas.usar_nombre', 'data-feedback-label': 'Usar el nombre de la ficha',
        onclick: async () => { if (await syncAccountName(admin, a.userId, person.display_name)) { toast('La cuenta usa ya el nombre de la ficha.'); await load(); } } }, `Usar «${person.display_name}»`)
      : issue === 'sin_ficha' ? el('button', { type: 'button', class: 'linkbtn', 'data-feedback-id': 'central.accesos.cuentas.enlazar', 'data-feedback-label': 'Enlazar con una ficha', onclick: () => openAccount(a) }, 'Enlazar')
        : null;
    return el('th', { scope: 'row', class: 'ctl-acname' },
      el('button', { type: 'button', class: `ctl-acbtn${a.disabled ? ' off' : ''}`, 'data-feedback-id': 'central.accesos.cuentas.fila', 'data-feedback-label': 'Cuenta', onclick: () => openAccount(a) },
        el('span', { class: 'accountname', 'data-feedback-ignore': '' }, a.kind === 'agent' ? icon('bot', 14) : null, nameOf(a), a.userId === me ? el('span', { class: 'muted' }, ' (tú)') : null)),
      el('span', { class: 'ctl-acmeta muted small', 'data-feedback-ignore': '' }, [a.email ?? '', a.lastSignInAt ? `último acceso ${relativeTime(a.lastSignInAt)}` : ''].filter(Boolean).join(' · ')),
      status || issue ? el('span', { class: 'chips' }, status,
        issue === 'sin_ficha' ? el('span', { class: 'chip warn', 'data-issue': 'sin_ficha' }, 'Sin ficha') : null,
        issue === 'nombre' ? el('span', { class: 'chip warn', 'data-issue': 'nombre' }, 'Nombre distinto de la ficha') : null, fix) : null);
  }

  function paint(): void {
    paintChips();
    paintOwners();
    const visible = base()
      .filter((a) => matchesChip(a, chip))
      .filter((a) => !query || a.displayName.toLowerCase().includes(query) || (a.email ?? '').toLowerCase().includes(query));
    if (!visible.length) {
      // Sin leerla (sin red o con error), el aviso de arriba dice por qué: nada de «Todavía no hay cuentas».
      if (!read) replace(list);
      else replace(list, el('p', { class: 'empty hint' }, accounts.length ? 'Ninguna cuenta coincide.' : 'Todavía no hay cuentas.'));
      return;
    }
    const head = el('tr', null, el('th', { scope: 'col', class: 'ctl-acname' }, 'Cuenta'),
      ...catalog.map((app) => {
        const n = ownersOf(accounts, app.id).length;
        return el('th', { scope: 'col', class: `ctl-apphead${n <= 1 ? ' lone' : ''}${app.kind === 'portal' ? ' portal' : ''}`, title: n === 0 ? 'Sin propietario' : n === 1 ? 'Un solo propietario' : '' },
          appShort(catalog, app.id), app.kind === 'portal' ? el('span', { class: 'ctl-portaltag' }, 'portal') : null, n <= 1 ? el('span', { class: 'ctl-appwarn', 'aria-label': n === 0 ? ' (sin propietario)' : ' (un solo propietario)' }, n === 0 ? ' !' : ' 1') : null);
      }));
    replace(list,
      fbIgnoreWithin(el('table', { class: 'ctl-grid' },
        el('caption', { class: 'vh' }, 'Acceso de cada cuenta a cada app: P propietario, E editor, L lector, O outsider; en los portales, Todos, Huésped u Organiza'),
        el('thead', null, head),
        el('tbody', null, ...visible.map((a) => el('tr', { class: 'accountrow', 'data-user': a.userId }, nameCell(a), ...catalog.map((app) => cell(a, app)))))), '.ctl-acname .accountname'),
      el('p', { class: 'hint ctl-legend' }, 'P propietario · E editor · L lector · O outsider (lo da el nivel de casa) · * con ámbitos en su app. En los portales: Todos (todos los retiros), Huésped u Organiza.'));
  }

  /** Aviso con las cuentas del equipo que hay que enlazar o alinear (FB_2026_013). */
  function paintIssues(): void {
    const all = accounts.map(issueOf);
    const missing = all.filter((x) => x === 'sin_ficha').length;
    const names = all.filter((x) => x === 'nombre').length;
    if (!missing && !names) { replace(issues); if (chip === 'revisar') chip = 'todas'; return; }
    const parts = [missing ? `${plural(missing, 'cuenta del equipo sin ficha', 'cuentas del equipo sin ficha')}` : '', names ? `${plural(names, 'con otro nombre que su ficha', 'con otro nombre que su ficha')}` : ''].filter(Boolean);
    replace(issues, el('p', { class: 'note warn', id: 'accountIssues' }, `${parts.join(' · ')}. La ficha de Personas manda sobre el nombre. `,
      el('button', { class: 'linkbtn', type: 'button', id: 'showIssues', 'data-feedback-id': 'central.accesos.cuentas.revisar', 'data-feedback-label': 'Ver las cuentas por revisar',
        onclick: () => { chip = chip === 'revisar' ? 'todas' : 'revisar'; paint(); paintIssues(); } }, chip === 'revisar' ? 'Ver todas' : 'Ver solo esas')));
  }

  async function load(): Promise<void> {
    // Las fichas salen del espejo, también sin red: sin ellas, la lista guardada marcaba «Sin ficha» en todas.
    people = (await loadPeopleLite(client).catch(() => ({ people }))).people;
    try {
      [catalog, accounts, grants] = await Promise.all([admin.catalog(), admin.accounts(), admin.houseGrants().catch(() => grants)]);
      read = true;
      replace(note);
      paintIssues();
    } catch (error) {
      replace(note, navigator.onLine ? el('p', { class: 'formerror', role: 'alert', 'data-feedback-id': 'central.accesos.cuentas.error', 'data-feedback-label': 'Error de cuentas' }, describeError(error)) : offlineNote(admin.cached.accounts?.at));
    }
    if (state.alive) paint();
  }

  /**
   * Cambia el acceso de una cuenta a una app: confirma quitar y hacer propietario, conserva los ámbitos que la app ya
   * tuviera y ofrece «Deshacer», que devuelve el rol y los ámbitos de antes. Devuelve si se hizo.
   */
  async function applyChange(account: Account, app: CatalogApp, role: Role | null): Promise<boolean> {
    const before: AccountMembership | null = membership(account, app.id);
    if ((before?.role ?? null) === role) return false;
    const name = nameOf(account);
    if (before?.role === 'owner' && role !== 'owner' && onlyOwner(account, app.id)) {
      toast(`${name} es el único propietario de ${app.name}: antes, haz propietario a otra cuenta.`);
      return false;
    }
    if (role === null && !(await confirmDialog({ title: `¿Quitar el acceso a ${app.name}?`, text: `${name} dejará de entrar en ${app.name}. Sus datos en la app no se borran.`, confirmLabel: 'Quitar acceso', danger: true }))) return false;
    if (role === 'owner' && !(await confirmDialog({ title: `¿Hacer propietario de ${app.name}?`, text: app.id === 'central'
      ? `${name} podrá administrar las cuentas y accesos de todas las apps.` : `${name} podrá gestionar miembros, agentes y la papelera de ${app.name}.`, confirmLabel: 'Hacer propietario' }))) return false;
    await usage.run('central.accesos.cuenta.cambiar_acceso', () => admin.setMembership({ app: app.id, userId: account.userId, role, ...(role && before ? { scopes: before.scopes } : {}) }));
    toastWithAction(role ? `Acceso a ${app.name}: ${ROLE_LABELS[role]}.` : `Acceso a ${app.name} quitado.`, {
      label: 'Deshacer',
      onClick: () => void (async () => {
        try {
          await admin.setMembership({ app: app.id, userId: account.userId, role: before?.role ?? null, ...(before ? { scopes: before.scopes } : {}) });
          toast(`Deshecho: ${before ? ROLE_LABELS[before.role] : 'sin acceso'} en ${app.name}.`);
          await load();
          onChanged?.();
        } catch (e) { toast(describeError(e)); }
      })(),
    });
    await load();
    return true;
  }
  /** Para repintar una ficha abierta tras «Deshacer». */
  let onChanged: (() => void) | null = null;

  /** Hoja de una casilla: los roles que se pueden dar ahí, con las reglas de §2. */
  function openCell(account: Account, app: CatalogApp): void {
    const m = membership(account, app.id);
    const derived = m ? grantFor(grants, account.userId, app.id, m.role) : null;
    const isMe = account.userId === me;
    const person = personOf(account);
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
    const why = el('p', { class: 'hint ctl-rv-why' });
    let sheet: Sheet | null = null;
    const binds: Array<() => void> = [];
    let lock: string | null = null;
    if (derived) lock = `Lo da el nivel de casa «${HOUSE_LEVEL_LABELS[derived.level as HouseLevel] ?? derived.level}»: se cambia en Personas.`;
    else if (isMe && app.id === 'central') lock = 'Es tu acceso a Central: no puedes quitarte la administración.';
    else if (account.kind === 'agent' && app.id === 'central') lock = 'Un agente no puede tener Central.';
    else if (m?.role === 'outsider') lock = 'Outsider lo da el nivel de casa: se cambia en Personas.';
    const lone = m?.role === 'owner' && onlyOwner(account, app.id);
    const choices: Array<Role | null> = lock ? [] : [...rolesFor(account, app.id), null];
    const option = (role: Role | null) => {
      const current = (m?.role ?? null) === role;
      const blocked = lone && role !== 'owner';
      const b = el('button', { type: 'button', class: `ctl-rolebtn${current ? ' on' : ''}`, 'aria-pressed': String(current), disabled: blocked || undefined, dataset: { role: role ?? 'none' },
        'data-feedback-id': 'central.accesos.casilla.rol', 'data-feedback-label': 'Rol de la casilla',
        onclick: async () => {
          error.textContent = '';
          try { if (await applyChange(account, app, role)) void sheet?.close(true); } catch (e) { error.textContent = describeError(e); }
        } }, role ? ROLE_LABELS[role] : 'Sin acceso') as HTMLButtonElement;
      if (!current && !blocked) binds.push(bindOnline(b, { client, reason: NEEDS_NETWORK, line: why }));
      return b;
    };
    const body = el('div', { class: 'ctl-cellsheet', 'data-feedback-id': 'central.accesos.casilla.contenido', 'data-feedback-label': 'Hoja de la casilla' },
      el('p', null, 'Ahora: ', el('strong', null, m ? ROLE_LABELS[m.role] : 'sin acceso'), m && describeScopes(app.id, m.scopes) ? ` · ${describeScopes(app.id, m.scopes)}` : ''),
      lock ? el('p', { class: 'note', 'data-locked': '' }, icon('lock', 16), ' ', lock, ' ',
        (derived || m?.role === 'outsider') && person ? el('a', { href: `#/personas/${person.id}`, 'data-feedback-id': 'central.accesos.casilla.ir_a_personas', 'data-feedback-label': 'Ir a la ficha de Personas', onclick: () => void sheet?.close(true) }, 'Abrir su ficha') : null) : null,
      lone ? el('p', { class: 'note warn', 'data-lone': '' }, `Es el único propietario de ${app.name}. Para cambiarlo, haz antes propietario a otra cuenta.`) : null,
      choices.length ? el('div', { class: 'ctl-roles', role: 'group', 'aria-label': `Acceso a ${appShort(catalog, app.id)}` }, ...choices.map(option)) : null,
      why, error);
    sheet = openSheet({
      title: `${nameOf(account)} · ${appShort(catalog, app.id)}`, body,
      panelAttrs: { 'data-feedback-id': 'central.accesos.casilla', 'data-feedback-label': 'Casilla de acceso' },
      closeAttrs: { 'data-feedback-id': 'central.accesos.casilla.cerrar', 'data-feedback-label': 'Cerrar' },
      onClose: () => { for (const b of binds) b(); },
    });
    if (sheet) fbIgnoreWithin(sheet.element, '.sheet-head h2');
  }

  function openAccount(account: Account): void {
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.accesos.cuenta.error', 'data-feedback-label': 'Error de la cuenta' });
    const isMe = account.userId === me;
    const agent = account.kind === 'agent';
    let adding = false;
    const current = (app: string) => account.memberships.find((m) => m.app === app) ?? null;

    async function refresh(): Promise<void> {
      await load();
      const fresh = accounts.find((a) => a.userId === account.userId);
      if (fresh) { account = fresh; renderBody(); }
    }
    onChanged = () => void refresh();

    async function change(app: CatalogApp, select: HTMLSelectElement): Promise<void> {
      const before = current(app.id);
      const role = (select.value || null) as Role | null;
      if ((before?.role ?? null) === role) return;
      error.textContent = '';
      select.disabled = true;
      try {
        if (!(await applyChange(account, app, role))) { select.value = before?.role ?? ''; return; }
        await refresh();
      } catch (e) {
        error.textContent = describeError(e);
        select.value = before?.role ?? '';
      } finally {
        select.disabled = false;
      }
    }

    async function togglePeopleScope(input: HTMLInputElement): Promise<void> {
      const m = current('central');
      if (!m) return;
      input.disabled = true;
      try {
        const scopes = { ...((m.scopes as Record<string, unknown> | null) ?? {}), people: input.checked };
        if (!input.checked) delete (scopes as Record<string, unknown>).people;
        await admin.setMembership({ app: 'central', userId: account.userId, role: m.role, scopes: Object.keys(scopes).length ? scopes : null });
        toast(input.checked ? 'Ahora ve los datos reservados de personas.' : 'Ya no ve los datos reservados de personas.');
        await refresh();
      } catch (e) {
        error.textContent = describeError(e);
        input.checked = !input.checked;
      } finally {
        input.disabled = false;
      }
    }

    async function resetPassword(): Promise<void> {
      if (!(await confirmDialog({ title: '¿Crear una contraseña temporal nueva?', text: 'La contraseña actual deja de valer y se cierran sus sesiones en los demás dispositivos.', confirmLabel: 'Crear contraseña' }))) return;
      try {
        const out = await usage.run('central.accesos.cuenta.contrasena', () => admin.resetPassword(account.userId));
        showSecret(out.temporaryPassword, account.email ?? '');
      } catch (e) { error.textContent = describeError(e); }
    }

    async function toggleDisabled(): Promise<void> {
      const disable = !account.disabled;
      if (disable && !(await confirmDialog({ title: '¿Desactivar la cuenta?', text: 'No podrá entrar en ninguna app hasta que la reactives. Sus accesos se conservan.', confirmLabel: 'Desactivar', danger: true }))) return;
      try {
        await admin.setDisabled(account.userId, disable);
        toast(disable ? 'Cuenta desactivada.' : 'Cuenta reactivada.');
        await refresh();
      } catch (e) { error.textContent = describeError(e); }
    }

    /** Ficha de Personas de la cuenta: enlazar si no tiene (o crearla) y alinear el nombre si es distinto. */
    function personSection(): HTMLElement | null {
      if (!isStaffAccount(account, catalog)) return null;
      const person = personOf(account);
      const head = el('div', { class: 'sectionlabel', 'data-feedback-id': 'central.accesos.cuenta.ficha', 'data-feedback-label': 'Ficha de Personas' }, 'Ficha de Personas');
      if (person) {
        return el('div', { class: 'personlink' }, head,
          el('p', null, el('a', { href: `#/personas/${person.id}`, 'data-feedback-ignore': '' }, person.display_name)),
          person.display_name !== account.displayName ? el('p', { class: 'note warn', 'data-feedback-id': 'central.accesos.cuenta.nombre_distinto', 'data-feedback-label': 'Nombre distinto de la ficha' }, 'La cuenta se llama de otra forma que su ficha. ',
            el('button', { class: 'linkbtn', type: 'button', id: 'useFichaName', 'data-feedback-id': 'central.accesos.cuenta.usar_nombre_ficha', 'data-feedback-label': 'Usar el nombre de la ficha', onclick: async () => {
              if (await syncAccountName(admin, account.userId, person.display_name)) { toast('La cuenta usa ya el nombre de la ficha.'); await refresh(); }
            } }, 'Usar el nombre de la ficha')) : null);
      }
      const free = people.filter((p) => !p.user_id);
      const select = el('select', { id: 'linkPerson', 'data-field-id': 'central.accesos.link_person', 'aria-label': 'Persona del equipo', 'data-feedback-ignore': '' },
        el('option', { value: '' }, 'Persona nueva: crear su ficha con este nombre'),
        ...free.map((p) => el('option', { value: p.id }, p.display_name))) as HTMLSelectElement;
      const link = el('button', { class: 'primary', type: 'button', id: 'linkPersonSubmit', 'data-feedback-id': 'central.accesos.cuenta.enlazar_ficha', 'data-feedback-label': 'Enlazar con una persona', onclick: async () => {
        error.textContent = '';
        link.disabled = true;
        try {
          const chosen = free.find((p) => p.id === select.value) ?? null;
          if (chosen) {
            await client.commit([{ op: 'update', table: T.people, id: chosen.id, expectedRevision: chosen.revision, fields: { user_id: account.userId } }]);
            if (chosen.display_name !== account.displayName) await syncAccountName(admin, account.userId, chosen.display_name);
          } else {
            await client.commit([{ op: 'insert', table: T.people, id: crypto.randomUUID(), fields: newPersonFields(account.displayName || account.email || 'Sin nombre', account.userId, levelsActive(people) ? 'staff' : undefined) }]);
          }
          toast(chosen ? 'Cuenta enlazada con su ficha.' : 'Ficha creada y enlazada.');
          await refresh();
        } catch (e) { error.textContent = describeError(e); } finally { link.disabled = false; }
      } }, 'Enlazar con una persona') as HTMLButtonElement;
      return el('div', { class: 'personlink' }, head,
        el('p', { class: 'note warn', 'data-feedback-id': 'central.accesos.cuenta.sin_ficha', 'data-feedback-label': 'Cuenta sin ficha' }, 'Esta cuenta del equipo no tiene ficha en Personas.'),
        el('label', { class: 'field', 'data-feedback-id': 'central.accesos.cuenta.campo_persona', 'data-feedback-label': 'Persona del equipo' }, el('span', null, 'Persona del equipo'), select), link);
    }

    function appRow(app: CatalogApp): HTMLElement {
      const m = current(app.id);
      const roles = rolesFor(account, app.id);
      const select = el('select', { id: `role-${app.id}`, 'aria-label': 'Acceso' },
        el('option', { value: '', selected: !m }, 'Sin acceso'),
        ...[...roles].reverse().map((r) => el('option', { value: r, selected: m?.role === r }, ROLE_LABELS[r])),
        // Un rol que no se da a mano (outsider, por el nivel de casa) se enseña igual, sin ofrecerlo a las demás.
        ...(m && !roles.includes(m.role) ? [el('option', { value: m.role, selected: true }, ROLE_LABELS[m.role])] : [])) as HTMLSelectElement;
      // Id fijo (la lista de apps cambia); la etiqueta, con la app, solo en la pantalla.
      fbMark(select, 'central.accesos.cuenta.rol', 'Acceso a una app').setAttribute('data-feedback-label', `Acceso a ${appShort(catalog, app.id)}`);
      select.addEventListener('change', () => void change(app, select));
      if ((isMe && app.id === 'central') || (agent && app.id === 'central')) select.disabled = true;
      const scopes = m ? describeScopes(app.id, m.scopes) : null;
      const derived = m ? grantFor(grants, account.userId, app.id, m.role) : null;
      let extra: HTMLElement | null = null;
      if (derived) {
        // Lo da el nivel de casa (O4): fijo aquí; se cambia en la ficha de Personas.
        select.disabled = true;
        const person = personOf(account);
        extra = el('p', { class: 'muted small', 'data-derived': app.id, 'data-feedback-id': 'central.accesos.cuenta.por_nivel', 'data-feedback-label': 'Acceso por nivel de casa' },
          `Lo da el nivel de casa «${HOUSE_LEVEL_LABELS[derived.level as HouseLevel] ?? derived.level}»: cámbialo en `,
          person ? el('a', { href: `#/personas/${person.id}`, 'data-feedback-id': 'central.accesos.cuenta.ir_a_personas', 'data-feedback-label': 'Ir a la ficha de Personas' }, 'Personas') : 'Personas', '.');
      } else if (app.id === 'central' && m?.role === 'editor') {
        const box = el('input', { type: 'checkbox', id: 'scope-people', 'data-feedback-id': 'central.accesos.cuenta.datos_reservados', 'data-feedback-label': 'Ve datos reservados de personas', checked: (m.scopes as { people?: unknown } | null)?.people === true }) as HTMLInputElement;
        box.addEventListener('change', () => void togglePeopleScope(box));
        extra = el('label', { class: 'check' }, box, el('span', null, 'Ve datos reservados de personas (contacto, documentos)'));
      } else if (scopes && app.id !== 'central') {
        extra = el('p', { class: 'muted small' }, scopes, ' · ', el('a', { href: `https://${app.domain}/`, target: '_blank', rel: 'noopener', 'data-feedback-id': 'central.accesos.cuenta.editar_en_app', 'data-feedback-label': 'Editar en la app' }, `Editar en ${appShort(catalog, app.id)}`));
      }
      const lone = m?.role === 'owner' && onlyOwner(account, app.id)
        ? el('p', { class: 'note warn small', 'data-lone': app.id }, `Único propietario de ${appShort(catalog, app.id)}: antes de quitárselo, haz propietario a otra cuenta.`) : null;
      return el('div', { class: 'approw', 'data-feedback-id': 'central.accesos.cuenta.app', 'data-feedback-label': 'Acceso a una app' },
        el('div', { class: 'appname' }, el('strong', null, appShort(catalog, app.id)), el('span', { class: 'muted small' }, app.domain)),
        select, extra, lone);
    }

    const content = el('div', { class: 'accountsheet', 'data-feedback-id': 'central.accesos.cuenta.contenido', 'data-feedback-label': 'Ficha de la cuenta' });
    function renderBody(): void {
      // Solo las apps donde entra; las demás, con «Añadir app (n)» (MUELA-085).
      const inApps = catalog.filter((app) => current(app.id));
      const others = catalog.filter((app) => !current(app.id) && !(agent && app.id === 'central'));
      const addBtn = others.length && !adding
        ? el('button', { type: 'button', class: 'ghost', id: 'addApp', 'data-feedback-id': 'central.accesos.cuenta.anadir_app', 'data-feedback-label': 'Añadir app', onclick: () => { adding = true; renderBody(); } }, icon('plus', 16), `Añadir app (${others.map((a) => appShort(catalog, a.id)).join(', ')})`)
        : null;
      replace(content,
        el('p', { class: 'muted', 'data-feedback-ignore': '' }, [account.email, `alta ${formatDate(account.createdAt)}`, account.lastSignInAt ? `último acceso ${relativeTime(account.lastSignInAt)}` : 'nunca ha entrado'].filter(Boolean).join(' · ')),
        account.disabled ? el('p', { class: 'note warn' }, 'Cuenta desactivada: no puede entrar en ninguna app.') : null,
        isMe ? el('p', { class: 'note' }, 'Es tu cuenta: no puedes quitarte la administración ni desactivarte.') : null,
        personSection(),
        el('div', { class: 'sectionlabel', 'data-feedback-id': 'central.accesos.cuenta.acceso_por_app', 'data-feedback-label': 'Acceso por app' }, 'Acceso por app'),
        ...inApps.map(appRow),
        inApps.length ? null : el('p', { class: 'muted' }, 'Sin accesos.'),
        ...(adding ? others.map(appRow) : []),
        addBtn,
        error,
        agent ? el('p', { class: 'muted' }, 'Las claves de este agente se gestionan en la pestaña Agentes.') : el('div', { class: 'zone', 'data-feedback-id': 'central.accesos.cuenta.zona', 'data-feedback-label': 'Acciones de la cuenta' },
          el('button', { class: 'ghost', type: 'button', id: 'resetPassword', 'data-feedback-id': 'central.accesos.cuenta.contrasena_nueva', 'data-feedback-label': 'Contraseña temporal nueva', onclick: () => void resetPassword() }, icon('lock', 18), 'Contraseña temporal nueva'),
          isMe ? null : el('button', { class: account.disabled ? 'ghost' : 'danger', type: 'button', id: 'toggleDisabled', 'data-feedback-id': 'central.accesos.cuenta.desactivar', 'data-feedback-label': 'Desactivar o reactivar cuenta', onclick: () => void toggleDisabled() },
            account.disabled ? 'Reactivar cuenta' : 'Desactivar cuenta')),
      );
    }
    renderBody();
    const accountSheet = openSheet({
      title: nameOf(account),
      meta: account.kind === 'agent' ? 'Agente' : undefined,
      body: content,
      panelAttrs: { 'data-feedback-id': 'central.accesos.cuenta', 'data-feedback-label': 'Cuenta' },
      closeAttrs: { 'data-feedback-id': 'central.accesos.cuenta.cerrar', 'data-feedback-label': 'Cerrar' },
      onClose: () => { onChanged = null; },
    });
    // El título de la hoja es el nombre o el correo de la cuenta.
    fbIgnoreWithin(accountSheet.element, '.sheet-head h2');
  }

  if (accounts.length) paint();
  await load();
}
