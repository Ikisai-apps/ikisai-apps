/**
 * Ikisai Tasks · personas de Central en lugar de la familia «Grupo: Persona» (fase P2, PR 3a; docs/tasks/API.md §33).
 *
 * La vista previa PROPONE una ficha de Central para cada etiqueta de persona (`proposePerson`, con lo que publica Central
 * para Tasks: `central.people_options`, leída como lectura registrada con el usuario que pide) y la propietaria CONFIRMA cada
 * una. La ida exige la correspondencia confirmada de todas las etiquetas usadas; los procedimientos SQL revalidan cada
 * persona con `central.person_alive`. Todo, solo para la propietaria humana con acceso completo.
 * - `POST read/tasks.people_preview {mapping?}` (lo desvía `createTasksApp` a `actions/people-preview`): vista previa.
 * - `POST actions/people-to-central {requestId, mapping}`: la ida. `CENTRAL_PEOPLE_EMPTY` si Central no tiene personas con
 *   nivel de casa.
 * - `POST actions/people-to-labels {requestId, dropUnmapped?}`: la vuelta, con la correspondencia guardada.
 * `mapping` = `{ "<labelId>": "<personId>" | "level:staff|outsider|direccion" | "remove" }`; basta una etiqueta de cada
 * grupo (las copias por área de la misma persona reciben lo mismo).
 */
import { createSync, fail, type AppRoute, type RequestContext, type Supabase } from '../_kit/mod.ts';
import {
  isAdministrator, isPeopleMapValue, personLabelGroups, proposalValue, proposePerson,
  type FamilyRow, type LabelRow, type PersonLabelGroup, type PersonOption, type Role, type SettingRow, type TabRow,
} from '../_domain/tasks/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 2000;

export function peopleRoutes(supabase: Supabase): AppRoute[] {
  /** Confirmaciones y lecturas internas: mismo `core.commit`, sin el `beforeCommit` que veta los `call` de clientes. */
  const internal = createSync(supabase, 'tasks', {});
  const admin = (ctx: RequestContext) => {
    if (!isAdministrator({ role: ctx.membership.role as Role, scopes: ctx.membership.scopes, kind: ctx.bootstrap.profile.kind })) {
      fail(403, 'FORBIDDEN', 'Se necesita un propietario con acceso a toda la app.');
    }
  };

  /** Las personas activas de Central, leídas con el usuario que pide. Si no se pueden leer, error claro. */
  async function peopleOptions(ctx: RequestContext): Promise<PersonOption[]> {
    const rows: PersonOption[] = [];
    try {
      for (let offset = 0; ; offset += PAGE) {
        const page = await internal.read(ctx, 'central.people_options', { limit: PAGE, offset }) as { rows?: PersonOption[]; total?: number } | null;
        if (!page || !Array.isArray(page.rows)) throw new Error('lectura sin filas');
        rows.push(...page.rows);
        if (page.rows.length < PAGE || rows.length >= Number(page.total ?? 0)) break;
      }
    } catch (error) {
      console.error('[tasks] central.people_options', (error as Error)?.message);
      fail(503, 'CENTRAL_UNAVAILABLE', 'No se pudo leer la lista de personas de Central. Inténtalo de nuevo más tarde.');
    }
    return rows.filter((p) => p && typeof p.person_id === 'string' && p.active !== false);
  }

  async function table<T>(ctx: RequestContext, name: 'tasks.families' | 'tasks.labels' | 'tasks.tabs' | 'tasks.settings'): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await supabase.rpc<{ rows: T[] }>('core_snapshot_table', { p_app: 'tasks', p_role: ctx.membership.role, p_table: name, p_include_deleted: false, p_limit: PAGE, p_offset: offset });
      rows.push(...page.rows);
      if (page.rows.length < PAGE) return rows;
    }
  }

  /** Lo confirmado de cada grupo: la correspondencia guardada por la última ida (si sus copias no se contradicen). */
  const confirmedOf = (group: PersonLabelGroup, saved: Record<string, unknown>): string | null => {
    const values = new Set(group.labelIds.map((id) => saved[id]).filter(isPeopleMapValue));
    return values.size === 1 ? [...values][0]! : null;
  };

  /** El `mapping` de la petición, extendido a todas las copias de cada grupo. */
  function expand(mapping: unknown, groups: readonly PersonLabelGroup[]): Map<string, string> {
    const raw = mapping ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 2000) fail(422, 'INVALID_OPERATION', 'mapping es un objeto {labelId: personId | level:<nivel> | remove}.');
    const out = new Map<string, string>();
    const byLabel = new Map(groups.flatMap((g) => g.labelIds.map((id) => [id, g] as const)));
    for (const [labelId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!UUID.test(labelId) || typeof value !== 'string' || !isPeopleMapValue(value.toLowerCase())) {
        fail(422, 'INVALID_OPERATION', 'mapping es un objeto {labelId: personId | level:<nivel> | remove}.', { labelId });
      }
      const group = byLabel.get(labelId.toLowerCase());
      for (const id of group ? group.labelIds : [labelId.toLowerCase()]) {
        const previous = out.get(id);
        if (previous !== undefined && previous !== value.toLowerCase()) fail(422, 'INVALID_OPERATION', 'Dos valores distintos para la misma persona.', { labelId: id });
        out.set(id, value.toLowerCase());
      }
    }
    return out;
  }

  async function preview(ctx: RequestContext, body: Record<string, unknown>) {
    const [options, families, labels, tabs, settings] = await Promise.all([
      peopleOptions(ctx), table<FamilyRow>(ctx, 'tasks.families'), table<LabelRow>(ctx, 'tasks.labels'), table<TabRow>(ctx, 'tasks.tabs'), table<SettingRow>(ctx, 'tasks.settings'),
    ]);
    const saved = (settings.find((s) => s.key === 'people_map')?.value ?? {}) as Record<string, unknown>;
    const groups = personLabelGroups(families, labels);
    const mapping = expand(body.mapping, groups);
    const people = options.filter((o) => o.house_level).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const items = groups.map((g) => {
      const proposal = proposePerson(g.name, people);
      const confirmed = confirmedOf(g, saved);
      const chosen = mapping.get(g.labelIds[0]!) ?? null;
      return { g, proposal, confirmed, chosen, value: chosen ?? confirmed ?? proposalValue(proposal) };
    });
    const map = items.flatMap((i) => i.g.labelIds.map((labelId) => ({ labelId, value: i.value, group: i.g.key })));
    const out = await internal.read(ctx, 'tasks.people_preview', { map }) as Record<string, any>;
    const names = new Map(people.map((p) => [p.person_id, p]));
    const centralEmpty = people.length === 0;
    if (out.source === 'central') {
      for (const item of out.lost ?? []) {
        const person = names.get(item.value) ?? options.find((o) => o.person_id === item.value);
        if (person) Object.assign(item, { personId: person.person_id, name: person.name, initials: person.initials ?? null });
        else if (String(item.value).startsWith('level:')) item.houseLevel = String(item.value).slice(6);
      }
      return { ...out, people: people.map(option), ...(centralEmpty ? { centralEmpty } : {}) };
    }
    const usage = new Map<string, Record<string, any>>((out.groups ?? []).map((g: Record<string, any>) => [g.group, g]));
    const tabName = new Map(tabs.map((t) => [t.id, t.name]));
    const result = items.filter((i) => usage.has(i.g.key)).map((i) => {
      const u = usage.get(i.g.key)!;
      const labelIds = (u.labelIds ?? []) as string[];
      return {
        labelId: labelIds[0], labelIds, name: i.g.name, parentName: i.g.parentName,
        areas: i.g.tabIds.map((tabId) => ({ tabId, name: tabId ? tabName.get(tabId) ?? null : 'General' })),
        tasks: u.tasks, projects: u.projects, owners: u.owners, routes: u.routes,
        used: u.tasks + u.projects + u.owners + u.routes > 0,
        proposal: i.proposal, confirmed: i.confirmed, ...(i.chosen ? { chosen: i.chosen } : {}),
      };
    }).sort((a, b) => (a.parentName ?? '').localeCompare(b.parentName ?? '', 'es') || a.name.localeCompare(b.name, 'es'));
    return {
      source: 'labels', families: out.families, counts: out.counts, labels: result,
      unconfirmed: out.unconfirmed ?? [], people: people.map(option), ...(centralEmpty ? { centralEmpty } : {}),
    };
  }

  const option = (p: PersonOption) => ({ personId: p.person_id, name: p.name, initials: p.initials ?? null, houseLevel: p.house_level });

  const requestId = (value: unknown) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
    return value as string;
  };

  async function commit(ctx: RequestContext, id: string, procedure: string, args: Record<string, unknown>) {
    const committed = await internal.commit(ctx, { requestId: id, operations: [{ op: 'call', procedure, args }] });
    const result = (committed.results[0] as { result?: { source: string; counts: Record<string, number> } })?.result;
    return { source: result?.source, counts: result?.counts ?? {}, cursor: committed.cursor };
  }

  return [
    { method: 'POST', pattern: 'actions/people-preview', handler: async ({ ctx, json }) => { admin(ctx); return preview(ctx, await json()); } },
    {
      method: 'POST', pattern: 'actions/people-to-central', handler: async ({ ctx, json }) => {
        admin(ctx);
        const body = await json();
        const id = requestId(body.requestId);
        if (body.mapping === undefined || body.mapping === null) fail(422, 'INVALID_OPERATION', 'Falta mapping: la propietaria confirma cada etiqueta.');
        const [options, families, labels] = await Promise.all([peopleOptions(ctx), table<FamilyRow>(ctx, 'tasks.families'), table<LabelRow>(ctx, 'tasks.labels')]);
        if (!options.some((o) => o.house_level)) fail(422, 'CENTRAL_PEOPLE_EMPTY', 'Central todavía no tiene personas con nivel de casa: ponlo allí antes de pasar las personas.');
        const mapping = expand(body.mapping, personLabelGroups(families, labels));
        const map = [...mapping].map(([labelId, value]) => ({ labelId, value }));
        return commit(ctx, id, 'tasks.people_to_central', { map });
      },
    },
    {
      method: 'POST', pattern: 'actions/people-to-labels', handler: async ({ ctx, json }) => {
        admin(ctx);
        const body = await json();
        return commit(ctx, requestId(body.requestId), 'tasks.people_to_labels', { dropUnmapped: body.dropUnmapped === true });
      },
    },
  ];
}

/**
 * La vista previa se pide como las demás lecturas (`POST read/tasks.people_preview`), pero antes hay que leer Central con
 * el usuario: el kit sirve `read/:name` directamente desde SQL, así que esa ruta se desvía a `actions/people-preview`.
 */
export function withPeoplePreview(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  const READ = /\/api\/v1\/read\/tasks\.people_preview\/?$/;
  return async (request) => {
    if (request.method !== 'POST') return handler(request);
    const url = new URL(request.url);
    if (!READ.test(url.pathname)) return handler(request);
    url.pathname = url.pathname.replace(READ, '/api/v1/actions/people-preview');
    const body = await request.arrayBuffer();
    return handler(new Request(url, { method: 'POST', headers: request.headers, body }));
  };
}
