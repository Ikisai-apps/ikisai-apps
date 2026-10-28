/**
 * Redsys (tarjeta y Bizum), segundo adaptador de la pasarela compartida (decisión de VG del 27-10: Stripe primero, Redsys
 * después). Mismo contrato que Stripe (`PaymentGateway`, `./stripe.ts`), con lo que Redsys tiene de distinto:
 *
 * - **No hay URL de pago.** Se paga mandando por POST, desde el navegador, un formulario firmado a Redsys. `createCheckout`
 *   devuelve ese formulario en `session.form`; la app lo guarda y lo sirve en su propia página de paso
 *   (`session.url` = `goUrl/<pedido>`), que lo envía sola. Así la URL que se comparte es corta y la app decide si el
 *   enlace sigue valiendo (caducado o cancelado: no se manda).
 * - **No se pregunta ni se caduca en la pasarela** (`queryable: false`): el estado llega por el aviso firmado
 *   (`DS_MERCHANT_MERCHANTURL`) y la caducidad la lleva la app. `getCheckout` y `expireCheckout` lanzan `NOT_SUPPORTED`.
 * - **Firma HMAC_SHA256_V1:** clave del pedido = 3DES(clave del comercio, número de pedido); firma = HMAC-SHA256 de
 *   `Ds_MerchantParameters` con esa clave, en base64. Los avisos traen la firma en base64 «de URL».
 * - **Bizum** es otro medio de la misma pasarela (`DS_MERCHANT_PAYMETHODS = z`).
 * - **Devoluciones** por REST (`trataPeticionREST`, tipo de operación 3). Redsys no tiene clave de idempotencia: la app
 *   no repite una devolución hecha (la registra antes).
 *
 * Los secretos (`REDSYS_SECRET_KEY`, el código de comercio y el terminal) solo viven en la Edge; aquí llegan como
 * parámetro. Ningún dato de tarjeta pasa por Ikisai.
 */
import { tripleDesCbcZeroIv } from './des.ts';
import { checkCheckoutRequest, PaymentGatewayError, type CheckoutSession, type PaymentEvent, type PaymentGateway } from './stripe.ts';

export const REDSYS_URLS = {
  pruebas: { pay: 'https://sis-t.redsys.es:25443/sis/realizarPago', rest: 'https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST' },
  real: { pay: 'https://sis.redsys.es/sis/realizarPago', rest: 'https://sis.redsys.es/sis/rest/trataPeticionREST' },
} as const;

export interface RedsysOptions {
  /** Clave secreta del comercio (SHA-256), en base64, tal como la da el banco. */
  secretKey: string;
  /** Código de comercio (FUC) y terminal. */
  merchantCode: string;
  terminal: string;
  /** `pruebas` (sis-t) o `real`. */
  environment: 'pruebas' | 'real';
  /** Página de paso de la app (pública): `${goUrl}/<pedido>` sirve el formulario. */
  goUrl: string;
  /** Donde Redsys manda el aviso firmado (la ruta pública de la app). */
  notifyUrl: string;
  /** Medios: tarjeta, Bizum o los dos (por defecto, los dos). */
  methods?: 'card' | 'bizum' | 'both';
  fetch?: typeof fetch;
  now?: () => number;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const utf8b64 = (s: string) => b64(new TextEncoder().encode(s));
const fromUtf8b64 = (s: string) => new TextDecoder().decode(fromB64(s));

/** Número de pedido de Redsys (12 caracteres, los 4 primeros cifras) estable para la misma clave de idempotencia. */
export async function redsysOrder(idempotencyKey: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(idempotencyKey)));
  const digits = String(((h[0]! << 8) | h[1]!) % 10000).padStart(4, '0');
  const alnum = [...h.slice(2, 10)].map((b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
  return digits + alnum;
}

/** Firma HMAC_SHA256_V1 de unos `Ds_MerchantParameters` para un pedido. */
export async function redsysSignature(secretKey: string, order: string, merchantParameters: string): Promise<string> {
  const padded = new Uint8Array(Math.ceil(order.length / 8) * 8);
  padded.set(new TextEncoder().encode(order));
  const orderKey = tripleDesCbcZeroIv(fromB64(secretKey), padded);
  const key = await crypto.subtle.importKey('raw', orderKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(merchantParameters))));
}

const normSig = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
function sameSig(a: string, b: string): boolean {
  const x = normSig(a); const y = normSig(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Parámetros de un aviso de Redsys ya comprobado (claves tal cual: `Ds_Order`, `Ds_Response`, `Ds_Amount`…). */
export type RedsysNotification = Record<string, string>;

/**
 * Comprueba el aviso de Redsys (`Ds_SignatureVersion`, `Ds_MerchantParameters`, `Ds_Signature`, en el cuerpo del POST o
 * en el JSON de la respuesta REST). Devuelve los parámetros si la firma es buena; si no, lanza `PaymentGatewayError`.
 */
export async function verifyRedsysNotification(fields: Record<string, string | null | undefined>, secretKey: string): Promise<RedsysNotification> {
  const params = fields.Ds_MerchantParameters; const signature = fields.Ds_Signature;
  if (!params || !signature || !secretKey) throw new PaymentGatewayError('Sin firma.', 'SIGNATURE_MISSING');
  if (fields.Ds_SignatureVersion && fields.Ds_SignatureVersion !== 'HMAC_SHA256_V1') throw new PaymentGatewayError('Versión de firma desconocida.', 'SIGNATURE_INVALID');
  let decoded: Record<string, unknown>;
  try { decoded = JSON.parse(fromUtf8b64(params)); } catch { throw new PaymentGatewayError('Parámetros inválidos.', 'PAYLOAD_INVALID'); }
  const order = String(decoded.Ds_Order ?? decoded.DS_ORDER ?? '');
  if (!order) throw new PaymentGatewayError('Aviso sin pedido.', 'PAYLOAD_INVALID');
  if (!sameSig(signature, await redsysSignature(secretKey, order, params))) throw new PaymentGatewayError('Firma incorrecta.', 'SIGNATURE_INVALID');
  const plain = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); try { return decodeURIComponent(s); } catch { return s; } };
  return Object.fromEntries(Object.entries(decoded).map(([k, v]) => [k, plain(v)]));
}

/**
 * Un aviso de Redsys en el formato común:
 * - autorizado (`Ds_Response` 0000–0099) en un pago → `paid`;
 * - devolución aceptada (`Ds_TransactionType` 3, `Ds_Response` 0900) → `refunded`;
 * - lo demás (denegado, cancelado por quien paga) → `failed`.
 * `Ds_MerchantData` lleva los metadatos (JSON) que puso `createCheckout`.
 */
export function normalizeRedsysNotification(n: RedsysNotification): PaymentEvent {
  const response = Number(n.Ds_Response);
  const type = String(n.Ds_TransactionType ?? '0');
  let metadata: Record<string, string> = {};
  try { const m = JSON.parse(n.Ds_MerchantData || '{}'); if (m && typeof m === 'object') metadata = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v)])); } catch { /* sin metadatos */ }
  const amount = Number.isFinite(Number(n.Ds_Amount)) ? Number(n.Ds_Amount) : null;
  const order = n.Ds_Order ?? '';
  const base = { sessionId: order, paymentIntent: order, currency: n.Ds_Currency === '978' ? 'eur' : (n.Ds_Currency || null), metadata };
  if (type === '3') {
    return { ...base, eventId: `redsys:${order}:3:${n.Ds_AuthorisationCode || n.Ds_Response}`, kind: response === 900 ? 'refunded' : 'ignored', amountCents: amount, refundedCents: response === 900 ? amount : null };
  }
  const ok = Number.isInteger(response) && response >= 0 && response <= 99;
  return { ...base, eventId: `redsys:${order}:${type}:${ok ? 'ok' : `ko${n.Ds_Response}`}`, kind: ok ? 'paid' : 'failed', amountCents: amount, refundedCents: null };
}

/** Respuesta 0000–0099: pago autorizado. */
export const redsysAuthorized = (n: RedsysNotification) => { const r = Number(n.Ds_Response); return Number.isInteger(r) && r >= 0 && r <= 99; };

export function createRedsysGateway(options: RedsysOptions): PaymentGateway {
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const urls = REDSYS_URLS[options.environment];
  const envelope = async (order: string, params: Record<string, string>) => {
    const merchantParameters = utf8b64(JSON.stringify(params));
    return { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: merchantParameters, Ds_Signature: await redsysSignature(options.secretKey, order, merchantParameters) };
  };
  const unsupported = async (): Promise<CheckoutSession> => { throw new PaymentGatewayError('Redsys no deja preguntar ni caducar el pago: lo lleva la app.', 'NOT_SUPPORTED'); };
  return {
    provider: 'redsys', queryable: false,
    async createCheckout(r) {
      checkCheckoutRequest(r, now());
      if (r.currency !== 'eur') throw new PaymentGatewayError('Redsys cobra solo en euros.', 'INVALID_CURRENCY');
      const order = await redsysOrder(r.idempotencyKey);
      const merchantData = JSON.stringify(r.metadata);
      if (merchantData.length > 1024) throw new PaymentGatewayError('Metadatos demasiado largos.', 'INVALID_METADATA');
      const params: Record<string, string> = {
        DS_MERCHANT_AMOUNT: String(r.amountCents), DS_MERCHANT_ORDER: order, DS_MERCHANT_MERCHANTCODE: options.merchantCode,
        DS_MERCHANT_CURRENCY: '978', DS_MERCHANT_TRANSACTIONTYPE: '0', DS_MERCHANT_TERMINAL: options.terminal,
        DS_MERCHANT_MERCHANTURL: options.notifyUrl, DS_MERCHANT_URLOK: r.successUrl, DS_MERCHANT_URLKO: r.cancelUrl,
        DS_MERCHANT_PRODUCTDESCRIPTION: r.description.slice(0, 125), DS_MERCHANT_MERCHANTDATA: merchantData,
        ...(options.methods === 'card' ? { DS_MERCHANT_PAYMETHODS: 'C' } : options.methods === 'bizum' ? { DS_MERCHANT_PAYMETHODS: 'z' } : {}),
      };
      return {
        provider: 'redsys', id: order, url: `${options.goUrl.replace(/\/$/, '')}/${order}`, expiresAt: r.expiresAt.toISOString(),
        status: 'open', paymentStatus: 'unpaid', amountCents: r.amountCents, currency: 'eur', metadata: { ...r.metadata }, paymentIntent: null,
        form: { action: urls.pay, fields: await envelope(order, params) },
      };
    },
    getCheckout: unsupported,
    expireCheckout: unsupported,
    async refund(order, amountCents) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new PaymentGatewayError('Importe inválido.', 'INVALID_AMOUNT');
      const body = await envelope(order, { DS_MERCHANT_AMOUNT: String(amountCents), DS_MERCHANT_ORDER: order, DS_MERCHANT_MERCHANTCODE: options.merchantCode,
        DS_MERCHANT_CURRENCY: '978', DS_MERCHANT_TRANSACTIONTYPE: '3', DS_MERCHANT_TERMINAL: options.terminal });
      let res: Response;
      try {
        res = await transport(urls.rest, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new PaymentGatewayError('La pasarela no responde.', 'GATEWAY_UNAVAILABLE');
      }
      const out = await res.json().catch(() => ({})) as Record<string, string>;
      if (!res.ok || out.errorCode) throw new PaymentGatewayError('La pasarela ha rechazado la devolución.', String(out.errorCode ?? 'GATEWAY_REJECTED'), res.status);
      const n = await verifyRedsysNotification(out, options.secretKey);
      if (Number(n.Ds_Response) !== 900) throw new PaymentGatewayError('La pasarela ha rechazado la devolución.', `DS_${n.Ds_Response}`);
      return { refundId: `${order}:${n.Ds_AuthorisationCode || 'dev'}`, status: 'succeeded' };
    },
  };
}

/** Página de paso: HTML mínimo que manda solo el formulario firmado a Redsys (con botón por si no hay JavaScript). */
export function redsysGoPage(form: { action: string; fields: Record<string, string> }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const inputs = Object.entries(form.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pago</title></head>`
    + `<body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center"><form id="f" method="post" action="${esc(form.action)}">${inputs}`
    + `<p>Te llevamos a la página de pago segura…</p><button type="submit">Ir a pagar</button></form>`
    + `<script>document.getElementById('f').submit()</script></body></html>`;
}

/** Para pruebas y para el Redsys falso: el aviso firmado que mandaría Redsys. */
export async function signRedsysNotification(secretKey: string, params: Record<string, string>): Promise<Record<string, string>> {
  const merchantParameters = utf8b64(JSON.stringify(params));
  const sig = await redsysSignature(secretKey, params.Ds_Order!, merchantParameters);
  return { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: merchantParameters, Ds_Signature: sig.replace(/\+/g, '-').replace(/\//g, '_') };
}

/** Decodifica `Ds_MerchantParameters` (para pruebas y para la página de paso). */
export const decodeRedsysParameters = (merchantParameters: string): Record<string, string> => JSON.parse(fromUtf8b64(merchantParameters));
