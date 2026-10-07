import {
  confirmDialog, el, formatDate, icon, openSheet, plural, relativeTime, renderAccessLog, renderSecretOnce, replace, toast,
  type AccessLogEntry, type Sheet,
} from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { describeScopes, EVENT_LABELS, ROLE_LABELS, type Account, type AccessEvent, type AdminApi, type AgentKey, type CatalogApp, type Role } from '../app/admin.ts';
import type { ViewMount } from './shell.ts';

export type AccessTab = 'cuentas' | 'alta' | 'agentes' | 'registro';

const TABS: Array<{ id: AccessTab; label: string; hash: string }> = [
  { id: 'cuentas', label: 'Cuentas', hash: '#/accesos' },
  { id: 'alta', label: 'Alta', hash: '#/accesos/alta' },
  { id: 'agentes', label: 'Agentes', hash: '#/accesos/agentes' },
  { id: 'registro', label: 'Registro', hash: '#/accesos/registro' },
];

const ROLES: Role[] = ['reader', 'editor', 'owner'];

function offlineNote(at?: string): HTMLElement {
  return el('p', { class: 'note warn', role: 'status' }, icon('offline', 18),
    at ? ` Sin conexión: lista del ${formatDate(at)}. Los cambios necesitan red.` : ' Sin conexión: los accesos se leen y cambian en el momento y necesitan red.');
}

function roleSelect(id: string, value: Role | null, options: { agent: boolean; app: string }): HTMLSelectElement {
  const allowed = ROLES.filter((r) => !(options.agent && (r === 'owner' || options.app === 'central')));
  return el('select', { id, 'aria-label': 'Acceso' },
    el('option', { value: '', selected: value === null }, 'Sin acceso'),
    ...allowed.map((r) => el('option', { value: r, selected: value === r }, ROLE_LABELS[r]))) as HTMLSelectElement;
}

/** Accesos (API.md §9.4): solo owner de Central. Todo necesita red; la última lista se pinta sin red mientras dure la sesión. */
export function mountAccess(tab: AccessTab): ViewMount {
  return (ctx) => {
    const { main, admin, client } = ctx;
    const body = el('div', { id: `access-${tab}` });
    replace(
      main,
      el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Accesos'),
        el('p', null, 'Quién entra en cada app de Ikisai y con qué permiso.'))),
      el('nav', { class: 'segmented', 'aria-label': 'Secciones de accesos' },
        ...TABS.map((t) => el('a', { href: t.hash, class: t.id === tab ? 'active' : '', 'aria-current': t.id === tab ? 'page' : null, id: `tab-${t.id}` }, t.label))),
      body,
    );
    const me = client.bootstrap()?.profile.userId ?? '';
    const state = { alive: true };
    const stop = () => { state.alive = false; };
    switch (tab) {
      case 'cuentas': void mountAccounts(body, admin, me, state, ctx.navigate); break;
      case 'alta': mountInvite(body, admin, ctx.navigate); break;
      case 'agentes': void mountAgents(body, admin, state); break;
      case 'registro': void mountLog(body, admin, state); break;
    }
    return stop;
  };
}

// ---------------------------------------------------------------------------
// Cuentas: lista de cuentas con su acceso en cada app; ficha con cambios de acceso, contraseña y desactivación.
// ---------------------------------------------------------------------------
async function mountAccounts(body: HTMLElement, admin: AdminApi, me: string, state: { alive: boolean }, navigate: (hash: string) => void): Promise<void> {
  let catalog: CatalogApp[] = admin.cached.catalog ?? [];
  let accounts: Account[] = admin.cached.accounts?.items ?? [];
  let query = '';
  let showAgents = false;
  const list = el('ul', { class: 'list accounts', id: 'accountList', 'aria-label': 'Cuentas' });
  const note = el('div');
  const search = el('input', { type: 'search', id: 'accountSearch', placeholder: 'Buscar por nombre o correo', 'aria-label': 'Buscar cuenta',
    oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); paint(); } });
  const agentsToggle = el('label', { class: 'check' },
    el('input', { type: 'checkbox', id: 'showAgents', onchange: (e: Event) => { showAgents = (e.target as HTMLInputElement).checked; paint(); } }),
    el('span', null, 'Mostrar agentes'));
  replace(body, el('div', { class: 'toolbar' }, search, agentsToggle,
    el('button', { class: 'primary', type: 'button', id: 'goInvite', onclick: () => navigate('#/accesos/alta') }, icon('plus', 18), 'Alta')), note, list);

  const appName = (id: string) => catalog.find((a) => a.id === id)?.name.replace(/^Ikisai /, '') ?? id;

  function paint(): void {
    const visible = accounts
      .filter((a) => showAgents || a.kind !== 'agent')
      .filter((a) => !query || a.displayName.toLowerCase().includes(query) || (a.email ?? '').toLowerCase().includes(query));
    if (!visible.length) {
      replace(list, el('li', { class: 'empty' }, accounts.length ? 'Ninguna cuenta coincide.' : 'Todavía no hay cuentas.'));
      return;
    }
    replace(list, ...visible.map((a) => {
      const chips = a.memberships.map((m) => el('span', { class: `chip role-${m.role}`, title: describeScopes(m.app, m.scopes) ?? '' },
        `${appName(m.app)} · ${ROLE_LABELS[m.role]}`, describeScopes(m.app, m.scopes) ? ' *' : ''));
      if (a.disabled) chips.unshift(el('span', { class: 'chip alert' }, 'Desactivada'));
      if (a.kind === 'agent') chips.unshift(el('span', { class: 'chip' }, icon('bot', 14), 'Agente'));
      return el('li', null, el('button', { class: 'accountrow', type: 'button', 'data-user': a.userId, onclick: () => openAccount(a) },
        el('span', { class: 'accountname' }, a.displayName || a.email || 'Sin nombre', a.userId === me ? el('span', { class: 'muted' }, ' (tú)') : null),
        el('span', { class: 'muted accountmeta' }, [a.email ?? '', a.lastSignInAt ? `último acceso ${relativeTime(a.lastSignInAt)}` : 'nunca ha entrado'].filter(Boolean).join(' · ')),
        el('span', { class: 'chips' }, ...(chips.length ? chips : [el('span', { class: 'muted' }, 'Sin accesos')]))));
    }));
  }

  async function load(): Promise<void> {
    try {
      [catalog, accounts] = await Promise.all([admin.catalog(), admin.accounts()]);
      replace(note);
    } catch (error) {
      replace(note, navigator.onLine ? el('p', { class: 'formerror', role: 'alert' }, describeError(error)) : offlineNote(admin.cached.accounts?.at));
    }
    if (state.alive) paint();
  }

  function openAccount(account: Account): void {
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
    const isMe = account.userId === me;
    const agent = account.kind === 'agent';
    const current = (app: string) => account.memberships.find((m) => m.app === app) ?? null;

    async function refresh(): Promise<void> {
      await load();
      const fresh = accounts.find((a) => a.userId === account.userId);
      if (fresh) { account = fresh; renderBody(); }
    }

    async function change(app: CatalogApp, select: HTMLSelectElement): Promise<void> {
      const before = current(app.id);
      const role = (select.value || null) as Role | null;
      if ((before?.role ?? null) === role) return;
      error.textContent = '';
      const name = account.displayName || account.email || 'esta cuenta';
      if (role === null && !(await confirmDialog({ title: `¿Quitar el acceso a ${app.name}?`, text: `${name} dejará de entrar en ${app.name}. Sus datos en la app no se borran.`, confirmLabel: 'Quitar acceso', danger: true }))) {
        select.value = before?.role ?? ''; return;
      }
      if (role === 'owner' && !(await confirmDialog({ title: `¿Hacer propietario de ${app.name}?`, text: app.id === 'central'
        ? `${name} podrá administrar las cuentas y accesos de todas las apps.` : `${name} podrá gestionar miembros, agentes y la papelera de ${app.name}.`, confirmLabel: 'Hacer propietario' }))) {
        select.value = before?.role ?? ''; return;
      }
      select.disabled = true;
      try {
        // Al cambiar el rol se conservan los ámbitos que la app ya tuviera (cada app edita los suyos).
        await admin.setMembership({ app: app.id, userId: account.userId, role, ...(role && before ? { scopes: before.scopes } : {}) });
        toast(role ? `Acceso a ${app.name}: ${ROLE_LABELS[role]}.` : `Acceso a ${app.name} quitado.`);
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
        const out = await admin.resetPassword(account.userId);
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

    const content = el('div', { class: 'accountsheet' });
    function renderBody(): void {
      const rows = catalog.map((app) => {
        const m = current(app.id);
        const select = roleSelect(`role-${app.id}`, m?.role ?? null, { agent, app: app.id });
        select.addEventListener('change', () => void change(app, select));
        if (isMe && app.id === 'central') select.disabled = true;
        const scopes = m ? describeScopes(app.id, m.scopes) : null;
        let extra: HTMLElement | null = null;
        if (app.id === 'central' && m?.role === 'editor') {
          const box = el('input', { type: 'checkbox', id: 'scope-people', checked: (m.scopes as { people?: unknown } | null)?.people === true }) as HTMLInputElement;
          box.addEventListener('change', () => void togglePeopleScope(box));
          extra = el('label', { class: 'check' }, box, el('span', null, 'Ve datos reservados de personas (contacto, documentos)'));
        } else if (scopes && app.id !== 'central') {
          extra = el('p', { class: 'muted small' }, scopes, ' · ', el('a', { href: `https://${app.domain}/`, target: '_blank', rel: 'noopener' }, `Editar en ${app.name.replace(/^Ikisai /, '')}`));
        }
        return el('div', { class: 'approw' },
          el('div', { class: 'appname' }, el('strong', null, app.name.replace(/^Ikisai /, '')), el('span', { class: 'muted small' }, app.domain)),
          select, extra);
      });
      replace(content,
        el('p', { class: 'muted' }, [account.email, `alta ${formatDate(account.createdAt)}`, account.lastSignInAt ? `último acceso ${relativeTime(account.lastSignInAt)}` : 'nunca ha entrado'].filter(Boolean).join(' · ')),
        account.disabled ? el('p', { class: 'note warn' }, 'Cuenta desactivada: no puede entrar en ninguna app.') : null,
        isMe ? el('p', { class: 'note' }, 'Es tu cuenta: no puedes quitarte la administración ni desactivarte.') : null,
        el('div', { class: 'sectionlabel' }, 'Acceso por app'),
        ...rows,
        error,
        agent ? el('p', { class: 'muted' }, 'Las claves de este agente se gestionan en la pestaña Agentes.') : el('div', { class: 'zone' },
          el('button', { class: 'ghost', type: 'button', id: 'resetPassword', onclick: () => void resetPassword() }, icon('lock', 18), 'Contraseña temporal nueva'),
          isMe ? null : el('button', { class: account.disabled ? 'ghost' : 'danger', type: 'button', id: 'toggleDisabled', onclick: () => void toggleDisabled() },
            account.disabled ? 'Reactivar cuenta' : 'Desactivar cuenta')),
      );
    }
    renderBody();
    openSheet({
      title: account.displayName || account.email || 'Cuenta',
      meta: account.kind === 'agent' ? 'Agente' : undefined,
      body: content,
    });
  }

  if (accounts.length) paint();
  await load();
}

/** Contraseña temporal mostrada una sola vez, con botón de copiar (kit). */
export function showSecret(password: string, email: string, onDone?: () => void): void {
  let sheet: Sheet | null = null;
  sheet = openSheet({
    title: 'Contraseña temporal',
    meta: email,
    body: el('div', null,
      el('p', null, 'Pásasela a la persona por un canal privado. Al entrar, conviene que la cambie.'),
      renderSecretOnce({ value: password, label: 'Contraseña temporal', warning: 'Solo se muestra ahora: no se puede volver a consultar.', onDone: () => { void sheet?.close(); onDone?.(); } })),
  });
}

// ---------------------------------------------------------------------------
// Alta: correo, nombre y accesos iniciales → contraseña temporal una vez.
// ---------------------------------------------------------------------------
function mountInvite(body: HTMLElement, admin: AdminApi, navigate: (hash: string) => void): void {
  const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
  const email = el('input', { id: 'inviteEmail', type: 'email', required: true, autocomplete: 'off', maxlength: '320' }) as HTMLInputElement;
  const name = el('input', { id: 'inviteName', type: 'text', maxlength: '80', autocomplete: 'off' }) as HTMLInputElement;
  const appsHost = el('div', { id: 'inviteApps' }, el('p', { class: 'muted' }, 'Cargando apps…'));
  const selects = new Map<string, HTMLSelectElement>();
  const submit = el('button', { class: 'primary', type: 'submit', id: 'inviteSubmit' }, 'Dar de alta') as HTMLButtonElement;

  const form = el('form', { novalidate: true, id: 'inviteForm', onsubmit: async (event: Event) => {
    event.preventDefault();
    error.textContent = '';
    const mail = email.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { error.textContent = 'Escribe un correo válido.'; email.focus(); return; }
    const memberships = [...selects].filter(([, s]) => s.value).map(([app, s]) => ({ app, role: s.value as Role }));
    if (!memberships.length) { error.textContent = 'Elige al menos una app.'; return; }
    submit.disabled = true;
    try {
      const out = await admin.invite({ email: mail, ...(name.value.trim() ? { displayName: name.value.trim() } : {}), memberships });
      if (out.temporaryPassword) {
        showSecret(out.temporaryPassword, out.email, () => navigate('#/accesos'));
      } else {
        toast('Esa cuenta ya existía: se le han añadido los accesos. Su contraseña no cambia.');
        navigate('#/accesos');
      }
      form.reset();
    } catch (e) {
      error.textContent = describeError(e);
    } finally {
      submit.disabled = false;
    }
  } },
  el('label', { class: 'field' }, el('span', null, 'Correo'), email),
  el('label', { class: 'field' }, el('span', null, 'Nombre visible'), name),
  el('div', { class: 'sectionlabel' }, 'Accesos iniciales'),
  appsHost,
  error,
  el('div', { class: 'formactions' }, submit));

  replace(body, el('p', { class: 'muted' }, 'Crea la cuenta con una contraseña temporal que se muestra una sola vez. Si el correo ya tiene cuenta, solo se añaden los accesos.'), form);

  void admin.catalog().then((catalog) => {
    replace(appsHost, ...catalog.map((app) => {
      const select = roleSelect(`invite-${app.id}`, null, { agent: false, app: app.id });
      selects.set(app.id, select);
      return el('label', { class: 'approw' }, el('span', { class: 'appname' }, el('strong', null, app.name.replace(/^Ikisai /, '')), el('span', { class: 'muted small' }, app.description ?? '')), select);
    }));
  }).catch((e) => replace(appsHost, navigator.onLine ? el('p', { class: 'formerror' }, describeError(e)) : offlineNote()));
}

// ---------------------------------------------------------------------------
// Agentes: claves de todas las apps; revocar corta al agente en todas.
// ---------------------------------------------------------------------------
async function mountAgents(body: HTMLElement, admin: AdminApi, state: { alive: boolean }): Promise<void> {
  const list = el('ul', { class: 'list', id: 'agentList', 'aria-label': 'Claves de agentes' });
  const note = el('div');
  let showRevoked = false;
  const toggle = el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'showRevoked', onchange: (e: Event) => { showRevoked = (e.target as HTMLInputElement).checked; paint(admin.cached.agents?.items ?? []); } }), el('span', null, 'Mostrar revocadas'));
  replace(body, el('p', { class: 'muted' }, 'Las claves las emite el propietario de cada app. Revocar una clave la corta en todas las apps y revoca sus propuestas abiertas.'), el('div', { class: 'toolbar' }, toggle), note, list);

  function paint(keys: AgentKey[]): void {
    const shown = keys.filter((k) => showRevoked || !k.revokedAt);
    if (!shown.length) { replace(list, el('li', { class: 'empty' }, 'No hay claves de agentes activas.')); return; }
    replace(list, ...shown.map((k) => el('li', { class: 'agentrow', 'data-key': k.keyId },
      el('div', null,
        el('strong', null, icon('bot', 16), ' ', k.name), el('span', { class: 'muted' }, ` · …${k.hint}`),
        el('div', { class: 'muted small' }, [
          k.memberships.map((m) => `${m.app} (${ROLE_LABELS[m.role]})`).join(', ') || 'sin accesos',
          k.lastUsedAt ? `usada ${relativeTime(k.lastUsedAt)}` : 'sin usar',
          k.expiresAt ? `caduca ${formatDate(k.expiresAt)}` : '',
        ].filter(Boolean).join(' · '))),
      k.revokedAt ? el('span', { class: 'chip alert' }, `Revocada ${formatDate(k.revokedAt, 'short')}`)
        : el('button', { class: 'danger small', type: 'button', onclick: () => void revoke(k) }, 'Revocar'))));
  }

  async function revoke(k: AgentKey): Promise<void> {
    if (!(await confirmDialog({ title: `¿Revocar la clave de «${k.name}»?`, text: 'El agente deja de poder entrar en todas las apps. No se puede deshacer: habría que emitir otra clave.', confirmLabel: 'Revocar', danger: true }))) return;
    try {
      const out = await admin.revokeAgent(k.keyId);
      toast(out.proposalsRevoked ? `Clave revocada y ${plural(out.proposalsRevoked, 'propuesta cerrada', 'propuestas cerradas')}.` : 'Clave revocada.');
      await load();
    } catch (e) { toast(describeError(e)); }
  }

  async function load(): Promise<void> {
    try {
      const keys = await admin.agents();
      replace(note);
      if (state.alive) paint(keys);
    } catch (e) {
      replace(note, navigator.onLine ? el('p', { class: 'formerror' }, describeError(e)) : offlineNote(admin.cached.agents?.at));
      if (state.alive) paint(admin.cached.agents?.items ?? []);
    }
  }
  await load();
}

// ---------------------------------------------------------------------------
// Registro de accesos de todas las apps, filtrable por app y paginado.
// ---------------------------------------------------------------------------
async function mountLog(body: HTMLElement, admin: AdminApi, state: { alive: boolean }): Promise<void> {
  let items: AccessEvent[] = [];
  let nextBefore: number | null = null;
  let app = '';
  const names = new Map<string, string>();
  const host = el('div', { id: 'accessLog' });
  const more = el('button', { class: 'ghost', type: 'button', id: 'logMore', hidden: true, onclick: () => void load(false) }, 'Cargar más') as HTMLButtonElement;
  const filter = el('select', { id: 'logApp', 'aria-label': 'App', onchange: (e: Event) => { app = (e.target as HTMLSelectElement).value; void load(true); } },
    el('option', { value: '' }, 'Todas las apps')) as HTMLSelectElement;
  replace(body, el('div', { class: 'toolbar' }, filter), host, more);

  try {
    const [catalog, accounts] = await Promise.all([admin.catalog(), admin.accounts()]);
    filter.append(...catalog.map((a) => el('option', { value: a.id }, a.name.replace(/^Ikisai /, ''))));
    for (const a of accounts) names.set(a.userId, a.displayName || a.email || 'Cuenta');
  } catch { /* sin red: el registro lo dirá */ }

  const appLabel = (id: string | null) => (id ? (filter.querySelector(`option[value="${id}"]`)?.textContent ?? id) : 'Todas');

  function entry(e: AccessEvent): AccessLogEntry {
    const meta = e.meta ?? {};
    // Core anota contraseña, desactivación y reactivación como `member_changed` con el detalle en `meta.event`.
    const event = e.event === 'member_changed' && typeof meta.event === 'string' ? meta.event : e.event;
    const target = typeof meta.userId === 'string' ? names.get(meta.userId) ?? 'otra cuenta' : typeof meta.name === 'string' ? meta.name : undefined;
    const detail = typeof meta.role === 'string' ? ` · ${ROLE_LABELS[meta.role as Role] ?? meta.role}` : meta.removed === true ? ' · quitado' : '';
    const tone: AccessLogEntry['tone'] = event === 'key_revoked' || event === 'account_disabled' || meta.removed === true ? 'alert' : undefined;
    return {
      at: e.at,
      label: `${EVENT_LABELS[event] ?? event}${detail} · ${appLabel(e.app)}`,
      actor: e.actorId ? names.get(e.actorId) ?? 'Cuenta' : 'Sistema',
      actorKind: e.keyId && e.event.startsWith('proposal') ? 'agent' : 'person',
      target,
      tone,
    };
  }

  async function load(reset: boolean): Promise<void> {
    if (reset) { items = []; nextBefore = null; }
    more.disabled = true;
    try {
      const out = await admin.accessLog({ ...(app ? { app } : {}), ...(nextBefore ? { before: nextBefore } : {}), limit: 50 });
      items = [...items, ...out.items];
      nextBefore = out.hasMore ? out.nextBefore : null;
      if (!state.alive) return;
      replace(host, renderAccessLog({ entries: items.map(entry), emptyText: 'Sin accesos registrados.' }));
      more.hidden = nextBefore === null;
    } catch (e) {
      replace(host, navigator.onLine ? el('p', { class: 'formerror' }, describeError(e)) : offlineNote());
    } finally {
      more.disabled = false;
    }
  }
  await load(true);
}
