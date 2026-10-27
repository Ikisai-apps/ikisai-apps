import type { SyncClient } from '@ikisai/sync-client';
import type { AppMenuRow, AppMenuSection, PaletteItem } from '@ikisai/ui-kit';
import {
  CLOSED_REQUIREMENT_STATUSES, DOCUMENT_KINDS, DOCUMENT_KIND_LABELS, REQUIREMENT_TYPES, REQUIREMENT_TYPE_LABELS, dueState, fold, reviewProgress,
  screensToAct, todayInMadrid,
} from '@ikisai/domain-central';
import { accountIssue } from '../app/account-names.ts';
import type { Account, AgentKey, CatalogApp } from '../app/admin.ts';
import { T } from '../app/client.ts';
import { RECENT_KIND_LABELS, agoText, readRecents, type Recent } from '../app/recents.ts';
import { dashboardSummary } from './dashboard.ts';

/**
 * Contenido del menú lateral común de Central (MUELA-013, con «Cuentas y accesos» arriba para quien administra, Bloque 2)
 * y de la búsqueda de la cabecera (Ctrl K). La cáscara (cajón, columna, perfil, sincronización, apps y ayuda) es del kit;
 * aquí, las secciones con sus recuentos, los recientes y lo que se puede buscar. Todo sale del espejo local: funciona sin red.
 * Lo de «Cuentas y accesos» es lo único que no está en el espejo: sale de la última lectura de Core en esta sesión
 * (`admin.cached`) y, sin red, el menú dice «se leen con red» en lugar de cifras (MUELA-085).
 */

type Row = Record<string, unknown> & { id: string; deleted_at?: string | null };

interface TypeCount { key: string; label: string; total: number; alert: number; warn: number }
export interface MenuData {
  requirements: TypeCount[];
  documents: TypeCount[];
  openRequirements: number;
  liveDocuments: number;
  conflicts: number;
  review: { done: number; total: number; toAct: number };
  /** Fichas vivas (para las cuentas «por revisar»). */
  people: Array<{ user_id: string | null; display_name: string }>;
  index: PaletteItem[];
}

/** Lo que el menú sabe de las cuentas: la última lectura de Core (o nada) y si hay red. */
export interface AccessData {
  online: boolean;
  accounts: Account[] | null;
  agents: AgentKey[] | null;
  catalog: CatalogApp[] | null;
}

export const EMPTY_MENU: MenuData = { requirements: [], documents: [], openRequirements: 0, liveDocuments: 0, conflicts: 0, review: { done: 0, total: 0, toAct: 0 }, people: [], index: [] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «1 vencida · 1 vence pronto» o «al día». */
function stateText(c: TypeCount, overdue: [string, string]): string {
  const parts = [c.alert ? plural(c.alert, overdue[0], overdue[1]) : '', c.warn ? `${c.warn} ${c.warn === 1 ? 'vence' : 'vencen'} pronto` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'al día';
}
const tone = (c: { alert: number; warn: number }) => (c.alert ? 'alert' as const : c.warn ? 'warn' as const : null);

/** Pantallas que se pueden buscar (y su ruta). Las de Accesos, solo para quien administra. */
export function screenItems(isAdmin: boolean, navigate: (hash: string) => void): PaletteItem[] {
  const screens: Array<[string, string, string]> = [
    ['Inicio', '#/', 'portada vencimientos direccion indicadores'],
    ['Vencimientos', '#/cumplimiento', 'cumplimiento vence caduca'],
    ['Obligaciones', '#/cumplimiento/requisitos', 'cumplimiento seguros licencias revisiones'],
    ['Documentos clave', '#/cumplimiento/documentos', 'cumplimiento polizas contratos actas'],
    ['Personas', '#/personas', 'equipo fichas'],
    ['Equipos', '#/personas/equipos', 'personas'],
    ['Oficios', '#/personas/oficios', 'capacidades personas'],
    ['Inventario', '#/inventario', 'recursos stock'],
    ['Datos de la entidad', '#/entidad', 'razon social nif iban logotipo'],
    ['Planos del centro', '#/entidad/planos', 'mapa de zonas plano dibujo colocar estancias'],
    ['Textos y contacto', '#/textos', 'avisos legales declaraciones correos'],
    ['Registro de decisiones', '#/decisiones', 'votar decidir'],
    ['Revisión semanal', '#/direccion/semana', 'direccion semana reunion indicadores rojo atencion acciones'],
    ['Conflictos', '#/conflictos', 'cambios rechazados'],
    ['Revisión', '#/revision', 'pantallas avance feedback'],
    ...(isAdmin ? [
      ['Cuentas', '#/accesos', 'accesos permisos'], ['Alta de cuenta', '#/accesos/alta', 'accesos nueva'],
      ['Agentes', '#/accesos/agentes', 'claves ia'], ['Registro de accesos', '#/accesos/registro', 'auditoria'],
      ['Uso y cobertura', '#/revision/uso', 'uso campos funciones cobertura recorridos'],
    ] as Array<[string, string, string]> : []),
  ];
  return screens.map(([text, hash, keywords]) => ({ group: 'Pantallas', text, keywords, hint: 'Pantalla', run: () => navigate(hash) }));
}

export function recentRows(recents: Recent[], max: number): AppMenuRow[] {
  const icons: Record<string, string> = { obligacion: 'list', documento: 'invoice', persona: 'user', decision: 'history', articulo: 'grid', pantalla: 'grid' };
  return recents.slice(0, max).map((r) => ({ label: r.title, sub: `${RECENT_KIND_LABELS[r.kind] ?? r.kind} · ${agoText(r.at)}`, icon: icons[r.kind] ?? 'list', href: r.hash, feedbackId: 'central.menu.recientes.fila' }));
}

/** Lo que el menú y la búsqueda necesitan del espejo: recuentos por tipo, conflictos, revisión y el índice de búsqueda. */
export async function loadMenuData(client: SyncClient, isAdmin: boolean, navigate: (hash: string) => void): Promise<MenuData> {
  try {
    const today = todayInMadrid();
    const [requirements, documents, decisions, people, teams, screens, conflicts] = await Promise.all([
      client.list(T.requirements), client.list(T.keyDocuments), client.list(T.decisions), client.list(T.people), client.list(T.teams),
      client.list(T.reviewScreens), client.conflicts(),
    ]) as unknown as [Row[], Row[], Row[], Row[], Row[], Row[], unknown[]];
    const count = <K extends string>(rows: Row[], keys: readonly K[], labels: Record<string, string>, typeOf: (r: Row) => string, state: (r: Row) => string): TypeCount[] =>
      keys.map((key) => {
        const mine = rows.filter((r) => !r.deleted_at && typeOf(r) === key);
        const states = mine.map(state);
        return { key, label: labels[key] ?? key, total: mine.length, alert: states.filter((s) => s === 'vencido').length, warn: states.filter((s) => s === 'por_vencer').length };
      }).filter((c) => c.total > 0);
    const reqState = (r: Row) => dueState(r.expires_on as string | null, today, Number(r.notice_days ?? 30), CLOSED_REQUIREMENT_STATUSES.includes(String(r.status)));
    const docState = (r: Row) => dueState(r.expires_on as string | null, today, 30, r.status === 'sustituido');
    const live = (rows: Row[]) => rows.filter((r) => !r.deleted_at);
    const progress = reviewProgress(screens as never);
    // Índice de búsqueda (K1, `keepOrder`): lo vigente antes que lo cerrado, en el orden en que se da.
    const open = live(requirements).filter((r) => !CLOSED_REQUIREMENT_STATUSES.includes(String(r.status)) && r.status !== 'cumplido');
    const rest = live(requirements).filter((r) => !open.includes(r));
    const index: PaletteItem[] = [
      ...[...open, ...rest].map((r) => ({ group: 'Obligaciones', text: String(r.name), sub: [r.code, REQUIREMENT_TYPE_LABELS[String(r.requirement_type) as keyof typeof REQUIREMENT_TYPE_LABELS]].filter(Boolean).join(' · '), keywords: fold(String(r.code ?? '')), hint: 'Obligación', run: () => navigate(`#/cumplimiento/${r.id}`) })),
      ...live(documents).sort((a, b) => Number(a.status === 'sustituido') - Number(b.status === 'sustituido')).map((d) => ({ group: 'Documentos', text: String(d.name), sub: [d.code, DOCUMENT_KIND_LABELS[String(d.document_type)]].filter(Boolean).join(' · '), keywords: fold(String(d.code ?? '')), hint: 'Documento', run: () => navigate(`#/cumplimiento/documentos?doc=${d.id}`) })),
      ...live(people).filter((p) => p.active !== false).map((p) => ({ group: 'Personas', text: String(p.display_name ?? ''), hint: 'Persona', run: () => navigate(`#/personas/${p.id}`) })),
      ...live(decisions).sort((a, b) => Number(a.status !== 'vigente') - Number(b.status !== 'vigente')).map((d) => ({ group: 'Decisiones', text: String(d.name), sub: String(d.code ?? ''), keywords: fold(String(d.summary ?? '')).slice(0, 200), hint: 'Decisión', run: () => navigate(`#/decisiones/${d.id}`) })),
      ...live(teams).map((t) => ({ group: 'Equipos', text: String(t.name ?? ''), hint: 'Equipo', run: () => navigate('#/personas/equipos') })),
    ];
    return {
      requirements: count(requirements, REQUIREMENT_TYPES, REQUIREMENT_TYPE_LABELS, (r) => String(r.requirement_type), reqState),
      documents: count(documents, DOCUMENT_KINDS, DOCUMENT_KIND_LABELS, (r) => String(r.document_type), docState),
      openRequirements: open.length,
      liveDocuments: live(documents).filter((d) => d.status !== 'sustituido').length,
      conflicts: conflicts.length,
      review: { ...progress, toAct: isAdmin ? screensToAct(screens as never).length : 0 },
      people: live(people).map((x) => ({ user_id: (x.user_id as string | null) ?? null, display_name: String(x.display_name ?? '') })),
      index,
    };
  } catch {
    return EMPTY_MENU;
  }
}

/** Las secciones del menú (azulejos que despliegan sus filas). */
/** Recuentos de «Cuentas y accesos»: cuentas de personas, las que hay que revisar y las claves de agente en uso. */
export function accessCounts(access: AccessData, people: MenuData['people'], now = Date.now()): { accounts: number; issues: number; agents: number | null } | null {
  if (!access.accounts) return null;
  const catalog = access.catalog ?? [];
  return {
    accounts: access.accounts.filter((a) => a.kind !== 'agent').length,
    issues: catalog.length ? access.accounts.filter((a) => accountIssue(a, catalog, people) !== null).length : 0,
    agents: access.agents ? access.agents.filter((k) => !k.revokedAt && (!k.expiresAt || Date.parse(k.expiresAt) > now)).length : null,
  };
}

export function menuSections(data: MenuData, isAdmin: boolean, userId: string | null, access: AccessData = { online: true, accounts: null, agents: null, catalog: null }): AppMenuSection[] {
  const sum = (rows: TypeCount[]) => rows.reduce((acc, c) => ({ alert: acc.alert + c.alert, warn: acc.warn + c.warn }), { alert: 0, warn: 0 });
  const req = sum(data.requirements);
  const doc = sum(data.documents);
  const kpis = dashboardSummary(userId);
  const sections: AppMenuSection[] = [];
  // Bloque 2 (VG): «Cuentas y accesos» arriba, solo para quien administra, con sus recuentos (MUELA-085 y 086). Sin red,
  // «se leen con red» en lugar de cifras: los accesos se leen en Core en el momento.
  if (isAdmin) {
    const off = !access.online;
    const c = off ? null : accessCounts(access, data.people);
    const issuesText = c?.issues ? `${c.issues} por revisar` : '';
    sections.push({ key: 'cuentas', label: 'Cuentas y accesos', icon: 'lock',
      summary: off ? 'se leen con red' : c ? [plural(c.accounts, 'cuenta', 'cuentas'), issuesText].filter(Boolean).join(' · ') : 'quién entra y con qué',
      badge: c?.issues ? { text: String(c.issues), tone: 'warn' } : null, rows: [
        { label: 'Cuentas', sub: off ? 'se leen con red' : issuesText ? `${issuesText}: sin ficha o con otro nombre` : 'personas con acceso a las apps', icon: 'user',
          count: c ? { text: String(c.accounts), tone: c.issues ? 'warn' : null } : null, href: '#/accesos', feedbackId: 'central.menu.cuentas.cuentas' },
        { label: 'Alta de cuenta', sub: off ? 'necesita conexión' : 'dar acceso a una persona nueva', icon: 'plus', href: '#/accesos/alta', feedbackId: 'central.menu.cuentas.alta' },
        { label: 'Agentes', sub: off ? 'se leen con red' : c?.agents != null ? `${c.agents === 1 ? '1 clave en uso' : `${c.agents} claves en uso`}` : 'claves de los agentes de IA', icon: 'bot',
          count: c?.agents != null ? { text: String(c.agents) } : null, href: '#/accesos/agentes', feedbackId: 'central.menu.cuentas.agentes' },
        { label: 'Registro de accesos', sub: off ? 'se lee con red' : 'quién entró y cuándo', icon: 'eye', href: '#/accesos/registro', feedbackId: 'central.menu.cuentas.registro' },
      ] });
  }
  sections.push({ key: 'entidad', label: 'La entidad', icon: 'briefcase', summary: 'datos, textos y decisiones', badge: data.conflicts ? { text: String(data.conflicts), tone: 'alert' } : null, rows: [
    { label: 'Datos de la entidad', sub: 'razón social, NIF/CIF, IBAN y logotipo', icon: 'briefcase', href: '#/entidad', feedbackId: 'central.menu.entidad.datos' },
    { label: 'Planos del centro', sub: 'el mapa de zonas: dibujos y estancias', icon: 'grid', href: '#/entidad/planos', feedbackId: 'central.menu.entidad.planos' },
    { label: 'Textos y contacto', sub: 'avisos legales, declaraciones y mensajes', icon: 'edit', href: '#/textos', feedbackId: 'central.menu.entidad.textos' },
    { label: 'Registro de decisiones', sub: 'qué se decidió, por qué y cómo se aplica', icon: 'history', href: '#/decisiones', feedbackId: 'central.menu.entidad.decisiones' },
    { label: 'Conflictos', sub: data.conflicts ? `${plural(data.conflicts, 'conflicto', 'conflictos')} por resolver` : 'ninguno pendiente', icon: 'warn',
      count: data.conflicts ? { text: String(data.conflicts), tone: 'alert' } : null, href: '#/conflictos', feedbackId: 'central.menu.entidad.conflictos' },
  ] });
  sections.push({ key: 'oblig', label: 'Obligaciones', icon: 'list', summary: req.alert ? plural(req.alert, 'vencida', 'vencidas') : req.warn ? `${req.warn} ${req.warn === 1 ? 'vence' : 'vencen'} pronto` : 'al día',
    badge: tone(req) ? { text: String(req.alert || req.warn), tone: tone(req) } : null, rows: [
      { label: 'Todas las obligaciones', sub: `${plural(data.openRequirements, 'pendiente', 'pendientes')} · por tipo`, icon: 'list', href: '#/cumplimiento/requisitos', feedbackId: 'central.menu.obligaciones.todas' },
      ...data.requirements.map((c) => ({ label: c.label, sub: stateText(c, ['vencida', 'vencidas']), icon: 'tag', count: { text: String(c.total), tone: tone(c) },
        href: `#/cumplimiento/requisitos?tipo=${c.key}`, feedbackId: 'central.menu.obligaciones.tipo' })),
    ] });
  sections.push({ key: 'docs', label: 'Documentos', icon: 'invoice', summary: doc.alert ? plural(doc.alert, 'caducado', 'caducados') : doc.warn ? `${doc.warn} ${doc.warn === 1 ? 'caduca' : 'caducan'} pronto` : 'al día',
    badge: tone(doc) ? { text: String(doc.alert || doc.warn), tone: tone(doc) } : null, rows: [
      { label: 'Todos los documentos', sub: `${plural(data.liveDocuments, 'vigente', 'vigentes')} · por tipo`, icon: 'invoice', href: '#/cumplimiento/documentos', feedbackId: 'central.menu.documentos.todos' },
      ...data.documents.map((c) => ({ label: c.label, sub: stateText(c, ['caducado', 'caducados']), icon: 'tag', count: { text: String(c.total), tone: tone(c) },
        href: `#/cumplimiento/documentos?tipo=${c.key}`, feedbackId: 'central.menu.documentos.tipo' })),
    ] });
  sections.push({ key: 'direccion', label: 'Dirección', icon: 'board', summary: 'indicadores',
    badge: kpis.some((k) => k.critical) ? { text: String(kpis.reduce((n, k) => n + k.critical, 0)), tone: 'alert' } : kpis.some((k) => k.attention) ? { text: String(kpis.reduce((n, k) => n + k.attention, 0)), tone: 'warn' } : null,
    rows: [
      // La revisión semanal, siempre la primera (VG, 27-10: no la encontraba desde Central).
      { label: 'Revisión semanal', sub: 'lo que está en rojo, notas y acciones', icon: 'list', href: '#/direccion/semana', feedbackId: 'central.menu.direccion.semana' },
      ...(kpis.length ? kpis.map((k) => ({ label: k.name, sub: [plural(k.total, 'indicador', 'indicadores'), k.critical ? plural(k.critical, 'crítico', 'críticos') : '', k.attention ? `${k.attention} en atención` : ''].filter(Boolean).join(' · '),
        icon: 'board', count: k.critical ? { text: String(k.critical), tone: 'alert' as const } : k.attention ? { text: String(k.attention), tone: 'warn' as const } : null, href: `#/?direccion=${k.app}`, feedbackId: 'central.menu.direccion.app' }))
        : [{ label: 'Panel de dirección', sub: 'indicadores de cada app', icon: 'board', href: '#/?direccion', feedbackId: 'central.menu.direccion.panel' }]),
    ] });
  sections.push({ key: 'equipos', label: 'Equipos y oficios', icon: 'people', summary: 'quién hace qué', rows: [
    { label: 'Equipos', sub: 'quién trabaja con quién', icon: 'people', href: '#/personas/equipos', feedbackId: 'central.menu.equipos.equipos' },
    { label: 'Oficios', sub: 'qué sabe hacer cada persona', icon: 'tag', href: '#/personas/oficios', feedbackId: 'central.menu.equipos.oficios' },
  ] });
  sections.push({ key: 'revision', label: 'Revisión', icon: 'check', summary: data.review.total ? `${data.review.done} de ${data.review.total} pasadas` : 'avance y comentarios',
    badge: data.review.toAct ? { text: String(data.review.toAct), tone: 'warn' } : null, rows: [
      { label: 'Avance de las pantallas', sub: data.review.total ? `${data.review.done} de ${data.review.total} pasadas a Sevilla` : 'pantallas y comentarios', icon: 'check', href: '#/revision', feedbackId: 'central.menu.revision.avance' },
      ...(isAdmin ? [{ label: 'Uso y cobertura', sub: 'qué se usa, qué nadie usa y qué no se mide', icon: 'eye', href: '#/revision/uso', feedbackId: 'central.menu.revision.uso' }] : []),
      ...(data.review.toAct ? [{ label: 'Lo que te toca', sub: plural(data.review.toAct, 'pantalla por valorar', 'pantallas por valorar'), icon: 'star', count: { text: String(data.review.toAct), tone: 'warn' as const }, href: '#/revision?toca', feedbackId: 'central.menu.revision.toca' }] : []),
    ] });
  return sections;
}

export { readRecents };
