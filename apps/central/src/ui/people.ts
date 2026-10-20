import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  compressImage, confirmDialog, createSortableList, el, icon, openSheet, positionBetween, renderMedal, replace, toast, type Sheet,
} from '@ikisai/ui-kit';
import {
  AVAILABILITIES, AVAILABILITY_LABELS, BASE_ROLES, BASE_ROLE_LABELS, COVERAGES, COVERAGE_LABELS, ENGAGEMENTS, ENGAGEMENT_LABELS,
  FREE_RECORD_TYPES, RECORD_KINDS, RECORD_STATUSES, RECORD_STATUS_LABELS, RECORD_TYPE_LABELS, RELATIONS, RELATION_LABELS,
  DIRECTION_BASE_ROLES, HOUSE_LEVELS, HOUSE_LEVEL_LABELS, OUTSIDER_ACCESS_TEXT, proposeHouseLevel, relationForLevel, type HouseGrant, type HouseLevel,
  canSeeReserved, dueState, personStatus, recordTypesFor, todayInMadrid, validateOperations, type RecordKind,
} from '@ikisai/domain-central';
import { guard } from '../app/guard.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import { grantFor, ROLE_LABELS, type Account, type Role } from '../app/admin.ts';
import { showSecret } from './access.ts';
import { syncAccountName } from '../app/account-names.ts';
import { checkExistingAccount, mergePeople } from './account-conflict.ts';
import type { ViewContext, ViewMount } from './shell.ts';
import { fbIgnoreWithin, fbMark } from './feedback.ts';
import { createLevelStar } from '@ikisai/ui-kit';
import { TRADE_LEVEL_LABELS } from '@ikisai/domain-central';
import { effectiveLevels, inheritedLevel, levelLabel as tradeLevelLabel, levelStar, loadTrades, markLevelStar, tradeTree, tradeWithDescendants, type PersonTrade, type Trade } from './trades.ts';

type Base = { id: string; revision: number; updated_at: string; deleted_at: string | null };
export type Person = Mirror<Base & {
  code: string; display_name: string; relation: string; base_role: string; coverage: string; availability: string;
  availability_notes: string | null; active: boolean; committed_post: boolean; user_id: string | null; position: number;
  house_level: HouseLevel | null; merged_into?: string | null; initials?: string | null;
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

/**
 * Interruptor de la fase P1 (RECURSOS.md §17.5): mientras ninguna persona tenga nivel de casa, Personas se ve como antes
 * (Relación, Función, Cobertura). Al aplicar la vista previa del nivel, pasa a «Nivel de casa» y «Área principal». Vaciar los
 * niveles vuelve atrás sin perder nada: `relation` y `coverage` se conservan.
 */
let houseLevelsOn = false;
const levelLabel = (level: string | null | undefined) => (level ? HOUSE_LEVEL_LABELS[level as HouseLevel] ?? level : 'Sin nivel');
const areaLabel = (role: string) => BASE_ROLE_LABELS[role as keyof typeof BASE_ROLE_LABELS] ?? role;

async function loadPeople(client: SyncClient): Promise<{ people: Person[]; privates: Private[]; records: PersonRecord[]; teams: Team[]; personTeams: PersonTeam[]; trades: Trade[]; capabilities: PersonTrade[] }> {
  const reserved = canSeeReserved(client.bootstrap()?.membership);
  const [people, privates, records, teams, personTeams] = await Promise.all([
    client.list(T.people, { includeDeleted: true }),
    reserved ? client.list(T.personPrivate, { includeDeleted: true }) : Promise.resolve([]),
    reserved ? client.list(T.personRecords, { includeDeleted: true }) : Promise.resolve([]),
    client.list(T.teams),
    client.list(T.personTeams, { includeDeleted: true }),
  ]);
  houseLevelsOn = (people as unknown as Person[]).some((p) => !p.deleted_at && p.house_level);
  const { trades, capabilities } = await loadTrades(client);
  return {
    trades, capabilities,
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
// Lista de personas · Directorio de caras (Bloque 2, MUELA-085; §1 y §2 de PERDIDAS_central_bloque2)
// ---------------------------------------------------------------------------
/** Lo peor de la documentación de una persona (solo para quien ve los datos reservados): anillo y «Requiere atención». */
type DocTone = 'alert' | 'warn' | 'ok' | null;
function docTone(records: PersonRecord[], personId: string, today: string): { tone: DocTone; text: string | null } {
  const mine = records.filter((r) => r.person_id === personId && !r.deleted_at);
  if (!mine.length) return { tone: null, text: null };
  const s = personStatus(mine, today);
  if (s.documents === 'caducado' || s.training === 'caducado') return { tone: 'alert', text: 'Documentación caducada' };
  const soon = mine.filter((r) => dueState(r.expires_on, today, 30, r.status === 'no_aplica') === 'por_vencer').sort((a, b) => (a.expires_on ?? '').localeCompare(b.expires_on ?? ''));
  if (soon.length) return { tone: 'warn', text: `Caduca el ${day(soon[0]!.expires_on)}: ${soon[0]!.title || RECORD_TYPE_LABELS[soon[0]!.record_type as keyof typeof RECORD_TYPE_LABELS] || soon[0]!.record_type}` };
  if (s.documents === 'pendiente' || s.training === 'pendiente') return { tone: null, text: 'Documentación pendiente' };
  return { tone: 'ok', text: null };
}

export const mountPeople: ViewMount = (ctx) => {
  const { main, client, navigate } = ctx;
  const role = client.bootstrap()?.membership.role ?? 'reader';
  const canEdit = role !== 'reader';
  // Datos reservados (§2): quien no los ve no tiene anillos ni «Requiere atención»; la app ni los descarga.
  const reserved = canSeeReserved(client.bootstrap()?.membership);
  let data: Awaited<ReturnType<typeof loadPeople>> = { people: [], privates: [], records: [], teams: [], personTeams: [], trades: [], capabilities: [] };
  let query = '';
  let relation = '';
  let level = '';
  let trade = '';
  let team = '';
  let showInactive = false;
  let filtersOpen = false;
  // Fase O4: lo que el nivel de casa ha dado a cada cuenta (solo dirección y con red), para las chips de los outsiders.
  let grants: HouseGrant[] = ctx.isAdmin ? ctx.admin.cached.grants ?? [] : [];
  const appName = (id: string) => ctx.admin.cached.catalog?.find((a) => a.id === id)?.name.replace(/^Ikisai /, '') ?? id;

  const host = el('div', { id: 'peopleList', 'data-feedback-id': 'central.personas.lista', 'data-feedback-label': 'Directorio de personas' });
  const attention = el('section', { id: 'peopleAttention', 'aria-label': 'Requiere atención', 'data-feedback-id': 'central.personas.atencion', 'data-feedback-label': 'Requiere atención' });
  const trashList = el('ul', { class: 'list', 'aria-label': 'Personas en la papelera', 'data-feedback-id': 'central.personas.papelera.lista', 'data-feedback-label': 'Personas en la papelera' });
  const trashLabel = el('summary', { class: 'sectionlabel ctl-trashhead', 'data-feedback-id': 'central.personas.papelera.cabecera', 'data-feedback-label': 'Papelera de personas' }, 'Papelera ', el('span', { class: 'count' }, '0'));
  const trash = el('details', { id: 'peopleTrash', 'data-feedback-id': 'central.personas.papelera', 'data-feedback-label': 'Papelera', hidden: true }, trashLabel, trashList);
  const search = el('input', { type: 'search', id: 'peopleSearch', 'data-feedback-id': 'central.personas.buscar', 'data-feedback-label': 'Buscar persona', placeholder: 'Buscar por nombre', 'aria-label': 'Buscar persona',
    oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); paint(); } });
  const relationFilter = el('select', { id: 'peopleRelation', 'aria-label': 'Relación', 'data-feedback-id': 'central.personas.filtro_relacion', 'data-feedback-label': 'Filtro por relación', onchange: (e: Event) => { relation = (e.target as HTMLSelectElement).value; paint(); } },
    ...options(RELATIONS, RELATION_LABELS, '', 'Todas las relaciones'));
  // Nivel de casa en chips (085); «Sin nivel», solo para dirección.
  const levelChips = el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'Nivel de casa', id: 'peopleLevels', hidden: true });
  // Oficio (P1): filtra por un oficio y todo lo que cuelga de él. Sin oficios, no se ve (la pantalla queda como antes).
  const tradeFilter = el('select', { id: 'peopleTrade', 'aria-label': 'Oficio', hidden: true, 'data-feedback-id': 'central.personas.filtro_oficio', 'data-feedback-label': 'Filtro por oficio', onchange: (e: Event) => { trade = (e.target as HTMLSelectElement).value; paint(); } },
    el('option', { value: '' }, 'Todos los oficios')) as HTMLSelectElement;
  // Solo antes de aplicar el nivel por primera vez: la vista previa para dirección.
  const levelsNote = el('div', { 'data-feedback-id': 'central.personas.aviso_nivel', 'data-feedback-label': 'Aviso del nivel de casa' });
  // Equipo, dentro de «Filtros» (se conserva: cruza equipo con oficio y nivel, que el tablero no hace).
  const teamFilter = el('select', { id: 'peopleTeam', 'aria-label': 'Equipo', 'data-feedback-id': 'central.personas.filtro_equipo', 'data-feedback-label': 'Filtro por equipo', onchange: (e: Event) => { team = (e.target as HTMLSelectElement).value; paint(); } },
    el('option', { value: '' }, 'Todos los equipos')) as HTMLSelectElement;
  const fabLabel = el('span', null, 'Nueva persona');
  const inactive = el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'peopleInactive', 'data-feedback-id': 'central.personas.mostrar_inactivas', 'data-feedback-label': 'Mostrar inactivas', onchange: (e: Event) => { showInactive = (e.target as HTMLInputElement).checked; paint(); } }), el('span', null, 'Mostrar inactivas'));
  const filtersPanel = el('div', { class: 'ctl-filters', id: 'peopleFilters', hidden: true, 'data-feedback-id': 'central.personas.filtros', 'data-feedback-label': 'Filtros' }, relationFilter, tradeFilter, teamFilter, inactive);
  const filtersToggle = el('button', { type: 'button', class: 'ghost', id: 'peopleFiltersToggle', 'aria-expanded': 'false', 'aria-controls': 'peopleFilters', 'data-feedback-id': 'central.personas.filtros_abrir', 'data-feedback-label': 'Abrir los filtros',
    onclick: () => { filtersOpen = !filtersOpen; filtersPanel.hidden = !filtersOpen; filtersToggle.setAttribute('aria-expanded', String(filtersOpen)); } }, icon('filter', 16), el('span', { class: 'ctl-filtercount' }, 'Filtros'));
  const orderBtn = canEdit ? el('button', { type: 'button', class: 'ghost', id: 'peopleOrder', 'data-feedback-id': 'central.personas.ordenar', 'data-feedback-label': 'Ordenar personas', onclick: () => openOrder() }, icon('grip', 16), 'Ordenar') : null;

  replace(
    main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.personas.cabecera', 'data-feedback-label': 'Cabecera de Personas' }, el('div', null, el('h2', null, 'Personas'),
      el('p', null, 'Quién trabaja o colabora con Ikisai, tenga o no cuenta en las apps.'))),
    el('div', { class: 'ctl-searchrow', 'data-feedback-id': 'central.personas.barra', 'data-feedback-label': 'Búsqueda y filtros' }, search, filtersToggle),
    levelChips,
    filtersPanel,
    el('div', { class: 'toolbar' },
      el('a', { class: 'ghost btnlike', href: '#/personas/equipos', id: 'manageTeams', 'data-feedback-id': 'central.personas.equipos', 'data-feedback-label': 'Equipos' }, icon('people', 16), 'Equipos'),
      el('a', { class: 'ghost btnlike', href: '#/personas/oficios', id: 'manageTrades', 'data-feedback-id': 'central.personas.oficios', 'data-feedback-label': 'Oficios' }, icon('tag', 16), 'Oficios'),
      orderBtn),
    levelsNote,
    attention,
    host,
    trash,
    canEdit ? el('button', { class: 'fab', type: 'button', id: 'newPerson', 'data-feedback-id': 'central.personas.nueva', 'data-feedback-label': 'Nueva persona',
      // Con el filtro «Outsider», la ficha nueva nace con ese nivel (O4, uno menos).
      onclick: () => openPersonEditor(ctx, null, (id) => navigate(`#/personas/${id}`), { level: houseLevelsOn && level === 'outsider' ? 'outsider' : undefined }) }, icon('plus'), fabLabel) : null,
  );

  /** Hasta tres oficios de la persona, los de más nivel, con su estrella. */
  function topTrades(personId: string): HTMLElement[] {
    const names = new Map(data.trades.filter((t) => !t.deleted_at && t.active).map((t) => [t.id, t.name]));
    return data.capabilities.filter((c) => c.person_id === personId && names.has(c.trade_id))
      .sort((a, b) => (b.level - a.level) || names.get(a.trade_id)!.localeCompare(names.get(b.trade_id)!, 'es')).slice(0, 3)
      .map((c) => el('span', { class: 'chip tradechip' }, levelStar(c.level), names.get(c.trade_id)!));
  }

  /** Outsider (O4): en qué apps entra por su nivel, o el aviso de que sin cuenta no entra en ninguna. */
  function outsiderChips(p: Person): HTMLElement[] {
    if (!houseLevelsOn || p.house_level !== 'outsider') return [];
    if (!p.user_id) return [el('span', { class: 'chip warn', 'data-issue': 'sin_cuenta' }, 'Sin cuenta: no entra en ninguna app')];
    return grants.filter((g) => g.userId === p.user_id).map((g) => el('span', { class: `chip role-${g.role} derived`, 'data-derived': '', title: 'Lo da el nivel de casa' },
      `${appName(g.app)} · ${ROLE_LABELS[g.role as Role] ?? g.role}`));
  }

  /** La cara de una persona: medallón de 72 (anillo según la documentación, solo con permiso), nombre, área y nivel, y sus chips. */
  function row(p: Person): HTMLElement {
    const today = todayInMadrid();
    const doc = reserved ? docTone(data.records, p.id, today) : { tone: null, text: null };
    const chips = [
      ...outsiderChips(p),
      ...(p.active ? [] : [el('span', { class: 'chip' }, 'Inactiva')]),
      ...(p.committed_post ? [el('span', { class: 'chip' }, 'Puesto comprometido')]: []),
      ...teamsOf(data, p.id).map(teamChip),
      ...topTrades(p.id),
      ...statusChips(data.records, p.id, today),
      ...(p._pending ? [el('span', { class: 'chip pending' }, 'Pendiente de sincronizar')] : []),
    ];
    return el('button', { class: `personrow ctl-personface${p.active ? '' : ' inactive'}`, type: 'button', 'data-person': p.id, dataset: { ring: doc.tone ?? 'none' }, 'data-feedback-id': 'central.personas.lista.fila', 'data-feedback-label': 'Persona', onclick: () => navigate(`#/personas/${p.id}`) },
      el('span', { class: 'ctl-ring' }, renderMedal({ name: p.display_name, initials: p.initials ?? null, size: 72 })),
      el('span', { class: 'accountname', 'data-feedback-ignore': '' }, p.display_name, p.user_id ? el('span', { class: 'muted', title: 'Tiene cuenta' }, ' ', icon('user', 14)) : null),
      el('span', { class: 'muted accountmeta', 'data-feedback-id': 'central.personas.lista.funcion', 'data-feedback-label': 'Función y relación' }, houseLevelsOn
        ? `${areaLabel(p.base_role)} · ${levelLabel(p.house_level)}`
        : `${BASE_ROLE_LABELS[p.base_role as keyof typeof BASE_ROLE_LABELS] ?? p.base_role} · ${RELATION_LABELS[p.relation as keyof typeof RELATION_LABELS] ?? p.relation}`),
      !p.user_id && !(houseLevelsOn && p.house_level === 'outsider') ? el('span', { class: 'muted small' }, 'Sin cuenta') : null,
      chips.length ? el('span', { class: 'chips', 'data-feedback-id': 'central.personas.lista.etiquetas', 'data-feedback-label': 'Estado de la persona' }, ...chips) : null);
  }

  /** «Requiere atención»: quien tiene algo caducado o por caducar, lo peor primero. Solo con permiso de datos reservados. */
  function paintAttention(alive: Person[]): void {
    if (!reserved) { replace(attention); return; }
    const today = todayInMadrid();
    const list = alive.filter((p) => p.active).map((p) => ({ p, doc: docTone(data.records, p.id, today) }))
      .filter((x) => x.doc.tone === 'alert' || x.doc.tone === 'warn')
      .sort((a, b) => (a.doc.tone === b.doc.tone ? a.p.display_name.localeCompare(b.p.display_name, 'es') : a.doc.tone === 'alert' ? -1 : 1));
    replace(attention, list.length ? [
      el('h3', { class: 'sectionlabel' }, `Requiere atención · ${list.length}`),
      el('ul', { class: 'list ctl-attention' }, ...list.map(({ p, doc }) => el('li', null,
        el('button', { type: 'button', class: `ctl-attrow ${doc.tone}`, 'data-person': p.id, 'data-feedback-id': 'central.personas.atencion.fila', 'data-feedback-label': 'Persona que requiere atención', onclick: () => navigate(`#/personas/${p.id}`) },
          renderMedal({ name: p.display_name, initials: p.initials ?? null, size: 40 }),
          el('span', null, el('strong', { 'data-feedback-ignore': '' }, p.display_name), el('span', { class: 'ctl-attwhy' }, doc.text)))))),
    ] : []);
  }

  /** Aviso para dirección, solo hasta aplicar el nivel por primera vez: «N personas sin nivel de casa · Revisar propuesta». */
  function paintLevelsNote(alive: Person[]): void {
    if (houseLevelsOn || !ctx.isAdmin || !alive.length) { replace(levelsNote); return; }
    replace(levelsNote, el('p', { class: 'note', id: 'levelsNote' }, `Nivel de casa: ${alive.length === 1 ? '1 persona no lo tiene' : `${alive.length} personas no lo tienen`}. `,
      el('button', { class: 'linkbtn', type: 'button', id: 'reviewLevels', 'data-feedback-id': 'central.personas.revisar_nivel', 'data-feedback-label': 'Revisar la propuesta de nivel', onclick: () => openLevelsPreview(alive) }, 'Revisar propuesta')));
  }

  /** Vista previa editable del nivel de casa (aprobada por el usuario): una fila por persona, con el nivel propuesto. */
  function openLevelsPreview(alive: Person[]): void {
    let sheet: Sheet | null = null;
    const error = el('p', { class: 'formerror', role: 'alert', 'data-feedback-id': 'central.personas.nivel.error', 'data-feedback-label': 'Error del nivel de casa' });
    const rows = alive.map((p) => {
      const select = el('select', { id: `lv-${p.id}`, 'aria-label': `Nivel de casa de ${p.display_name}`, 'data-person': p.id },
        ...options(HOUSE_LEVELS, HOUSE_LEVEL_LABELS, proposeHouseLevel(p), 'Sin nivel (fuera del directorio)')) as HTMLSelectElement;
      return { p, select, node: el('div', { class: 'approw', 'data-feedback-id': 'central.personas.nivel.fila', 'data-feedback-label': 'Nivel de una persona' },
        el('span', { class: 'appname' }, el('strong', { 'data-feedback-ignore': '' }, p.display_name),
          el('span', { class: 'muted small' }, `${BASE_ROLE_LABELS[p.base_role as keyof typeof BASE_ROLE_LABELS] ?? p.base_role} · ${RELATION_LABELS[p.relation as keyof typeof RELATION_LABELS] ?? p.relation}${p.active ? '' : ' · inactiva'}`)),
        select) };
    });
    const apply = el('button', { class: 'primary', type: 'button', id: 'applyLevels', 'data-feedback-id': 'central.personas.nivel.aplicar', 'data-feedback-label': 'Aplicar el nivel de casa', onclick: async () => {
      error.textContent = '';
      const operations: RowOperation[] = rows.filter((r) => r.select.value).map((r) => ({ op: 'update', table: T.people, id: r.p.id, expectedRevision: r.p.revision, fields: { house_level: r.select.value } }));
      if (!operations.length) { error.textContent = 'Elige el nivel de al menos una persona.'; return; }
      apply.disabled = true;
      const ok = await commitSafely(client, operations, 'Nivel de casa aplicado.');
      apply.disabled = false;
      if (ok) await sheet?.close(true);
    } }, 'Aplicar') as HTMLButtonElement;
    sheet = openSheet({
      title: 'Nivel de casa',
      body: el('div', { id: 'levelsPreview', 'data-feedback-id': 'central.personas.nivel.contenido', 'data-feedback-label': 'Propuesta de nivel de casa' },
        el('p', { class: 'muted' }, 'Propuesta por su función y su relación con Ikisai. Cámbiala donde haga falta. Quien quede sin nivel sale del directorio (lo sigues viendo con el filtro «Sin nivel»). Relación y cobertura se conservan.'),
        ...rows.map((r) => r.node), error),
      panelAttrs: { 'data-feedback-id': 'central.personas.nivel', 'data-feedback-label': 'Nivel de casa' },
      closeAttrs: { 'data-feedback-id': 'central.personas.nivel.cerrar', 'data-feedback-label': 'Cerrar' },
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.personas.nivel.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), apply],
    });
  }

  /** «Ordenar» (se conserva el orden manual): la lista reordenable del kit, con todas las personas vivas. */
  function openOrder(): void {
    const alive = data.people.filter((p) => !p.deleted_at).sort((a, b) => (a.position - b.position) || a.display_name.localeCompare(b.display_name, 'es'));
    const sortable = createSortableList<Person>({
      items: alive, key: (p) => p.id, render: (p) => el('span', { 'data-feedback-ignore': '' }, p.display_name), name: (p) => p.display_name, label: 'Personas', id: 'peopleSortable',
      onReorder: async (items, move) => {
        const prev = items[move.to - 1]?.position ?? null;
        const next = items[move.to + 1]?.position ?? null;
        const position = positionBetween(prev, next);
        await commitSafely(client, [{ op: 'update', table: T.people, id: move.item.id, expectedRevision: move.item.revision, fields: { position } }], 'Orden guardado.');
        await load();
      },
    });
    openSheet({
      title: 'Ordenar personas',
      body: el('div', null, el('p', { class: 'muted small' }, 'Arrastra o usa las flechas para ordenar.'), fbMark(sortable.element, 'central.personas.lista.ordenable', 'Personas ordenables')),
      panelAttrs: { 'data-feedback-id': 'central.personas.orden', 'data-feedback-label': 'Ordenar personas' },
      closeAttrs: { 'data-feedback-id': 'central.personas.orden.cerrar', 'data-feedback-label': 'Cerrar' },
    });
  }

  function paintLevels(alive: Person[]): void {
    levelChips.hidden = !houseLevelsOn;
    if (!houseLevelsOn) { replace(levelChips); return; }
    const chip = (value: string, label: string, n: number) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(level === value), dataset: { level: value || 'todos' }, 'data-feedback-id': 'central.personas.filtro_nivel', 'data-feedback-label': 'Filtro por nivel de casa',
      onclick: () => { level = level === value ? '' : value; paint(); } }, `${label} (${n})`);
    const shown = alive.filter((p) => showInactive || p.active);
    replace(levelChips,
      chip('', 'Todos', shown.filter((p) => !!p.house_level).length),
      ...HOUSE_LEVELS.map((l) => chip(l, HOUSE_LEVEL_LABELS[l], shown.filter((p) => p.house_level === l).length)),
      ...(ctx.isAdmin ? [chip('sin_nivel', 'Sin nivel', shown.filter((p) => !p.house_level).length)] : []));
  }

  function paint(): void {
    const alive = data.people.filter((p) => !p.deleted_at).sort((a, b) => (a.position - b.position) || a.display_name.localeCompare(b.display_name, 'es'));
    const inTeam = team ? new Set(data.personTeams.filter((x) => x.team_id === team && !x.deleted_at).map((x) => x.person_id)) : null;
    relationFilter.hidden = houseLevelsOn;
    fabLabel.textContent = houseLevelsOn && level === 'outsider' ? 'Nuevo outsider' : 'Nueva persona';
    // Con el nivel activo, el directorio es de quien tiene nivel; «Sin nivel», solo para dirección.
    const byLevel = (p: Person) => !houseLevelsOn ? (!relation || p.relation === relation)
      : level === 'sin_nivel' ? !p.house_level : !!p.house_level && (!level || p.house_level === level);
    const tree = tradeTree(data.trades);
    tradeFilter.hidden = !tree.length;
    if (tradeFilter.options.length !== tree.length + 1) {
      replace(tradeFilter, el('option', { value: '' }, 'Todos los oficios'), ...tree.map((x) => el('option', { value: x.trade.id, selected: x.trade.id === trade }, `${'· '.repeat(x.depth)}${x.trade.name}`)));
    }
    // El oficio y lo que cuelga de él, más quien lo sabe por un antepasado (1510).
    const knows = trade ? new Set([...data.capabilities.filter((c) => tradeWithDescendants(data.trades, trade).has(c.trade_id)).map((c) => c.person_id),
      ...[...effectiveLevels(data.trades, data.capabilities)].filter(([, m]) => m.has(trade)).map(([p]) => p)]) : null;
    const filtered = alive.filter((p) => (showInactive || p.active) && byLevel(p) && (!knows || knows.has(p.id)) && (!inTeam || inTeam.has(p.id)) && (!query || p.display_name.toLowerCase().includes(query)));
    paintLevelsNote(alive);
    paintLevels(alive);
    paintAttention(alive);
    if (teamFilter.options.length !== data.teams.length + 1) {
      replace(teamFilter, el('option', { value: '' }, 'Todos los equipos'), ...data.teams.map((t) => el('option', { value: t.id, selected: t.id === team }, t.name)));
    }
    // Cuántos filtros de «Filtros» hay puestos, en su botón.
    const active = [relation && !houseLevelsOn, trade, team, showInactive].filter(Boolean).length;
    filtersToggle.querySelector('.ctl-filtercount')!.textContent = active ? `Filtros (${active})` : 'Filtros';
    if (!filtered.length) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.personas.vacio', 'data-feedback-label': 'Sin personas' },
        el('strong', null, alive.length ? 'Ninguna persona coincide' : 'Todavía no hay personas'),
        alive.length ? 'Cambia el filtro o la búsqueda.' : canEdit ? 'Añade a quien trabaja o colabora con Ikisai: con o sin cuenta.' : ''));
    } else {
      replace(host, el('ul', { class: 'ctl-directory', 'aria-label': 'Personas', 'data-feedback-id': 'central.personas.lista.filas', 'data-feedback-label': 'Personas' }, ...filtered.map((p) => el('li', null, row(p)))));
    }
    const deleted = data.people.filter((p) => p.deleted_at);
    trash.hidden = deleted.length === 0 || !canEdit;
    trashLabel.querySelector('.count')!.textContent = String(deleted.length);
    replace(trashList, ...deleted.map((p) => el('li', { class: 'agentrow ctl-trashrow', 'data-feedback-id': 'central.personas.papelera.fila', 'data-feedback-label': 'Persona en la papelera' }, el('span', { 'data-feedback-ignore': '' }, p.display_name),
      el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'central.personas.papelera.restaurar', 'data-feedback-label': 'Restaurar', onclick: () => void restorePerson(client, data, p).then(load) }, icon('restore', 18), 'Restaurar'))));
  }

  async function load(): Promise<void> {
    data = await loadPeople(client);
    paint();
  }

  void load();
  if (ctx.isAdmin && navigator.onLine) {
    void Promise.all([ctx.admin.houseGrants(), ctx.admin.catalog()]).then(([items]) => { grants = items; paint(); }).catch(() => undefined);
  }
  const offs = [T.people, T.personPrivate, T.personRecords, T.teams, T.personTeams, T.trades, T.personTrades].map((t) => client.onTable(t, () => void load()));
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
function openPersonEditor(ctx: ViewContext, person: Person | null, onCreated?: (id: string) => void, defaults: { level?: HouseLevel } = {}): void {
  const { client } = ctx;
  let sheet: Sheet | null = null;
  const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.persona.editar.error', 'data-feedback-label': 'Error del formulario' });
  const name = el('input', { id: 'p-name', 'data-feedback-ignore': '', type: 'text', maxlength: '80', required: true, value: person?.display_name ?? '' }) as HTMLInputElement;
  const initials = el('input', { id: 'p-initials', 'data-feedback-ignore': '', type: 'text', maxlength: '4', autocomplete: 'off', value: person?.initials ?? '' }) as HTMLInputElement;
  const relation = el('select', { id: 'p-relation' }, ...options(RELATIONS, RELATION_LABELS, person?.relation ?? 'equipo')) as HTMLSelectElement;
  const levelsOn = houseLevelsOn;
  // «Área principal» sin las funciones de dirección (las sustituye el nivel), salvo la que ya tenga la ficha.
  const areas = levelsOn ? BASE_ROLES.filter((r) => !DIRECTION_BASE_ROLES.includes(r) || r === person?.base_role) : BASE_ROLES;
  const baseRole = el('select', { id: 'p-role' }, ...options(areas, BASE_ROLE_LABELS, person?.base_role ?? 'otro')) as HTMLSelectElement;
  const houseLevel = el('select', { id: 'p-level' }, ...options(HOUSE_LEVELS, HOUSE_LEVEL_LABELS, person ? person.house_level : defaults.level ?? 'staff', 'Sin nivel (fuera del directorio)')) as HTMLSelectElement;
  // O4: qué accesos da o quita el nivel elegido, antes de guardar.
  const levelHint = el('p', { class: 'muted small', id: 'p-level-hint', 'aria-live': 'polite', 'data-feedback-id': 'central.persona.editar.aviso_nivel', 'data-feedback-label': 'Qué da el nivel de casa' });
  const paintLevelHint = () => {
    const was = person?.house_level ?? null;
    const now = houseLevel.value || null;
    levelHint.textContent = now === 'outsider' && was !== 'outsider'
      ? `Como outsider entrará en ${OUTSIDER_ACCESS_TEXT}.${person?.user_id ? '' : ' Sin cuenta no entra en ninguna app.'}`
      : was === 'outsider' && now !== 'outsider' ? 'Deja de ser outsider: pierde lo que le daba el nivel en Guests y Tasks. Su ficha, sus oficios y lo que hizo se conservan.' : '';
  };
  houseLevel.addEventListener('change', paintLevelHint);
  paintLevelHint();
  const coverage = el('select', { id: 'p-coverage' }, ...options(COVERAGES, COVERAGE_LABELS, person?.coverage ?? 'todo')) as HTMLSelectElement;
  const availability = el('select', { id: 'p-availability' }, ...options(AVAILABILITIES, AVAILABILITY_LABELS, person?.availability ?? 'segun_calendario')) as HTMLSelectElement;
  const notes = el('textarea', { id: 'p-notes', rows: '2', maxlength: '300', placeholder: 'Solo fines de semana, julio y agosto…' }) as HTMLTextAreaElement;
  notes.value = person?.availability_notes ?? '';
  const committed = el('input', { type: 'checkbox', id: 'p-committed', checked: person?.committed_post ?? false }) as HTMLInputElement;

  const values = (): Record<string, unknown> => {
    const common = { display_name: name.value.trim(), initials: text(initials.value), base_role: baseRole.value, availability: availability.value, availability_notes: text(notes.value), committed_post: committed.checked };
    if (!levelsOn) return { ...common, relation: relation.value, coverage: coverage.value };
    // «Relación» y «Cobertura» ya no se piden; la relación se sigue escribiendo (la del nivel) solo si cambia el nivel o es nueva.
    const lv = (houseLevel.value || null) as HouseLevel | null;
    const keepRelation = person && (person.house_level ?? null) === lv;
    return { ...common, house_level: lv, relation: keepRelation ? person.relation : relationForLevel(lv) };
  };
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
    const renamed = person?.user_id && 'display_name' in changed() ? { userId: person.user_id, name: name.value.trim() } : null;
    const ok = await commitSafely(client, operations, person ? 'Cambios guardados.' : 'Persona creada.');
    save.disabled = false;
    if (!ok) return;
    guard.dirtyEditor = false;
    await sheet?.close(true);
    // La ficha manda (FB_2026_013): su cuenta enlazada toma el nombre nuevo. Solo lo puede cambiar quien administra Central.
    if (renamed) {
      if (ctx.isAdmin) void syncAccountName(ctx.admin, renamed.userId, renamed.name);
      else toast('El nombre de su cuenta lo actualiza quien administra Central (Accesos).');
    }
    if (!person) onCreated?.(id);
  } },
  el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_nombre', 'data-feedback-label': 'Nombre' }, el('span', null, 'Nombre con el que se le conoce'), name),
  el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_iniciales', 'data-feedback-label': 'Iniciales' }, el('span', null, 'Iniciales (opcional)'), initials,
    el('span', { class: 'muted small' }, 'Hasta 4 letras, para las chips de Tasks. Si no las pones, se usa el nombre de pila.')),
  levelsOn
    ? el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.editar.nivel_area', 'data-feedback-label': 'Nivel de casa y área' },
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_nivel', 'data-feedback-label': 'Nivel de casa' }, el('span', null, 'Nivel de casa'), houseLevel),
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_area', 'data-feedback-label': 'Área principal' }, el('span', null, 'Área principal'), baseRole))
    : el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.editar.relacion_funcion', 'data-feedback-label': 'Relación y función' },
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_relacion', 'data-feedback-label': 'Relación con Ikisai' }, el('span', null, 'Relación con Ikisai'), relation),
      el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_funcion', 'data-feedback-label': 'Función' }, el('span', null, 'Función'), baseRole)),
  levelsOn ? levelHint : null,
  levelsOn
    ? el('label', { class: 'field', 'data-feedback-id': 'central.persona.editar.campo_disponibilidad', 'data-feedback-label': 'Disponibilidad' }, el('span', null, 'Disponibilidad'), availability)
    : el('div', { class: 'fieldrow', 'data-feedback-id': 'central.persona.editar.cobertura_disponibilidad', 'data-feedback-label': 'Cobertura y disponibilidad' },
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
    let data: Awaited<ReturnType<typeof loadPeople>> = { people: [], privates: [], records: [], teams: [], personTeams: [], trades: [], capabilities: [] };
    let accounts: Account[] | null = null;
    let grants: HouseGrant[] = isAdmin ? admin.cached.grants ?? [] : [];
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
        el('p', { 'data-feedback-ignore': '' }, (houseLevelsOn ? [person.code, areaLabel(person.base_role), levelLabel(person.house_level)]
          : [person.code, BASE_ROLE_LABELS[person.base_role as keyof typeof BASE_ROLE_LABELS], RELATION_LABELS[person.relation as keyof typeof RELATION_LABELS]]).filter(Boolean).join(' · ')),
        el('span', { class: 'chips', 'data-feedback-id': 'central.persona.cabecera.estado', 'data-feedback-label': 'Estado de la persona' }, ...(person.active ? [] : [el('span', { class: 'chip' }, 'Inactiva')]), ...(person.deleted_at ? [el('span', { class: 'chip alert' }, 'En la papelera')] : []), ...statusChips(data.records, personId, today))));

      const basic = block('Ficha', 'blockBasic', [el('dl', { class: 'kvlist', 'data-feedback-id': 'central.persona.ficha.datos', 'data-feedback-label': 'Datos básicos' },
        ...(houseLevelsOn ? [
          kv('Nivel de casa', levelLabel(person.house_level)),
          kv('Área principal', areaLabel(person.base_role)),
        ] : [
          kv('Relación', RELATION_LABELS[person.relation as keyof typeof RELATION_LABELS]),
          kv('Función', BASE_ROLE_LABELS[person.base_role as keyof typeof BASE_ROLE_LABELS]),
          kv('Cobertura', COVERAGE_LABELS[person.coverage as keyof typeof COVERAGE_LABELS]),
        ]),
        kv('Iniciales', person.initials),
        kv('Disponibilidad', [AVAILABILITY_LABELS[person.availability as keyof typeof AVAILABILITY_LABELS], person.availability_notes].filter(Boolean).join(' · ')),
        kv('Puesto comprometido', person.committed_post ? 'Sí' : null))],
      canEdit || outsiderAction(person) ? el('span', { class: 'blockactions' },
        canEdit ? el('button', { class: 'linkbtn', type: 'button', id: 'editPerson', 'data-feedback-id': 'central.persona.ficha.editar', 'data-feedback-label': 'Editar ficha', onclick: () => openPersonEditor(ctx, person) }, icon('edit', 16), 'Editar') : null,
        outsiderAction(person)) : null);

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
      const paths = new Map(tradeTree(data.trades, true).map((x) => [x.trade.id, x.path]));
      const caps = data.capabilities.filter((c) => c.person_id === person.id && paths.has(c.trade_id))
        .sort((a, b) => (b.level - a.level) || paths.get(a.trade_id)!.localeCompare(paths.get(b.trade_id)!, 'es'));
      const tradesBlock = block('Oficios', 'blockTrades', [caps.length
        ? el('ul', { class: 'list tradecaps', id: 'personTrades', 'data-feedback-id': 'central.persona.oficios.lista', 'data-feedback-label': 'Oficios de la persona' }, ...caps.map((c) => capabilityRow(person, c, paths.get(c.trade_id)!)))
        : el('p', { class: 'muted' }, 'Sin oficios.')],
        reserved && !person.deleted_at ? el('button', { class: 'linkbtn', type: 'button', id: 'addTrade', 'data-feedback-id': 'central.persona.oficios.anadir', 'data-feedback-label': 'Añadir oficio', onclick: () => openCapabilityEditor(person, null) }, icon('plus', 16), 'Añadir oficio') : null);
      const accountBlock = isAdmin ? block('Cuenta', 'blockAccount', accountBody(person, priv)) : null;

      const danger = canEdit && !person.deleted_at ? el('div', { class: 'zone', 'data-feedback-id': 'central.persona.acciones', 'data-feedback-label': 'Acciones de la persona' },
        el('button', { class: 'ghost', type: 'button', id: 'toggleActive', 'data-feedback-id': 'central.persona.acciones.activar', 'data-feedback-label': 'Marcar activa o inactiva', onclick: () => void commitSafely(client, [{ op: 'update', table: T.people, id: person.id, expectedRevision: person.revision, fields: { active: !person.active } }], person.active ? 'Marcada como inactiva.' : 'Marcada como activa.') },
          person.active ? 'Marcar inactiva' : 'Marcar activa'),
        el('button', { class: 'danger', type: 'button', id: 'deletePerson', 'data-feedback-id': 'central.persona.acciones.papelera', 'data-feedback-label': 'Enviar a papelera', onclick: () => void deletePerson(person) }, icon('trash', 18), 'Enviar a papelera')) : null;

      replace(host, head, basic, tradesBlock, teamsBlock, privateBlock, recordsBlock, accountBlock, danger);
      fbMark(host.querySelector('#blockTrades'), 'central.persona.oficios', 'Oficios');
      fbMark(host.querySelector('#blockBasic'), 'central.persona.ficha', 'Ficha');
      fbMark(host.querySelector('#blockTeams'), 'central.persona.equipos', 'Equipos');
      fbMark(host.querySelector('#blockPrivate'), 'central.persona.contacto', 'Contacto y vinculación');
      fbMark(host.querySelector('#blockRecords'), 'central.persona.documentacion', 'Documentación y formación');
      fbMark(host.querySelector('#blockAccount'), 'central.persona.cuenta', 'Cuenta');
    }

    /** «Por «Albañilería» ya tiene Sabe: aquí, como mínimo, Sabe.» */
    const minimumText = (min: { level: number; from: string }) => {
      const from = tradeTree(data.trades, true).find((x) => x.trade.id === min.from)?.path ?? '';
      return `Por «${from}» ya tiene ${tradeLevelLabel(min.level)}: aquí, como mínimo, ${tradeLevelLabel(min.level)}.`;
    };

    /**
     * Una capacidad: estrella (editable para quien gestiona personas: pulsar cambia el nivel), ruta del oficio y nota. Lo del
     * padre es el mínimo en el hijo (1510): la estrella no baja de ahí y, si lo puesto es menos, dice de dónde le viene.
     */
    function capabilityRow(person: Person, c: PersonTrade, path: string): HTMLElement {
      const min = inheritedLevel(data.trades, data.capabilities, person.id, c.trade_id);
      const shown = Math.max(c.level, min?.level ?? 0);
      const fromPath = min && min.level > c.level ? tradeTree(data.trades, true).find((x) => x.trade.id === min.from)?.path ?? null : null;
      let star: HTMLElement;
      if (reserved && !person.deleted_at) {
        const control = createLevelStar({ levels: 3, labels: [...TRADE_LEVEL_LABELS], value: shown, name: `Nivel en ${path}`,
          onChange: (picked) => {
            const level = min && picked < min.level ? min.level : picked;
            if (level !== picked) control.set(level);
            if (level === c.level) { if (level !== picked) toast(minimumText(min!)); return; }
            void commitSafely(client, [{ op: 'update', table: T.personTrades, id: c.id, expectedRevision: c.revision, fields: { level } }],
              level !== picked ? `Nivel: ${tradeLevelLabel(level)}. ${minimumText(min!)}` : `Nivel: ${tradeLevelLabel(level)}.`);
          } });
        markLevelStar(control.element.querySelector('button'));
        star = control.element;
      } else star = levelStar(shown);
      return el('li', { class: 'caprow', 'data-trade': c.trade_id, 'data-feedback-id': 'central.persona.oficios.fila', 'data-feedback-label': 'Oficio de la persona' },
        star,
        el('span', { class: 'capname' }, el('strong', null, path), el('span', { class: 'muted small' }, ` · ${tradeLevelLabel(shown)}${fromPath ? ` · por ${fromPath}` : ''}`)),
        c.note ? el('span', { class: 'muted small capnote', 'data-feedback-ignore': '' }, c.note) : null,
        reserved && !person.deleted_at ? el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'central.persona.oficios.editar', 'data-feedback-label': 'Editar oficio de la persona', onclick: () => openCapabilityEditor(person, c) }, 'Editar') : null);
    }

    /** Añadir o editar una capacidad: oficio (del árbol), nivel con la estrella y nota opcional. */
    function openCapabilityEditor(person: Person, c: PersonTrade | null): void {
      let sheet: Sheet | null = null;
      const taken = new Set(data.capabilities.filter((x) => x.person_id === person.id).map((x) => x.trade_id));
      const tree = tradeTree(data.trades).filter((x) => c ? x.trade.id === c.trade_id : !taken.has(x.trade.id));
      if (!c && !tree.length) { toast(data.trades.some((t) => !t.deleted_at) ? 'Ya tiene todos los oficios del catálogo.' : 'Todavía no hay oficios: créalos en Personas › Oficios.'); return; }
      const tradeSelect = el('select', { id: 'pt-trade', disabled: !!c }, ...tree.map((x) => el('option', { value: x.trade.id }, `${'· '.repeat(x.depth)}${x.trade.name}`))) as HTMLSelectElement;
      // Lo heredado del padre es el mínimo (1510): la estrella no baja de ahí y un aviso lo dice antes de guardar.
      const minOf = () => inheritedLevel(data.trades, data.capabilities, person.id, c?.trade_id ?? tradeSelect.value);
      let level = Math.max(c?.level ?? 1, minOf()?.level ?? 0);
      const minHint = el('p', { class: 'muted small', id: 'pt-min', 'aria-live': 'polite', 'data-feedback-id': 'central.persona.oficios.editor.minimo', 'data-feedback-label': 'Mínimo heredado del padre' });
      const star = createLevelStar({ levels: 3, labels: [...TRADE_LEVEL_LABELS], value: level, name: 'Nivel', showLabel: true, onChange: (v) => {
        const min = minOf();
        level = min && v < min.level ? min.level : v;
        if (level !== v) star.set(level);
      } });
      markLevelStar(star.element.querySelector('button'));
      const paintMin = () => {
        const min = minOf();
        minHint.textContent = min ? minimumText(min) : '';
        minHint.hidden = !min;
        if (min && level < min.level) { level = min.level; star.set(level); }
      };
      tradeSelect.addEventListener('change', paintMin);
      paintMin();
      const note = el('input', { id: 'pt-note', type: 'text', maxlength: '300', value: c?.note ?? '', placeholder: 'Por ejemplo: solo instalaciones pequeñas' }) as HTMLInputElement;
      const save = el('button', { class: 'primary', type: 'button', id: 'savePersonTrade', 'data-feedback-id': 'central.persona.oficios.editor.guardar', 'data-feedback-label': 'Guardar', onclick: async () => {
        const min = minOf();
        const fields = { level: Math.max(level, min?.level ?? 0), note: note.value.trim() || null };
        const ops: RowOperation[] = c ? [{ op: 'update', table: T.personTrades, id: c.id, expectedRevision: c.revision, fields }]
          : [{ op: 'insert', table: T.personTrades, id: crypto.randomUUID(), fields: { ...fields, person_id: person.id, trade_id: tradeSelect.value } }];
        if (await commitSafely(client, ops, c ? 'Oficio guardado.' : 'Oficio añadido.')) await sheet?.close(true);
      } }, 'Guardar');
      sheet = ignoreSheetMeta(openSheet({
        title: c ? 'Editar oficio' : 'Añadir oficio', meta: person.display_name,
        body: el('div', { 'data-feedback-id': 'central.persona.oficios.editor', 'data-feedback-label': 'Oficio de la persona' },
          el('label', { class: 'field', 'data-feedback-id': 'central.persona.oficios.editor.campo_oficio', 'data-feedback-label': 'Oficio' }, el('span', null, 'Oficio'), tradeSelect),
          el('div', { class: 'field', 'data-feedback-id': 'central.persona.oficios.editor.campo_nivel', 'data-feedback-label': 'Nivel' }, el('span', null, 'Nivel'), star.element,
            el('span', { class: 'muted small' }, 'Pulsa la estrella para cambiar: aprende, sabe, experto.'), minHint),
          el('label', { class: 'field', 'data-feedback-id': 'central.persona.oficios.editor.campo_nota', 'data-feedback-label': 'Nota' }, el('span', null, 'Nota (opcional)'), note)),
        panelAttrs: { 'data-feedback-id': 'central.persona.oficios.editor.hoja', 'data-feedback-label': 'Oficio de la persona' },
        closeAttrs: { 'data-feedback-id': 'central.persona.oficios.editor.cerrar', 'data-feedback-label': 'Cerrar' },
        foot: [
          c ? el('button', { class: 'danger', type: 'button', id: 'deletePersonTrade', 'data-feedback-id': 'central.persona.oficios.editor.quitar', 'data-feedback-label': 'Quitar oficio', onclick: async () => {
            if (await commitSafely(client, [{ op: 'delete', table: T.personTrades, id: c.id, expectedRevision: c.revision }], 'Oficio quitado.')) await sheet?.close(true);
          } }, 'Quitar') : el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.oficios.editor.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'),
          save],
      }));
    }

    /** O4 · «Convertir en outsider» (sin nivel) o «Quitar de outsider»: solo dirección y con los niveles ya aplicados. */
    function outsiderAction(person: Person): HTMLElement | null {
      if (!isAdmin || !houseLevelsOn || person.deleted_at) return null;
      if (!person.house_level) {
        return el('button', { class: 'ghost', type: 'button', id: 'convertOutsider', 'data-feedback-id': 'central.persona.outsider.convertir', 'data-feedback-label': 'Convertir en outsider', onclick: () => void openConvertOutsider(person) }, 'Convertir en outsider');
      }
      if (person.house_level === 'outsider') {
        return el('button', { class: 'ghost', type: 'button', id: 'removeOutsider', 'data-feedback-id': 'central.persona.outsider.quitar', 'data-feedback-label': 'Quitar de outsider', onclick: () => openRemoveOutsider(person) }, 'Quitar de outsider');
      }
      return null;
    }

    const toOutsider = (person: Person, extra: Record<string, unknown> = {}): RowOperation =>
      ({ op: 'update', table: T.people, id: person.id, expectedRevision: person.revision, fields: { house_level: 'outsider', relation: relationForLevel('outsider'), ...extra } });

    /** Hoja «Convertir en outsider»: qué ve y dónde entra; sin cuenta, se la puede dar en el mismo paso o dejarla para después. */
    async function openConvertOutsider(person: Person): Promise<void> {
      let sheet: Sheet | null = null;
      const priv = data.privates.find((x) => x.person_id === person.id && !x.deleted_at) ?? null;
      const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.persona.outsider.error', 'data-feedback-label': 'Error al convertir' });
      const intro = el('p', { class: 'note', 'data-feedback-id': 'central.persona.outsider.explicacion', 'data-feedback-label': 'Qué da ser outsider' },
        `Entrará como outsider en ${OUTSIDER_ACCESS_TEXT}. No entra en Booking, Food ni Central. Sale en Personas con el nivel «Outsider» y sus datos no cambian.`);
      const done = async (message: string) => {
        await sheet?.close(true);
        toast(message);
        accounts = null;
        void loadAccounts();
      };
      const convert = async (button: HTMLButtonElement) => {
        button.disabled = true;
        const ok = await commitSafely(client, [toOutsider(person)], person.user_id ? 'Ahora es outsider: entra en Guests y Tasks.' : 'Ahora es outsider. Sin cuenta no entra en ninguna app.');
        button.disabled = false;
        if (ok) { await sheet?.close(true); accounts = null; void loadAccounts(); }
      };
      if (person.user_id) {
        const submit = el('button', { class: 'primary', type: 'button', id: 'convertSubmit', 'data-feedback-id': 'central.persona.outsider.confirmar', 'data-feedback-label': 'Convertir', onclick: () => void convert(submit) }, 'Convertir') as HTMLButtonElement;
        sheet = ignoreSheetMeta(openSheet({
          title: 'Convertir en outsider', meta: person.display_name, body: el('div', { id: 'convertSheet' }, intro, error),
          panelAttrs: { 'data-feedback-id': 'central.persona.outsider.hoja', 'data-feedback-label': 'Convertir en outsider' },
          closeAttrs: { 'data-feedback-id': 'central.persona.outsider.cerrar', 'data-feedback-label': 'Cerrar' },
          foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.outsider.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), submit],
        }));
        return;
      }
      // Sin cuenta: correo para dársela ahora (los accesos de outsider llegan solos al enlazarla) y, como hoy, otros accesos opcionales.
      let catalog: Awaited<ReturnType<typeof admin.catalog>> = [];
      if (navigator.onLine) { try { catalog = await admin.catalog(); } catch { catalog = []; } }
      const email = el('input', { id: 'co-email', 'data-feedback-ignore': '', type: 'email', maxlength: '320', value: priv?.email ?? '' }) as HTMLInputElement;
      const selects = new Map<string, HTMLSelectElement>();
      const rows = catalog.filter((app) => app.id !== 'guests' && app.id !== 'tasks').map((app) => {
        const s = el('select', { id: `co-${app.id}`, 'aria-label': `Acceso a ${app.name}` }, el('option', { value: '' }, 'Sin acceso'),
          ...(['reader', 'editor', 'owner'] as Role[]).map((r) => el('option', { value: r }, ROLE_LABELS[r]))) as HTMLSelectElement;
        selects.set(app.id, s);
        fbMark(s, 'central.persona.outsider.otro_acceso', 'Otro acceso').setAttribute('data-feedback-label', `Acceso a ${app.name.replace(/^Ikisai /, '')}`);
        return el('label', { class: 'approw', 'data-feedback-id': 'central.persona.outsider.app', 'data-feedback-label': 'Otro acceso' }, el('span', { class: 'appname' }, el('strong', null, app.name.replace(/^Ikisai /, ''))), s);
      });
      const later = el('button', { class: 'ghost', type: 'button', id: 'convertNoAccount', 'data-feedback-id': 'central.persona.outsider.sin_cuenta', 'data-feedback-label': 'Convertir sin cuenta', onclick: () => void convert(later) }, 'Convertir sin cuenta') as HTMLButtonElement;
      const submit = el('button', { class: 'primary', type: 'button', id: 'convertSubmit', 'data-feedback-id': 'central.persona.outsider.con_cuenta', 'data-feedback-label': 'Convertir y dar cuenta', onclick: async () => {
        error.textContent = '';
        if (!navigator.onLine) { error.textContent = 'Dar cuenta necesita conexión. Puedes convertir sin cuenta y dársela después.'; return; }
        const mail = email.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { error.textContent = 'Escribe un correo válido.'; email.focus(); return; }
        const memberships = [...selects].filter(([, x]) => x.value).map(([app, x]) => ({ app, role: x.value as Role }));
        submit.disabled = true;
        try {
          // Una persona, una ficha, una cuenta: como en «Dar cuenta».
          const choice = await checkExistingAccount({ admin, client, email: mail, person, appName });
          if (choice.kind === 'abort' || choice.kind === 'use_existing') {
            if (choice.kind === 'abort' && choice.otherEmail) { email.focus(); email.select(); error.textContent = 'Escribe el correo de esta persona.'; }
            return;
          }
          const into = choice.kind === 'merge' ? choice.into : null;
          const out = await usage.run('central.persona.outsider.con_cuenta', () => admin.invite({ email: mail, displayName: into ? into.display_name : person.display_name, memberships }));
          if (into) {
            // Ya tenía ficha con esa cuenta: se fusionan y queda el nivel de esa ficha (se cambia desde ella).
            await mergePeople(client, person.id, into.id);
            await sheet?.close(true);
            toast(`Fichas fusionadas: queda «${into.display_name}». Ponle el nivel desde su ficha.`);
            navigate(`#/personas/${into.id}`);
            return;
          }
          const fresh = data.people.find((x) => x.id === person.id) ?? person;
          await client.commit([toOutsider(fresh, { user_id: out.userId })]);
          if (out.temporaryPassword) { await sheet?.close(true); accounts = null; void loadAccounts(); showSecret(out.temporaryPassword, out.email); }
          else await done('Ya tenía cuenta con ese correo: queda enlazada y es outsider.');
        } catch (e) {
          error.textContent = describeError(e);
        } finally {
          submit.disabled = false;
        }
      } }, 'Convertir y dar cuenta') as HTMLButtonElement;
      sheet = ignoreSheetMeta(openSheet({
        title: 'Convertir en outsider', meta: person.display_name,
        body: el('div', { id: 'convertSheet' }, intro,
          el('p', { class: 'note warn', 'data-feedback-id': 'central.persona.outsider.aviso_sin_cuenta', 'data-feedback-label': 'Aviso sin cuenta' }, 'No tiene cuenta: sin ella no entra en ninguna app. Puedes dársela ahora o después.'),
          el('label', { class: 'field', 'data-feedback-id': 'central.persona.outsider.campo_correo', 'data-feedback-label': 'Correo para su cuenta' }, el('span', null, 'Correo para su cuenta'), email),
          rows.length ? el('div', { class: 'sectionlabel', 'data-feedback-id': 'central.persona.outsider.otros_accesos', 'data-feedback-label': 'Otros accesos' }, 'Otros accesos (opcional)') : null, ...rows, error),
        panelAttrs: { 'data-feedback-id': 'central.persona.outsider.hoja', 'data-feedback-label': 'Convertir en outsider' },
        closeAttrs: { 'data-feedback-id': 'central.persona.outsider.cerrar', 'data-feedback-label': 'Cerrar' },
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.outsider.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), later, submit],
        initialFocus: email,
      }));
    }

    /** «Quitar de outsider» (decisión del usuario): se pregunta a qué nivel pasa, con «Sin nivel» por defecto. No se borra nada. */
    function openRemoveOutsider(person: Person): void {
      let sheet: Sheet | null = null;
      const target = el('select', { id: 'ro-level', 'aria-label': 'Pasa a' },
        el('option', { value: '' }, 'Sin nivel (fuera del directorio)'), el('option', { value: 'staff' }, HOUSE_LEVEL_LABELS.staff)) as HTMLSelectElement;
      const submit = el('button', { class: 'primary', type: 'button', id: 'removeOutsiderSubmit', 'data-feedback-id': 'central.persona.outsider.quitar_confirmar', 'data-feedback-label': 'Quitar', onclick: async () => {
        const lv = (target.value || null) as HouseLevel | null;
        submit.disabled = true;
        const ok = await commitSafely(client, [{ op: 'update', table: T.people, id: person.id, expectedRevision: person.revision, fields: { house_level: lv, relation: relationForLevel(lv) } }],
          lv ? 'Ya no es outsider: ahora es Staff.' : 'Ya no es outsider.');
        submit.disabled = false;
        if (ok) { await sheet?.close(true); accounts = null; void loadAccounts(); }
      } }, 'Quitar') as HTMLButtonElement;
      sheet = ignoreSheetMeta(openSheet({
        title: '¿Quitar de outsider?', meta: person.display_name,
        body: el('div', { id: 'removeOutsiderSheet' },
          el('p', { 'data-feedback-id': 'central.persona.outsider.quitar_explicacion', 'data-feedback-label': 'Qué pasa al quitarlo' },
            'Pierde lo que le daba el nivel en Guests y Tasks; lo que tuviera antes vuelve. Sus estancias, notas, comentarios, oficios y la ficha se conservan.'),
          el('label', { class: 'field', 'data-feedback-id': 'central.persona.outsider.quitar_pasa_a', 'data-feedback-label': 'Pasa a' }, el('span', null, 'Pasa a'), target)),
        panelAttrs: { 'data-feedback-id': 'central.persona.outsider.quitar_hoja', 'data-feedback-label': 'Quitar de outsider' },
        closeAttrs: { 'data-feedback-id': 'central.persona.outsider.quitar_cerrar', 'data-feedback-label': 'Cerrar' },
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.outsider.quitar_cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), submit],
      }));
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
        account && account.displayName !== person.display_name ? el('p', { class: 'note warn', 'data-feedback-id': 'central.persona.cuenta.nombre_distinto', 'data-feedback-label': 'Nombre de la cuenta distinto' },
          'La cuenta tiene otro nombre. ',
          el('button', { class: 'linkbtn', type: 'button', id: 'useFichaName', 'data-feedback-id': 'central.persona.cuenta.usar_nombre_ficha', 'data-feedback-label': 'Usar el nombre de la ficha', onclick: async () => {
            if (await syncAccountName(admin, account.userId, person.display_name)) { toast('La cuenta usa ya el nombre de la ficha.'); accounts = null; void loadAccounts(); }
          } }, 'Usar el nombre de la ficha')) : null,
        account ? el('span', { class: 'chips', 'data-feedback-id': 'central.persona.cuenta.accesos', 'data-feedback-label': 'Accesos de la cuenta' }, ...(account.disabled ? [el('span', { class: 'chip alert' }, 'Desactivada')] : []),
          ...account.memberships.map((m) => grantFor(grants, account.userId, m.app, m.role)
            ? el('span', { class: `chip role-${m.role} derived`, 'data-derived': '' }, `${appName(m.app)} · ${ROLE_LABELS[m.role]}`, el('span', { class: 'muted' }, ' · por nivel de casa'))
            : el('span', { class: `chip role-${m.role}` }, `${appName(m.app)} · ${ROLE_LABELS[m.role]}`))) : null,
        account ? derivedNote(account) : null,
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
          // Una persona, una ficha, una cuenta: si el correo ya tiene cuenta, se avisa y se elige antes de dar el alta.
          const choice = await checkExistingAccount({ admin, client, email: mail, person, appName });
          if (choice.kind === 'abort') {
            if (choice.otherEmail) { email.focus(); email.select(); error.textContent = 'Escribe el correo de esta persona.'; }
            return;
          }
          if (choice.kind === 'use_existing') return; // sin ficha de partida no se llega aquí: «Dar cuenta» siempre tiene una
          const into = choice.kind === 'merge' ? choice.into : null;
          const out = await usage.run('central.persona.cuenta.dar', () => admin.invite({ email: mail, displayName: into ? into.display_name : person.display_name, memberships }));
          if (into) {
            await mergePeople(client, person.id, into.id);
            await sheet?.close(true);
            toast(`Fichas fusionadas: queda «${into.display_name}».`);
            navigate(`#/personas/${into.id}`);
            return;
          }
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
        if (await commitSafely(client, [{ op: 'update', table: T.people, id: person.id, expectedRevision: fresh.revision, fields: { user_id: select.value } }], 'Cuenta enlazada.')) {
          await sheet?.close(true);
          // La ficha manda: la cuenta enlazada toma su nombre (FB_2026_013).
          const account = free.find((a) => a.userId === select.value);
          if (account && account.displayName !== fresh.display_name) await syncAccountName(admin, account.userId, fresh.display_name);
          accounts = null; void loadAccounts();
        }
      } }, 'Enlazar');
      sheet = ignoreSheetMeta(openSheet({ title: 'Enlazar cuenta existente', meta: person.display_name, body: el('label', { class: 'field', 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja.campo_cuenta', 'data-feedback-label': 'Cuenta' }, el('span', null, 'Cuenta'), select),
        panelAttrs: { 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja', 'data-feedback-label': 'Enlazar cuenta existente' },
        closeAttrs: { 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja.cerrar', 'data-feedback-label': 'Cerrar' },
        foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.persona.cuenta.enlazar_hoja.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), submit] }));
    }

    const appName = (id: string) => admin.cached.catalog?.find((a) => a.id === id)?.name.replace(/^Ikisai /, '') ?? id;

    /** Qué le da el nivel y qué tenía antes, que es lo que vuelve al quitarlo. */
    function derivedNote(account: Account): HTMLElement | null {
      const mine = grants.filter((g) => g.userId === account.userId && account.memberships.some((m) => m.app === g.app && m.role === g.role));
      if (!mine.length) return null;
      const before = mine.filter((g) => g.previousRole).map((g) => `${appName(g.app)} · ${ROLE_LABELS[g.previousRole as Role] ?? g.previousRole}`);
      return el('p', { class: 'muted small', id: 'derivedNote', 'data-feedback-id': 'central.persona.cuenta.por_nivel', 'data-feedback-label': 'Accesos por nivel de casa' },
        `Lo marcado «por nivel de casa» lo da el nivel «${HOUSE_LEVEL_LABELS[mine[0]!.level as HouseLevel] ?? mine[0]!.level}» y se cambia aquí, no en Accesos.`,
        before.length ? ` Antes tenía ${before.join(', ')}: vuelve si se quita el nivel.` : ' Al quitar el nivel, se retira.');
    }

    async function loadAccounts(): Promise<void> {
      if (!isAdmin) return;
      try { [accounts, , grants] = await Promise.all([admin.accounts(), admin.catalog(), admin.houseGrants().catch(() => grants)]); } catch { accounts = admin.cached.accounts?.items ?? null; }
      paint();
    }

    async function load(): Promise<void> {
      data = await loadPeople(client);
      paint();
    }

    void load().then(() => loadAccounts());
    const offs = [T.people, T.personPrivate, T.personRecords, T.teams, T.personTeams, T.trades, T.personTrades].map((t) => client.onTable(t, () => void load()));
    return () => offs.forEach((off) => off());
  };
}
