/**
 * Apuntes de otras apps (seguridad, auditoría del 27-10, F1; el mismo modelo que Tasks §45): `invoices.record_app_entry`
 * sigue llegando por `/api/v1/commands` con el token de la persona (cuentan su rol y su ámbito), pero `source_app` solo
 * vale si la llamada viene del servidor de esa app: `X-Ikisai-Worker-Key` (la `IKISAI_WORKER_KEY` de todas las Edges) y
 * `X-Ikisai-Caller: flow | booking`. Un navegador no tiene la clave.
 * - Con la prueba, `source_app` tiene que ser quien llama: si no, 403 `SOURCE_MISMATCH`.
 * - Las apps de `APP_ENTRY_SOURCES_REQUIRED` ya no valen sin ella: 403 `CALLER_REQUIRED`. Cada una entra en cuanto su app
 *   manda las cabeceras (Core avisa); mientras, se acepta como hasta ahora para no cortar los envíos.
 * La prueba se lee al entrar la petición (`withServerCaller`) y la consulta el hook de commit (`checkAppEntrySources`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, type Operation } from '../_kit/mod.ts';

export const APP_ENTRY_SOURCES: ReadonlySet<string> = new Set(['flow', 'booking']);
export const APP_ENTRY_SOURCES_REQUIRED: ReadonlySet<string> = new Set<string>(['flow', 'booking']);

const scope = new AsyncLocalStorage<string | null>();

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** La app de servidor que llama (`flow` | `booking`) si trae la clave de worker y su nombre; si no, `null`. */
export function serverCaller(request: Request, workerKey: string | undefined): string | null {
  const key = request.headers.get('x-ikisai-worker-key');
  const caller = (request.headers.get('x-ikisai-caller') ?? '').trim().toLowerCase();
  if (!workerKey || !key || !sameSecret(key, workerKey) || !APP_ENTRY_SOURCES.has(caller)) return null;
  return caller;
}

/** Atiende la petición recordando quién llama, para el hook de commit. */
export function withServerCaller(handler: (request: Request) => Promise<Response>, workerKey: string | undefined) {
  return (request: Request): Promise<Response> => scope.run(serverCaller(request, workerKey), () => handler(request));
}

/** Comprueba el origen de cada `record_app_entry` del lote frente a quien llama. */
export function checkAppEntrySources(operations: Operation[], required: ReadonlySet<string> = APP_ENTRY_SOURCES_REQUIRED): void {
  const caller = scope.getStore() ?? null;
  for (const op of operations as Array<{ op?: string; procedure?: string; args?: { source_app?: unknown } }>) {
    if (op.op !== 'call' || op.procedure !== 'invoices.record_app_entry') continue;
    const source = String(op.args?.source_app ?? '').trim();
    if (caller && caller !== source) fail(403, 'SOURCE_MISMATCH', `La llamada viene de ${caller}: source_app tiene que ser ${caller}.`, { field: 'source_app' });
    if (required.has(source) && caller !== source) fail(403, 'CALLER_REQUIRED', `${source} envía a Finance desde su servidor, con X-Ikisai-Caller y la clave de worker.`, { field: 'source_app' });
  }
}
