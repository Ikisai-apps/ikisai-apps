/**
 * Fases 4 y 5 (API.md §13): lo que configura el organizador y lo que publican Booking, Food y Organizers para el huésped.
 * Cada lectura guarda su última respuesta en la caché por persona para verla sin cobertura. Si una lectura todavía no
 * existe en el servidor (la app dueña aún no la ha publicado), devuelve `null` y Guests se comporta como en la fase 1.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { cache } from './cache.ts';
import { errorCode, isNetworkError } from './client.ts';
import type { Loaded } from './api.ts';
import { normalizeExperience, normalizeMaterial, normalizeQuestion } from './normalize.ts';

export * from './portal-types.ts';
import type { Experience, Lodging, Material, Menu, Place, ProgramItem, Question, Window } from './portal-types.ts';

export interface PortalReads {
  experience(reservationId: string): Promise<Loaded<Experience> | null>;
  program(reservationId: string): Promise<Loaded<{ items: ProgramItem[] }> | null>;
  menu(reservationId: string, guestId: string): Promise<Loaded<Menu> | null>;
  place(): Promise<Loaded<Place> | null>;
  materials(reservationId: string): Promise<Loaded<{ items: Material[] }> | null>;
  questions(reservationId: string, guestId: string): Promise<Loaded<{ items: Question[] }> | null>;
  lodging(guestId: string): Promise<Loaded<Lodging> | null>;
  answer(guestId: string, questionId: string, value: unknown): Promise<{ revision?: number }>;
  chooseBed(guestId: string, bedId: string): Promise<{ revision?: number; status: 'confirmed' | 'requested' }>;
  releaseBed(guestId: string): Promise<unknown>;
  roomPreference(guestId: string, text: string | null, groundFloor: boolean): Promise<unknown>;
  /** URL firmada de 5 minutos de un archivo publicado a este portal (C8, `GET portal-files/:fileId`). */
  fileUrl(fileId: string): Promise<{ url: string; expiresAt: string; name?: string; mime?: string }>;
}

/** Errores que significan «esta lectura aún no existe o no te corresponde»: se trata como módulo sin publicar. */
const NOT_PUBLISHED = new Set(['NOT_FOUND', 'READ_NOT_ALLOWED', 'NOT_ALLOWED', 'FORBIDDEN', 'UNKNOWN_READ', 'OUT_OF_SCOPE']);

export function createPortalReads(client: SyncClient): PortalReads {
  const userId = () => client.bootstrap()?.profile.userId ?? 'anon';

  async function read<T>(name: string, args: Record<string, unknown>): Promise<Loaded<T> | null> {
    const user = userId();
    try {
      const value = await client.api<T>(`/read/${name}`, { method: 'POST', json: args });
      void cache.saveRead(user, name, args, value);
      return { value, at: new Date().toISOString(), stale: false };
    } catch (error) {
      if (isNetworkError(error)) {
        const copy = await cache.read<T>(user, name, args);
        if (copy) return { value: copy.value, at: copy.at, stale: true };
        throw error;
      }
      const status = (error as { status?: number }).status;
      if (NOT_PUBLISHED.has(errorCode(error)) || status === 404 || status === 403) return null;
      throw error;
    }
  }
  const invoke = <T>(name: string, args: Record<string, unknown>) => client.api<T>(`/invoke/${name}`, { method: 'POST', json: args });

  return {
    experience: async (reservationId) => {
      const loaded = await read<unknown>('organizers.guest_experience_for', { reservation_id: reservationId });
      const value = loaded ? normalizeExperience(loaded.value) : null;
      return loaded && value ? { ...loaded, value } : null;
    },
    program: (reservationId) => read('booking.portal_program', { reservation_id: reservationId }),
    menu: (reservationId, guestId) => read('food.portal_menu', { reservation_id: reservationId, guest_id: guestId }),
    place: async () => {
      // Proyección (vista): una fila; se pide por GET con límite, como los textos de Central.
      const user = userId();
      try {
        const out = await client.api<{ rows?: Place[]; items?: Place[] }>('/read/central.portal_place_projection?limit=1');
        const value = (out.rows ?? out.items ?? [])[0];
        if (!value) return null;
        void cache.saveRead(user, 'central.portal_place_projection', {}, value);
        return { value, at: new Date().toISOString(), stale: false };
      } catch (error) {
        if (isNetworkError(error)) {
          const copy = await cache.read<Place>(user, 'central.portal_place_projection', {});
          return copy ? { value: copy.value, at: copy.at, stale: true } : null;
        }
        return null;
      }
    },
    materials: async (reservationId) => {
      const loaded = await read<{ items?: Array<Record<string, unknown>> }>('organizers.guest_materials', { reservation_id: reservationId });
      return loaded ? { ...loaded, value: { items: (loaded.value.items ?? []).map(normalizeMaterial) } } : null;
    },
    questions: async (reservationId, guestId) => {
      const loaded = await read<{ items?: Array<Record<string, unknown>> }>('organizers.guest_questions', { reservation_id: reservationId, guest_id: guestId });
      return loaded ? { ...loaded, value: { items: (loaded.value.items ?? []).map(normalizeQuestion) } } : null;
    },
    lodging: (guestId) => read('booking.portal_lodging', { guest_id: guestId }),
    answer: (guestId, questionId, value) => invoke('organizers.guest_answer', { guest_id: guestId, question_id: questionId, value }),
    chooseBed: (guestId, bedId) => invoke('booking.portal_choose_bed', { guest_id: guestId, bed_id: bedId }),
    releaseBed: (guestId) => invoke('booking.portal_release_bed', { guest_id: guestId }),
    roomPreference: (guestId, text, groundFloor) => invoke('booking.portal_room_preference', { guest_id: guestId, text, ground_floor: groundFloor }),
    fileUrl: (fileId) => client.api(`/portal-files/${encodeURIComponent(fileId)}`),
  };
}

/** ¿Se ve ahora un módulo con esa ventana? `moment` es antes, durante o después del retiro (hora de Madrid). */
export function inWindow(window: Window | undefined, moment: 'before' | 'during' | 'after'): boolean {
  return !window || window === 'always' || window === moment;
}
