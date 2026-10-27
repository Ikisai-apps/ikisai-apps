/**
 * Subida inmediata de un archivo de Organizers (contrato §5: ticket, PUT directo al bucket y verificación), sin la cola de
 * `sync-client`. La usa dirección para proponer un material con archivo (propuestas del equipo de Ikisai, 0703): una
 * sugerencia no viaja con la cola de subidas, así que lleva el `file_id` ya verificado. Necesita red.
 *
 * El archivo es de quien lo sube hasta que se acepta la propuesta: entonces lo referencia el material del retiro y lo leen
 * quien organiza y, si lo publica, sus asistentes (K3). Si la propuesta no se acepta, la recogida de huérfanos lo borra.
 */
import type { SyncClient } from '@ikisai/sync-client';

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadNow(client: SyncClient, blob: Blob, meta: { filename: string; mime: string }): Promise<string> {
  const ticket = await client.api<{ id: string; uploadUrl: string; method?: string; headers?: Record<string, string> }>('/uploads', {
    method: 'POST', json: { filename: meta.filename, mime: meta.mime, size: blob.size, sha256: await sha256(blob) },
  });
  const headers = new Headers(ticket.headers ?? {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', meta.mime);
  let put: Response;
  try {
    put = await fetch(ticket.uploadUrl, { method: ticket.method ?? 'PUT', headers, body: blob });
  } catch {
    throw Object.assign(new Error('upload'), { code: 'NETWORK' });
  }
  if (!put.ok) throw Object.assign(new Error('upload'), { code: 'UPLOAD_FAILED' });
  await client.api(`/uploads/${encodeURIComponent(ticket.id)}/verify`, { method: 'POST', json: {} });
  return ticket.id;
}
