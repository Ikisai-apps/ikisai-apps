/**
 * Lecturas y acciones de Booking para el huésped (docs/guests/API.md §6.2, Booking §16.6 y §16.8). Las lecturas guardan
 * su última respuesta en la caché local para verlas sin red; las escrituras las ordena `writer.ts`.
 */
import type { SyncClient } from '@ikisai/sync-client';
import type { GuestMode } from '@ikisai/domain-booking';
import { cache } from './cache.ts';
import { isNetworkError } from './client.ts';

export type Source = 'guest' | 'organizer' | 'staff';

export interface Restriction {
  id?: string; restriction_type: string; subject: string | null; severity: string | null; kitchen_notes: string | null; source?: Source;
}

export interface MyGuest {
  id: string; revision: number; mode: GuestMode; fields: Record<string, string | boolean | null>; missing: string[]; signed: boolean;
  sources: Record<string, Source>; allergies_visible_to_organizer: boolean; privacy_ack_at: string | null; privacy_ack_version: string | null;
  diet_reviewed_at: string | null; signature_text_version: string | null;
  /** Huésped de muestra para la vista previa del organizador (BG11): solo lectura. */
  preview?: boolean;
  reservation: { title: string; start_date: string | null; end_date: string | null; status: string; arrival_time: string | null; departure_time: string | null };
  restrictions: Restriction[];
}

/** Entrada del ámbito de la cuenta: una persona en un retiro (API.md §5). */
export interface Grant { reservation_id: string; guest_id: string }

/** Resultado de una lectura: `at` es la hora de los datos y `stale` dice si vienen de la caché por falta de red. */
export interface Loaded<T> { value: T; at: string; stale: boolean }

export interface WriteResult { guest_id: string; revision: number; cursor: number | null; signature_reset?: boolean }

export interface GuestApi {
  grants(): Grant[];
  myGuest(guestId: string): Promise<Loaded<MyGuest>>;
  update(guestId: string, expectedRevision: number, fields: Record<string, unknown>): Promise<WriteResult>;
  consent(guestId: string, expectedRevision: number, args: { allergies_visible_to_organizer?: boolean; privacy_ack_version?: string }): Promise<WriteResult>;
  restrictions(guestId: string, items: Restriction[]): Promise<WriteResult>;
  sign(guestId: string, expectedRevision: number, image: Blob, signedByName: string, textVersion: string | null): Promise<WriteResult>;
  permanentAccount(): Promise<boolean>;
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createGuestApi(client: SyncClient): GuestApi {
  const userId = () => client.bootstrap()?.profile.userId ?? 'anon';
  const invoke = (name: string, args: Record<string, unknown>) => client.api<WriteResult>(`/invoke/${name}`, { method: 'POST', json: args });

  /** Imagen de la firma: ticket, PUT directo al bucket `guests-documents` y verificación (contrato §5). */
  async function upload(image: Blob): Promise<string> {
    const ticket = await client.api<{ id: string; uploadUrl: string; method?: string; headers?: Record<string, string> }>('/uploads', {
      method: 'POST', json: { filename: 'firma.png', mime: image.type || 'image/png', size: image.size, sha256: await sha256(image) },
    });
    const headers = new Headers(ticket.headers ?? {});
    if (!headers.has('Content-Type')) headers.set('Content-Type', image.type || 'image/png');
    let put: Response;
    try {
      put = await fetch(ticket.uploadUrl, { method: ticket.method ?? 'PUT', headers, body: image });
    } catch {
      throw Object.assign(new Error('upload'), { code: 'NETWORK' });
    }
    if (!put.ok) throw Object.assign(new Error('upload'), { code: 'UPLOAD_FAILED' });
    await client.api(`/uploads/${encodeURIComponent(ticket.id)}/verify`, { method: 'POST', json: {} });
    return ticket.id;
  }

  return {
    grants() {
      const scopes = client.bootstrap()?.membership.scopes as { grants?: Array<Partial<Grant>> } | null | undefined;
      return (scopes?.grants ?? []).filter((g): g is Grant => typeof g.reservation_id === 'string' && typeof g.guest_id === 'string');
    },
    async myGuest(guestId) {
      const user = userId();
      try {
        const value = await client.api<MyGuest>('/read/booking.portal_my_guest', { method: 'POST', json: { guest_id: guestId } });
        void cache.saveRead(user, 'my_guest', { guestId }, value);
        return { value, at: new Date().toISOString(), stale: false };
      } catch (error) {
        if (isNetworkError(error)) {
          const copy = await cache.read<MyGuest>(user, 'my_guest', { guestId });
          if (copy) return { value: copy.value, at: copy.at, stale: true };
        }
        throw error;
      }
    },
    update: (guestId, expectedRevision, fields) => invoke('booking.portal_guest_update', { guest_id: guestId, expectedRevision, fields }),
    consent: (guestId, expectedRevision, args) => invoke('booking.portal_guest_consent', { guest_id: guestId, expectedRevision, ...args }),
    restrictions: (guestId, items) => invoke('booking.portal_set_restrictions', {
      guest_id: guestId,
      items: items.map((r) => ({ restriction_type: r.restriction_type, subject: r.subject || null, severity: r.severity || null, kitchen_notes: r.kitchen_notes || null })),
    }),
    async sign(guestId, expectedRevision, image, signedByName, textVersion) {
      const fileId = await upload(image);
      return invoke('booking.portal_guest_sign', { guest_id: guestId, expectedRevision, file_id: fileId, signed_by_name: signedByName, ...(textVersion ? { text_version: textVersion } : {}) });
    },
    async permanentAccount() {
      try {
        return (await client.api<{ permanentAccount?: boolean }>('/auth/config')).permanentAccount === true;
      } catch {
        return false;
      }
    },
  };
}
