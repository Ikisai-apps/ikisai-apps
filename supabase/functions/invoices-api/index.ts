// Punto de entrada Deno de la Edge Function `invoices-api`.
import { createInvoicesApp, DEFAULT_TASKS_API_BASE } from './app.ts';
import { createDocumentExtractorFromEnv } from '../_kit/extract.ts';
import { createStripeGateway } from '../_domain/payments/stripe.ts';
import { createRedsysGateway } from '../_domain/payments/redsys.ts';

declare const Deno: { serve: (handler: (request: Request) => Promise<Response>) => void; env: { get: (name: string) => string | undefined } };

const config = {
  url: Deno.env.get('SUPABASE_URL') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  release: Deno.env.get('IKISAI_RELEASE') ?? 'development',
  stage: 'beta' as const,
  workerKey: Deno.env.get('IKISAI_WORKER_KEY'),
  // API de Tareas para validar destinos con el token del usuario; en QA puede apuntar a la función directa.
  tasksApiBase: Deno.env.get('IKISAI_TASKS_API_BASE') ?? DEFAULT_TASKS_API_BASE,
};

// Extracción automática (API.md §6): OpenAI si existe `OPENAI_API_KEY` (decisión del usuario), Anthropic si no.
// Sin ninguna clave responde EXTRACTION_UNAVAILABLE 503 y la app ofrece pegar el JSON.
// Pagos en línea (finance-18, API.md §19.6). Cada pasarela se crea si tiene sus secretos; el interruptor
// `PAYMENTS_PROVIDER` (`stripe` por defecto, o `redsys`) dice cuál crea los enlaces nuevos. Las demás siguen conciliando
// sus enlaces ya creados. Sin ninguna: PAYMENTS_OFF.
const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
const stripe = stripeKey ? createStripeGateway({ secretKey: stripeKey }) : null;
const redsysKey = Deno.env.get('REDSYS_SECRET_KEY');
const redsysCode = Deno.env.get('REDSYS_MERCHANT_CODE');
const edge = `${config.url.replace(/\/$/, '')}/functions/v1/invoices-api/api/v1/public/payments/redsys`;
const redsys = redsysKey && redsysCode ? createRedsysGateway({
  secretKey: redsysKey, merchantCode: redsysCode, terminal: Deno.env.get('REDSYS_TERMINAL') ?? '1',
  environment: Deno.env.get('REDSYS_ENV') === 'real' ? 'real' : 'pruebas', goUrl: `${edge}/go`, notifyUrl: edge,
}) : null;
const active = Deno.env.get('PAYMENTS_PROVIDER') === 'redsys' ? redsys : stripe;
const payments = active ?? null;
const paymentsOthers = [stripe, redsys].filter((g): g is NonNullable<typeof g> => !!g && g !== active);
Deno.serve(createInvoicesApp({ ...config, payments, paymentsOthers, paymentsWebhookSecret: Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? null, redsysSecretKey: redsysKey ?? null,
  extractInvoice: createDocumentExtractorFromEnv(config, (name) => Deno.env.get(name)) }));
