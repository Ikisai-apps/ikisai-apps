import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  compressImage, confirmDialog, createSortableList, el, icon, openSheet, positionBetween, replace, toast, type Sheet,
} from '@ikisai/ui-kit';
import {
  AVAILABILITIES, AVAILABILITY_LABELS, BASE_ROLES, BASE_ROLE_LABELS, COVERAGES, COVERAGE_LABELS, ENGAGEMENTS, ENGAGEMENT_LABELS,
  FREE_RECORD_TYPES, RECORD_KINDS, RECORD_STATUSES, RECORD_STATUS_LABELS, RECORD_TYPE_LABELS, RELATIONS, RELATION_LABELS,
  canSeeReserved, dueState, personStatus, recordTypesFor, todayInMadrid, validateOperations, type RecordKind,
} from '@ikisai/domain-central';
import { guard } from '../app/guard.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import { ROLE_LABELS, type Account, type Role } from '../app/admin.ts';
import { showSecret } from './access.ts';
import type { ViewContext, ViewMount } from './shell.ts';
import { fbIgnoreWithin, fbMark } from './feedback.ts';

type Base = { id: string; revision: number; updated_at: string; deleted_at: string | null };
export type Person = Mirror<Base & {
  code: string; display_name: string; relation: string; base_role: string; coverage: string; availability: string;
  availability_notes: string | null; active: boolean; committed_post: boolean; user_id: string | null; position: number;
}>;
type Private = Mirror<Base & {
  person_id: string; legal_name: string | null; phone: string | null; email: string | null; engagement: string | null;
  engaged_from: string | null; engaged_until: string | null; emergency_contact: string | null; notes: string | null;
}>;
export type PersonRecord = Mirror<Base & {
  person_id: string; kind: RecordKind; record_type: string; title: string | null; status: string; issued_on: string | null;
  expires_on: string | null; reviewed_on: string | null; file_id: string | { $blob: string } | null; notes: string | null; position: number;
}>;

const FILE_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const text = (value: string) => value.trim() || null;
const date = (value: string) => value || null;
const day = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : null);
const STATE_LABEL = { vencido: 'Caducado', por_vencer: 'Caduca pronto', al_dia: '' } as const;
/** La línea secundaria de las hojas lleva el nombre de la persona (o su código PER_…): el gesto la ignora. */
const ignoreSheetMeta = (sheet: Sheet): Sheet => { fbIgnoreWithin(sheet.element, '.sheet-body > .meta'); return sheet; };

/** Lectura del espejo local; las tablas reservadas solo llegan a quien puede verlas. */
export type Team = Mirror<Base & { name: string; color: string | null; position: number }>;
export type PersonTeam = Mirror<Base & { person_id: string; team_id: string }>;

async function loadPeople(client: SyncClient): Promise<{ people: Person[]; privates: Private[]; records: PersonRecord[]; teams: Team[]; personTeams: PersonTeam[] }> {
  const reserved = canSeeReserved(client.bootstrap()?.membership);
  const [people, privates, records, teams, personTeams] = await Promise.all([
    client.list(T.people, { includeDeleted: true }),
    reserved ? client.list(T.personPrivate, { includeDeleted: true }) : Promise.resolve([]),
    reserved ? client.list(T.personRecords, { includeDeleted: true }) : Promise.resolve([]),
    client.list(T.teams),
    client.list(T.personTeams, { includeDeleted: true }),
  ]);
  return {
    people: people as unknown as Person[], privates: privates as unknown as Private[], records: records as unknown as PersonRecord[],
    teams: (teams as unknown as Team[]).sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name, 'es')),
    personTeams: personTeams as unknown as PersonTeam[],
  };
}

/** Equipos vivos de una persona, en el orden de los equipos. */
function teamsOf(data: { teams: Team[]; personTeams: PersonTeam[] }, personId: string): Team[] {
  const ids = new Set(data.personTeams.filter((x) => x.person_id === personId && !x.deleted_at).map((x) => x.team_id));
  return data.teams.filter((t) => ids.has(t.id));
}

function teamChip(t: Team): HTMLElement {
  return el('span', { class: 'chip teamchip', style: t.color ? `--team:${t.color}` : null }, t.name);
}

async function commitSafely(client: SyncClient, operations: RowOperation[], okMessage: string, current?: (table: string, id: string) => Record<string, unknown> | undefined): Promise<boolean> {
  const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' }, current);
  if (issue) { toast(issue.message); return false; }
  try {
    await client.commit(operations);
    toast(!navigator.onLine ? `${okMessage} Se sincronizará cuando haya red.` : okMessage);
    return true;
  } catch (error) {
    toast(describeError(error));
    return false;
  }
}

function options<T extends string>(values: readonly T[], labels: Record<string, string>, selected: string | null | undefined, empty?: string): HTMLElement[] {
  return [
    ...(empty !== undefined ? [el('option', { value: '', selected: !selected }, empty)] : []),
    ...values.map((v) => el('option', { value: v, selected: selected === v }, labels[v] ?? v)),
  ];
}

/** Chips del estado documental derivado (solo para quien ve los datos reservados). */
function statusChips(records: PersonRecord[], personId: string, today: string): HTMLElement[] {
  const mine = records.filter((r) => r.person_id === personId && !r.deleted_at);
  if (!mine.length) return [];
  const s = personStatus(mine, today);
  const out: HTMLElement[] = [];
  if (s.documents === 'caducado' || s.training === 'caducado') out.push(el('span', { class: 'chip alert' }, 'Documentación caducada'));
  else if (mine.some((r) => dueState(r.expires_on, today, 30, r.status === 'no_aplica') === 'por_vencer')) out.push(el('span', { class: 'chip warn' }, 'Caduca pronto'));
  else if (s.documents === 'pendiente' || s.training === 'pendiente') out.push(el('span', { class: 'chip' }, 'Documentación pendiente'));
  return out;
}

// ---------------------------------------------------------------------------
// Lista de personas
// ---------------------------------------------------------------------------
export const mountPeople: ViewMount = (ctx) => {
  const { main, client, navigate } = ctx;
  const role = client.bootstrap()?.membership.role ?? 'reader';
  const canEdit = role !== 'reader';
  let data: Awaited<ReturnType<typeof loadPeople>> = { people: [], privates: [], records: [], teams: [], personTeams: [] };
  let query = '';
  let relation = '';
  let team = '';
  let showInactive = false;

  const host = el('div', { id: 'peopleList', 'data-feedback-id': 'central.personas.lista', 'data-feedback-label': 'Lista de personas' });
  const trashList = el('ul', { class: 'list', 'aria-label': 'Personas en la papelera', 'data-feedback-id': 'central.personas.papelera.lista', 'data-feedback-label': 'Personas en la papelera' });
  const trashLabel = el('summary', { class: 'sectionlabel', style: 'cursor:pointer', 'data-feedback-id': 'central.personas.papelera.cabecera', 'data-feedback-label': 'Papelera de personas' }, 'Papelera ', el('span', { class: 'count' }, '0'));
  const trash = el('details', { id: 'peopleTrash', 'data-feedback-id': 'central.personas.papelera', 'data-feedback-label': 'Papelera', hidden: true }, trashLabel, trashList);
  const search = el('input', { type: 'search', id: 'peopleSearch', 'data-feedback-id': 'central.personas.buscar', 'data-feedback-label': 'Buscar persona', placeholder: 'Buscar por nombre', 'aria-label': 'Buscar persona',
    oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); paint(); } });
  const relationFilter = el('select', { id: 'peopleRelation', 'aria-label': 'Relación', 'data-feedback-id': 'central.personas.filtro_relacion', 'data-feedback-label': 'Filtro por relación', onchange: (e: Event) => { relation = (e.target as HTMLSelectElement).value; paint(); } },
    ...options(RELATIONS, RELATION_LABELS, '', 'Todas las relaciones'));
  const teamFilter = el('select', { id: 'peopleTeam', 'aria-label': 'Equipo', 'data-feedback-id': 'central.personas.filtro_equipo', 'data-feedback-label': 'Filtro por equipo', onchange: (e: Event) => { team = (e.target as HTMLSelectElement).value; paint(); } },
    el('option', { value: '' }, 'Todos los equipos')) as HTMLSelectElement;
  const inactive = el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'peopleInactive', 'data-feedback-id': 'central.personas.mostrar_inactivas', 'data-feedback-label': 'Mostrar inactivas', onchange: (e: Event) => { showInactive = (e.target as HTMLInputElement).checked; paint(); } }), el('span', null, 'Mostrar inactivas'));

  replace(
    main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.personas.cabecera', 'data-feedback-label': 'Cabecera de Personas' }, el('div', null, el('h2', null, 'Personas'),
      el('p', null, 'Quién trabaja o colabora con Ikisai, tenga o no cuenta en las apps.'))),
    el('div', { class: 'toolbar', 'data-feedback-id': 'central.personas.barra', 'data-feedback-label': 'Búsqueda y filtros' }, search, relationFilter, teamFilter, inactive,
      el('a', { class: 'ghost btnlike', href: '#/personas/equipos', id: 'manageTeams', 'data-feedback-id': 'central.personas.equipos', 'data-feedback-label': 'Equipos' }, icon('people', 16), 'Equipos')),
    host,
    trash,
    canEdit ? el('button', { class: 'fab', type: 'button', id: 'newPerson', 'data-feedback-id': 'central.personas.nueva', 'data-feedback-label': 'Nueva persona', onclick: () => openPersonEditor(ctx, null, (id) => navigate(`#/personas/${id}`)) }, icon('plus'), 'Nueva persona') : null,
  );

  function row(p: Person): HTMLElement {
    const today = todayInMadrid();
    const chips = [
      ...(p.active ? [] : [el('span', { class: 'chip' }, 'Inactiva')]),
      ...(p.committed_post ? [el('span', { class: 'chip' }, 'Puesto comprometido')]: []),
      ...teamsOf(data, p.id).map(teamChip),
      ...statusChips(data.records, p.id, today),
      ...(p._pending ? [el('span', { class: 'chip pending' }, 'Pendiente de sincronizar')] : []),
    ];
    return el('button', { class: 'personrow', type: 'button', 'data-person': p.id, 'data-feedback-id': 'central.personas.lista.fila', 'data-feedback-label': 'Persona', onclick: () => navigate(`#/personas/${p.id}`) },
      el('span', { class: 'accountname', 'data-feedback-ignore': '' }, p.display_name, p.user_id ? el('span', { class: 'muted', title: 'Tiene cuenta' }, ' ', icon('user', 14)) : null),
      el('span', { class: 'muted accountmeta', 'data-feedback-id': 'central.personas.lista.funcion', 'data-feedback-label': 'Función y relación' }, `${BASE_ROLE_LABELS[p.base_role as keyof typeof BASE_ROLE_LABELS] ?? p.base_role} · ${RELATION_LABELS[p.relation as keyof typeof RELATION_LABELS] ?? p.relation}`),
      chips.length ? el('span', { class: 'chips', 'data-feedback-id': 'central.personas.lista.etiquetas', 'data-feedback-label': 'Estado de la persona' }, ...chips) : null);
  }

  function paint(): void {
    const alive = data.people.filter((p) => !p.deleted_at).sort((a, b) => (a.position - b.position) || a.display_name.localeCompare(b.display_name, 'es'));
    const inTeam = team ? new Set(data.personTeams.filter((x) => x.team_id === team && !x.deleted_at).map((x) => x.person_id)) : null;
    const filtered = alive.filter((p) => (showInactive || p.active) && (!relation || p.relation === relation) && (!inTeam || inTeam.has(p.id)) && (!query || p.display_name.toLowerCase().includes(query)));
    if (teamFilter.options.length !== data.teams.length + 1) {
      replace(teamFilter, el('option', { value: '' }, 'Todos los equipos'), ...data.teams.map((t) => el('option', { value: t.id, selected: t.id === team }, t.name)));
    }
    if (!filtered.length) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.personas.vacio', 'data-feedback-label': 'Sin personas' },
        el('strong', null, alive.length ? 'Ninguna persona coincide' : 'Todavía no hay personas'),
        alive.length ? 'Cambia el filtro o la búsqueda.' : canEdit ? 'Añade a quien trabaja o colabora con Ikisai: con o sin cuenta.' : ''));
    } else if (canEdit && !query && !relation && !team && showInactive) {
      // Orden manual (decisión del usuario): solo con la lista completa, para que la posición tenga sentido.
      const sortable = createSortableList<Person>({
        items: filtered, key: (p) => p.id, render: (p) => row(p), name: (p) => p.display_name, label: 'Personas', id: 'peopleSortable',
        onReorder: async (items, move) => {
          const prev = items[move.to - 1]?.position ?? null;
          const next = items[move.to + 1]?.position ?? null;
          const position = positionBetween(prev, next);
          await commitSafely(client, [{ op: 'update', table: T.people, id: move.item.id, expectedRevision: move.item.revision, fields: { position } }], 'Orden guardado.');
          await load();
        },
      });
      replace(host, el('p', { class: 'muted small' }, 'Arrastra o usa las flechas para ordenar.'), fbMark(sortable.element, 'central.personas.lista.ordenable', 'Personas ordenables'));
    } else {
      replace(host, el('ul', { class: 'accounts', 'aria-label': 'Personas', 'data-feedback-id': 'central.personas.lista.filas', 'data-feedback-label': 'Personas' }, ...filtered.map((p) => el('li', null, row(p)))),
        canEdit && alive.length > 1 ? el('p', { class: 'muted small' }, 'Para ordenar a mano, marca «Mostrar inactivas» y deja la búsqueda y el filtro vacíos.') : null);
    }
    const deleted = data.people.filter((p) => p.deleted_at);
    trash.hidden = deleted.length === 0 || !canEdit;
    trashLabel.querySelector('.count')!.textContent = String(deleted.length);
    replace(trashList, ...deleted.map((p) => el('li', { class: 'agentrow', 'data-feedback-id': 'central.personas.papelera.fila', 'data-feedback-label': 'Persona en la papelera' }, el('span', { 'data-feedback-ignore': '' }, p.display_name),
      el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'central.personas.papelera.restaurar', 'data-feedback-label': 'Restaurar', onclick: () => void restorePerson(client, data, p).then(load) }, icon('restore', 18), 'Restaurar'))));
  }

  async function load(): Promise<void> {
    data = await loadPeople(client);
    paint();
  }

  void load();
  const offs = [T.people, T.personPrivate, T.personRecords, T.teams, T.personTeams].map((t) => client.onTable(t, () => void load()));
  return () => offs.forEach((off) => off());
};

/** Restaurar una persona y, en el mismo lote, lo reservado que se borró con ella (si quien restaura lo ve). */
async function restorePerson(client: SyncClient, data: Awaited<ReturnType<typeof loadPeople>>, p: Person): Promise<void> {
  const children = [...data.privates, ...data.records].filter((c) => c.person_id === p.id && c.deleted_at && c.deleted_at === p.deleted_at);
  const links = data.personTeams.filter((x) => x.person_id === p.id && x.deleted_at && x.deleted_at === p.deleted_at && data.teams.some((t) => t.id === x.team_id));
  await commitSafely(client, [
    { op: 'restore', table: T.people, id: p.id, expectedRevision: p.revision },
    ...children.map((c) => ({ op: 'restore' as const, table: 'kind' in c ? T.personRecords : T.personPrivate, id: c.id, expectedRevision: c.revision })),
    ...links.map((x) => ({ op: 'restore' as const, table: T.personTeams, id: x.id, expectedRevision: x.revision })),
  ], `«${p.display_name}» restaurada.`);
}

// ---------------------------------------------------------------------------
// Editor de la ficha básica (alta y edición)
// ---------------------------------------------------------------------------
function openPersonEditor(ctx: ViewContext, person: Person | null, onCreated?: (id: string) => void): void {
  const { client } = ctx;
  let sheet: Sheet | null = null;
  const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.persona.editar.error', 'data-feedback-label': 'Error del formulario' });
  const name = el('input', { id: 'p-name', 'data-feedback-ignore': '', type: 'text', maxlength: '80', required: true, value: person?.display_name ?? '' }) as HTMLInputElement;
  const relation = el('select', { id: 'p-relation' }, ...options(RELATIONS, RELATION_LABELS, person?.relation ?? 'equipo')) as HTMLSelectElement;
  const baseRole = el('select', { id: 'p-role' }, ...options(BASE_ROLES, BASE_ROLE_LABELS, person?.base_role ?? 'otro')) as HTMLSelectElement;
  const coverage = el('select', { id: 'p-coverage' }, ...options(COVERAGES, COVERAGE_LABELS, person?.coverage ?? 'todo')) as HTMLSelectElement;
  const availability = el('select', { id: 'p-availability' }, ...options(AVAILABILITIES, AVAILABILITY_LABELS, person?.availability ?? 'segun_calendario')) as HTMLSelectElement;
  const notes = el('textarea', { id: 'p-notes', rows: '2', maxlength: '300', placeholder: 'Solo fines de semana, julio y agosto…' }) as HTMLTextAreaElement;
  notes.value = person?.availability_notes ?? '';
  const committed = el('input', { type: 'checkbox', id: 'p-committed', checked: person?.committed_post ?? false }) as HTMLInputElement;

  const values = (): Record<string, unknown> => ({
    display_name: name.value.trim(), relation: relation.value, base_role: baseRole.value, coverage: coverage.value,
    availability: availability.value, availability_notes: text(notes.value), committed_post: committed.checked,
  });
  const changed = () => {
    const all = values();
    return person ? Object.fromEntries(Object.entries(all).filter(([k, v]) => (person[k] ?? null) !== (v ?? null))) : all;
  };
  const refresh = () => {
    const dirty = Object.keys(changed()).length > 0;
    guard.dirtyEditor = person ? dirty : name.value.trim() !== '';
    sheet?.setFootHidden(person !== null && !dirty);
  };
  const save = el('button', { class: 'primary', type: 'submit', id: 'savePerson', form: 'personForm', 'data-feedback-id': 'central.persona.editar.guardar', 'data-feedback-label': 'Guardar' }, 'Guardar') as HTMLButtonElement;
  const form = el('form', { novalidate: true, id: 'personForm', 'data-feedback-id': 'central.persona.editar.formulario', 'data-feedback-label': 'Formulario de la ficha', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
    event.preventDefault();
    error.textContent = '';
    if (!name.value.trim()) { error.textContent = 'El nombre es obligatorio.'; name.focus(); return; }
    const id = person?.id ?? crypto.randomUUID();
    const operations: RowOperation[] = person
      ? [{ op: 'update', table: T.people, id, expectedRevision: person.revision, fields: changed() }]
      : [{ op: 'insert', table: T.people, id, fields: { ...values(), position: Date.now() / 1000 } }];
    save.disabled = true;
    const ok = await commitSafely(client, operations, person ? 'Cambios guardados.' : 'Persona creada.');
    save.disabled = false;
    if (!ok) return;
    guard.dirtyEditor = false;
    await sheet?.close(true);
    if (!person) onCreated?.(id);
  } },
  el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_nombre', 'data-feedback-label': 'Nombre' }, el('span', null, 'Nombre con el que se le conoce'), name),
  el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.editar.relacion_funcion', 'data-feedback-label': 'Relación y función' },
    el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_relacion', 'data-feedback-label': 'Relación con Ikisai' }, el('span', null, 'Relación con Ikisai'), relation),
    el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_funcion', 'data-feedback-label': 'Función' }, el('span', null, 'Función'), baseRole)),
  el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.editar.cobertura_disponibilidad', 'data-feedback-label': 'Cobertura y disponibilidad' },
    el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_cobertura', 'data-feedback-label': 'Cobertura' }, el('span', null, 'Cobertura'), coverage),
    el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_disponibilidad', 'data-feedback-label': 'Disponibilidad' }, el('span', null, 'Disponibilidad'), availability)),
  el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_notas', 'data-feedback-label': 'Notas de disponibilidad' }, el('span', null, 'Notas de disponibilidad'), notes,
    el('span', { class: 'muted small' }, 'Sin datos de salud ni motivos personales: lo ve todo el equipo de Central.')),
  el('label', { class: 'check', 'data-feedback-id': 'central.persona.editar.campo_puesto', 'data-feedback-label': 'Puesto comprometido' }, committed, el('span', null, 'Puesto comprometido en la licitación')),
  error);
  sheet = ignoreSheetMeta(openSheet({
    title: person ? 'Editar ficha' : 'Nueva persona',
    meta: person ? `${person.code ?? ''} · revisión ${person.revision}` : undefined,
    body: form,
    panelAttrs: { 'data-feedback-id': 'central.persona.editar', 'data-feedback-label': person ? 'Editar ficha' : 'Nueva persona' },
    closeAttrs: { 'data-feedback-id': 'central.persona.editar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
    foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, person ? 'Cerrar' : 'Cancelar'), save],
    footHidden: person !== null,
    initialFocus: name,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; sheet = null; },
  }));
}

// ---------------------------------------------------------------------------
// Ficha de una persona
// ---------------------------------------------------------------------------
export function mountPerson(personId: string): ViewMount {
  return (ctx) => {
    const { main, client, navigate, admin, isAdmin, usage } = ctx;
    const membership = client.bootstrap()?.membership;
    const canEdit = membership?.role !== 'reader';
    const reserved = canSeeReserved(membership);
    let data: Awaited<ReturnType<typeof loadPeople>> = { people: [], privates: [], records: [], teams: [], personTeams: [] };
    let accounts: Account[] | null = null;
    const host = el('div', { id: 'personView', 'data-feedback-id': 'central.persona.contenido', 'data-feedback-label': 'Ficha de la persona' });
    replace(main, el('a', { href: '#/personas', class: 'backlink', 'data-feedback-id': 'central.persona.volver', 'data-feedback-label': 'Volver a Personas' }, '← Personas'), host);

    /** Clave cerrada de cada bloque de la ficha para su id de «Sugerencias y QA». */
    function block(title: string, id: string, body: (HTMLElement | null)[], action?: HTMLElement | null): HTMLElement {
      return el('section', { class: 'card personblock', id },
        el('div', { class: 'blockhead' }, el('h3', null, title), action ?? null), ...body);
    }
    const kv = (label: string, value: string | null | undefined) => (value ? el('div', { class: 'kv' }, el('dt', null, label), el('dd', null, value)) : null);

    function paint(): void {
      const person = data.people.find((p) => p.id === personId);
      if (!person) {
        replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.persona.no_encontrada', 'data-feedback-label': 'Persona no encontrada' }, el('strong', null, 'No se encontró la persona'), 'Puede que se haya borrado.'));
        return;
      }
      document.title = `${person.display_name} · Ikisai Central`;
      const today = todayInMadrid();
      const priv = data.privates.find((x) => x.person_id === personId && !x.deleted_at) ?? null;
      const records = data.records.filter((r) => r.person_id === personId && !r.deleted_at).sort((a, b) => (a.position - b.position) || a.record_type.localeCompare(b.record_type));

      const head = el('div', { class: 'pagehead', 'data-feedback-id': 'central.persona.cabecera', 'data-feedback-label': 'Cabecera de la persona' }, el('div', null,
        el('h2', { 'data-feedback-ignore': '' }, person.display_name),
        el('p', { 'data-feedback-ignore': '' }, [person.code, BASE_ROLE_LABELS[person.base_role as keyof typeof BASE_ROLE_LABELS], RELATION_LABELS[person.relation as keyof typeof RELATION_LABELS]].filter(Boolean).join(' · ')),
        el('span', { class: 'chips', 'data-feedback-id': 'central.persona.cabecera.estado', 'data-feedback-label': 'Estado de la persona' }, ...(person.active ? [] : [el('span', { class: 'chip' }, 'Inactiva')]), ...(person.deleted_at ? [el('span', { class: 'chip alert' }, 'En la papelera')] : []), ...statusChips(data.records, personId, today))));

      const basic = block('Ficha', 'blockBasic', [el('dl', { class: 'kvlist', 'data-feedback-id': 'central.persona.ficha.datos', 'data-feedback-label': 'Datos básicos' },
        kv('Relación', RELATION_LABELS[person.relation as keyof typeof RELATION_LABELS]),
        kv('Función', BASE_ROLE_LABELS[person.base_role as keyof typeof BASE_ROLE_LABELS]),
        kv('Cobertura', COVERAGE_LABELS[person.coverage as keyof typeof COVERAGE_LABELS]),
        kv('Disponibilidad', [AVAILABILITY_LABELS[person.availability as keyof typeof AVAILABILITY_LABELS], person.availability_notes].filter(Boolean).join(' · ')),
        kv('Puesto comprometido', person.committed_post ? 'Sí' : null))],
      canEdit ? el('button', { class: 'linkbtn', type: 'button', id: 'editPerson', 'data-feedback-id': 'central.persona.ficha.editar', 'data-feedback-label': 'Editar ficha', onclick: () => openPersonEditor(ctx, person) }, icon('edit', 16), 'Editar') : null);

      const privateBlock = reserved ? block('Contacto y vinculación', 'blockPrivate', priv ? [el('dl', { class: 'kvlist', 'data-feedback-id': 'central.persona.contacto.datos', 'data-feedback-label': 'Datos de contacto', 'data-feedback-ignore': '' },
        kv('Nombre completo', priv.legal_name), kv('Teléfono', priv.phone), kv('Correo', priv.email),
        kv('Vinculación', priv.engagement ? ENGAGEMENT_LABELS[priv.engagement as keyof typeof ENGAGEMENT_LABELS] : null),
        kv('Desde', day(priv.engaged_from)),
        kv('Hasta', day(priv.engaged_until)),
        kv('Contacto de emergencia', priv.emergency_contact), kv('Notas reservadas', priv.notes))]
        : [el('p', { class: 'muted' }, 'Sin datos de contacto.')],
      el('button', { class: 'linkbtn', type: 'button', id: 'editPrivate', 'data-feedback-id': 'central.persona.contacto.editar_datos', 'data-feedback-label': 'Editar contacto y vinculación', onclick: () => openPrivateEditor(person, priv) }, icon('edit', 16), priv ? 'Editar' : 'Añadir'))
        : el('p', { class: 'muted small lockednote', 'data-feedback-id': 'central.persona.reservado', 'data-feedback-label': 'Datos reservados' }, icon('lock', 14), ' Contacto, vinculación y documentación solo los ve quien tiene acceso a los datos reservados.');

      const recordsBlock = reserved ? block('Documentación y formación', 'blockRecords', [
        records.length ? el('ul', { class: 'records', id: 'recordList', 'data-feedback-id': 'central.persona.documentacion.lista', 'data-feedback-label': 'Documentación y formación' }, ...records.map((r) => {
          const state = dueState(r.expires_on, today, 30, r.status === 'no_aplica');
          const label = r.title && FREE_RECORD_TYPES.includes(r.record_type) ? r.title : RECORD_TYPE_LABELS[r.record_type] ?? r.record_type;
          return el('li', { class: 'recordrow', 'data-record': r.id, 'data-feedback-id': 'central.persona.documentacion.fila', 'data-feedback-label': 'Registro' },
            el('div', null,
              el('strong', null, label),
              el('div', { class: 'muted small' }, [r.kind === 'formacion' ? 'Formación' : 'Documento', RECORD_STATUS_LABELS[r.status as keyof typeof RECORD_STATUS_LABELS],
                r.expires_on ? `caduca el ${day(r.expires_on)}` : 'no caduca'].join(' · ')),
              el('span', { class: 'chips' },
                ...(state !== 'al_dia' ? [el('span', { class: state === 'vencido' ? 'chip alert' : 'chip warn' }, STATE_LABEL[state])] : []),
                ...(r._pending ? [el('span', { class: 'chip pending' }, 'Pendiente de sincronizar')] : []))),
            el('div', { class: 'rowactions' },
              r.file_id && typeof r.file_id === 'string' ? el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'central.persona.documentacion.archivo', 'data-feedback-label': 'Abrir archivo', onclick: () => void openFile(r) }, icon('attach', 16), 'Archivo') : null,
              r.file_id && typeof r.file_id !== 'string' ? el('span', { class: 'muted small' }, 'Archivo pendiente de subir') : null,
              el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'central.persona.documentacion.editar', 'data-feedback-label': 'Editar registro', onclick: () => openRecordEditor(person, r) }, 'Editar')));
        })) : el('p', { class: 'muted' }, 'Sin documentación ni formación registradas.')],
      el('button', { class: 'linkbtn', type: 'button', id: 'newRecord', 'data-feedback-id': 'central.persona.documentacion.anadir', 'data-feedback-label': 'Añadir', onclick: () => openRecordEditor(person, null) }, icon('plus', 16), 'Añadir')) : null;

      const mine = teamsOf(data, person.id);
      const teamsBlock = block('Equipos', 'blockTeams', [mine.length ? el('span', { class: 'chips', id: 'personTeams', 'data-feedback-id': 'central.persona.equipos.lista', 'data-feedback-label': 'Equipos de la persona' }, ...mine.map(teamChip)) : el('p', { class: 'muted' }, 'Sin equipo.')],
        reserved && !person.deleted_at ? el('button', { class: 'linkbtn', type: 'button', id: 'editTeams', 'data-feedback-id': 'central.persona.equipos.cambiar', 'data-feedback-label': 'Cambiar equipos', onclick: () => openTeamsEditor(person) }, icon('edit', 16), 'Cambiar') : null);
      const accountBlock = isAdmin ? block('Cuenta', 'blockAccount', accountBody(person, priv)) : null;

      const danger = canEdit && !person.deleted_at ? el('div', { class: 'zone', 'data-feedback-id': 'central.persona.acciones', 'data-feedback-label': 'Acciones de la persona' },
        el('button', { class: 'ghost', type: 'button', id: 'toggleActive', 'data-feedback-id': 'central.persona.acciones.activar', 'data-feedback-label': 'Marcar activa o inactiva', onclick: () => void commitSafely(client, [{ op: 'update', table: T.people, id: person.id, expectedRevision: person.revision, fields: { active: !person.active } }], person.active ? 'Marcada como inactiva.' : 'Marcada como activa.') },
          person.active ? 'Marcar inactiva' : 'Marcar activa'),
        el('button', { class: 'danger', type: 'button', id: 'deletePerson', 'data-feedback-id': 'central.persona.acciones.papelera', 'data-feedback-label': 'Enviar a papelera', onclick: () => void deletePerson(person) }, icon('trash', 18), 'Enviar a papelera')) : null;

      replace(host, head, basic, teamsBlock, privateBlock, recordsBlock, accountBlock, danger);
      fbMark(host.querySelector('#blockBasic'), 'central.persona.ficha', 'Ficha');
      fbMark(host.querySelector('#blockTeams'), 'central.persona.equipos', 'Equipos');
      fbMark(host.querySelector('#blockPrivate'), 'central.persona.contacto', 'Contacto y vinculación');
      fbMark(host.querySelector('#blockRecords'), 'central.persona.documentacion', 'Documentación y formación');
      fbMark(host.querySelector('#blockAccount'), 'central.persona.cuenta', 'Cuenta');
    }

    function accountBody(person: Person, priv: Private | null): HTMLElement[] {
      if (!person.user_id) {
        return [el('p', { class: 'muted' }, 'Sin cuenta: no entra en ninguna app.'),
          el('div', { class: 'zone', 'data-feedback-id': 'central.persona.cuenta.acciones', 'data-feedback-label': 'Acciones de la cuenta' },
            el('button', { class: 'primary', type: 'button', id: 'giveAccount', 'data-feedback-id': 'central.persona.cuenta.dar', 'data-feedback-label': 'Dar cuenta', onclick: () => void openGiveAccount(person, priv) }, icon('plus', 18), 'Dar cuenta'),
            el('button', { class: 'ghost', type: 'button', id: 'linkAccount', 'data-feedback-id': 'central.persona.cuenta.enlazar', 'data-feedback-label': 'Enlazar cuenta existente', onclick: () => void openLinkAccount(person) }, 'Enlazar cuenta existente'))];
      }
      const account = accounts?.find((a) => a.userId === person.user_id);
      return [
        account ? el('p', { 'data-feedback-ignore': '' }, el('strong', null, account.displayName || account.email || 'Cuenta'), el('span', { class: 'muted' }, ` · ${account.email ?? ''}`)) : el('p', { class: 'muted' }, accounts ? 'Cuenta enlazada (no aparece en la lista de cuentas).' : 'Cuenta enlazada. Sus accesos se ven con conexión.'),
        account ? el('span', { class: 'chips', 'data-feedback-id': 'central.persona.cuenta.accesos', 'data-feedback-label': 'Accesos de la cuenta' }, ...(account.disabled ? [el('span', { class: 'chip alert' }, 'Desactivada')] : []),
          ...account.memberships.map((m) => el('span', { class: `chip role-${m.role}` }, `${appName(m.app)} · ${ROLE_LABELS[m.role]}`))) : null,
        el('div', { class: 'zone', 'data-feedback-id': 'central.persona.cuenta.acciones', 'data-feedback-label': 'Acciones de la cuenta' },
          el('a', { class: 'ghost btnlike', href: '#/accesos', 'data-feedback-id': 'central.persona.cuenta.cambiar_accesos', 'data-feedback-label': 'Cambiar accesos en Accesos' }, 'Cambiar accesos en Accesos'),
          el('button', { class: 'ghost', type: 'button', id: 'unlinkAccount', 'data-feedback-id': 'central.persona.cuenta.desenlazar', 'data-feedback-label': 'Desenlazar cuenta', onclick: async () => {
            if (!(await confirmDialog({ title: '¿Desenlazar la cuenta?', text: 'La cuenta y sus accesos siguen igual; solo deja de estar unida a esta ficha.', confirmLabel: 'Desenlazar' }))) return;
            await commitSafely(client, [{ op: 'update', table: T.people, id: person.id, expectedRevision: person.revision, fields: { user_id: null } }], 'Cuenta desenlazada.');
          } }, 'Desenlazar')),
      ].filter(Boolean) as HTMLElement[];
    }

    function openTeamsEditor(person: Person): void {
      let sheet: Sheet | null = null;
      const current = new Map(data.personTeams.filter((x) => x.person_id === person.id && !x.deleted_at).map((x) => [x.team_id, x]));
      const boxes = data.teams.map((t) => el('input', { type: 'checkbox', value: t.id, 'data-feedback-id': 'central.persona.equipos.editar.equipo', 'data-feedback-label': 'Equipo', checked: current.has(t.id) }) as HTMLInputElement);
      const save = el('button', { class: 'primary', type: 'button', id: 'saveTeams', 'data-feedback-id': 'central.persona.equipos.editar.guardar', 'data-feedback-label': 'Guardar', onclick: async () => {
        const wanted = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
        const operations: RowOperation[] = [
          ...[...wanted].filter((id) => !current.has(id)).map((id) => ({ op: 'insert' as const, table: T.personTeams, id: crypto.randomUUID(), fields: { person_id: person.id, team_id: id } })),
          ...[...current].filter(([id]) => !wanted.has(id)).map(([, x]) => ({ op: 'delete' as const, table: T.personTeams, id: x.id, expectedRevision: x.revision })),
        ];
        if (!operations.length) { await sheet?.close(true); return; }
        if (await commitSafely(client, operations, 'Equipos guardados.')) await sheet?.close(true);
      } }, 'Guardar');
      sheet = ignoreSheetMeta(openSheet({
        title: 'Equipos', meta: person.display_name,
        panelAttrs: { 'data-feedback-id': 'central.persona.equipos.editar', 'data-feedback-label': 'Equipos de la persona' },
        closeAttrs: { 'data-feedback-id': 'central.persona.equipos.editar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
        body: el('div', { 'data-feedback-id': 'central.persona.equipos.editar.contenido', 'data-feedback-label': 'Elegir equipos' },
          data.teams.length ? el('div', { class: 'scopes', id: 'teamChoices', 'data-feedback-id': 'central.persona.equipos.editar.opciones', 'data-feedback-label': 'Equipos disponibles' }, ...boxes.map((b, i) => el('label', { class: 'check' }, b, el('span', null, data.teams[i]!.name))))
            : el('p', { class: 'muted' }, 'Todavía no hay equipos.'),
          el('a', { href: '#/personas/equipos', class: 'small', 'data-feedback-id': 'central.persona.equipos.editar.gestionar', 'data-feedback-label': 'Gestionar equipos', onclick: () => void sheet?.close(true) }, 'Gestionar equipos')),
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.equipos.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save],
      }));
    }

    async function openFile(r: PersonRecord): Promise<void> {
      if (!navigator.onLine) { toast('Abrir el archivo necesita conexión.'); return; }
      const win = window.open('', '_blank');
      try {
        const out = await client.api<{ url: string }>(`/people/records/${r.id}/file`);
        if (win) win.location.href = out.url; else location.href = out.url;
      } catch (error) {
        win?.close();
        toast(describeError(error));
      }
    }

    async function deletePerson(person: Person): Promise<void> {
      const children = [...data.privates, ...data.records].filter((c) => c.person_id === person.id && !c.deleted_at);
      const text = children.length
        ? 'También irán a la papelera sus datos reservados y su documentación. Si solo ha dejado de colaborar, mejor márcala inactiva.'
        : 'Si solo ha dejado de colaborar, mejor márcala inactiva.';
      if (!(await confirmDialog({ title: `¿Enviar a «${person.display_name}» a la papelera?`, text, confirmLabel: 'Enviar a papelera', danger: true }))) return;
      const ok = await commitSafely(client, [
        ...children.map((c) => ({ op: 'delete' as const, table: 'kind' in c ? T.personRecords : T.personPrivate, id: c.id, expectedRevision: c.revision })),
        ...data.personTeams.filter((x) => x.person_id === person.id && !x.deleted_at)
          .map((x) => ({ op: 'delete' as const, table: T.personTeams, id: x.id, expectedRevision: x.revision })),
        { op: 'delete' as const, table: T.people, id: person.id, expectedRevision: person.revision },
      ], 'Enviada a la papelera.');
      if (ok) navigate('#/personas');
    }

    function openPrivateEditor(person: Person, priv: Private | null): void {
      let sheet: Sheet | null = null;
      const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.persona.contacto.editar.error', 'data-feedback-label': 'Error del formulario' });
      const input = (id: string, value: string | null | undefined, attrs: Record<string, string> = {}) => el('input', { id, type: 'text', value: value ?? '', ...attrs }) as HTMLInputElement;
      const legal = input('pp-legal', priv?.legal_name, { maxlength: '160', 'data-feedback-ignore': '' });
      const phone = input('pp-phone', priv?.phone, { maxlength: '32', type: 'tel', 'data-feedback-ignore': '' });
      const email = input('pp-email', priv?.email, { maxlength: '320', type: 'email', 'data-feedback-ignore': '' });
      const engagement = el('select', { id: 'pp-engagement' }, ...options(ENGAGEMENTS, ENGAGEMENT_LABELS, priv?.engagement, 'Sin indicar')) as HTMLSelectElement;
      const from = input('pp-from', priv?.engaged_from, { type: 'date', 'data-feedback-id': 'central.persona.contacto.editar.desde', 'data-feedback-label': 'Desde' });
      const until = input('pp-until', priv?.engaged_until, { type: 'date', 'data-feedback-id': 'central.persona.contacto.editar.hasta', 'data-feedback-label': 'Hasta' });
      const emergency = input('pp-emergency', priv?.emergency_contact, { maxlength: '160', placeholder: 'Nombre y teléfono', 'data-feedback-ignore': '' });
      const notes = el('textarea', { id: 'pp-notes', 'data-feedback-ignore': '', rows: '3', maxlength: '1000' }) as HTMLTextAreaElement;
      notes.value = priv?.notes ?? '';
      const values = (): Record<string, unknown> => ({
        legal_name: text(legal.value), phone: text(phone.value), email: text(email.value)?.toLowerCase() ?? null, engagement: engagement.value || null,
        engaged_from: date(from.value), engaged_until: date(until.value), emergency_contact: text(emergency.value), notes: text(notes.value),
      });
      const changed = () => (priv ? Object.fromEntries(Object.entries(values()).filter(([k, v]) => (priv[k] ?? null) !== (v ?? null))) : values());
      const refresh = () => { const dirty = Object.keys(changed()).length > 0; guard.dirtyEditor = dirty; sheet?.setFootHidden(priv !== null && !dirty); };
      const save = el('button', { class: 'primary', type: 'submit', id: 'savePrivate', form: 'privateForm', 'data-feedback-id': 'central.persona.contacto.editar.guardar', 'data-feedback-label': 'Guardar' }, 'Guardar') as HTMLButtonElement;
      const form = el('form', { novalidate: true, id: 'privateForm', 'data-feedback-id': 'central.persona.contacto.editar.formulario', 'data-feedback-label': 'Formulario de contacto', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        const operations: RowOperation[] = priv
          ? [{ op: 'update', table: T.personPrivate, id: priv.id, expectedRevision: priv.revision, fields: changed() }]
          : [{ op: 'insert', table: T.personPrivate, id: crypto.randomUUID(), fields: { person_id: person.id, ...values() } }];
        const issue = validateOperations(operations, membership ?? { role: 'reader' }, () => priv ?? undefined);
        if (issue) { error.textContent = issue.message; return; }
        save.disabled = true;
        const ok = await commitSafely(client, operations, 'Datos reservados guardados.');
        save.disabled = false;
        if (ok) { guard.dirtyEditor = false; await sheet?.close(true); }
      } },
      el('p', { class: 'note', 'data-feedback-id': 'central.persona.contacto.editar.aviso', 'data-feedback-label': 'Aviso de datos reservados' }, icon('lock', 16), ' Solo lo ven quien administra Central y los editores con acceso a datos reservados.'),
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.contacto.editar.campo_nombre_completo', 'data-feedback-label': 'Nombre completo' }, el('span', null, 'Nombre completo'), legal),
      el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.contacto.editar.telefono_correo', 'data-feedback-label': 'Teléfono y correo' }, el('label', { class: 'field', 'data-feedback-id': 'central.persona.contacto.editar.campo_telefono', 'data-feedback-label': 'Teléfono' }, el('span', null, 'Teléfono'), phone), el('label', { class: 'field', 'data-feedback-id': 'central.persona.contacto.editar.campo_correo', 'data-feedback-label': 'Correo' }, el('span', null, 'Correo'), email)),
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.contacto.editar.campo_vinculacion', 'data-feedback-label': 'Vinculación' }, el('span', null, 'Vinculación'), engagement),
      el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.contacto.editar.periodo', 'data-feedback-label': 'Periodo de vinculación' }, el('label', { class: 'field' }, el('span', null, 'Desde'), from), el('label', { class: 'field' }, el('span', null, 'Hasta'), until)),
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.contacto.editar.campo_emergencia', 'data-feedback-label': 'Contacto de emergencia' }, el('span', null, 'Contacto de emergencia (opcional)'), emergency),
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.contacto.editar.campo_notas', 'data-feedback-label': 'Notas reservadas' }, el('span', null, 'Notas reservadas'), notes, el('span', { class: 'muted small' }, 'Sin datos de salud: si hace falta, va en un documento.')),
      error);
      sheet = ignoreSheetMeta(openSheet({
        title: 'Contacto y vinculación', meta: person.display_name, body: form,
        panelAttrs: { 'data-feedback-id': 'central.persona.contacto.editar', 'data-feedback-label': 'Contacto y vinculación' },
        closeAttrs: { 'data-feedback-id': 'central.persona.contacto.editar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.contacto.editar.cancelar', 'data-feedback-label': 'Cerrar', onclick: () => void sheet?.close() }, 'Cerrar'), save],
        footHidden: priv !== null, initialFocus: legal,
        beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
        onClose: () => { guard.dirtyEditor = false; sheet = null; },
      }));
    }

    function openRecordEditor(person: Person, record: PersonRecord | null): void {
      let sheet: Sheet | null = null;
      let staged: Blob | null = null;
      let stagedName = '';
      const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.persona.documentacion.editar.error', 'data-feedback-label': 'Error del formulario' });
      const kind = el('select', { id: 'r-kind' }, ...options(RECORD_KINDS, { documento: 'Documento', formacion: 'Formación' }, record?.kind ?? 'documento')) as HTMLSelectElement;
      const type = el('select', { id: 'r-type' }) as HTMLSelectElement;
      const fillTypes = () => replace(type, ...options(recordTypesFor(kind.value as RecordKind), RECORD_TYPE_LABELS, record?.kind === kind.value ? record.record_type : recordTypesFor(kind.value as RecordKind)[0]));
      fillTypes();
      const title = el('input', { id: 'r-title', type: 'text', maxlength: '120', value: record?.title ?? '' }) as HTMLInputElement;
      const titleField = el('label', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_titulo', 'data-feedback-label': 'Título' }, el('span', null, 'Título'), title);
      const status = el('select', { id: 'r-status' }, ...options(RECORD_STATUSES, RECORD_STATUS_LABELS, record?.status ?? 'pendiente')) as HTMLSelectElement;
      const issued = el('input', { id: 'r-issued', type: 'date', value: record?.issued_on ?? '' }) as HTMLInputElement;
      const expires = el('input', { id: 'r-expires', type: 'date', value: record?.expires_on ?? '' }) as HTMLInputElement;
      const reviewed = el('input', { id: 'r-reviewed', type: 'date', value: record?.reviewed_on ?? '' }) as HTMLInputElement;
      const notes = el('textarea', { id: 'r-notes', 'data-feedback-ignore': '', rows: '2', maxlength: '500' }) as HTMLTextAreaElement;
      notes.value = record?.notes ?? '';
      const fileInput = el('input', { id: 'r-file', type: 'file', accept: FILE_MIME.join(','), class: 'visually-hidden', 'data-feedback-id': 'central.persona.documentacion.editar.archivo_adjunto', 'data-feedback-label': 'Archivo adjunto' }) as HTMLInputElement;
      const fileState = el('span', { class: 'muted small', id: 'r-file-state', 'data-feedback-id': 'central.persona.documentacion.editar.estado_archivo', 'data-feedback-label': 'Estado del archivo' }, record?.file_id ? 'Tiene archivo adjunto.' : 'Sin archivo.');
      const syncTitle = () => { titleField.hidden = !FREE_RECORD_TYPES.includes(type.value); };
      syncTitle();
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (!FILE_MIME.includes(file.type)) { error.textContent = 'El archivo debe ser PDF o una imagen.'; return; }
        try {
          // Fotos a «resolución WhatsApp» (contrato §11.3); los PDF tal cual.
          staged = file.type === 'application/pdf' ? file : (await compressImage(file, { thumbSide: 0 })).full;
          stagedName = file.type === 'application/pdf' ? file.name : file.name.replace(/\.[^.]+$/, '') + (staged.type === 'image/webp' ? '.webp' : '.jpg');
          fileState.textContent = `Nuevo archivo: ${stagedName}`;
          refresh();
        } catch {
          error.textContent = 'No se pudo leer ese archivo.';
        }
      });

      const values = (): Record<string, unknown> => ({
        kind: kind.value, record_type: type.value, title: FREE_RECORD_TYPES.includes(type.value) ? text(title.value) : null, status: status.value,
        issued_on: date(issued.value), expires_on: date(expires.value), reviewed_on: date(reviewed.value), notes: text(notes.value),
      });
      const changed = () => (record ? Object.fromEntries(Object.entries(values()).filter(([k, v]) => (record[k] ?? null) !== (v ?? null))) : values());
      const refresh = () => { const dirty = Object.keys(changed()).length > 0 || staged !== null; guard.dirtyEditor = dirty; sheet?.setFootHidden(record !== null && !dirty); };
      kind.addEventListener('change', () => { fillTypes(); syncTitle(); });
      type.addEventListener('change', syncTitle);

      const save = el('button', { class: 'primary', type: 'submit', id: 'saveRecord', form: 'recordForm', 'data-feedback-id': 'central.persona.documentacion.editar.guardar', 'data-feedback-label': 'Guardar' }, 'Guardar') as HTMLButtonElement;
      const form = el('form', { novalidate: true, id: 'recordForm', 'data-feedback-id': 'central.persona.documentacion.editar.formulario', 'data-feedback-label': 'Formulario de registro', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        const id = record?.id ?? crypto.randomUUID();
        const build = (fileRef: unknown): RowOperation[] => {
          const fields = { ...changed(), ...(staged ? { file_id: fileRef } : {}) };
          return record
            ? [{ op: 'update', table: T.personRecords, id, expectedRevision: record.revision, fields }]
            : [{ op: 'insert', table: T.personRecords, id, fields: { person_id: person.id, ...fields, position: Date.now() / 1000 } }];
        };
        // Se valida antes de encolar el archivo, para no dejarlo pendiente si un dato está mal.
        const issue = validateOperations(build({ $blob: 'pendiente' }), membership ?? { role: 'reader' }, () => record ?? undefined);
        if (issue) { error.textContent = issue.message; error.scrollIntoView({ block: 'nearest' }); return; }
        save.disabled = true;
        try {
          let fileRef: unknown = null;
          if (staged) fileRef = { $blob: await client.stageBlob(staged, { filename: stagedName, mime: staged.type }) };
          const ok = await commitSafely(client, build(fileRef), record ? 'Registro guardado.' : 'Registro añadido.');
          usage.track('central.persona.documentacion.guardar', ok ? 'success' : 'error');
          if (ok) { guard.dirtyEditor = false; await sheet?.close(true); }
        } finally {
          save.disabled = false;
        }
      } },
      el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.documentacion.editar.clase_tipo', 'data-feedback-label': 'Clase y tipo' }, el('label', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_clase', 'data-feedback-label': 'Clase' }, el('span', null, 'Clase'), kind), el('label', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_tipo', 'data-feedback-label': 'Tipo' }, el('span', null, 'Tipo'), type)),
      titleField,
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_estado', 'data-feedback-label': 'Estado' }, el('span', null, 'Estado'), status),
      el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.documentacion.editar.fechas', 'data-feedback-label': 'Fechas' }, el('label', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_fecha', 'data-feedback-label': 'Fecha' }, el('span', null, 'Fecha'), issued), el('label', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_caduca', 'data-feedback-label': 'Caduca' }, el('span', null, 'Caduca'), expires)),
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_revision', 'data-feedback-label': 'Última revisión' }, el('span', null, 'Última revisión'), reviewed),
      el('div', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_archivo', 'data-feedback-label': 'Archivo' }, el('span', null, 'Archivo'), fileState,
        el('label', { class: 'ghost btnlike', for: 'r-file', 'data-feedback-id': 'central.persona.documentacion.editar.adjuntar', 'data-feedback-label': 'Adjuntar' }, icon('upload', 18), record?.file_id ? 'Sustituir archivo' : 'Adjuntar PDF o foto'), fileInput),
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.documentacion.editar.campo_notas', 'data-feedback-label': 'Notas' }, el('span', null, 'Notas'), notes),
      error,
      record ? el('div', { class: 'zone', 'data-feedback-id': 'central.persona.documentacion.editar.zona', 'data-feedback-label': 'Zona de peligro' }, el('button', { class: 'danger', type: 'button', id: 'deleteRecord', 'data-feedback-id': 'central.persona.documentacion.editar.borrar', 'data-feedback-label': 'Borrar registro', onclick: async () => {
        if (!(await confirmDialog({ title: '¿Borrar este registro?', text: 'Va a la papelera de Central.', confirmLabel: 'Borrar', danger: true }))) return;
        if (await commitSafely(client, [{ op: 'delete', table: T.personRecords, id: record.id, expectedRevision: record.revision }], 'Registro borrado.')) { guard.dirtyEditor = false; await sheet?.close(true); }
      } }, icon('trash', 18), 'Borrar registro')) : null);
      sheet = ignoreSheetMeta(openSheet({
        title: record ? 'Editar registro' : 'Nuevo registro', meta: person.display_name, body: form,
        panelAttrs: { 'data-feedback-id': 'central.persona.documentacion.editar', 'data-feedback-label': record ? 'Editar registro' : 'Nuevo registro' },
        closeAttrs: { 'data-feedback-id': 'central.persona.documentacion.editar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.documentacion.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, record ? 'Cerrar' : 'Cancelar'), save],
        footHidden: record !== null, initialFocus: kind,
        beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
        onClose: () => { guard.dirtyEditor = false; sheet = null; },
      }));
    }

    async function openGiveAccount(person: Person, priv: Private | null): Promise<void> {
      if (!navigator.onLine) { toast('Dar cuenta necesita conexión.'); return; }
      let catalog;
      try { catalog = await admin.catalog(); } catch (e) { toast(describeError(e)); return; }
      let sheet: Sheet | null = null;
      const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.persona.cuenta.dar.error', 'data-feedback-label': 'Error del formulario' });
      const email = el('input', { id: 'ga-email', 'data-feedback-ignore': '', type: 'email', maxlength: '320', value: priv?.email ?? '' }) as HTMLInputElement;
      const selects = new Map<string, HTMLSelectElement>();
      const rows = catalog.map((app) => {
        const s = el('select', { id: `ga-${app.id}`, 'aria-label': `Acceso a ${app.name}` }, el('option', { value: '' }, 'Sin acceso'),
          ...(['reader', 'editor', 'owner'] as Role[]).map((r) => el('option', { value: r }, ROLE_LABELS[r]))) as HTMLSelectElement;
        selects.set(app.id, s);
        fbMark(s, 'central.persona.cuenta.dar.rol', 'Acceso a una app').setAttribute('data-feedback-label', `Acceso a ${app.name.replace(/^Ikisai /, '')}`);
        return el('label', { class: 'approw', 'data-feedback-id': 'central.persona.cuenta.dar.app', 'data-feedback-label': 'Acceso a una app' }, el('span', { class: 'appname' }, el('strong', null, app.name.replace(/^Ikisai /, ''))), s);
      });
      const submit = el('button', { class: 'primary', type: 'submit', form: 'giveForm', id: 'giveSubmit', 'data-feedback-id': 'central.persona.cuenta.dar.enviar', 'data-feedback-label': 'Dar cuenta' }, 'Dar cuenta') as HTMLButtonElement;
      const form = el('form', { novalidate: true, id: 'giveForm', 'data-feedback-id': 'central.persona.cuenta.dar.formulario', 'data-feedback-label': 'Formulario de cuenta', onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        const mail = email.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { error.textContent = 'Escribe un correo válido.'; return; }
        const memberships = [...selects].filter(([, s]) => s.value).map(([app, s]) => ({ app, role: s.value as Role }));
        if (!memberships.length) { error.textContent = 'Elige al menos una app.'; return; }
        submit.disabled = true;
        try {
          const out = await usage.run('central.persona.cuenta.dar', () => admin.invite({ email: mail, displayName: person.display_name, memberships }));
          const fresh = data.people.find((p) => p.id === person.id) ?? person;
          await client.commit([{ op: 'update', table: T.people, id: person.id, expectedRevision: fresh.revision, fields: { user_id: out.userId } }]);
          await sheet?.close(true);
          accounts = null;
          if (out.temporaryPassword) showSecret(out.temporaryPassword, out.email);
          else toast('Ya tenía cuenta con ese correo: se han añadido los accesos y queda enlazada.');
          void loadAccounts();
        } catch (e) {
          error.textContent = describeError(e);
        } finally {
          submit.disabled = false;
        }
      } },
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.cuenta.dar.campo_correo', 'data-feedback-label': 'Correo de la cuenta' }, el('span', null, 'Correo de la cuenta'), email),
      el('div', { class: 'sectionlabel', 'data-feedback-id': 'central.persona.cuenta.dar.accesos_iniciales', 'data-feedback-label': 'Accesos iniciales' }, 'Accesos iniciales'), ...rows, error);
      sheet = ignoreSheetMeta(openSheet({
        title: 'Dar cuenta', meta: person.display_name, body: form,
        panelAttrs: { 'data-feedback-id': 'central.persona.cuenta.dar', 'data-feedback-label': 'Dar cuenta' },
        closeAttrs: { 'data-feedback-id': 'central.persona.cuenta.dar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.cuenta.dar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), submit],
        initialFocus: email,
      }));
    }

    async function openLinkAccount(person: Person): Promise<void> {
      await loadAccounts();
      if (!accounts) { toast('Enlazar una cuenta necesita conexión.'); return; }
      const linked = new Set(data.people.filter((p) => !p.deleted_at && p.user_id).map((p) => p.user_id));
      const free = accounts.filter((a) => a.kind !== 'agent' && !linked.has(a.userId));
      if (!free.length) { toast('No hay cuentas sin enlazar. Usa «Dar cuenta».'); return; }
      let sheet: Sheet | null = null;
      const select = el('select', { id: 'la-account', 'data-feedback-ignore': '' }, ...free.map((a) => el('option', { value: a.userId }, `${a.displayName || a.email} · ${a.email ?? ''}`))) as HTMLSelectElement;
      const submit = el('button', { class: 'primary', type: 'button', id: 'linkSubmit', 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja.enviar', 'data-feedback-label': 'Enlazar', onclick: async () => {
        const fresh = data.people.find((p) => p.id === person.id) ?? person;
        if (await commitSafely(client, [{ op: 'update', table: T.people, id: person.id, expectedRevision: fresh.revision, fields: { user_id: select.value } }], 'Cuenta enlazada.')) await sheet?.close(true);
      } }, 'Enlazar');
      sheet = ignoreSheetMeta(openSheet({ title: 'Enlazar cuenta existente', meta: person.display_name, body: el('label', { class: 'field', 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja.campo_cuenta', 'data-feedback-label': 'Cuenta' }, el('span', null, 'Cuenta'), select),
        panelAttrs: { 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja', 'data-feedback-label': 'Enlazar cuenta existente' },
        closeAttrs: { 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja.cerrar', 'data-feedback-label': 'Cerrar' },
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), submit] }));
    }

    const appName = (id: string) => admin.cached.catalog?.find((a) => a.id === id)?.name.replace(/^Ikisai /, '') ?? id;

    async function loadAccounts(): Promise<void> {
      if (!isAdmin) return;
      try { [accounts] = await Promise.all([admin.accounts(), admin.catalog()]); } catch { accounts = admin.cached.accounts?.items ?? null; }
      paint();
    }

    async function load(): Promise<void> {
      data = await loadPeople(client);
      paint();
    }

    void load().then(() => loadAccounts());
    const offs = [T.people, T.personPrivate, T.personRecords, T.teams, T.personTeams].map((t) => client.onTable(t, () => void load()));
    return () => offs.forEach((off) => off());
  };
}
