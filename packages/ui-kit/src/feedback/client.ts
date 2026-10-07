/**
 * Cliente del feedback sobre las rutas de FEEDBACK.md §7, con la bandeja sin red (especificación §18):
 * - «Enviar» guarda primero en la bandeja (IndexedDB) y luego intenta enviar: sube las imágenes (`feedback/uploads` →
 *   PUT firmado → `verify`), y después `POST feedback` con el mismo `id` y `requestId` en cada intento (idempotente).
 * - Sin red o con 5xx, reintenta al arrancar, con el evento `online` y con un temporizador de espera creciente (al recargar
 *   sin red Chromium no emite `online`). Un error que no se arregla reintentando (límite, fuera de ámbito, idempotencia)
 *   deja el elemento marcado para que la persona lo vea.
 * - «Enviado» solo cuando el servidor confirma.
 */
import type { FeedbackOutboxItem } from './store.ts';
import { feedbackOutbox } from './store.ts';

export interface FeedbackApiInit { method?: string; json?: unknown }
/** La `api` de `sync-client` (`client.api(path, init)`): rutas relativas a `/api/v1`, errores con `status` y `code`. */
export type FeedbackApi = <T = unknown>(path: string, init?: FeedbackApiInit) => Promise<T>;

export interface FeedbackReport {
  id: string; code: string; originApp: string; subject: string; intent: string; message: string;
  node: { id: string; path: string[] } | null; status: string; display: string; supportersCount: number; mine: boolean;
  createdAt: string; verifiedAt?: string | null; verifiedBuild?: string | null;
  /** «Me bloquea» (FEEDBACK.md §8.6). */
  blocking?: boolean;
}

export interface FeedbackClientOptions {
  api: FeedbackApi;
  app: string;
  userId: () => string | null;
  /** Para subir los Blobs al `uploadUrl` firmado (por defecto `fetch`). */
  fetchImpl?: typeof fetch;
  onChange?: () => void;
  onSent?: (report: FeedbackReport, item: FeedbackOutboxItem) => void;
}

export interface FeedbackClient {
  enqueue(item: FeedbackOutboxItem): Promise<void>;
  flush(): Promise<void>;
  pending(): Promise<FeedbackOutboxItem[]>;
  openReports(nodeId: string): Promise<FeedbackReport[]>;
  support(reportId: string): Promise<number>;
  /** Reportes corregidos a la espera de que alguien compruebe (`GET feedback?status=pending_verify&app=`). */
  pendingVerify(): Promise<FeedbackReport[]>;
  verify(reportId: string, build: string | null): Promise<void>;
  reopen(reportId: string, message?: string): Promise<void>;
  destroy(): void;
}

const PERMANENT = new Set(['FEEDBACK_TOO_MANY_ATTACHMENTS', 'FEEDBACK_MESSAGE_TOO_LONG', 'FEEDBACK_CONTEXT_TOO_LARGE', 'FEEDBACK_ATTACHMENT_INVALID', 'OUT_OF_SCOPE', 'IDEMPOTENCY_REUSE', 'FEEDBACK_RATE_LIMITED']);

function errorCode(error: unknown): { code: string; status: number } {
  const e = error as { code?: string; status?: number; name?: string };
  return { code: e?.code ?? (e?.name === 'TypeError' ? 'NETWORK' : 'ERROR'), status: e?.status ?? 0 };
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createFeedbackClient(options: FeedbackClientOptions): FeedbackClient {
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attemptsSinceSuccess = 0;

  function schedule(): void {
    if (timer) clearTimeout(timer);
    const wait = Math.min(300_000, 5_000 * 2 ** Math.min(6, attemptsSinceSuccess));
    timer = setTimeout(() => { timer = null; void flush(); }, wait);
  }

  async function upload(item: FeedbackOutboxItem): Promise<void> {
    for (const image of item.images) {
      if (image.uploadedId) continue;
      const meta = await options.api<{ id: string; uploadUrl: string; method?: string; headers?: Record<string, string>; duplicateOf?: string | null }>('/feedback/uploads', {
        json: { filename: image.filename, mime: image.mime, size: image.blob.size, sha256: await sha256(image.blob) },
      });
      if (meta.duplicateOf) { image.uploadedId = meta.duplicateOf; await feedbackOutbox.put(item); continue; }
      const put = await doFetch(meta.uploadUrl, { method: meta.method ?? 'PUT', headers: meta.headers ?? { 'Content-Type': image.mime }, body: image.blob });
      if (!put.ok) throw Object.assign(new Error('No se pudo subir la imagen'), { status: put.status, code: put.status >= 500 ? 'UPLOAD' : 'FEEDBACK_ATTACHMENT_INVALID' });
      await options.api(`/feedback/uploads/${encodeURIComponent(meta.id)}/verify`, { method: 'POST', json: {} });
      image.uploadedId = meta.id;
      await feedbackOutbox.put(item);
    }
  }

  async function send(item: FeedbackOutboxItem): Promise<void> {
    try {
      await upload(item);
      const { report } = await options.api<{ report: FeedbackReport }>('/feedback', {
        json: {
          id: item.id, requestId: item.requestId, subject: item.subject, intent: item.intent, message: item.message,
          node: { id: item.nodeId, path: item.nodePath }, blocking: !!item.blocking, scope: item.scope, category: item.category, context: item.context,
          attachmentIds: item.images.map((i) => i.uploadedId).filter(Boolean),
        },
      });
      await feedbackOutbox.delete(item.id);
      attemptsSinceSuccess = 0;
      options.onSent?.(report, item);
    } catch (error) {
      const { code, status } = errorCode(error);
      item.attempts += 1;
      item.lastError = code;
      item.failed = PERMANENT.has(code) || (status >= 400 && status < 500 && status !== 408);
      await feedbackOutbox.put(item);
      if (!item.failed) { attemptsSinceSuccess += 1; schedule(); }
    }
  }

  async function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      const user = options.userId();
      if (!user) return;
      const items = (await feedbackOutbox.list(user, options.app)).filter((i) => !i.failed);
      for (const item of items) await send(item);
      options.onChange?.();
    })().finally(() => { flushing = null; });
    return flushing;
  }

  const onOnline = () => { void flush(); };
  window.addEventListener('online', onOnline);
  void flush();

  return {
    async enqueue(item) { await feedbackOutbox.put(item); options.onChange?.(); await flush(); },
    flush,
    async pending() { const user = options.userId(); return user ? feedbackOutbox.list(user, options.app) : []; },
    async openReports(nodeId) {
      try { return (await options.api<{ items: FeedbackReport[] }>(`/feedback?node=${encodeURIComponent(nodeId)}&status=open&limit=5`)).items ?? []; }
      catch { return []; }
    },
    async pendingVerify() {
      try { return (await options.api<{ items: FeedbackReport[] }>(`/feedback?status=pending_verify&app=${encodeURIComponent(options.app)}`)).items ?? []; }
      catch { return []; }
    },
    async verify(reportId, build) { await options.api(`/feedback/${encodeURIComponent(reportId)}/verify`, { method: 'POST', json: { build } }); },
    async reopen(reportId, message) { await options.api(`/feedback/${encodeURIComponent(reportId)}/reopen`, { method: 'POST', json: message ? { message } : {} }); },
    async support(reportId) { return (await options.api<{ supportersCount: number }>(`/feedback/${encodeURIComponent(reportId)}/support`, { method: 'POST', json: {} })).supportersCount; },
    destroy() { window.removeEventListener('online', onOnline); if (timer) clearTimeout(timer); },
  };
}
