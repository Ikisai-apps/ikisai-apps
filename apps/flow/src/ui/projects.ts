import { el, renderCover, replace } from '@ikisai/ui-kit';
import { TABLES } from '@ikisai/domain-flow';
import { loadProjects, projectDates, projectState, type Project } from '../app/data.ts';
import { coverUrl } from '../app/documents.ts';
import type { ViewMount } from './shell.ts';

/**
 * Entrada común a Flow (traspaso V0.3 §2.1; flow-19): la pantalla de antes de entrar en un flujo.
 * - Grupos: Ahora, Próximos, Pasados y cerrados (plegado) y, para el encargado, Pruebas. En una jornada conviven varios
 *   flujos (barra, llegadas, preparación, avance) y cada persona entra en el suyo, sin una pantalla global.
 * - Cada tarjeta dice para qué es, cuándo y de qué evento (o «General»), cuánta gente lleva trabajo, lo pendiente, lo urgente
 *   y la vista recomendada, y entra directo en ella.
 * - Sin crear flujos desde aquí (VG, 27-10): los diseña Dirección con Core.
 * Cada persona ve sus flujos (ámbitos, 0902); Dirección, todos.
 */
interface Column { project_id: string; key: string; position: number; deleted_at: string | null }
interface UnitRow { project_id: string; kind: string; status: string; assigned_to: string | null; priority: boolean; prio?: string | null; deleted_at: string | null }
interface BookingEvent { event_id: string; name: string }

/** Para qué es cada plantilla y su vista recomendada (Carriles, Secuencial o Guiado). */
const PURPOSE: Record<string, { text: string; view: 'Carriles' | 'Secuencial' | 'Guiado' }> = {
  barra: { text: 'Pedidos, cocina, entrega e ingredientes de la barra', view: 'Carriles' },
  checkin: { text: 'Llegadas, camas, firma y salidas de los huéspedes', view: 'Carriles' },
  avance: { text: 'El trabajo de cada agente y las decisiones de Dirección', view: 'Carriles' },
};
const COLUMN_SLUG: Record<string, string> = { order: 'caja', prep: 'preparacion', ingredients: 'ingredientes', service: 'servicio', logistics: 'logistica',
  arrival: 'llegada', bed: 'cama', signature: 'firma', departure: 'salida', avance: 'avance' };

type Group = 'now' | 'next' | 'past' | 'test';
const GROUPS: Array<[Group, string]> = [['now', 'Ahora'], ['next', 'Próximos'], ['past', 'Pasados y cerrados'], ['test', 'Pruebas']];
function groupOf(p: Project, today: string): Group {
  if (p.test_mode) return 'test';
  if (p.status === 'closed' || (p.ends_on && p.ends_on < today)) return 'past';
  if (p.starts_on && p.starts_on > today) return 'next';
  return 'now';
}

export const mountProjects: ViewMount = ({ main, client, navigate }) => {
  const host = el('div', { class: 'flow-entry' });
  const role = client.bootstrap()?.membership.role ?? '';
  const isOwner = role === 'owner';
  const canRun = ['editor', 'owner'].includes(role);
  main.append(el('h1', { class: 'col-title' }, 'Flujos'),
    ...(canRun ? [el('a', { class: 'ghost button-link', href: '#/recorridos' }, 'Recorridos')] : []),
    host);
  let events = new Map<string, string>();
  void client.api<{ rows: BookingEvent[] }>('/read/booking.event_projection?limit=500')
    .then((r) => { events = new Map((r.rows ?? []).map((e) => [e.event_id, e.name])); void paint(); }).catch(() => undefined);

  async function paint(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const [projects, columns, units] = await Promise.all([loadProjects(client), client.list(TABLES.columns), client.list(TABLES.units)]);
    const cols = (columns as unknown as Column[]).filter((c) => !c.deleted_at);
    const work = (units as unknown as UnitRow[]).filter((u) => !u.deleted_at && (u.status === 'pending' || u.status === 'in_progress'));
    const covers = new Map(await Promise.all(projects.map(async (p) => [p.id, await coverUrl(client, p)] as const)));
    if (!projects.length) { replace(host, el('p', { class: 'muted' }, 'Aún no tienes ningún flujo asignado. Pide acceso a Dirección.')); return; }

    const card = (p: Project) => {
      const purpose = PURPOSE[p.template_key ?? ''];
      const first = cols.filter((c) => c.project_id === p.id).sort((a, b) => a.position - b.position)[0];
      // Vista recomendada: Carriles entra en la primera columna (el tablero); si no hay columnas, el Inicio del flujo.
      // La v1 congelada entra como siempre, por su Inicio.
      const target = !p.frozen && purpose?.view === 'Carriles' && first ? `#/p/${p.id}/${COLUMN_SLUG[first.key] ?? first.key}` : `#/p/${p.id}`;
      const mine = work.filter((u) => u.project_id === p.id && u.kind !== 'station');
      const people = new Set(mine.map((u) => u.assigned_to).filter(Boolean)).size;
      const urgent = mine.filter((u) => u.priority || u.prio === 'urgente').length;
      const context = p.booking_event_id ? (events.get(p.booking_event_id) ?? 'Evento de Booking') : 'General';
      const facts: Array<[string, boolean]> = [
        ...(purpose?.text ?? p.notes ? [[purpose?.text ?? p.notes ?? '', false] as [string, boolean]] : []),
        [`${context}${projectDates(p) ? ` · ${projectDates(p)}` : ''}`, false],
        [mine.length ? `${mine.length} pendientes${people ? ` · ${people} ${people === 1 ? 'persona' : 'personas'}` : ''}` : 'Nada pendiente', false],
        ...(urgent ? [[`${urgent} ${urgent === 1 ? 'urgente' : 'urgentes'}`, true] as [string, boolean]] : []),
      ];
      return el('div', { class: `flow-card${p.status === 'closed' ? ' is-closed' : ''}`, role: 'listitem' },
        renderCover({
          title: p.name,
          image: covers.get(p.id) ?? p.cover_image,
          pill: projectState(p),
          pillTone: p.status === 'active' && p.starts_on && projectState(p).startsWith('Ahora') ? 'ok' : null,
          stats: purpose?.view ? `Vista: ${purpose.view}` : null,
          headingLevel: 2,
          onOpen: () => navigate(target),
          feedbackId: 'flow.flujos.tarjeta',
        }),
        el('ul', { class: 'flow-card-facts' }, ...facts.map(([f, urgentFact]) => el('li', { class: urgentFact ? 'is-urgent' : '' }, f))));
    };

    const byGroup = new Map<Group, Project[]>();
    for (const p of projects) { const g = groupOf(p, today); if (g === 'test' && !isOwner) continue; byGroup.set(g, [...(byGroup.get(g) ?? []), p]); }
    replace(host, ...GROUPS.filter(([g]) => byGroup.get(g)?.length).map(([g, label]) => {
      const items = el('div', { class: 'flows', role: 'list', 'aria-label': label }, ...byGroup.get(g)!.map(card));
      return g === 'past'
        ? el('details', { class: 'flow-entry-group' }, el('summary', null, `${label} (${byGroup.get(g)!.length})`), items)
        : el('section', { class: 'flow-entry-group', 'aria-label': label }, el('h2', { class: 'flow-entry-title' }, label), items);
    }));
  }

  const off = client.onTable(TABLES.projects, () => void paint());
  void paint();
  return off;
};
