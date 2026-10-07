/**
 * Ikisai Booking · transporte HTTPS hacia SES.HOSPEDAJES (docs/booking/API.md §17.3). Los servidores de SES no envían el
 * intermedio de la FNMT: se añade a la confianza con `Deno.createHttpClient({ caCerts })` y, si el runtime no lo ofrece,
 * con `Deno.connectTls({ caCerts })` y una petición HTTP/1.1 mínima. En Node (pruebas) se inyecta `fetchImpl`.
 */
import { FNMT_AC_COMPONENTES_PEM } from './fnmt.ts';

export type SesEnvironment = 'pre' | 'prod';
export const SES_ENDPOINTS: Record<SesEnvironment, string> = {
  pre: 'https://hospedajes.pre-ses.mir.es/hospedajes-web/ws/v1/comunicacion',
  prod: 'https://hospedajes.ses.mir.es/hospedajes-web/ws/v1/comunicacion',
};

export interface SesCredentials { user: string; password: string; landlordCode: string; establishmentCode: string }
export type SesVia = 'createHttpClient' | 'connectTls' | 'fetch';
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

async function viaConnectTls(url: string, xml: string, auth: { user: string; password: string } | null): Promise<SesResponse> {
  const target = new URL(url);
  const conn = await DenoNs.connectTls({ hostname: target.hostname, port: Number(target.port || 443), caCerts: [FNMT_AC_COMPONENTES_PEM] });
  try {
    const body = new TextEncoder().encode(xml);
    const head = [`POST ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, 'Connection: close',
      ...Object.entries(headers(auth, body.length)).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
    await conn.write(new TextEncoder().encode(head));
    await conn.write(body);
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(16 * 1024);
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error('SES_TIMEOUT');
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    const raw = new TextDecoder().decode(chunks.reduce((a, c) => { const o = new Uint8Array(a.length + c.length); o.set(a); o.set(c, a.length); return o; }, new Uint8Array()));
    const [headPart, ...rest] = raw.split('\r\n\r\n');
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(headPart ?? '')?.[1] ?? 0);
    let text = rest.join('\r\n\r\n');
    if (/transfer-encoding:\s*chunked/i.test(headPart ?? '')) text = dechunk(text);
    return { status, body: text, via: 'connectTls' };
  } finally {
    try { conn.close(); } catch { /* ya cerrada */ }
  }
}

function dechunk(text: string): string {
  let out = ''; let rest = text;
  for (;;) {
    const i = rest.indexOf('\r\n');
    if (i < 0) break;
    const size = parseInt(rest.slice(0, i), 16);
    if (!size) break;
    out += rest.slice(i + 2, i + 2 + size);
    rest = rest.slice(i + 2 + size + 2);
  }
  return out;
}

/**
 * Transporte de la Edge. `fetchImpl` (pruebas) evita Deno. Si `Deno.createHttpClient` no existe o lanza, se prueba
 * `Deno.connectTls`; el resultado dice qué vía funcionó (ping de Core).
 */
export function createSesTransport(options: { fetchImpl?: typeof fetch } = {}): SesTransport {
  return {
    async post(environment, xml, auth) {
      const url = SES_ENDPOINTS[environment];
      if (options.fetchImpl) {
        const body = new TextEncoder().encode(xml);
        const res = await options.fetchImpl(url, { method: 'POST', headers: headers(auth, body.length), body });
        return { status: res.status, body: await res.text(), via: 'fetch' };
      }
      if (!DenoNs) throw new Error('SES_TRANSPORT_UNAVAILABLE');
      if (typeof DenoNs.createHttpClient === 'function') {
        try { return await viaHttpClient(url, xml, auth); } catch (error) {
          if (typeof DenoNs.connectTls !== 'function') throw error;
        }
      }
      if (typeof DenoNs.connectTls === 'function') return viaConnectTls(url, xml, auth);
      throw new Error('SES_TRANSPORT_UNAVAILABLE');
    },
  };
}

/** Ping de Core (§17.3): solo el saludo TLS contra PRE, sin credenciales; espera 401. Devuelve qué vías funcionan. */
export async function sesTlsPing(): Promise<{ results: Array<{ via: SesVia; ok: boolean; status?: number; error?: string }> }> {
  const results: Array<{ via: SesVia; ok: boolean; status?: number; error?: string }> = [];
  const probe = '<?xml version="1.0" encoding="UTF-8"?><ping/>';
  for (const via of ['createHttpClient', 'connectTls'] as const) {
    const available = !!DenoNs && typeof DenoNs[via] === 'function';
    if (!available) { results.push({ via, ok: false, error: 'no disponible en este runtime' }); continue; }
    try {
      const res = via === 'createHttpClient' ? await viaHttpClient(SES_ENDPOINTS.pre, probe, null) : await viaConnectTls(SES_ENDPOINTS.pre, probe, null);
      results.push({ via, ok: res.status > 0, status: res.status });
    } catch (error) {
      results.push({ via, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
  }
  return { results };
}
