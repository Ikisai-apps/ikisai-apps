/**
 * Accesos › Agentes · fichas de agente (API.md §2.18, migración 1520). Encima de las claves: una ficha por agente con quién
 * responde por él (una persona, por defecto, o una entidad de servicio), su misión, dónde trabaja, sus accesos (los de sus
 * claves, del núcleo) y quién le sigue. Solo el owner de Central las cambia; van por `commands`, también sin red.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, icon, openSheet, renderSecretOnce, replace, toast, type Sheet, type Usage } from '@ikisai/ui-kit';
import { RESPONSIBLE_KIND_LABELS, hasResponsible, successorChain, validateOperations, type AgentRow, type ResponsibleKind } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import type { AdminApi, AgentKey } from '../app/admin.ts';
import { fbMark } from './feedback.ts';

type Row = AgentRow & { revision: number; code?: string | null; mission?: string | null; work_areas?: string | null; notes?: string | null; deleted_at?: string | null };
type Person = { id: string; display_name: string; active?: boolean; deleted_at?: string | null; merged_into?: string | null };

/** «Responde: Marga», «Responde: Servicio de guardia (servicio)» o «Sin responsable». */
export function responsibleText(a: Pick<Row, 'responsible_kind' | 'responsible_person_id' | 'responsible_service'>, people: ReadonlyMap<string, Person>): string {
  if (!hasResponsible(a)) return 'Sin responsable';
  if ((a.responsible_kind ?? 'person') === 'service') return `Responde: ${a.responsible_service!.trim()} (servicio)`;
  const p = people.get(a.responsible_person_id!);
  return p ? `Responde: ${p.display_name}${p.deleted_at || p.active === false ? ' (ya no está activa)' : ''}` : 'Responde: una persona que no ves';
}

export function mountAgentCards(host: HTMLElement, client: SyncClient, usage: Usage, keys: () => AgentKey[], alive: () => boolean, admin: AdminApi, onAccounts: () => void): void {
  const list = el('div', { id: 'agentCards', 'data-feedback-id': 'central.accesos.agentes.fichas', 'data-feedback-label': 'Fichas de agente' });
  // «Nuevo agente» crea la cuenta, sus accesos y su ficha de una vez (VG, 27-10: una ficha sola no daba acceso a nada).
  const add = el('button', { class: 'primary', type: 'button', id: 'newAgentCard', 'data-feedback-id': 'central.accesos.agentes.fichas.nueva', 'data-feedback-label': 'Nuevo agente', onclick: () => void createAgent(null) }, icon('plus', 18), 'Nuevo agente');
  replace(host,
    el('div', { class: 'ctl-agentcardshead' }, el('h3', null, 'Fichas'), add),
    el('p', { class: 'muted small' }, 'Quién responde por cada agente, qué hace y quién le sigue. Sin responsable, el agente no se activa.'),
    list);

  const accountName = (userId: string) => keys().find((k) => k.userId === userId)?.name ?? null;
  const accessOf = (userId: string | null | undefined) => {
    if (!userId) return null;
    const apps = [...new Set(keys().filter((k) => k.userId === userId && !k.revokedAt).flatMap((k) => k.memberships.map((m) => m.app)))];
    return apps.length ? `Entra en: ${apps.join(', ')}` : 'Sin claves vivas';
  };

  async function data(): Promise<{ agents: Row[]; people: Map<string, Person> }> {
    const [agents, people] = await Promise.all([client.list(T.agents), client.list(T.people)]);
    return {
      agents: (agents as unknown as Row[]).filter((a) => !a.deleted_at).sort((a, b) => a.display_name.localeCompare(b.display_name, 'es')),
      people: new Map((people as unknown as Person[]).map((p) => [p.id, p])),
    };
  }

  async function paint(): Promise<void> {
    const { agents, people } = await data();
    if (!alive()) return;
    replace(list, agents.length
      ? el('ul', { class: 'list' }, ...agents.map((a) => {
        const next = successorChain(agents, a.id)[0];
        const tone = hasResponsible(a) ? '' : ' warn';
        const account = a.user_id ? (accountName(a.user_id) ? `Cuenta: ${accountName(a.user_id)}` : 'Cuenta enlazada') : 'Sin cuenta';
        return el('li', { class: `agentrow${tone}`, 'data-agent': a.id, 'data-feedback-id': 'central.accesos.agentes.fichas.fila', 'data-feedback-label': 'Ficha de agente' },
          el('div', null,
            el('strong', null, icon('bot', 16), ' ', a.display_name), a.code ? el('span', { class: 'muted', 'data-feedback-ignore': '' }, ` · ${a.code}`) : null, ' ',
            el('span', { class: `chip${a.active ? ' ok' : ''}`, 'data-agent-state': '' }, a.active ? 'Activo' : 'Inactivo'),
            el('div', { class: 'muted small', 'data-agent-meta': '' }, [responsibleText(a, people), account, accessOf(a.user_id)].filter(Boolean).join(' · ')),
            a.mission ? el('div', { class: 'small' }, a.mission) : null,
            a.work_areas ? el('div', { class: 'muted small' }, `Trabaja en: ${a.work_areas}`) : null,
            next ? el('div', { class: 'muted small', 'data-agent-successor': '' }, `Le sigue: ${next.display_name}`) : null),
          el('button', { class: 'small', type: 'button', 'aria-label': `Editar: ${a.display_name}`, 'data-feedback-id': 'central.accesos.agentes.fichas.editar', 'data-feedback-label': 'Editar ficha de agente', onclick: () => void edit(a) }, 'Editar'));
      }))
      : el('p', { class: 'empty hint' }, 'Aún no hay fichas de agente. Crea una para dejar escrito quién responde por cada agente.'));
  }

  /**
   * Nuevo agente (o la cuenta de una ficha que aún no tiene): nombre, apps y si lee o también edita. Crea la cuenta de agente
   * con sus accesos, enseña la clave una vez y deja la ficha enlazada. Los agentes nunca entran en Central.
   */
  async function createAgent(card: Row | null): Promise<void> {
    if (!navigator.onLine) { toast('Dar de alta un agente necesita conexión.'); return; }
    let catalog;
    try { catalog = (await admin.catalog()).filter((a) => a.id !== 'central'); } catch (e) { toast(describeError(e)); return; }
    let sheet: Sheet | null = null;
    const name = el('input', { id: 'na-name', 'data-field-id': 'central.accesos.new_agent_name', maxlength: 100, value: card?.display_name ?? '', required: true }) as HTMLInputElement;
    const role = el('select', { id: 'na-role', 'data-field-id': 'central.accesos.new_agent_role' },
      el('option', { value: 'reader', selected: true }, 'Lector: solo lee'), el('option', { value: 'editor' }, 'Editor: lee y propone cambios')) as HTMLSelectElement;
    const boxes = catalog.map((a) => el('input', { type: 'checkbox', value: a.id, checked: true, 'aria-label': a.name }) as HTMLInputElement);
    const expires = el('input', { id: 'na-expires', 'data-field-id': 'central.accesos.new_agent_expires', type: 'date' }) as HTMLInputElement;
    const error = el('p', { class: 'formerror', role: 'alert', 'data-feedback-id': 'central.accesos.agentes.nuevo.error', 'data-feedback-label': 'Error del alta de agente' });
    const submit = el('button', { class: 'primary', type: 'button', id: 'na-submit', 'data-feedback-id': 'central.accesos.agentes.nuevo.crear', 'data-feedback-label': 'Crear el agente', onclick: async () => {
      error.textContent = '';
      const apps = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!name.value.trim()) { error.textContent = 'Pon un nombre.'; return; }
      if (!apps.length) { error.textContent = 'Elige al menos una app.'; return; }
      submit.disabled = true;
      try {
        const out = await usage.run('central.accesos.agentes.nuevo', () => admin.createAgent({ name: name.value.trim(), role: role.value as 'reader' | 'editor', apps, expiresAt: expires.value ? `${expires.value}T23:59:59Z` : null }));
        // La ficha, enlazada a su cuenta: la que había o una nueva.
        const op = card
          ? { op: 'update' as const, table: T.agents, id: card.id, expectedRevision: Number(card.revision), fields: { user_id: out.userId } }
          : { op: 'insert' as const, table: T.agents, id: crypto.randomUUID(), fields: { display_name: out.name, user_id: out.userId } };
        await client.commit([op]).catch((e) => toast(describeError(e)));
        await sheet?.close(true);
        onAccounts();
        const failed = out.apps.filter((a) => !a.ok).map((a) => catalog!.find((c) => c.id === a.app)?.name ?? a.app);
        showKey(out.token, out.name, failed);
        await paint();
      } catch (e) { error.textContent = describeError(e); } finally { submit.disabled = false; }
    } }, 'Crear el agente');
    sheet = openSheet({ title: card ? `Cuenta de agente · ${card.display_name}` : 'Nuevo agente',
      body: el('div', { 'data-feedback-id': 'central.accesos.agentes.nuevo', 'data-feedback-label': 'Nuevo agente' },
        el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
        el('label', { class: 'field' }, el('span', null, 'Qué puede hacer'), role),
        el('div', { class: 'field', id: 'na-apps', 'data-feedback-id': 'central.accesos.agentes.nuevo.apps', 'data-feedback-label': 'Apps del agente' },
          el('span', null, 'En qué apps'), ...catalog.map((a, i) => el('label', { class: 'check' }, boxes[i]!, el('span', null, a.name.replace(/^Ikisai /, ''))))),
        el('p', { class: 'muted small' }, 'Central no admite agentes. Solo se le da acceso en las apps donde tú seas propietario.'),
        el('label', { class: 'field' }, el('span', null, 'Caduca (opcional)'), expires),
        error),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.accesos.agentes.nuevo.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), submit],
      initialFocus: name });
  }

  /** La clave del agente, una sola vez; y en qué apps no se ha podido dar acceso. */
  function showKey(token: string, agentName: string, failed: string[]): void {
    let sheet: Sheet | null = null;
    sheet = openSheet({ title: 'Clave del agente', meta: agentName,
      panelAttrs: { 'data-feedback-id': 'central.accesos.agentes.clave', 'data-feedback-label': 'Clave del agente' },
      body: el('div', null,
        el('p', null, 'Configúrala en el agente. Con ella entra en las apps que has elegido.'),
        failed.length ? el('p', { class: 'note', id: 'na-failed' }, `Sin acceso en: ${failed.join(', ')} (no eres propietario o no lo admite).`) : null,
        renderSecretOnce({ value: token, label: 'Clave del agente', warning: 'Solo se muestra ahora: no se puede volver a consultar. Si se pierde, se revoca y se crea otra.', onDone: () => void sheet?.close(),
          valueAttrs: { 'data-feedback-id': 'central.accesos.agentes.clave.valor', 'data-feedback-label': 'Clave', 'data-feedback-ignore': '' },
          copyAttrs: { 'data-feedback-id': 'central.accesos.agentes.clave.copiar', 'data-feedback-label': 'Copiar' },
          doneAttrs: { 'data-feedback-id': 'central.accesos.agentes.clave.hecho', 'data-feedback-label': 'Hecho' } })),
    });
  }

  async function edit(current: Row | null): Promise<void> {
    const { agents, people } = await data();
    let sheet: Sheet | null = null;
    const v = (x: unknown) => (x === null || x === undefined ? '' : String(x));
    const name = fbMark(el('input', { id: 'ag-name', 'data-field-id': 'central.accesos.agent_name', 'data-field-entity': 'central.agents', 'data-field-prop': 'display_name', maxlength: 80, value: v(current?.display_name), required: true }) as HTMLInputElement, 'central.accesos.agentes.fichas.nombre', 'Nombre del agente');
    const accounts = [...new Map(keys().map((k) => [k.userId, k.name])).entries()];
    const account = fbMark(el('select', { id: 'ag-account', 'data-field-id': 'central.accesos.agent_account', 'data-field-entity': 'central.agents', 'data-field-prop': 'user_id' }, el('option', { value: '' }, 'Sin cuenta'),
      ...accounts.map(([id, n]) => el('option', { value: id, selected: current?.user_id === id }, n))) as HTMLSelectElement, 'central.accesos.agentes.fichas.cuenta', 'Cuenta del agente');
    const mission = fbMark(el('textarea', { id: 'ag-mission', 'data-field-id': 'central.accesos.agent_mission', 'data-field-entity': 'central.agents', 'data-field-prop': 'mission', maxlength: 500, rows: 3 }, v(current?.mission)) as HTMLTextAreaElement, 'central.accesos.agentes.fichas.mision', 'Misión');
    const areas = fbMark(el('input', { id: 'ag-areas', 'data-field-id': 'central.accesos.agent_areas', 'data-field-entity': 'central.agents', 'data-field-prop': 'work_areas', maxlength: 300, value: v(current?.work_areas), placeholder: 'Apps y repositorios' }) as HTMLInputElement, 'central.accesos.agentes.fichas.trabaja', 'Dónde trabaja');
    const kind = fbMark(el('select', { id: 'ag-kind', 'data-field-id': 'central.accesos.agent_responsible_kind', 'data-field-entity': 'central.agents', 'data-field-prop': 'responsible_kind' }, ...(['person', 'service'] as const).map((k) => el('option', { value: k, selected: (current?.responsible_kind ?? 'person') === k }, RESPONSIBLE_KIND_LABELS[k]))) as HTMLSelectElement, 'central.accesos.agentes.fichas.tipo', 'Tipo de responsable');
    const alivePeople = [...people.values()].filter((p) => !p.deleted_at && p.active !== false && !p.merged_into).sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));
    const person = fbMark(el('select', { id: 'ag-person', 'data-field-id': 'central.accesos.agent_person', 'data-field-entity': 'central.agents', 'data-field-prop': 'responsible_person_id' }, el('option', { value: '' }, 'Elige una persona'),
      ...alivePeople.map((p) => el('option', { value: p.id, selected: current?.responsible_person_id === p.id }, p.display_name))) as HTMLSelectElement, 'central.accesos.agentes.fichas.persona', 'Persona responsable');
    const service = fbMark(el('input', { id: 'ag-service', 'data-field-id': 'central.accesos.agent_service', 'data-field-entity': 'central.agents', 'data-field-prop': 'responsible_service', maxlength: 120, value: v(current?.responsible_service), placeholder: 'Nombre de la entidad de servicio' }) as HTMLInputElement, 'central.accesos.agentes.fichas.servicio', 'Entidad de servicio');
    const personField = el('label', { class: 'field' }, el('span', null, 'Persona'), person);
    const serviceField = el('label', { class: 'field' }, el('span', null, 'Entidad de servicio'), service);
    const syncKind = () => { const s = kind.value === 'service'; personField.hidden = s; serviceField.hidden = !s; };
    kind.addEventListener('change', syncKind);
    syncKind();
    const active = fbMark(el('input', { id: 'ag-active', 'data-field-id': 'central.accesos.agent_active', 'data-field-entity': 'central.agents', 'data-field-prop': 'active', type: 'checkbox', checked: !!current?.active }) as HTMLInputElement, 'central.accesos.agentes.fichas.activo', 'Activo');
    const successor = fbMark(el('select', { id: 'ag-successor', 'data-field-id': 'central.accesos.agent_successor', 'data-field-entity': 'central.agents', 'data-field-prop': 'successor_id' }, el('option', { value: '' }, 'Nadie'),
      ...agents.filter((a) => a.id !== current?.id).map((a) => el('option', { value: a.id, selected: current?.successor_id === a.id }, a.display_name))) as HTMLSelectElement, 'central.accesos.agentes.fichas.sucesor', 'Le sigue');
    const notes = fbMark(el('textarea', { id: 'ag-notes', 'data-field-id': 'central.accesos.agent_notes', 'data-field-entity': 'central.agents', 'data-field-prop': 'notes', maxlength: 500, rows: 2 }, v(current?.notes)) as HTMLTextAreaElement, 'central.accesos.agentes.fichas.notas', 'Notas');
    const error = el('p', { class: 'formerror', role: 'alert', 'data-feedback-id': 'central.accesos.agentes.fichas.error', 'data-feedback-label': 'Error de la ficha' });
    const text = (x: HTMLInputElement | HTMLTextAreaElement) => x.value.trim() || null;

    const save = el('button', { class: 'primary', type: 'button', id: 'saveAgentCard', 'data-feedback-id': 'central.accesos.agentes.fichas.guardar', 'data-feedback-label': 'Guardar ficha', onclick: async () => {
      const k = kind.value as ResponsibleKind;
      const fields = {
        display_name: name.value.trim(), user_id: account.value || null, mission: text(mission), work_areas: text(areas),
        responsible_kind: k, responsible_person_id: k === 'person' ? person.value || null : null, responsible_service: k === 'service' ? text(service) : null,
        active: active.checked, successor_id: successor.value || null, notes: text(notes),
      };
      const operations = current
        ? [{ op: 'update' as const, table: T.agents, id: current.id, expectedRevision: Number(current.revision), fields }]
        : [{ op: 'insert' as const, table: T.agents, id: crypto.randomUUID(), fields }];
      const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' });
      if (issue) { error.textContent = issue.message; return; }
      try {
        await usage.run('central.accesos.agentes.fichas.guardar', () => client.commit(operations));
        toast(current ? 'Ficha guardada.' : 'Ficha creada.');
        await sheet?.close(true);
        await paint();
      } catch (e) { error.textContent = describeError(e); }
    } }, current ? 'Guardar' : 'Crear');

    sheet = openSheet({ title: current ? current.display_name : 'Nueva ficha de agente', meta: current?.code ?? undefined,
      body: el('div', { 'data-feedback-id': 'central.accesos.agentes.fichas.formulario', 'data-feedback-label': 'Ficha de agente' },
        el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
        el('label', { class: 'field' }, el('span', null, 'Cuenta de agente'), account),
        current && !current.user_id ? el('button', { class: 'softbtn', type: 'button', id: 'ag-create-account', 'data-feedback-id': 'central.accesos.agentes.fichas.crear_cuenta', 'data-feedback-label': 'Crear su cuenta de agente',
          onclick: () => { void sheet?.close(true); void createAgent(current); } }, icon('plus', 16), 'Crear su cuenta de agente') : null,
        el('p', { class: 'muted small' }, 'Las cuentas salen de las claves emitidas. Sus accesos se dan en cada app, no aquí.'),
        el('label', { class: 'field' }, el('span', null, 'Misión'), mission),
        el('label', { class: 'field' }, el('span', null, 'Dónde trabaja'), areas),
        el('label', { class: 'field' }, el('span', null, 'Quién responde'), kind),
        personField, serviceField,
        el('label', { class: 'ctl-agentactive' }, active, el('span', null, 'Activo')),
        el('label', { class: 'field' }, el('span', null, 'Le sigue'), successor),
        el('label', { class: 'field' }, el('span', null, 'Notas'), notes),
        error),
      foot: [
        // Borrar la ficha (VG, 28-10: una ficha sin cuenta no se puede «revocar»). Borrado lógico; con cuenta, se revoca antes su clave.
        current ? el('button', { class: 'ghost danger', type: 'button', id: 'ag-delete', 'data-feedback-id': 'central.accesos.agentes.fichas.borrar', 'data-feedback-label': 'Borrar la ficha', onclick: async () => {
          if (current.user_id && keys().some((k) => k.userId === current.user_id && !k.revokedAt)) { error.textContent = 'Antes, revoca su clave en «Claves».'; return; }
          if (!(await confirmDialog({ title: `¿Borrar la ficha «${current.display_name}»?`, text: 'Deja de salir en Agentes. No toca ninguna cuenta.', confirmLabel: 'Borrar', danger: true }))) return;
          try {
            await usage.run('central.accesos.agentes.fichas.borrar', () => client.commit([{ op: 'delete', table: T.agents, id: current.id, expectedRevision: Number(current.revision) }]));
            toast('Ficha borrada.');
            await sheet?.close(true);
            await paint();
          } catch (e) { error.textContent = describeError(e); }
        } }, 'Borrar la ficha') : null,
        el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.accesos.agentes.fichas.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save],
      initialFocus: name });
  }

  void paint();
}
