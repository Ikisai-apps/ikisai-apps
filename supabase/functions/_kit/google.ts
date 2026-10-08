/**
 * Cuenta de servicio de Google para cualquier Edge (Calendar en Booking, Drive en Finance): JWT RS256 firmado con
 * WebCrypto y cambiado por un token de acceso que se guarda en memoria hasta poco antes de caducar.
 * Nunca se escribe en registros nada de la clave ni del token. El secreto común es `GOOGLE_SERVICE_ACCOUNT_JSON`.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: string;
}

/** Error de autenticación: `recoverable` (red, 5xx, 429: reintentar) o `blocked` (clave o permisos: lo arregla una persona). */
export class GoogleAuthError extends Error {
  constructor(readonly kind: 'recoverable' | 'blocked', readonly code: string) {
    super(code);
  }
}

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const encodeJson = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** Clave privada PKCS#8 en PEM → CryptoKey para firmar RS256. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Lee el JSON de la cuenta de servicio; null si falta o no es válido. */
export function parseServiceAccount(raw: string | undefined | null): GoogleServiceAccount | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.client_email !== 'string' || typeof parsed?.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY')) return null;
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
  } catch {
    return null;
  }
}

export interface GoogleTokenSourceConfig {
  serviceAccountJson?: string | null;
  /** Ámbitos separados por espacios, p. ej. `https://www.googleapis.com/auth/drive`. */
  scope: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Fuente de tokens de acceso, o null si no hay una cuenta de servicio válida (integración apagada). */
export function createGoogleTokenSource(config: GoogleTokenSourceConfig): { clientEmail: string; accessToken(): Promise<string> } | null {
  const account = parseServiceAccount(config.serviceAccountJson);
  if (!account) return null;
  const transport = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 10_000;
  let key: Promise<CryptoKey> | null = null;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - 60_000 > now()) return token.value;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({ iss: account!.clientEmail, scope: config.scope, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    let signature: ArrayBuffer;
    try {
      key ??= importPrivateKey(account!.privateKey);
      signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await key, new TextEncoder().encode(unsigned));
    } catch {
      key = null;
      throw new GoogleAuthError('blocked', 'GOOGLE_AUTH_ERROR');
    }
    const assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;
    let response: Response;
    try {
      response = await transport(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GoogleAuthError('recoverable', 'GOOGLE_UNREACHABLE');
    }
    const body = await response.json().catch(() => null);
    if (response.status >= 500 || response.status === 429) throw new GoogleAuthError('recoverable', 'GOOGLE_TOKEN_UNAVAILABLE');
    if (response.status !== 200 || typeof body?.access_token !== 'string') throw new GoogleAuthError('blocked', 'GOOGLE_AUTH_ERROR');
    token = { value: body.access_token, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  return { clientEmail: account.clientEmail, accessToken };
}
