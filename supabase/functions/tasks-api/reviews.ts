/**
 * Ikisai Tasks · «Revisión de apertura» (encargo de VG por Core, 27-10-2026; docs/tasks/API.md §46). Las revisiones y sus
 * resultados solo se escriben con sus procedimientos: la app los pide por estas rutas, con la persona (su rol y su ámbito
 * los vuelve a comprobar el SQL), nunca con un `call` desde `commands`.
 *
 * - `POST reviews {templateId, tabId, title?, eventRef?, due?, reviewId?}`: crea la revisión desde su plantilla
 *   (`tasks.review_create`): el proyecto, una madre por zona y una hija por ítem. `reviewId` (uuid) hace la petición
 *   repetible; sin él, uno nuevo. Responde `{reviewId, projectId, created, items?}`.
 */
import { createSync, fail, type AppRoute, type Supabase } from '../_kit/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_REF = /^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9_.:/-]{1,150}$/;

export function reviewRoutes(supabase: Supabase): AppRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  const call = async (ctx: Parameters<typeof internal.commit>[0], procedure: string, args: Record<string, unknown>) =>
    ((await internal.commit(ctx, { requestId: `${procedure}-${crypto.randomUUID()}`, operations: [{ op: 'call', procedure, args }] })).results[0] as { result?: unknown })?.result;

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
  }];
}
