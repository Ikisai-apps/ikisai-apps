/**
 * Ikisai Tasks · trabajo pedido desde otras apps (docs/tasks/API.md §19). `POST requests/task` crea, una sola vez por
 * referencia, una tarea pedida por otra app (Central) con el token de la persona. No es una acción `invoke`: la tarea
 * pasa por `core.commit` (procedimiento `tasks.request_task`), y así llega a los espejos, al historial y a «deshacer».
 *
 * Idempotencia: el id de la tarea se deriva de `<source>:<external_ref>`. Si ya existe se devuelve tal cual
 * (`created: false`), también si está en la papelera (`deleted: true`): otra app no resucita lo que alguien borró.
 *
 * Enrutado (§20): la petición dice qué es (`kind`) y Tasks decide dónde va: la regla del usuario para ese tipo, la
 * sugerencia `project_id | tab_id` si quien pide la ve, o «Por clasificar». Lo que una regla manda a un área que quien
 * pide no ve entra igualmente (buzón) y quien pide solo recibe su estado (`request`: pending, created o dismissed).
 */
import { createSync, ensureServiceActor, fail, sha256Hex, type AppRoute, type Supabase, type WorkerRoute } from '../_kit/mod.ts';

const SOURCE = /^[a-z][a-z0-9_-]{1,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = ['normal', 'high', 'critical'];
const KIND_NAME = /^[a-z0-9][a-z0-9_.-]{0,60}$/;
const ORIGIN_URL = /^https:\/\/([a-z0-9-]+\.)*ikisai\.com(\/|$)/;
const REPORT_CODE = /^[A-Za-z0-9_-]{1,40}$/;
/** Tipos que Feedback puede pedir por la ruta de worker (contrato de Core, FEEDBACK.md §4): solo lo operativo. */
const FEEDBACK_KINDS = new Set([
  ...['damage', 'cleaning', 'missing', 'utilities', 'safety', 'other'].map((k) => `feedback.space.${k}`),
  ...['setup', 'accommodation', 'cleaning', 'food', 'technical', 'operation', 'other'].map((k) => `feedback.event.${k}`),
]);

/** Uuid v4 derivado de un texto (mismo esquema que los ids deterministas de `mcp.ts`). */
export async function requestTaskId(externalRef: string): Promise<string> {
  const hex = (await sha256Hex(`ikisai-tasks-request:${externalRef}`)).slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type TaskTarget = { id: string; visible?: boolean; request?: string; [key: string]: unknown };

/** Las hijas de una tarea pedida (§42), con el contexto de quien escribe (la persona o la identidad de servicio): primero,
 *  con la lista entera, se pone al día y se retira; después, cada hija que falta en su propio lote (la procedencia de una
 *  tarea se fija una por lote). Repetir completa lo que haya quedado a medias. */
async function writeChildren(internal: ReturnType<typeof createSync>, ctx: Parameters<ReturnType<typeof createSync>['commit']>[0], tag: string,
  parentRef: string, kind: string, children: Array<Record<string, string>>) {
  type ChildOut = { ref: string; taskId: string; status: string };
  type Outcome = { children: ChildOut[]; created: number; updated: number; retired: number };
  const call = async (args: Record<string, unknown>) => ((await internal.commit(ctx, { requestId: `${tag}-children-${crypto.randomUUID()}`,
    operations: [{ op: 'call', procedure: 'tasks.request_children', args: { parentRef, kind, ...args } }] })).results[0] as { result?: Outcome })?.result;
  const first = await call({ children, create: false, retire: true });
  const list = first?.children ?? [];
  let created = 0;
  for (const [i, child] of list.entries()) {
    if (child.status !== 'missing') continue;
    const made = await call({ children: [children.find((c) => c.ref === child.ref)], retire: false });
    list[i] = made?.children[0] ?? child;
    created += made?.created ?? 0;
  }
  return { children: list, childrenCounts: { created, updated: first?.updated ?? 0, retired: first?.retired ?? 0 } };
}


export function requestRoutes(supabase: Supabase): AppRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  return [{
    method: 'POST', pattern: 'requests/task', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Pedir tareas necesita permiso de edición en Tasks.');
      const body = await json() as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      const text = (field: string, max: number, required = false): string | undefined => {
        const value = body[field];
        if (value === undefined || value === null) return required ? invalid(field, `Falta ${field}.`) : undefined;
        if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(field, `${field} debe ser texto de 1 a ${max} caracteres.`);
        return value as string;
      };
      const source = text('source', 31, true)!;
      if (!SOURCE.test(source)) invalid('source', 'source es el id de la app que pide, en minúsculas (p. ej. central).');
      const reference = text('external_ref', 150, true)!.trim();
      const title = text('title', 500, true)!.trim();
      const note = text('note', 20000);
      const due = text('due', 10);
      if (due !== undefined && (!DATE.test(due) || Number.isNaN(Date.parse(due)))) invalid('due', 'due va como AAAA-MM-DD.');
      const priority = text('priority', 10);
      if (priority !== undefined && !PRIORITIES.includes(priority)) invalid('priority', 'priority es normal, high o critical.');
      // Qué es: `<source>.<nombre>`. Sin él (peticiones de §19), `<source>.general`.
      const kind = text('kind', 100) ?? `${source}.general`;
      if (!kind.startsWith(source + '.') || !KIND_NAME.test(kind.slice(source.length + 1))) invalid('kind', `kind va como ${source}.<nombre>, en minúsculas.`);
      const kindLabel = text('kind_label', 100)?.trim() || undefined;
      const externalUrl = text('external_url', 500);
      if (externalUrl !== undefined && !ORIGIN_URL.test(externalUrl)) invalid('external_url', 'external_url debe ser https en ikisai.com.');
      // Dónde, solo como sugerencia: manda la regla del usuario; sin regla ni sugerencia válida, «Por clasificar».
      const projectId = text('project_id', 36), tabId = text('tab_id', 36);
      // De qué espacio de Recursos se avisa (0336): opcional; si no existe o está archivado, la petición entra sin él.
      const spaceId = text('space_id', 36);
      for (const [field, value] of [['project_id', projectId], ['tab_id', tabId], ['space_id', spaceId]] as const) if (value !== undefined && !UUID.test(value)) invalid(field, `${field} debe ser un uuid.`);
      // Hijas (§42): la lista ENTERA de esta petición, cada una con su clave estable; las que dejen de venir se retiran.
      const children = parseChildren(body.children, invalid);

      const externalRef = `${source}:${reference}`;
      const id = await requestTaskId(externalRef);
      // Con la tarea viva y sin hacer, sus hijas; si no (pendiente de clasificar, hecha o en la papelera), `children: null`.
      const withChildren = async <T extends { task: TaskTarget | null }>(out: T) => {
        if (children === undefined) return out;
        // Una petición pendiente o descartada también sale como `kind: 'task'`, pero sin proyecto (tasks.targets, §20).
        const task = out.task as { projectId?: string; visible?: boolean; done?: boolean; deleted?: boolean } | null;
        if (!task?.projectId || task.visible === false || task.done || task.deleted) return { ...out, children: null };
        return { ...out, ...(await writeChildren(internal, ctx, `request-${source}`, externalRef, kind, children)) };
      };
      const read = async () => {
        const out = await supabase.rpc<{ items: TaskTarget[] }>('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.targets', p_args: { kind: 'task', ids: [id] } });
        return out.items[0] ?? null;
      };
      const existing = await read();
      if (existing) return withChildren({ created: false, routed: null, task: existing });

      let created = false, routed: string | null = null;
      try {
        const result = await internal.commit(ctx, {
          requestId: `request-task-${crypto.randomUUID()}`,
          operations: [{ op: 'call', procedure: 'tasks.request_task', args: { id, externalRef, kind, kindLabel, externalUrl, title, note, due, priority, projectId: projectId?.toLowerCase(), tabId: tabId?.toLowerCase(), spaceId: spaceId?.toLowerCase() } }],
        });
        const outcome = (result.results[0] as { result?: { created?: boolean; routed?: string } })?.result;
        created = !!outcome?.created;
        routed = outcome?.routed ?? null;
      } catch (error) {
        // Dos peticiones a la vez: la segunda choca con la tarea que acaba de crear la primera, que es la que se devuelve.
        const raced = await read();
        if (raced) return withChildren({ created: false, routed: null, task: raced });
        throw error;
      }
      const task = await read();
      if (!task) fail(409, 'EXTERNAL_REF_IN_USE', 'Esa referencia ya la usa una tarea que no puedes ver.');
      // Pendiente de clasificar, la tarea aún no existe: las hijas esperan al próximo envío.
      return withChildren({ created, routed, task });
    },
  }, {
    /**
     * `GET requests/projects` (§43): los proyectos abiertos que ve quien pide, para elegir dónde pedir una tarea o una
     * compra (`project_id`). Sin el sistema («Entrada»), sin archivados y sin papelera. Es la capacidad `tasks.projects_open`.
     */
    method: 'GET', pattern: 'requests/projects', handler: async ({ ctx }) => {
      const out = await supabase.rpc<{ tabs?: Array<{ id: string; name: string; deleted?: boolean; projects?: Array<{ id: string; title: string; status: string; system?: string | null; deleted?: boolean }> }> }>(
        'core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.targets', p_args: {} });
      const projects = (out.tabs ?? []).filter((t) => !t.deleted).flatMap((t) => (t.projects ?? [])
        .filter((p) => !p.system && !p.deleted && p.status !== 'archived').map((p) => ({ id: p.id, title: p.title, tabId: t.id, tabName: t.name })));
      return { projects };
    },
  }, {
    /**
     * `POST requests/purchase` (§39, «Pedir a Tasks» desde Flow): una solicitud de compra pedida por otra app con el token
     * de la persona, en un proyecto de Tasks que esa persona ve. Nace «pedida» y la aprueba quien aprueba en el área.
     * Idempotente como `requests/task`: el id se deriva de `<source>:<external_ref>` y repetir devuelve la que ya hay. La
     * procedencia va en la nota («Pedida desde flow · <referencia>»): sin migración.
     */
    method: 'POST', pattern: 'requests/purchase', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Pedir compras necesita permiso de edición en Tasks.');
      const body = await json() as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      const text = (field: string, max: number, required = false): string | undefined => {
        const value = body[field];
        if (value === undefined || value === null) return required ? invalid(field, `Falta ${field}.`) : undefined;
        if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(field, `${field} debe ser texto de 1 a ${max} caracteres.`);
        return value as string;
      };
      const source = text('source', 31, true)!;
      if (!SOURCE.test(source)) invalid('source', 'source es el id de la app que pide, en minúsculas (p. ej. flow).');
      const reference = text('external_ref', 150, true)!.trim();
      const title = text('title', 300, true)!.trim();
      const note = text('note', 4000);
      const unit = text('unit', 20)?.trim() || null;
      const due = text('due', 10);
      if (due !== undefined && (!DATE.test(due) || Number.isNaN(Date.parse(due)))) invalid('due', 'due va como AAAA-MM-DD.');
      const priority = text('priority', 10);
      if (priority !== undefined && !PRIORITIES.includes(priority)) invalid('priority', 'priority es normal, high o critical.');
      const projectId = text('project_id', 36, true)!.toLowerCase();
      if (!UUID.test(projectId)) invalid('project_id', 'project_id debe ser un uuid.');
      const rawQuantity = body.quantity;
      if (rawQuantity !== undefined && rawQuantity !== null && (typeof rawQuantity !== 'number' || !Number.isFinite(rawQuantity) || rawQuantity <= 0 || rawQuantity >= 1e9)) invalid('quantity', 'quantity es un número mayor que 0.');
      const quantity = typeof rawQuantity === 'number' ? Math.round(rawQuantity * 1000) / 1000 : null;
      // El enlace de vuelta a la app que pide (Flow: la unidad), solo https en ikisai.com (§39.5, migración 0342).
      const externalUrl = text('external_url', 500);
      if (externalUrl !== undefined && !ORIGIN_URL.test(externalUrl)) invalid('external_url', 'external_url debe ser https en ikisai.com.');

      // El proyecto: tiene que existir y verlo quien pide (tasks.targets aplica su alcance); de él sale el área.
      const target = async (kind: string, id: unknown): Promise<{ id?: string; tabId?: string; deleted?: boolean; archived?: boolean } | null> => {
        try { return await supabase.rpc<{ id?: string; tabId?: string; deleted?: boolean; archived?: boolean }>('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.targets', p_args: { kind, id } }); } catch { return null; }
      };
      const project = await target('project', projectId);
      if (!project?.tabId || project.deleted) fail(404, 'NOT_FOUND', 'No existe ese proyecto o no lo puedes ver.', { field: 'project_id' });
      if (project!.archived) fail(422, 'PROJECT_ARCHIVED', 'Ese proyecto está archivado: elige uno abierto.', { field: 'project_id' });
      const tabId = project!.tabId!;

      const externalRef = `${source}:${reference}`;
      const id = await requestPurchaseId(externalRef);
      const rows = async () => {
        const out: Array<Record<string, unknown>> = [];
        for (let offset = 0; ; offset += 2000) {
          const page = await supabase.rpc<{ rows: Array<Record<string, unknown>> }>('core_snapshot_table', {
            p_app: 'tasks', p_role: ctx.membership.role, p_table: 'tasks.purchase_requests', p_include_deleted: true, p_limit: 2000, p_offset: offset,
          });
          out.push(...page.rows);
          if (page.rows.length < 2000) return out;
        }
      };
      const shape = (r: Record<string, unknown>) => ({
        kind: 'purchase_request', id: r.id, tabId: r.tab_id, projectId: r.project_id, title: r.title, status: r.status,
        quantity: r.quantity == null ? null : Number(r.quantity), unit: r.unit ?? null, revision: r.revision, deleted: !!r.deleted_at, externalRef,
        externalUrl: r.source_url ?? null,
      });
      // Lo que ya hay con esa referencia solo se devuelve si es del mismo proyecto que se pide (ya comprobado como visible
      // para quien llama). De otro proyecto, aunque sea de su área, no se dice nada: ni datos ni dónde está. Así una
      // referencia no sirve para leer solicitudes ajenas, y una ya usada en otro sitio no se «adopta».
      const visibleRow = async (row: Record<string, unknown>) => {
        if (row.project_id === projectId && row.tab_id === tabId) return row;
        return fail(409, 'EXTERNAL_REF_IN_USE', 'Esa referencia ya la usa otra solicitud.');
      };
      const all = await rows();
      const existing = all.find((r) => r.id === id);
      if (existing) return { created: false, purchase: shape(await visibleRow(existing)) };

      const lastPosition = Math.max(0, ...all.filter((r) => r.tab_id === tabId && !r.deleted_at).map((r) => Number(r.position) || 0));
      const fields: Record<string, unknown> = {
        tab_id: tabId, project_id: projectId, title,
        note: [`Pedida desde ${source} · ${reference}`, note?.trim()].filter(Boolean).join('\n'),
        quantity, unit, priority: priority ?? 'normal', due: due ?? null, needs_invoice: true, position: lastPosition + 1024,
        // Procedencia (0342): agrupa «Compras del evento» en Suministros y da el enlace de vuelta. Inmutable.
        source_app: source, source_ref: reference, source_url: externalUrl ?? null,
      };
      try {
        await internal.commit(ctx, { requestId: `request-purchase-${crypto.randomUUID()}`, operations: [{ op: 'insert', table: 'tasks.purchase_requests', id, fields }] });
      } catch (error) {
        // Dos peticiones a la vez: la segunda choca con el id de la primera, que es la que se devuelve.
        const raced = (await rows()).find((r) => r.id === id);
        if (raced) return { created: false, purchase: shape(await visibleRow(raced)) };
        throw error;
      }
      const row = (await rows()).find((r) => r.id === id);
      if (!row) fail(500, 'NOT_CREATED', 'La solicitud no quedó guardada.');
      return { created: true, purchase: shape(row!) };
    },
  }];
}

/** Uuid v4 de la solicitud de compra pedida desde otra app (espacio aparte del de las tareas). */
export async function requestPurchaseId(externalRef: string): Promise<string> {
  const hex = (await sha256Hex(`ikisai-tasks-purchase:${externalRef}`)).slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Orígenes de sistema (§22.2): qué app puede pedir trabajo desde su worker, sin persona, con qué tipos, con qué
 * identidad de servicio de Core escribe y qué enlace y metadatos lleva. Nada fuera de esta lista entra por aquí.
 */
interface SystemSource {
  service: string;
  kinds: ReadonlySet<string>;
  /** `external_ref` sin el prefijo de la app. */
  reference: RegExp;
  /** `external_url` válido para esta petición. */
  url: (reference: string, url: string) => boolean;
  /** Si `on_behalf_of` es obligatorio (Feedback) u opcional (Booking). */
  behalf: 'required' | 'optional';
  /** Si reenviar la misma referencia actualiza el título y la nota de la tarea abierta (Core, §25). */
  refresh?: boolean;
}
const SYSTEM_SOURCES: Record<string, SystemSource> = {
  feedback: {
    service: 'feedback', kinds: FEEDBACK_KINDS, reference: REPORT_CODE, behalf: 'required',
    url: (reference, url) => url === `https://tasks.ikisai.com/#/feedback/${reference}`,
  },
  booking: {
    // Plazo legal de SES y, desde los portales de organizadores (T3), fechas posibles, «quiere confirmar» y comentarios a la propuesta.
    // `booking.retreat_extra`: un extra contratado de un retiro (§23), que va al proyecto de su reserva (`project_ref`).
    // `booking.event_setup`: el «Montaje del evento» (§42), al proyecto de su reserva, con sus hijas (`children`); se reenvía entero.
    service: 'booking', kinds: new Set(['booking.ses_deadline', 'booking.organizer_dates', 'booking.organizer_confirm', 'booking.proposal_comment', 'booking.retreat_extra', 'booking.event_setup']), reference: /^[A-Za-z0-9_.:-]{1,150}$/, behalf: 'optional',
    url: (_reference, url) => /^https:\/\/booking\.ikisai\.com\/#\/[^\s]{0,190}$/.test(url),
  },
  core: {
    // Tareas que Core escribe para el usuario (§25): referencia del estilo `TV-2.1`, sin enlace. Si se reenvía con otro
    // título o nota, se actualiza la tarea mientras siga abierta.
    service: 'core', kinds: new Set(['core.user_task']), reference: /^[A-Za-z0-9_.-]{1,60}$/, behalf: 'optional', refresh: true,
    url: () => false,
  },
  invoices: {
    // Aviso de facturas de Drive de Finance (§26): por revisar o Drive bloqueado. Pide con la identidad `drive`; si se
    // reenvía con otro título o nota, se actualiza la tarea mientras siga abierta.
    service: 'drive', kinds: new Set(['invoices.drive_review', 'invoices.drive_blocked']), reference: /^drive:[A-Za-z0-9_.:-]{1,140}$/, behalf: 'optional', refresh: true,
    url: (_reference, url) => /^https:\/\/finance\.ikisai\.com\/#\/[^\s]{0,190}$/.test(url),
  },
};
/** Las hijas de una petición de worker (§42): hasta 100, cada una `{external_ref, title, note?, due?, priority?}` con una
 *  clave única. Devuelve la forma que espera `tasks.request_children` (`ref` en lugar de `external_ref`). */
function parseChildren(value: unknown, invalid: (field: string, message: string) => never): Array<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 100) invalid('children', 'children es una lista de hasta 100 hijas.');
  const seen = new Set<string>();
  return (value as unknown[]).map((raw, i) => {
    const field = `children[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(field, `${field} es {external_ref, title, note?, due?, priority?}.`);
    const child = raw as Record<string, unknown>;
    for (const key of Object.keys(child)) if (!['external_ref', 'title', 'note', 'due', 'priority'].includes(key)) invalid(`${field}.${key}`, `Campo no admitido en una hija: ${key}.`);
    const ref = typeof child.external_ref === 'string' ? child.external_ref.trim() : '';
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(ref)) invalid(`${field}.external_ref`, 'external_ref de la hija: de 1 a 100 letras, cifras, «_», «.», «:» o «-».');
    if (seen.has(ref)) invalid(`${field}.external_ref`, `external_ref repetida: ${ref}.`);
    seen.add(ref);
    const title = typeof child.title === 'string' ? child.title.trim() : '';
    if (!title || title.length > 120) invalid(`${field}.title`, 'title de la hija: de 1 a 120 caracteres.');
    const out: Record<string, string> = { ref, title };
    if (child.note !== undefined) { if (typeof child.note !== 'string' || child.note.length > 1000) invalid(`${field}.note`, 'note de la hija: hasta 1000 caracteres.'); out.note = child.note as string; }
    if (child.due !== undefined) { if (typeof child.due !== 'string' || !DATE.test(child.due) || Number.isNaN(Date.parse(child.due))) invalid(`${field}.due`, 'due de la hija va como AAAA-MM-DD.'); out.due = child.due as string; }
    if (child.priority !== undefined) { if (typeof child.priority !== 'string' || !PRIORITIES.includes(child.priority)) invalid(`${field}.priority`, 'priority de la hija es normal, high o critical.'); out.priority = child.priority as string; }
    return out;
  });
}
/** Nombre del tipo cuando quien pide no manda `kind_label`. */
const DEFAULT_KIND_LABELS: Record<string, string> = {
  'core.user_task': 'Core · Tarea para ti',
  'invoices.drive_review': 'Finance · Facturas de Drive por revisar',
  'invoices.drive_blocked': 'Finance · Drive bloqueado',
};
const SYSTEM_REF = new RegExp(`^(${Object.keys(SYSTEM_SOURCES).join('|')}):.{1,150}$`);
/** Avisos de máquina de Food (§22.3): los pide una persona por `requests/task`, pero su estado lo lee la Edge de Food. */
const FOOD_FAULT_REF = /^food:equipment_fault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{4}-\d{2}-\d{2}$/i;

/**
 * Rutas de worker (§22.2 y §22.3), de servidor a servidor con la clave de worker y sin sesión:
 * - `POST worker/requests/task`: una app de la lista pide trabajo; escribe su identidad de servicio por `core.commit`,
 *   con `tasks.request_task` y las reglas del usuario. Quién informó va como metadato (`on_behalf_of`), nunca como
 *   actor. Idempotente por `external_ref`.
 * - `POST worker/requests/status {externalRefs}`: solo el estado de cada petición (pending, open, done, dismissed,
 *   deleted o unknown), para que el worker de quien pidió lo copie. También los avisos de máquina de Food
 *   (`food:equipment_fault:<id>:<día>`), y ninguna otra referencia de `food:`.
 */
export function requestWorkerRoutes(supabase: Supabase): WorkerRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  return [{
    method: 'POST', pattern: 'requests/task', handler: async ({ json, invoke }) => {
      const body = await json() as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      const text = (field: string, max: number, required = false): string | undefined => {
        const value = body?.[field];
        if (value === undefined || value === null) return required ? invalid(field, `Falta ${field}.`) : undefined;
        if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(field, `${field} debe ser texto de 1 a ${max} caracteres.`);
        return (value as string).trim();
      };
      // Solo los campos del contrato: el destino lo deciden las reglas del usuario, nunca quien pide.
      for (const key of Object.keys(body ?? {})) if (!['source', 'kind', 'kind_label', 'external_ref', 'title', 'note', 'external_url', 'on_behalf_of', 'due', 'priority', 'project_ref', 'space_id', 'children'].includes(key)) invalid(key, `Campo no admitido: ${key}.`);
      const sourceName = String(body?.source ?? '');
      const source = Object.hasOwn(SYSTEM_SOURCES, sourceName) ? SYSTEM_SOURCES[sourceName]! : invalid('source', `source debe ser ${Object.keys(SYSTEM_SOURCES).join(' o ')}.`);
      const kind = text('kind', 100, true)!;
      if (!source.kinds.has(kind)) invalid('kind', `Tipo no admitido para ${sourceName}: ${[...source.kinds].join(', ')}.`);
      const reference = text('external_ref', 150, true)!;
      if (!source.reference.test(reference)) invalid('external_ref', 'external_ref no es una referencia válida.');
      const title = text('title', 120, true)!, note = text('note', 1000), kindLabel = text('kind_label', 100) || DEFAULT_KIND_LABELS[kind];
      // Fecha objetivo y urgencia, opcionales, con la misma validación que `requests/task` (Booking: plazo legal de SES).
      const due = text('due', 10);
      if (due !== undefined && (!DATE.test(due) || Number.isNaN(Date.parse(due)))) invalid('due', 'due va como AAAA-MM-DD.');
      const priority = text('priority', 10);
      if (priority !== undefined && !PRIORITIES.includes(priority)) invalid('priority', 'priority es normal, high o critical.');
      const externalUrl = text('external_url', 200);
      if (externalUrl !== undefined && !source.url(reference, externalUrl)) invalid('external_url', `external_url no es un enlace válido para ${sourceName}.`);
      const behalf = body?.on_behalf_of as { kind?: unknown; report_code?: unknown } | undefined;
      if (behalf === undefined || behalf === null) {
        if (source.behalf === 'required') invalid('on_behalf_of', 'Falta on_behalf_of.');
      } else if (typeof behalf !== 'object' || !['internal', 'organizer', 'guest'].includes(String(behalf.kind)) || typeof behalf.report_code !== 'string' || !REPORT_CODE.test(behalf.report_code)
        || Object.keys(behalf).some((k) => k !== 'kind' && k !== 'report_code')) {
        invalid('on_behalf_of', 'on_behalf_of es {kind: internal|organizer|guest, report_code}.');
      }

      // Al proyecto del retiro: un extra (obligatorio) o un reporte de Feedback sobre un retiro (opcional, `feedback.event.*`).
      // `project_ref` es la referencia de la reserva en Booking (`RES<código>`), la misma con la que se creó el proyecto (§23).
      const projectRef = text('project_ref', 150);
      const eventReport = sourceName === 'feedback' && kind.startsWith('feedback.event.');
      const toReservation = kind === 'booking.retreat_extra' || kind === 'booking.event_setup';
      if (toReservation && !projectRef) invalid('project_ref', 'Un extra o un montaje necesita project_ref (la referencia de su reserva).');
      if (projectRef !== undefined && ((!toReservation && !eventReport) || !SYSTEM_SOURCES.booking!.reference.test(projectRef))) {
        invalid('project_ref', 'project_ref solo vale para booking.retreat_extra, booking.event_setup y feedback.event.*, y es una referencia de reserva.');
      }

      // Hijas (§42): la lista ENTERA de esta petición, cada una con su clave estable. Las que dejen de venir se retiran.
      const children = parseChildren(body?.children, invalid);

      // De qué espacio de Recursos se avisa (0336; Feedback, el sitio del reporte): opcional, como en `requests/task`.
      const spaceId = text('space_id', 36);
      if (spaceId !== undefined && !UUID.test(spaceId)) invalid('space_id', 'space_id debe ser un uuid.');

      const externalRef = `${sourceName}:${reference}`;
      const id = await requestTaskId(externalRef);
      const status = async () => ((await invoke('tasks.requests_status', { externalRefs: [externalRef] })) as { items: Array<{ status: string; taskId: string | null }> }).items[0]!;
      const reply = (current: { status: string }) => ({ taskId: id, status: current.status });
      const refreshes = source.refresh || kind === 'booking.event_setup' || children !== undefined;
      // Las hijas, con la madre ya creada o reenviada y abierta; si no está abierta, no se tocan (`children: null`).
      let childCtx: Awaited<ReturnType<typeof internal.context>> | null = null;
      const withChildren = async <T extends { status: string }>(out: T) => {
        if (children === undefined) return out;
        if (out.status !== 'open' || !childCtx) return { ...out, children: null };
        return { ...out, ...(await writeChildren(internal, childCtx, sourceName, externalRef, kind, children)) };
      };
      const before = await status();
      if (before.status !== 'unknown' && !(refreshes && before.status === 'open')) return reply(before);

      let actor = ((await invoke('tasks.service_actor', { name: source.service })) as { actor: string | null }).actor;
      // Core no tiene Edge propia que cree su identidad (Booking y Feedback la crean en su tick): se crea aquí la primera vez.
      if (!actor && source.service === 'core') actor = await ensureServiceActor(supabase, 'core');
      if (!actor) fail(503, 'SERVICE_NOT_READY', `La identidad de servicio «${source.service}» aún no existe.`);
      const ctx = await internal.context({ id: actor!, email: null, sessionId: `service:${source.service}`, kind: 'human' }, '');
      childCtx = ctx;
      if (before.status !== 'unknown') {
        // Reenvío de una tarea abierta (§25): título y nota nuevos, si cambiaron; si no, no se escribe nada.
        const refreshed = await internal.commit(ctx, { requestId: `${sourceName}-${crypto.randomUUID()}`,
          operations: [{ op: 'call', procedure: 'tasks.refresh_request_task', args: { externalRef, title, ...(note !== undefined ? { note } : {}) } }] });
        return withChildren({ ...reply(before), updated: Boolean((refreshed.results[0] as { result?: { updated?: boolean } })?.result?.updated) });
      }
      const send = (toProject: boolean) => internal.commit(ctx, {
        requestId: `${sourceName}-${crypto.randomUUID()}`,
        operations: [{ op: 'call', procedure: 'tasks.request_task', args: {
          id, externalRef, kind, kindLabel, externalUrl, title, note, due, priority, ...(spaceId ? { spaceId: spaceId.toLowerCase() } : {}), ...(toProject && projectRef ? { projectRef: `booking:${projectRef}` } : {}), ...(behalf ? { onBehalfOf: { kind: behalf.kind, report_code: behalf.report_code } } : {}),
        } }],
      });
      try {
        let committed = await send(true);
        if ((committed.results[0] as { result?: { routed?: string } })?.result?.routed === 'no_project') {
          // Un reporte de Feedback no espera al proyecto: sin él, va por la regla de su tipo (o a «Por clasificar»).
          if (eventReport) committed = await send(false);
          else fail(409, 'PROJECT_NOT_READY', 'El proyecto de esa reserva aún no existe: pide antes el proyecto (requests/project).', { project_ref: projectRef });
        }
      } catch (error) {
        if ((error as { code?: string })?.code === 'PROJECT_NOT_READY') throw error;
        // Dos reintentos a la vez: el segundo choca con la petición que acaba de dar de alta el primero.
        const raced = await status();
        if (raced.status !== 'unknown') return withChildren(reply(raced));
        throw error;
      }
      return withChildren(reply(await status()));
    },
  }, {
    /**
     * `POST worker/requests/project` (§23, peticiones T1 de Organizers): el proyecto de un retiro, idempotente por la
     * reserva. Tasks compone el nombre `AAAAMMDD-<título>`; lo crea en el área de la regla del usuario para su tipo, lo
     * renombra si cambian la fecha o el título, lo archiva con `state: 'cancelled'` y lo desarchiva al volver a
     * confirmarse. Responde `{projectId, status}`.
     */
    method: 'POST', pattern: 'requests/project', handler: async ({ json, invoke }) => {
      const body = await json() as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      for (const key of Object.keys(body ?? {})) if (!['source', 'kind', 'external_ref', 'date', 'title', 'note', 'state'].includes(key)) invalid(key, `Campo no admitido: ${key}.`);
      if (body?.source !== 'booking') invalid('source', 'source debe ser booking.');
      if (body?.kind !== 'booking.retreat_project') invalid('kind', 'kind debe ser booking.retreat_project.');
      const reference = typeof body.external_ref === 'string' ? body.external_ref.trim() : '';
      if (!SYSTEM_SOURCES.booking!.reference.test(reference)) invalid('external_ref', 'external_ref es la referencia de la reserva.');
      const date = body.date;
      if (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(date))) invalid('date', 'date va como AAAA-MM-DD (día de entrada).');
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > 280) invalid('title', 'title es el título del retiro, de 1 a 280 caracteres.');
      if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000)) invalid('note', 'note es texto de hasta 1000 caracteres.');
      const state = body.state ?? 'confirmed';
      if (state !== 'confirmed' && state !== 'cancelled') invalid('state', 'state es confirmed o cancelled.');

      const externalRef = `booking:${reference}`;
      const actor = ((await invoke('tasks.service_actor', { name: 'booking' })) as { actor: string | null }).actor;
      if (!actor) fail(503, 'SERVICE_NOT_READY', 'La identidad de servicio «booking» aún no existe.');
      const ctx = await internal.context({ id: actor!, email: null, sessionId: 'service:booking', kind: 'human' }, '');
      const projectId = await requestTaskId(externalRef);
      const run = () => internal.commit(ctx, {
        requestId: `booking-project-${crypto.randomUUID()}`,
        operations: [{ op: 'call', procedure: 'tasks.request_project', args: {
          id: projectId, externalRef, kind: 'booking.retreat_project', name: `${(date as string).replaceAll('-', '')}-${title}`, note: body.note ?? '', state,
        } }],
      });
      let result;
      try { result = await run(); } catch (error) {
        // Dos peticiones a la vez para la misma reserva: la segunda choca con el proyecto que acaba de crear la primera.
        result = await run();
      }
      const out = (result.results[0] as { result?: { id: string | null; status: string } })?.result;
      return { projectId: out?.id ?? null, status: out?.status ?? 'unknown' };
    },
  }, {
    method: 'POST', pattern: 'requests/status', handler: async ({ json, invoke }) => {
      const body = await json() as { externalRefs?: unknown };
      const refs = body?.externalRefs;
      if (!Array.isArray(refs) || refs.length > 200 || refs.some((r) => typeof r !== 'string' || !(SYSTEM_REF.test(r) || FOOD_FAULT_REF.test(r)))) {
        fail(422, 'INVALID_INPUT', `externalRefs: hasta 200 referencias de ${Object.keys(SYSTEM_SOURCES).join(', ')} o avisos de máquina de Food.`, { field: 'externalRefs' });
      }
      return invoke('tasks.requests_status', { externalRefs: refs });
    },
  }];
}
