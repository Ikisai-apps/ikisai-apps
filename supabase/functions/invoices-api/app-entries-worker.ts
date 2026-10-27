/**
 * Apuntes de otras apps por worker (seguridad, auditoría del 27-10, F1): el origen lo fija el servidor, no el cuerpo.
 *
 * `POST /api/v1/worker/app-entries`, de Edge a Edge con `X-Ikisai-Worker-Key` y `X-Ikisai-Caller: flow | booking`.
 * El cuerpo es el de `invoices.record_app_entry` (API.md §17) sin `source_app` (si viene, tiene que ser el llamante) y con
 * `request_id` opcional para la idempotencia. Se escribe con la cuenta de servicio del llamante («Flow (sistema)»,
 * «Booking (sistema)»), por el commit de siempre con los hooks de Finance; el SQL (0250) comprueba que una cuenta de
 * servicio solo escribe apuntes de su app. Responde lo que devuelve `record_app_entry`.
 */
import { createSync, ensureServiceActor, fail, type AppHooks, type RequestContext, type Supabase, type WorkerRoute } from '../_kit/mod.ts';
import { sha256Hex, stable } from '../_kit/supabase.ts';

export const APP_ENTRY_CALLERS: Record<string, string> = { flow: 'Flow (sistema)', booking: 'Booking (sistema)' };
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export function appEntriesWorkerRoute(supabase: Supabase, hooks: AppHooks): WorkerRoute {
  const sync = createSync(supabase, 'invoices', hooks);
  const actors = new Map<string, Promise<RequestContext>>();
  const ctx = (caller: string) => {
    let c = actors.get(caller);
    if (!c) {
      c = (async () => {
        const id = await ensureServiceActor(supabase, caller);
        return sync.context({ id, email: null, sessionId: `service:${caller}`, kind: 'human', name: APP_ENTRY_CALLERS[caller]! }, '');
      })();
      c.catch(() => actors.delete(caller));
      actors.set(caller, c);
    }
    return c;
  };
  return {
    method: 'POST', pattern: 'app-entries', handler: async ({ request, json }) => {
      const caller = (request.headers.get('x-ikisai-caller') ?? '').trim();
      if (!Object.hasOwn(APP_ENTRY_CALLERS, caller)) fail(403, 'CALLER_REJECTED', `X-Ikisai-Caller tiene que ser ${Object.keys(APP_ENTRY_CALLERS).join(' o ')}.`);
      const body = await json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(422, 'INVALID_ARGS', 'El cuerpo es el apunte en JSON.', { field: 'body' });
      const { request_id: requestId, ...args } = body!;
      if (args.source_app !== undefined && args.source_app !== caller) fail(403, 'SOURCE_MISMATCH', 'source_app lo fija quien llama.', { field: 'source_app' });
      if (typeof args.source_ref !== 'string' || !args.source_ref.startsWith(`${caller}:`)) fail(422, 'INVALID_ARGS', `source_ref empieza por «${caller}:».`, { field: 'source_ref' });
      if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) fail(422, 'INVALID_ARGS', 'request_id: de 1 a 120 caracteres [A-Za-z0-9_.:-].', { field: 'request_id' });
      const entry = { ...args, source_app: caller };
      const out = await sync.commit(await ctx(caller), {
        requestId: (requestId as string | undefined) ?? `app-entry:${caller}:${(await sha256Hex(stable(entry))).slice(0, 40)}`,
        operations: [{ op: 'call', procedure: 'invoices.record_app_entry', args: entry }],
      });
      return (out.results[0] as { result?: unknown } | undefined)?.result ?? null;
    },
  };
}
