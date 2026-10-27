/**
 * Ikisai Organizers · API (docs/organizers/API.md §6 y §15). Portal de los organizadores.
 * - Lee y escribe en Booking con sus lecturas y acciones de portal (`read/booking.portal_*`, `invoke/booking.portal_*`),
 *   filtradas por el ámbito del enlace; emite los enlaces de sus huéspedes con `portal-links` (`portalIssuer`).
 * - Fase 4: sus propias tablas `organizers.*` (experiencia de Guests, materiales, preguntas, respuestas y ofertas), con
 *   `commands`/`snapshot`/`changes` del kit. Cada organizador ve y escribe solo las filas de sus reservas (`visible` y
 *   `beforeCommit` aquí; el gancho `organizers.validate_batch` en la base de datos) y abre los archivos de sus materiales
 *   (K3: `files/:id` comprueba la fila que los referencia con `visible`).
 * - Conservación (B18): `POST worker/retention/tick` borra las respuestas de los huéspedes a los 6 meses del fin del retiro,
 *   en un lote del sistema firmado por la cuenta de servicio `organizers`.
 * - «Pagar ahora» sin enlace (F5, Finance API.md §19.3): `POST payments/link` pide el enlace al worker de Finance en nombre de
 *   quien organiza; Finance comprueba el ámbito (0256). Se enciende con `IKISAI_PORTAL_PAYMENTS=1` (`GET payments/config`).
 * - Avisos de comentarios nuevos (0709): `POST worker/comment-notices/tick` manda a cada persona que organiza, como mucho
 *   cada hora, un correo con los comentarios de sus asistentes que aún no ha visto. Apagado hasta `IKISAI_ORGANIZER_MAIL=1`
 *   y el SMTP (`IKISAI_SMTP_*`).
 */
import { createApp, createSupabase, ensureServiceActor, fail, type AppConfig } from '../_kit/mod.ts';
import { MATERIAL_MAX_BYTES, MATERIAL_MIME, proposalVisible, validateOperations, visibleRow } from '../_domain/organizers/mod.ts';
import { githubEvidence, GithubError, parseRef, type EvidenceStore } from '../_domain/organizers/github.ts';
import { commentNoticeEmail, smtpFromEnv, type Mailer } from '../_domain/organizers/mail.ts';

export const ORGANIZERS_ORIGINS = ['https://organizers.ikisai.com', 'https://ikisai-organizers.pages.dev'];

/** Materiales del retiro: PDF hasta 15 MB e imágenes recomprimidas en el dispositivo (bucket de K5, #323). */
// K3 para miembros (#585): ningún miembro que no sea propietario lee un archivo ajeno por su id si no ve (`visible`) una
// fila viva que lo referencia. El único campo de archivo es `materials.file_id`, registrado en 0700.
export const ORGANIZERS_UPLOADS = { bucket: 'organizers-materials', allowedMime: MATERIAL_MIME, maxBytes: MATERIAL_MAX_BYTES, membersK3: true };

/** `organizers.github_evidence` (0704): token de solo lectura de la Edge (GITHUB_TOKEN); en las pruebas, `fetch` y caché propios. */
export interface OrganizersGithub { token?: string | null; fetch?: typeof fetch; store?: EvidenceStore }

/** «Pagar ahora» sin enlace (F5): encendido (o `IKISAI_PORTAL_PAYMENTS=1`); en las pruebas, `fetch` hacia la Edge de Finance. */
export interface OrganizersPayments { enabled?: boolean; fetch?: typeof fetch }

/** Avisos por correo (0709): encendido (o `IKISAI_ORGANIZER_MAIL=1`) y el envío (o el SMTP de `IKISAI_SMTP_*`). */
export interface OrganizersMail { enabled?: boolean; mailer?: Mailer | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A dónde vuelve quien paga: la pestaña Pagos de su retiro, con el resultado (`app/pay-link.ts`, `returnOf`). */
export function paymentReturnUrls(reservationId: string, invoiceId: string, origin = ORGANIZERS_ORIGINS[0]!): { success: string; cancel: string } {
  const at = `${origin}/#/retiro/${reservationId.toLowerCase()}/pagos?factura=${invoiceId.toLowerCase()}`;
  return { success: `${at}&pago=ok`, cancel: `${at}&pago=cancelado` };
}

export function createOrganizersApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'portalIssuer' | 'uploads' | 'hooks' | 'workerRoutes'> & Partial<Pick<AppConfig, 'origins'>> & { github?: OrganizersGithub; payments?: OrganizersPayments; mail?: OrganizersMail }) {
  const supabase = createSupabase(base);
  const { github, payments, mail, ...config } = base;
  const env = (name: string): string | undefined => (globalThis as any).Deno?.env?.get?.(name);
  const mailOn = mail?.enabled ?? env('IKISAI_ORGANIZER_MAIL') === '1';
  const mailer = mail && 'mailer' in mail ? mail.mailer ?? null : smtpFromEnv(env);
  const paymentsOn = payments?.enabled ?? ((globalThis as any).Deno?.env?.get?.('IKISAI_PORTAL_PAYMENTS') === '1');
  const financeWorker = (route: string, body: unknown) => (payments?.fetch ?? config.fetch ?? fetch)(
    `${supabase.base}/functions/v1/invoices-api/api/v1/worker/${route}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': config.workerKey ?? '', 'X-Ikisai-Caller': 'organizers' }, body: JSON.stringify(body) });
  const githubToken = github && 'token' in github ? github.token ?? null : ((globalThis as any).Deno?.env?.get?.('GITHUB_TOKEN') ?? null);
  return createApp({
    ...config,
    app: 'organizers',
    slug: 'organizers-api',
    origins: base.origins ?? ORGANIZERS_ORIGINS,
    portalIssuer: true,
    uploads: ORGANIZERS_UPLOADS,
    routes: [...(config.routes ?? []), {
      // Evidencia de GitHub de una tarjeta de Flow (capacidad del catálogo, 0704). Solo el personal de Organizers: owner o
      // editor sin `scopes.grants` (quien organiza un retiro es editor con grants y no la ve).
      method: 'GET', pattern: 'github/evidence',
      handler: async ({ ctx, url }) => {
        const role = ctx.membership.role;
        const portal = Array.isArray((ctx.membership.scopes as { grants?: unknown } | null)?.grants);
        if (!(role === 'owner' || (role === 'editor' && !portal))) fail(403, 'FORBIDDEN', 'Solo el equipo de Ikisai ve la evidencia de GitHub.');
        try {
          return await githubEvidence(parseRef(url.searchParams), { fetch: github?.fetch ?? fetch, token: githubToken, store: github?.store },
            { fresh: url.searchParams.get('fresh') === '1' });
        } catch (error) {
          if (error instanceof GithubError) fail(error.status, error.code, error.message, error.retryAfter ? { retryAfter: error.retryAfter } : null);
          throw error;
        }
      },
    }, {
      // ¿Puede quien organiza pagar en línea una factura sin enlace? (el botón «Pagar ahora» de las que no lo traen)
      method: 'GET', pattern: 'payments/config', handler: async () => ({ online: paymentsOn }),
    }, {
      // «Pagar ahora» sin enlace (F5): Finance lo crea o reutiliza el abierto. El ámbito lo comprueba Finance (0256); aquí, solo
      // que la persona pueda escribir y que los ids tengan forma. Ninguna URL de vuelta la elige el cliente.
      method: 'POST', pattern: 'payments/link',
      handler: async ({ ctx, json }) => {
        if (!paymentsOn) fail(503, 'PAYMENTS_OFF', 'El pago en línea aún no está activo.');
        if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', 'Con acceso de lectura no se puede pagar desde aquí.');
        const body = (await json().catch(() => null)) as { reservation_id?: unknown; issued_invoice_id?: unknown } | null;
        for (const k of ['reservation_id', 'issued_invoice_id'] as const) {
          if (typeof body?.[k] !== 'string' || !UUID.test(body[k] as string)) fail(422, 'INVALID_ARGS', `Falta ${k}.`, { field: k });
        }
        const reservationId = (body!.reservation_id as string).toLowerCase();
        const invoiceId = (body!.issued_invoice_id as string).toLowerCase();
        const back = paymentReturnUrls(reservationId, invoiceId);
        let res: Response;
        try {
          res = await financeWorker('payment-links/portal', { actor: ctx.user.id, reservation_id: reservationId, issued_invoice_id: invoiceId, return_url: back.success, cancel_url: back.cancel });
        } catch {
          fail(503, 'PAYMENT_GATEWAY', 'No hemos podido preparar el pago. Prueba otra vez en un momento.');
        }
        const data = await res.json().catch(() => null) as { url?: unknown; provider?: unknown; expires_at?: unknown; reused?: unknown; error?: { code?: string; message?: string } } | null;
        if (!res.ok || typeof data?.url !== 'string') {
          const code = data?.error?.code ?? 'PAYMENT_GATEWAY';
          // Lo de fuera del ámbito responde igual que lo inexistente; la clave de worker mal puesta no es culpa de quien paga.
          if (res.status === 401) fail(503, 'PAYMENT_GATEWAY', 'No hemos podido preparar el pago. Prueba otra vez en un momento.');
          fail(res.ok ? 502 : res.status, code, data?.error?.message ?? 'No hemos podido preparar el pago.');
        }
        return { url: data!.url, provider: data!.provider ?? null, expires_at: data!.expires_at ?? null, reused: data!.reused === true };
      },
    }],
    workerRoutes: [{
      method: 'POST', pattern: 'retention/tick',
      handler: async () => {
        await ensureServiceActor(supabase, 'organizers'); // el lote lo firma «Organizers (sistema)»
        return supabase.rpc('core_invoke', { p_app: 'organizers', p_actor: null, p_name: 'organizers.retention_run', p_args: { limit: 200 } });
      },
    }, {
      // Avisos de comentarios nuevos (0709): un correo por persona, con lo de sus retiros y nada de nadie más. Solo avanza el
      // cursor de quien lo ha recibido; si el envío falla, se intenta en la siguiente vuelta.
      method: 'POST', pattern: 'comment-notices/tick',
      handler: async () => {
        if (!mailOn || !mailer) return { sent: 0, errors: 0, off: true };
        const due = await supabase.rpc<Array<{ user_id: string; cursor: string; reservations: Array<{ reservation_id: string; comments: number }> }>>(
          'core_invoke', { p_app: 'organizers', p_actor: null, p_name: 'organizers.comment_notices_due', p_args: { limit: 50 } });
        let sent = 0; let errors = 0; let skipped = 0;
        const done = (person: { user_id: string; cursor: string }) => supabase.rpc('core_invoke',
          { p_app: 'organizers', p_actor: null, p_name: 'organizers.comment_notices_sent', p_args: { user_id: person.user_id, cursor: person.cursor } });
        for (const person of due ?? []) {
          try {
            const user = await supabase.remote('/auth/v1/admin/users/' + person.user_id, { service: true }) as { email?: string | null };
            // Sin correo o sin ningún retiro que vea: no hay a quién avisar; el cursor avanza para no volver a mirarlo.
            if (!user?.email) { await done(person); skipped++; continue; }
            // Los títulos, con la lectura del portal y como esa persona: solo los de sus retiros.
            const mine = await supabase.rpc<{ items?: Array<{ id: string; title: string }> }>('core_read',
              { p_app: 'organizers', p_actor: person.user_id, p_name: 'booking.portal_reservations', p_args: {} });
            const titles = new Map((mine?.items ?? []).map((r) => [r.id.toLowerCase(), r.title]));
            const reservations = person.reservations.filter((r) => titles.has(r.reservation_id.toLowerCase()))
              .map((r) => ({ title: titles.get(r.reservation_id.toLowerCase())!, comments: r.comments }));
            if (!reservations.length) { await done(person); skipped++; continue; }
            await mailer.send({ to: user.email, ...commentNoticeEmail(reservations, `${ORGANIZERS_ORIGINS[0]}/#/`) });
            await done(person);
            sent++;
          } catch {
            errors++;
          }
        }
        return { sent, errors, skipped };
      },
    }],
    hooks: {
      visible: (table, row, ctx) => visibleRow(table, row, ctx.membership, ctx.user.id),
      beforeCommit: (operations, ctx) => {
        const issue = validateOperations(operations, ctx.membership, undefined, ctx.user.id);
        if (issue) fail(issue.code === 'FORBIDDEN' || issue.code === 'OUT_OF_SCOPE' || issue.code === 'SUGGESTION_REQUIRED' ? 403 : 422, issue.code, issue.message, issue.details);
      },
      // Propuestas del equipo de Ikisai (0703): las ve y las decide quien organiza ese retiro con permiso propio.
      suggestionVisible: (suggestion, ctx) => proposalVisible(suggestion, ctx.membership),
    },
  });
}
