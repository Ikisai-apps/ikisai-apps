/**
 * Accesos · Alta (Bloque 2, MUELA-085 «Persona primero», con §2 de PERDIDAS_central_bloque2):
 * - Arriba, las caras de las fichas activas sin cuenta y «Persona nueva». Al elegir una, debajo: correo (el de su ficha si
 *   se ven reservados), nombre (el de la ficha manda), nivel de casa si la ficha es nueva y un rol por app con botones.
 * - «Como {compañero} ({equipo})» copia sus accesos: solo Editor y Lector; Propietario se copia como Editor y el resumen lo
 *   dice; nunca lo que da el nivel de casa ni «Ve datos reservados». Los agentes no salen como modelo.
 * - El resumen, y «Dar de alta» con el motivo sin red (`bindOnline`). **Un solo envío** al núcleo, y nada se escribe antes:
 *   la comprobación de correo repetido, la cuenta, y después la ficha (enlazar, crear o fusionar). La contraseña temporal
 *   sale al final, una sola vez.
 * - Flow + proyecto en un paso (encargo de VG del 27-10): bajo Flow, los proyectos (el más actual arriba). Marcar uno sin
 *   acceso a Flow le da Editor; van en el mismo envío como `scopes.projects`. Sin proyecto no vería nada en Flow.
 */
import { bindOnline, el, icon, renderMedal, replace, toast } from '@ikisai/ui-kit';
import type { SyncClient } from '@ikisai/sync-client';
import { HOUSE_LEVELS, HOUSE_LEVEL_LABELS, sortFlowProjects, todayInMadrid, type FlowProject, type HouseGrant, type HouseLevel } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import { grantFor, ROLE_LABELS, type Account, type AdminApi, type CatalogApp, type Role } from '../app/admin.ts';
import type { Usage } from '@ikisai/ui-kit';
import { checkExistingAccount, mergePeople } from './account-conflict.ts';
import { appShort, levelsActive, loadPeopleLite, newPersonFields, offlineNote, showSecret, type AccessState, type PersonLite } from './access-common.ts';
import { fbIgnoreWithin, fbMark } from './feedback.ts';

const INVITE_ROLES: Array<Role | null> = [null, 'reader', 'editor', 'owner'];

/** Lo que copia «Como {compañero}» (PERDIDAS §2): Editor y Lector; Propietario, como Editor; nunca lo del nivel de casa. */
export function copyFrom(model: Account, grants: readonly HouseGrant[]): { roles: Map<string, Role>; ownerDowngraded: string[] } {
  const roles = new Map<string, Role>();
  const ownerDowngraded: string[] = [];
  for (const m of model.memberships) {
    if (grantFor(grants, model.userId, m.app, m.role) || m.role === 'outsider') continue;
    if (m.role === 'owner') { roles.set(m.app, 'editor'); ownerDowngraded.push(m.app); } else roles.set(m.app, m.role);
  }
  return { roles, ownerDowngraded };
}

export async function mountInvite(body: HTMLElement, admin: AdminApi, client: SyncClient, navigate: (hash: string) => void, usage: Usage, state: AccessState): Promise<void> {
  const { people, emails } = await loadPeopleLite(client);
  const free = people.filter((p) => !p.user_id && p.active);
  const withLevels = levelsActive(people);
  let catalog: CatalogApp[] = admin.cached.catalog ?? [];
  let accounts: Account[] = admin.cached.accounts?.items ?? [];
  let grants: HouseGrant[] = admin.cached.grants ?? [];
  /** `undefined` = nadie elegido; `null` = persona nueva. */
  let chosen: PersonLite | null | undefined;
  const roles = new Map<string, Role>();
  let downgraded: string[] = [];
  // Proyectos de Flow para el alta (`null` = Flow no los publica o sin red) y los elegidos.
  let flowProjects: FlowProject[] | null = admin.cached.flowProjects ?? null;
  const picked = new Set<string>();
  /** A un outsider nuevo, Flow se lo da el nivel: aquí no se le pone Editor a mano. */
  const outsiderNew = () => chosen === null && !!levelField && level.value === 'outsider';

  // Equipos de cada ficha, para «Como Iñaki M. (Mantenimiento)».
  const teamsOf = new Map<string, string[]>();
  try {
    const teams = new Map(((await client.list(T.teams)) as unknown as Array<{ id: string; name: string; deleted_at: string | null }>).filter((t) => !t.deleted_at).map((t) => [t.id, t.name]));
    for (const pt of (await client.list(T.personTeams)) as unknown as Array<{ person_id: string; team_id: string; deleted_at: string | null }>) {
      if (pt.deleted_at || !teams.has(pt.team_id)) continue;
      teamsOf.set(pt.person_id, [...(teamsOf.get(pt.person_id) ?? []), teams.get(pt.team_id)!]);
    }
  } catch { /* sin equipos: solo el nombre */ }

  const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.accesos.alta.error', 'data-feedback-label': 'Error del alta' });
  const email = el('input', { id: 'inviteEmail', 'data-feedback-ignore': '', type: 'email', required: true, autocomplete: 'off', maxlength: '320' }) as HTMLInputElement;
  const name = el('input', { id: 'inviteName', 'data-feedback-ignore': '', type: 'text', maxlength: '80', autocomplete: 'off' }) as HTMLInputElement;
  const nameHelp = el('span', { class: 'muted small' });
  const level = el('select', { id: 'inviteLevel', 'aria-label': 'Nivel de casa' }, ...HOUSE_LEVELS.map((l) => el('option', { value: l, selected: l === 'staff' }, HOUSE_LEVEL_LABELS[l])),
    el('option', { value: '' }, 'Sin nivel (fuera del directorio)')) as HTMLSelectElement;
  const levelField = withLevels ? el('label', { class: 'field', 'data-feedback-id': 'central.accesos.alta.campo_nivel', 'data-feedback-label': 'Nivel de casa' }, el('span', null, 'Nivel de casa'), level) : null;
  const like = el('select', { id: 'inviteLike', 'aria-label': 'Como un compañero', 'data-feedback-ignore': '', onchange: () => applyLike() }, el('option', { value: '' }, 'Elegir a mano')) as HTMLSelectElement;
  const likeField = el('label', { class: 'field', 'data-feedback-id': 'central.accesos.alta.como', 'data-feedback-label': 'Como un compañero' }, el('span', null, 'Con los accesos de'), like,
    el('span', { class: 'muted small' }, 'Copia Editor y Lector; Propietario y lo que da el nivel de casa no se copian.'));
  const appsHost = el('div', { id: 'inviteApps', 'data-feedback-id': 'central.accesos.alta.apps', 'data-feedback-label': 'Accesos iniciales por app' }, el('p', { class: 'muted' }, 'Cargando apps…'));
  const summary = el('p', { class: 'note', id: 'inviteSummary', 'aria-live': 'polite', 'data-feedback-id': 'central.accesos.alta.resumen', 'data-feedback-label': 'Resumen del alta' });
  const submit = el('button', { class: 'primary', type: 'submit', id: 'inviteSubmit', 'data-feedback-id': 'central.accesos.alta.enviar', 'data-feedback-label': 'Dar de alta' }, 'Dar de alta') as HTMLButtonElement;
  state.cleanups.push(bindOnline(submit, { client, reason: 'El alta se hace en el momento: necesita conexión.' }));

  // --- Caras -----------------------------------------------------------------------------------------------------
  const face = (p: PersonLite | null) => el('button', {
    type: 'button', class: 'ctl-face', 'aria-pressed': 'false', dataset: { person: p?.id ?? '' }, 'data-feedback-id': 'central.accesos.alta.persona', 'data-feedback-label': 'Persona del alta',
    onclick: () => choose(p),
  }, p ? renderMedal({ name: p.display_name, initials: p.initials ?? null, size: 72 }) : el('span', { class: 'medal-disc ctl-face-new', style: '--medal-size:72px', 'aria-hidden': 'true' }, icon('plus', 28)),
  el('span', { class: 'ctl-face-name' }, p ? p.display_name : 'Persona nueva'));
  const faces = el('div', { class: 'ctl-faces', id: 'invitePeople', role: 'group', 'aria-label': 'A quién das de alta', 'data-feedback-id': 'central.accesos.alta.personas', 'data-feedback-label': 'Fichas sin cuenta' },
    ...free.map(face), face(null));
  fbIgnoreWithin(faces, '.ctl-face-name');

  function paintSummary(): void {
    const projectNames = [...picked].map((id) => flowProjects?.find((pr) => pr.id === id)?.name).filter(Boolean);
    const given = catalog.filter((a) => roles.has(a.id)).map((a) => `${appShort(catalog, a.id)} · ${ROLE_LABELS[roles.get(a.id)!]}${a.id === 'flow' && roles.get(a.id) !== 'owner' && projectNames.length ? ` (${projectNames.join(', ')})` : ''}`);
    const who = chosen ? chosen.display_name : name.value.trim() || 'La persona nueva';
    replace(summary, given.length ? `${who} entrará en ${given.join(', ')}.` : `${who} todavía no tiene ninguna app.`,
      downgraded.length ? el('span', { class: 'ctl-downgraded' }, ` Propietario no se copia: dalo a mano (${downgraded.map((a) => appShort(catalog, a)).join(', ')} va como Editor).`) : null);
  }

  function paintApps(): void {
    replace(appsHost, ...catalog.map((app) => {
      const group = el('div', { class: 'segmented ctl-invroles', role: 'group', id: `invite-${app.id}`, 'aria-label': `Acceso a ${appShort(catalog, app.id)}` },
        ...INVITE_ROLES.map((r) => {
          const on = (roles.get(app.id) ?? null) === r;
          return el('button', { type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on), dataset: { role: r ?? 'none' },
            onclick: () => { if (r) roles.set(app.id, r); else roles.delete(app.id); downgraded = downgraded.filter((a) => a !== app.id); paintApps(); paintSummary(); } }, r ? ROLE_LABELS[r] : 'Sin acceso');
        }));
      fbMark(group, 'central.accesos.alta.rol', 'Acceso a una app').setAttribute('data-feedback-label', `Acceso a ${appShort(catalog, app.id)}`);
      const row = el('div', { class: 'approw', 'data-feedback-id': 'central.accesos.alta.app', 'data-feedback-label': 'Acceso a una app' },
        el('span', { class: 'appname' }, el('strong', null, appShort(catalog, app.id)), el('span', { class: 'muted small' }, app.description ?? '')), group);
      return app.id === 'flow' ? el('div', null, row, flowPicker()) : row;
    }));
  }

  /** Proyectos de Flow bajo su fila: marcar uno sin acceso a Flow le da Editor (un paso). Propietario los ve todos. */
  function flowPicker(): HTMLElement | null {
    if (roles.get('flow') === 'owner') return null;
    if (outsiderNew()) return el('p', { class: 'muted small', id: 'inviteFlowOutsider' }, 'A un outsider, Flow se lo da el nivel; su proyecto se elige después, en su ficha.');
    if (!flowProjects) return el('p', { class: 'muted small', id: 'inviteFlowUnavailable' }, 'Los proyectos de Flow se eligen cuando Flow los publique.');
    if (!flowProjects.length) return null;
    const list = sortFlowProjects(flowProjects, todayInMadrid());
    return el('div', { class: 'scopes ctl-invprojects', id: 'inviteFlowProjects', role: 'group', 'aria-label': 'Proyectos de Flow', 'data-feedback-id': 'central.accesos.alta.proyectos_flow', 'data-feedback-label': 'Proyectos de Flow' },
      el('span', { class: 'muted small' }, 'Proyectos de Flow: solo ve los marcados.'),
      ...list.map((pr) => el('label', { class: 'check' },
        el('input', { type: 'checkbox', value: pr.id, checked: picked.has(pr.id), 'data-feedback-id': 'central.accesos.alta.proyecto_flow', 'data-feedback-label': 'Proyecto de Flow',
          onchange: (e: Event) => {
            const box = e.target as HTMLInputElement;
            if (box.checked) { picked.add(pr.id); if (!roles.has('flow')) roles.set('flow', 'editor'); } else picked.delete(pr.id);
            paintApps(); paintSummary();
          } }),
        el('span', null, pr.name))));
  }

  function applyLike(): void {
    const model = accounts.find((a) => a.userId === like.value) ?? null;
    if (!model) return;
    const out = copyFrom(model, grants);
    roles.clear();
    for (const [app, role] of out.roles) roles.set(app, role);
    downgraded = out.ownerDowngraded;
    paintApps();
    paintSummary();
  }

  function fillLike(): void {
    // Modelos: personas con cuenta y algún acceso (no agentes ni cuentas desactivadas).
    const models = accounts.filter((a) => a.kind !== 'agent' && !a.disabled && a.memberships.length)
      .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'es'));
    replace(like, el('option', { value: '' }, 'Elegir a mano'), ...models.map((a) => {
      const person = people.find((p) => p.user_id === a.userId);
      const teams = person ? teamsOf.get(person.id) ?? [] : [];
      return el('option', { value: a.userId }, `Como ${a.displayName || a.email}${teams.length ? ` (${teams.join(', ')})` : ''}`);
    }));
  }

  function choose(p: PersonLite | null): void {
    chosen = p;
    for (const b of faces.querySelectorAll<HTMLButtonElement>('.ctl-face')) b.setAttribute('aria-pressed', String(b.dataset.person === (p?.id ?? '')));
    name.readOnly = !!p;
    name.value = p ? p.display_name : '';
    if (p && emails.get(p.id)) email.value = emails.get(p.id)!;
    else if (!p) email.value = '';
    nameHelp.textContent = p ? 'El de su ficha. Para cambiarlo, edita la ficha en Personas.' : 'Será también el nombre de su ficha en Personas.';
    if (levelField) levelField.hidden = !!p; // el nivel solo se elige para una ficha nueva
    form.hidden = false;
    paintSummary();
    (p ? email : name).focus();
  }

  const form = el('form', { novalidate: true, id: 'inviteForm', hidden: true, 'data-feedback-id': 'central.accesos.alta.formulario', 'data-feedback-label': 'Formulario de alta', onsubmit: async (event: Event) => {
    event.preventDefault();
    error.textContent = '';
    const mail = email.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { error.textContent = 'Escribe un correo válido.'; email.focus(); return; }
    const memberships = [...roles].map(([app, role]) => ({ app, role, ...(app === 'flow' && role !== 'owner' && picked.size ? { scopes: { projects: [...picked] } } : {}) }));
    if (!memberships.length) { error.textContent = 'Elige al menos una app.'; return; }
    const p = chosen ?? null;
    let displayName = p ? p.display_name : name.value.trim();
    if (!displayName) { error.textContent = 'Escribe el nombre de la persona.'; name.focus(); return; }
    submit.disabled = true;
    try {
      // Una persona, una ficha, una cuenta: si el correo ya tiene cuenta, se avisa y se elige antes de dar el alta.
      const apps = await admin.catalog();
      const choice = await checkExistingAccount({ admin, client, email: mail, person: p, appName: (id) => appShort(apps, id) });
      if (choice.kind === 'abort') {
        if (choice.otherEmail) { email.focus(); email.select(); error.textContent = 'Escribe el correo de esta persona.'; }
        return;
      }
      if (choice.kind === 'merge' || choice.kind === 'use_existing') displayName = choice.into.display_name; // la ficha que queda manda
      const out = await usage.run('central.accesos.alta.crear', () => admin.invite({ email: mail, displayName, memberships }));
      // Enlaza la cuenta con su ficha (o crea la ficha), o fusiona la ficha elegida con la que ya tenía la cuenta.
      const current = ((await client.list(T.people)) as unknown as PersonLite[]).filter((x) => !x.deleted_at);
      const alreadyLinked = current.find((x) => x.user_id === out.userId);
      if (choice.kind === 'merge' && p) {
        await mergePeople(client, p.id, choice.into.id);
        toast(`Fichas fusionadas: queda «${choice.into.display_name}».`);
      } else if (choice.kind === 'use_existing') toast(`Accesos añadidos a la cuenta de ${choice.into.display_name}.`);
      else if (alreadyLinked) toast(`Esa cuenta ya estaba enlazada con la ficha de ${alreadyLinked.display_name}.`);
      else if (p) {
        const fresh = current.find((x) => x.id === p.id) ?? p;
        await client.commit([{ op: 'update', table: T.people, id: p.id, expectedRevision: fresh.revision, fields: { user_id: out.userId } }]);
      } else {
        await client.commit([{ op: 'insert', table: T.people, id: crypto.randomUUID(), fields: newPersonFields(displayName, out.userId, withLevels ? ((level.value || null) as HouseLevel | null) : undefined) }]);
      }
      if (out.temporaryPassword) {
        showSecret(out.temporaryPassword, out.email, () => navigate('#/accesos'));
      } else {
        // Fusión o ficha existente ya tienen su aviso; el resto, el de siempre.
        if (choice.kind !== 'merge' && choice.kind !== 'use_existing') toast('Esa cuenta ya existía: se le han añadido los accesos. Su contraseña no cambia.');
        navigate('#/accesos');
      }
    } catch (e) {
      error.textContent = describeError(e);
    } finally {
      submit.disabled = false;
    }
  } },
  el('label', { class: 'field', 'data-feedback-id': 'central.accesos.alta.campo_nombre', 'data-feedback-label': 'Nombre visible' }, el('span', null, 'Nombre'), name, nameHelp),
  el('label', { class: 'field', 'data-feedback-id': 'central.accesos.alta.campo_correo', 'data-feedback-label': 'Correo' }, el('span', null, 'Correo'), email),
  levelField,
  el('div', { class: 'sectionlabel', 'data-feedback-id': 'central.accesos.alta.accesos_iniciales', 'data-feedback-label': 'Accesos iniciales' }, 'Accesos iniciales'),
  likeField,
  appsHost,
  summary,
  error,
  el('div', { class: 'formactions', 'data-feedback-id': 'central.accesos.alta.acciones', 'data-feedback-label': 'Acciones del alta' }, submit));
  name.addEventListener('input', paintSummary);
  level.addEventListener('change', () => { paintApps(); paintSummary(); });

  replace(body,
    el('p', { class: 'muted' }, 'Elige a la persona: su cuenta queda enlazada con su ficha de Personas. Se crea con una contraseña temporal que se muestra una sola vez; si el correo ya tiene cuenta, solo se añaden los accesos.'),
    faces, form);
  if (catalog.length) paintApps();

  try {
    [catalog, accounts, grants] = await Promise.all([admin.catalog(), admin.accounts().catch(() => accounts), admin.houseGrants().catch(() => grants)]);
    if (catalog.some((a) => a.id === 'flow')) flowProjects = await admin.flowProjects().catch(() => flowProjects);
    paintApps();
    fillLike();
    paintSummary();
  } catch (e) {
    replace(appsHost, navigator.onLine ? el('p', { class: 'formerror', 'data-feedback-id': 'central.accesos.alta.error_apps', 'data-feedback-label': 'Error al cargar las apps' }, describeError(e)) : offlineNote());
  }
  if (accounts.length) fillLike();
}
