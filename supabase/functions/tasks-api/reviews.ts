/**
 * Ikisai Tasks · «Revisión de apertura» (encargo de VG por Core, 27-10-2026; docs/tasks/API.md §46). Las revisiones y sus
 * resultados solo se escriben con sus procedimientos: la app los pide por estas rutas, con la persona (su rol y su ámbito
 * los vuelve a comprobar el SQL), nunca con un `call` desde `commands`.
 *
 * - `POST reviews {templateId, tabId, title?, eventRef?, due?, reviewId?}`: crea la revisión desde su plantilla
 *   (`tasks.review_create`): el proyecto, una madre por zona y una hija por ítem. `reviewId` (uuid) hace la petición
 *   repetible; sin él, uno nuevo. Responde `{reviewId, projectId, created, items?}`.
 * - `POST reviews/result {itemId, result: ok|fail, value?, text?, fileId?}`: el resultado de un ítem
 *   (`tasks.review_item_result`, §46.3). Un fallo crea la correctiva y «volver a comprobar»; solo un nuevo «ok» verifica.
 *   Es la capacidad `tasks.review_item_result` del catálogo (Flow marca desde su lista de comprobación).
 * - `POST reviews/open {reviewId, override?, note?}`: «Lista para abrir» (`tasks.review_open`, §46.4). Con críticos
 *   pendientes, 409 `REVIEW_NOT_READY`, salvo una owner con el área entera, `override` y una nota.
 * - `GET reviews/projection?reviewId=…|eventRef=…`: la revisión con sus zonas, ítems y totales
 *   (`tasks.review_items_projection`); capacidad `tasks.review_projection`. También quien solo lee.
 */
import { createSync, fail, type AppRoute, type Supabase } from '../_kit/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_REF = /^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9_.:/-]{1,150}$/;

export function reviewRoutes(supabase: Supabase): AppRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  // Los procedimientos comprueban rol y ámbito en SQL. Los agentes no pasan por aquí: esto sería saltarse su revisión de riesgo.
  const call = async (ctx: Parameters<typeof internal.commit>[0], procedure: string, args: Record<string, unknown>) => {
    if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', 'Un agente no marca ni abre revisiones por esta ruta.');
    return ((await internal.commit(ctx, { requestId: `${procedure}-${crypto.randomUUID()}`, operations: [{ op: 'call', procedure, args }] })).results[0] as { result?: unknown })?.result;
  };

  return [{
    method: 'POST', pattern: 'reviews', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Crear una revisión necesita permiso de edición en Tasks.');
      const body = (await json().catch(() => ({}))) as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      const id = (field: string, required: boolean): string | undefined => {
        const v = body[field];
        if (v === undefined || v === null) return required ? invalid(field, `Falta ${field}.`) : undefined;
        if (typeof v !== 'string' || !UUID.test(v)) invalid(field, `${field} debe ser un uuid.`);
        return (v as string).toLowerCase();
      };
      const templateId = id('templateId', true)!, tabId = id('tabId', true)!, reviewId = id('reviewId', false) ?? crypto.randomUUID();
      const title = body.title;
      if (title !== undefined && (typeof title !== 'string' || title.length > 200)) invalid('title', 'title es texto de hasta 200 caracteres.');
      const eventRef = body.eventRef;
      if (eventRef !== undefined && eventRef !== null && (typeof eventRef !== 'string' || !EVENT_REF.test(eventRef))) invalid('eventRef', 'eventRef va como <app>:<referencia>, p. ej. booking:RES2026-80.');
      const due = body.due;
      if (due !== undefined && due !== null && (typeof due !== 'string' || !DATE.test(due) || Number.isNaN(Date.parse(due)))) invalid('due', 'due va como AAAA-MM-DD.');
      return await call(ctx, 'tasks.review_create', { reviewId, templateId, tabId, title: title ?? null, eventRef: eventRef ?? null, due: due ?? null });
    },
  }, {
    method: 'POST', pattern: 'reviews/result', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Marcar una revisión necesita permiso de edición en Tasks.');
      const body = (await json().catch(() => ({}))) as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      for (const key of Object.keys(body)) if (!['requestId', 'itemId', 'result', 'value', 'text', 'fileId'].includes(key)) invalid(key, `Campo no admitido: ${key}.`);
      if (typeof body.itemId !== 'string' || !UUID.test(body.itemId)) invalid('itemId', 'itemId debe ser un uuid.');
      if (body.result !== 'ok' && body.result !== 'fail') invalid('result', 'result es ok o fail.');
      if (body.value !== undefined && body.value !== null && (typeof body.value !== 'number' || !Number.isFinite(body.value))) invalid('value', 'value es un número.');
      if (body.text !== undefined && body.text !== null && (typeof body.text !== 'string' || body.text.length > 2000)) invalid('text', 'text es texto de hasta 2000 caracteres.');
      if (body.fileId !== undefined && body.fileId !== null && (typeof body.fileId !== 'string' || !UUID.test(body.fileId))) invalid('fileId', 'fileId debe ser un uuid.');
      return await call(ctx, 'tasks.review_item_result', {
        itemId: (body.itemId as string).toLowerCase(), result: body.result, value: body.value ?? null, text: body.text ?? null, fileId: typeof body.fileId === 'string' ? body.fileId.toLowerCase() : null,
      });
    },
  }, {
    method: 'POST', pattern: 'reviews/open', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Abrir una revisión necesita permiso de edición en Tasks.');
      const body = (await json().catch(() => ({}))) as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      if (typeof body.reviewId !== 'string' || !UUID.test(body.reviewId)) invalid('reviewId', 'reviewId debe ser un uuid.');
      if (body.override !== undefined && typeof body.override !== 'boolean') invalid('override', 'override es true o false.');
      if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 2000)) invalid('note', 'note es texto de hasta 2000 caracteres.');
      return await call(ctx, 'tasks.review_open', { reviewId: (body.reviewId as string).toLowerCase(), override: body.override === true, note: body.note ?? null });
    },
  }, {
    method: 'GET', pattern: 'reviews/projection', handler: async ({ ctx, url }) => {
      const reviewId = url.searchParams.get('reviewId'), eventRef = url.searchParams.get('eventRef');
      if (reviewId !== null && !UUID.test(reviewId)) fail(422, 'INVALID_INPUT', 'reviewId debe ser un uuid.', { field: 'reviewId' });
      if (eventRef !== null && !EVENT_REF.test(eventRef)) fail(422, 'INVALID_INPUT', 'eventRef va como <app>:<referencia>.', { field: 'eventRef' });
      if (!reviewId && !eventRef) fail(422, 'INVALID_INPUT', 'Falta reviewId o eventRef.', { field: 'reviewId' });
      return await supabase.rpc('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.review_items_projection',
        p_args: reviewId ? { reviewId: reviewId.toLowerCase() } : { eventRef } });
    },
  }];
}
