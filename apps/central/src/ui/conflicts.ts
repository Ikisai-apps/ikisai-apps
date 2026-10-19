import type { PendingConflict, RejectedBatch, SyncedRow } from '@ikisai/sync-client';
import { confirmDialog, el, formatDate, renderConflicts, renderTray, replace, toast, type TrayRow } from '@ikisai/ui-kit';
import { AVAILABILITY_LABELS, BASE_ROLE_LABELS, DECISION_SCOPE_LABELS, DECISION_STATUS_LABELS, ENGAGEMENT_LABELS, HOUSE_LEVEL_LABELS, RECORD_STATUS_LABELS, RECORD_TYPE_LABELS, RELATION_LABELS, REQUIREMENT_STATUS_LABELS, REQUIREMENT_TYPE_LABELS } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import type { ViewMount } from './shell.ts';
import { fbIgnore, fbMark } from './feedback.ts';

const FIELD_LABELS: Record<string, string> = {
  display_name: 'Nombre', relation: 'Relación', base_role: 'Función', coverage: 'Cobertura', availability: 'Disponibilidad',
  availability_notes: 'Notas de disponibilidad', active: 'Activa', committed_post: 'Puesto comprometido', user_id: 'Cuenta', position: 'Orden', house_level: 'Nivel de casa',
  legal_name: 'Nombre completo', phone: 'Teléfono', email: 'Correo', engagement: 'Vinculación', engaged_from: 'Desde', engaged_until: 'Hasta',
  emergency_contact: 'Contacto de emergencia', notes: 'Notas', kind: 'Clase', record_type: 'Tipo', title: 'Título', status: 'Estado',
  issued_on: 'Fecha', expires_on: 'Caduca', reviewed_on: 'Revisado', file_id: 'Archivo', deleted_at: 'Borrado',
  // Decisiones, textos, entidad, cumplimiento y revisión (MUELA-022: etiquetas llanas, nunca «summary» ni «scopes»).
  name: 'Nombre', summary: 'Qué se decidió y por qué', technical: 'Explicación técnica', scopes: 'Apps o áreas', decided_on: 'Fecha', superseded_by: 'Sustituida por',
  responsible_person_id: 'Responsable', link_url: 'Enlace', link_label: 'Texto del enlace', review_outcome: 'Decisión final', vote: 'Voto',
  body: 'Texto', key: 'Clave', lang: 'Idioma', trade_name: 'Nombre comercial', tax_id: 'NIF/CIF', address_line: 'Domicilio fiscal', postal_code: 'Código postal',
  city: 'Municipio', province: 'Provincia', country: 'País', website: 'Web', iban: 'IBAN', bizum: 'Bizum', venue_address: 'Dirección del lugar',
  venue_map_url: 'Enlace del mapa', logo_file_id: 'Logotipo', site_plan_file_id: 'Plano', requirement_type: 'Tipo', risk: 'Riesgo', notice_days: 'Avisar con',
  frequency: 'Frecuencia', reference_date: 'Referencia', next_action: 'Siguiente acción', next_action_on: 'Para el', description: 'Descripción', blocks_operation: 'Bloquea la operación',
  document_type: 'Tipo', requirement_id: 'Obligación', version: 'Versión', signed: 'Firmado', external_url: 'Enlace', step: 'Paso', url: 'Enlace', route: 'Ruta',
  feedback_prefix: 'Prefijo de feedback', handoff: 'Traspaso', note: 'Nota', color: 'Color',
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  relation: RELATION_LABELS, base_role: BASE_ROLE_LABELS, house_level: HOUSE_LEVEL_LABELS, availability: AVAILABILITY_LABELS, engagement: ENGAGEMENT_LABELS,
  record_type: RECORD_TYPE_LABELS, requirement_type: REQUIREMENT_TYPE_LABELS,
};
const STATUS_BY_TABLE: Record<string, Record<string, string>> = {
  [T.personRecords]: RECORD_STATUS_LABELS, [T.decisions]: DECISION_STATUS_LABELS, [T.requirements]: REQUIREMENT_STATUS_LABELS,
};

/** Áreas de la bandeja, en este orden (MUELA-022: Decisiones, Personas, Entidad, Textos…). */
const AREAS: Array<{ key: string; label: string; tables: string[]; fix: string }> = [
  { key: 'decisiones', label: 'Decisiones', tables: [T.decisions, T.decisionVotes], fix: 'Decisiones' },
  { key: 'personas', label: 'Personas', tables: [T.people, T.personPrivate, T.personRecords, T.personTeams, T.personTrades], fix: 'Personas' },
  { key: 'entidad', label: 'Entidad', tables: [T.entity], fix: 'Entidad' },
  { key: 'textos', label: 'Textos y contacto', tables: [T.texts], fix: 'Textos' },
  { key: 'cumplimiento', label: 'Cumplimiento', tables: [T.requirements, T.keyDocuments, T.requirementTasks], fix: 'Cumplimiento' },
  { key: 'equipos', label: 'Equipos y oficios', tables: [T.teams, T.trades, T.tradeKit], fix: 'Personas' },
  { key: 'direccion', label: 'Dirección', tables: [T.kpiTargets], fix: 'Inicio' },
  { key: 'revision', label: 'Revisión', tables: [T.reviewScreens], fix: 'Revisión' },
];
const areaOf = (table: string) => AREAS.find((a) => a.tables.includes(table)) ?? { key: 'otros', label: 'Otros', tables: [], fix: 'Inicio' };
const TABLE_LABELS: Record<string, string> = Object.fromEntries(AREAS.flatMap((a) => a.tables.map((t) => [t, a.label.toLowerCase()])));

/** Pantalla donde se corrige un cambio rechazado. */
function fixHash(table: string, id: string, row: SyncedRow | null | undefined): string {
  switch (table) {
    case T.decisions: return `#/decisiones/${id}`;
    case T.decisionVotes: return row?.decision_id ? `#/decisiones/${String(row.decision_id)}` : '#/decisiones';
    case T.people: return `#/personas/${id}`;
    case T.personPrivate: case T.personRecords: case T.personTeams: case T.personTrades: return row?.person_id ? `#/personas/${String(row.person_id)}` : '#/personas';
    case T.entity: return '#/entidad';
    case T.texts: return '#/textos';
    case T.requirements: return `#/cumplimiento/${id}`;
    case T.keyDocuments: return `#/cumplimiento/documentos?doc=${id}`;
    case T.requirementTasks: return row?.requirement_id ? `#/cumplimiento/${String(row.requirement_id)}` : '#/cumplimiento';
    case T.teams: return '#/personas/equipos';
    case T.trades: case T.tradeKit: return '#/personas/oficios';
    case T.reviewScreens: return '#/revision';
    default: return '#/';
  }
}

/** Un rechazo que puede salir bien al volver a intentarlo: falta de red o fallo del servidor. */
function transient(error: RejectedBatch['error']): boolean {
  const status = Number((error as { status?: number }).status ?? 0);
  return error.code === 'NETWORK' || error.code === 'BACKEND_UNAVAILABLE' || status === 0 || status >= 500;
}

/** Conflictos (§6.3) y lotes rechazados por el servidor, en la bandeja por áreas del kit (K20, MUELA-022 y 069). */
export const mountConflicts: ViewMount = ({ main, client, navigate }) => {
  const conflictHost = el('div', { id: 'conflictList', 'data-feedback-id': 'central.conflictos.lista', 'data-feedback-label': 'Conflictos' });
  const rejectedHost = el('div', { id: 'rejectedList', 'data-feedback-id': 'central.conflictos.rechazados.lista', 'data-feedback-label': 'Lista de rechazados' });
  const names = new Map<string, string>();
  const people = new Map<string, string>();
  const me = client.bootstrap()?.profile.userId ?? null;

  function show(field: string, value: unknown, table?: string): string {
    if (value === null || value === undefined || value === '') return '—';
    if (field === 'deleted_at') return formatDate(String(value));
    if (field === 'file_id' || field === 'logo_file_id' || field === 'site_plan_file_id') return 'Archivo';
    if (field === 'user_id') return 'Cuenta enlazada';
    if (field === 'responsible_person_id' || field === 'person_id') return names.get(String(value)) ?? 'Una persona';
    if (field === 'scopes' && Array.isArray(value)) return value.map((s) => DECISION_SCOPE_LABELS[String(s)] ?? String(s)).join(', ') || '—';
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (field === 'status' && table && STATUS_BY_TABLE[table]) return STATUS_BY_TABLE[table]![String(value)] ?? String(value);
    return VALUE_LABELS[field]?.[String(value)] ?? String(value);
  }

  function rowName(table: string, row: SyncedRow | null | undefined): string {
    if (!row) return 'Elemento';
    const person = names.get(String(row.person_id ?? row.id)) ?? '';
    const code = row.code ? `${String(row.code)} · ` : '';
    switch (table) {
      case T.people: return `Persona: ${String(row.display_name ?? person)}`;
      case T.personPrivate: return `Datos reservados de ${person || 'una persona'}`;
      case T.personRecords: return `${RECORD_TYPE_LABELS[String(row.record_type)] ?? 'Registro'} de ${person || 'una persona'}`;
      case T.decisions: case T.requirements: case T.keyDocuments: return `${code}${String(row.name ?? '')}`;
      case T.texts: return `${String(row.title ?? row.key ?? 'Texto')}${row.lang === 'en' ? ' · traducción al inglés' : ''}`;
      case T.entity: return 'Datos de la entidad';
      case T.reviewScreens: return `Pantalla: ${String(row.name ?? '')}`;
      case T.teams: case T.trades: return String(row.name ?? 'Elemento');
      default: return String(row.name ?? row.title ?? 'Elemento');
    }
  }

  const rejectedSection = el('section', { hidden: true, 'data-feedback-id': 'central.conflictos.rechazados', 'data-feedback-label': 'Rechazados por el servidor' }, el('div', { class: 'sectionlabel' }, 'Rechazados por el servidor'), rejectedHost);
  const intro = el('p', { id: 'conflictIntro' }, 'Nada se pierde hasta que decidas.');
  replace(
    main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.conflictos.cabecera', 'data-feedback-label': 'Cabecera de Conflictos' }, el('div', null, el('h2', null, 'Conflictos'), intro)),
    conflictHost,
    rejectedSection,
  );

  async function resolve(conflict: PendingConflict, decision: Parameters<typeof client.resolveConflict>[1]): Promise<void> {
    try {
      await client.resolveConflict(conflict.requestId, decision);
      toast('Conflicto resuelto. Se enviará tu decisión al servidor.');
      await load();
      if ((await client.conflicts()).length === 0 && (await client.rejected()).length === 0) navigate('#/');
    } catch (error) {
      toast(describeError(error));
    }
  }

  function rejectedRow(batch: RejectedBatch): TrayRow {
    const first = batch.operations.find((op) => op.op !== 'call') as (RejectedBatch['operations'][number] & { table: string; id: string }) | undefined;
    const key = first ? `${first.table}|${first.id}` : '';
    const row = first ? batch.baseRows[key] ?? ((first as { fields?: SyncedRow }).fields ?? null) : null;
    const area = first ? areaOf(first.table) : areaOf('');
    const verbs: Record<string, string> = { insert: 'Crear', update: 'Cambiar', delete: 'Borrar', restore: 'Restaurar', call: 'Ejecutar' };
    const title = first ? `${verbs[first.op] ?? 'Cambiar'} «${rowName(first.table, row)}»${batch.operations.length > 1 ? ` y ${batch.operations.length - 1} más` : ''}` : 'Cambio rechazado';
    return {
      id: batch.requestId, rejected: true, title,
      medal: { icon: 'warn', name: area.label },
      when: `Rechazado ${formatDate(batch.rejectedAt)}`,
      clash: [el('span', null, describeError(batch.error))],
      attrs: { 'data-feedback-id': 'central.conflictos.rechazados.lote', 'data-feedback-label': 'Lote rechazado' },
      actions: [
        ...(first ? [{ label: `Corregir en ${area.fix}`, primary: true, attrs: { 'data-feedback-id': 'central.conflictos.rechazados.corregir', 'data-feedback-label': 'Corregir' }, onClick: () => navigate(fixHash(first.table, first.id, row)) }] : []),
        // «Reintentar» solo si el fallo fue pasajero (red o servidor): un error definitivo volvería a fallar.
        ...(transient(batch.error) ? [{ label: 'Reintentar', attrs: { 'data-feedback-id': 'central.conflictos.rechazados.reintentar', 'data-feedback-label': 'Reintentar' }, onClick: async () => {
          try { await client.retryRejected(batch.requestId); toast('Reintentando el envío.'); await load(); } catch (error) { toast(describeError(error)); }
        } }] : []),
        { label: 'Descartar', attrs: { 'data-feedback-id': 'central.conflictos.rechazados.descartar', 'data-feedback-label': 'Descartar' }, onClick: async () => {
          if (!(await confirmDialog({ title: '¿Descartar estos cambios?', text: 'Se olvidarán en este dispositivo; el servidor conserva su versión.', confirmLabel: 'Descartar', danger: true }))) return;
          await client.discardRejected(batch.requestId);
          toast('Cambios descartados.');
          await load();
        } },
      ],
    };
  }

  async function load(): Promise<void> {
    const [conflicts, rejected] = await Promise.all([client.conflicts(), client.rejected()]);
    for (const row of await client.list(T.people, { includeDeleted: true })) {
      names.set(row.id, String(row.display_name ?? ''));
      if (row.user_id) people.set(String(row.user_id), String(row.display_name ?? ''));
    }
    const mineOnly = conflicts.length > 0 && conflicts.every((c) => c.current?.updated_by && c.current.updated_by === me);
    intro.textContent = !conflicts.length ? 'Nada se pierde hasta que decidas.'
      : mineOnly ? 'Cambiaste lo mismo desde otro dispositivo. Nada se pierde hasta que decidas.'
        : 'Otra persona cambió lo mismo que tú. Nada se pierde hasta que decidas.';
    // Cada conflicto muestra datos de personas (nombres, contacto, notas): el gesto lo ignora entero.
    replace(conflictHost, ...renderConflicts(conflicts, {
      layout: 'tray', undoMs: 8000, currentUserId: me, fieldLabels: FIELD_LABELS, tableLabels: TABLE_LABELS, feedbackId: 'central.conflictos.lista.conflicto',
      show: (field, value) => show(field, value),
      onResolve: resolve,
      rowName: (conflict) => rowName(conflict.operation.table, conflict.current ?? conflict.base),
      groupBy: (conflict) => { const a = areaOf(conflict.operation.table); return { key: a.key, label: a.label, order: AREAS.indexOf(a as never) }; },
      theirsName: (conflict) => people.get(String(conflict.current?.updated_by ?? '')) ?? null,
      medal: (conflict) => {
        const t = conflict.operation.table;
        const row = conflict.current ?? conflict.base;
        const person = t === T.people ? String(row?.display_name ?? '') : names.get(String(row?.person_id ?? '')) ?? '';
        return person ? { name: person } : { icon: t === T.decisions ? 'history' : t === T.entity ? 'briefcase' : t === T.texts ? 'edit' : 'list', name: areaOf(t).label };
      },
    }).map((node) => fbIgnore(fbMark(node, 'central.conflictos.bandeja', 'Bandeja de conflictos'))));
    rejectedSection.hidden = rejected.length === 0;
    replace(rejectedHost, rejected.length ? fbIgnore(renderTray({ label: 'Rechazados por el servidor', groups: [{ key: 'rechazados', label: 'Cambios que no se guardaron', rows: rejected.map(rejectedRow) }] })) : el('span'));
  }

  void load();
  // Se repinta solo si cambian los recuentos: repintar a mitad de un «Deshacer» de 8 s lo perdería.
  let last = `${client.status().conflicts}|${client.status().rejected}`;
  const off = client.onStatus((s) => { const now = `${s.conflicts}|${s.rejected}`; if (now !== last) { last = now; void load(); } });
  return () => off();
};
