/**
 * Ikisai Booking · transporte HTTPS hacia SES.HOSPEDAJES (docs/booking/API.md §17.3). Los servidores de SES no envían el
 * intermedio de la FNMT: se añade a la confianza con `Deno.createHttpClient({ caCerts })`, que es la vía comprobada en la
 * Edge de Supabase (ping de Core, 7-10-2026). En Node (pruebas) se inyecta `fetchImpl`.
 */
import { FNMT_AC_COMPONENTES_PEM } from './fnmt.ts';

export type SesEnvironment = 'pre' | 'prod';
export const SES_ENDPOINTS: Record<SesEnvironment, string> = {
  pre: 'https://hospedajes.pre-ses.mir.es/hospedajes-web/ws/v1/comunicacion',
  prod: 'https://hospedajes.ses.mir.es/hospedajes-web/ws/v1/comunicacion',
};

export interface SesCredentials { user: string; password: string; landlordCode: string; establishmentCode: string }
export type SesVia = 'createHttpClient' | 'fetch';
export interface SesResponse { status: number; body: string; via: SesVia }

export interface SesTransport {
  post(environment: SesEnvironment, xml: string, auth: { user: string; password: string } | null): Promise<SesResponse>;
}

const TIMEOUT_MS = 30_000;

/** Credenciales de un entorno desde los secretos `SES_PRE_*` / `SES_PROD_*`; null si falta alguno. */
export function sesCredentials(env: (name: string) => string | undefined, environment: SesEnvironment): SesCredentials | null {
  const p = `SES_${environment.toUpperCase()}_`;
  const user = env(`${p}USER`); const password = env(`${p}PASSWORD`);
  const landlordCode = env(`${p}LANDLORD_CODE`); const establishmentCode = env(`${p}ESTABLISHMENT_CODE`);
  return user && password && landlordCode && establishmentCode ? { user, password, landlordCode, establishmentCode } : null;
}

const headers = (auth: { user: string; password: string } | null, length: number): Record<string, string> => ({
  'content-type': 'text/xml; charset=utf-8',
  soapaction: '',
  'content-length': String(length),
  ...(auth ? { authorization: `Basic ${btoa(`${auth.user}:${auth.password}`)}` } : {}),
});

// deno-lint-ignore no-explicit-any
const DenoNs = (globalThis as any).Deno as any;

async function viaHttpClient(url: string, xml: string, auth: { user: string; password: string } | null): Promise<SesResponse> {
  const client = DenoNs.createHttpClient({ caCerts: [FNMT_AC_COMPONENTES_PEM] });
  try {
    const body = new TextEncoder().encode(xml);
    const res = await fetch(url, { method: 'POST', headers: headers(auth, body.length), body, client, signal: AbortSignal.timeout(TIMEOUT_MS) } as RequestInit);
    return { status: res.status, body: await res.text(), via: 'createHttpClient' };
  } finally {
    client.close?.();
  }
}

/** Transporte de la Edge. `fetchImpl` (pruebas) evita Deno. */
export function createSesTransport(options: { fetchImpl?: typeof fetch } = {}): SesTransport {
  return {
    async post(environment, xml, auth) {
      const url = SES_ENDPOINTS[environment];
      if (options.fetchImpl) {
        const body = new TextEncoder().encode(xml);
        const res = await options.fetchImpl(url, { method: 'POST', headers: headers(auth, body.length), body });
        return { status: res.status, body: await res.text(), via: 'fetch' };
      }
      if (typeof DenoNs?.createHttpClient !== 'function') throw new Error('SES_TRANSPORT_UNAVAILABLE');
      return viaHttpClient(url, xml, auth);
    },
  };
}

/** Ping de Core (§17.3): solo el saludo TLS contra PRE, sin credenciales; espera 401. */
export async function sesTlsPing(): Promise<{ results: Array<{ via: SesVia; ok: boolean; status?: number; error?: string }> }> {
  if (typeof DenoNs?.createHttpClient !== 'function') return { results: [{ via: 'createHttpClient', ok: false, error: 'no disponible en este runtime' }] };
  try {
    const res = await viaHttpClient(SES_ENDPOINTS.pre, '<?xml version="1.0" encoding="UTF-8"?><ping/>', null);
    return { results: [{ via: 'createHttpClient', ok: res.status > 0, status: res.status }] };
  } catch (error) {
    return { results: [{ via: 'createHttpClient', ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }] };
  }
}
