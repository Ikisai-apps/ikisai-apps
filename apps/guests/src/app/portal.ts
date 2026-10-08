/**
 * Fases 4 y 5 (API.md §13): lo que configura el organizador y lo que publican Booking, Food y Organizers para el huésped.
 * Cada lectura guarda su última respuesta en la caché por persona para verla sin cobertura. Si una lectura todavía no
 * existe en el servidor (la app dueña aún no la ha publicado), devuelve `null` y Guests se comporta como en la fase 1.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { cache } from './cache.ts';
import { errorCode, isNetworkError } from './client.ts';
import type { Loaded } from './api.ts';

export type Window = 'before' | 'during' | 'after' | 'always';
export type LodgingCapability = 'view' | 'prefer' | 'choose' | 'request';

/** Configuración de la experiencia (`organizers.guest_experience_for`, §13.1). */
export interface Experience {
  revision: number;
  modules: {
    program?: { visible: boolean; window?: Window };
    menu?: { visible: boolean; window?: Window };
    materials?: { visible: boolean };
    questions?: { visible: boolean };
    lodging?: { visible: boolean; capability?: LodgingCapability; choose_until?: string | null; options?: Array<{ key: string; label: string; guest_note: string | null }> };
    map?: { visible: boolean };
  };
  organizer_message?: { text: string; lang?: string | null } | null;
}

/** Programa del retiro (`booking.portal_program`, §13.2). */
export interface ProgramItem { id: string; day: string; starts_at: string | null; ends_at: string | null; title: string; place: string | null; public_note: string | null; kind: string }

/** Menú publicado (`food.portal_menu`, §13.3). */
export interface Menu { status: 'provisional' | 'confirmado' | null; services: Array<{ date: string; type: string; time: string | null; dishes: Array<{ name: string }> }> }

/** Materiales del organizador (`organizers.guest_materials`, §13.5). */
export interface Material {
  id: string; kind: 'file' | 'link' | 'text'; title: string; description: string | null; window?: Window;
  file?: { id: string; name: string; mime: string; size: number } | null; url?: string | null; body?: string | null;
}

/** Preguntas del organizador (`organizers.guest_questions`, §13.6). */
export type QuestionType = 'text' | 'choice' | 'multi' | 'yes_no' | 'number' | 'date';
export interface Question {
  id: string; revision?: number; type: QuestionType; label: string; help: string | null; options: Array<{ value: string; label: string }>;
  required: boolean; open: boolean; answer: { value: unknown; revision?: number; updated_at?: string } | null;
}

/** Alojamiento (`booking.portal_lodging`, §13.7). */
export interface Lodging {
  mine: { space_name: string; zone: string | null; bed_label: string | null; status: 'confirmed' | 'requested' } | null;
  preference: { text: string | null; ground_floor: boolean } | null;
  rooms: Array<{ space_id: string; name: string; zone: string | null; kind?: string; en_suite: boolean; beds_total: number; beds_free: number; option_key: string | null;
    beds: Array<{ bed_id: string; label: string; kind: string; free: boolean }> }>;
}

export interface PortalReads {
  experience(reservationId: string): Promise<Loaded<Experience> | null>;
  program(reservationId: string): Promise<Loaded<{ items: ProgramItem[] }> | null>;
  menu(reservationId: string): Promise<Loaded<Menu> | null>;
  materials(reservationId: string): Promise<Loaded<{ items: Material[] }> | null>;
  questions(reservationId: string, guestId: string): Promise<Loaded<{ items: Question[] }> | null>;
  lodging(reservationId: string, guestId: string): Promise<Loaded<Lodging> | null>;
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
    experience: (reservationId) => read('organizers.guest_experience_for', { reservation_id: reservationId }),
    program: (reservationId) => read('booking.portal_program', { reservation_id: reservationId }),
    menu: (reservationId) => read('food.portal_menu', { reservation_id: reservationId }),
    materials: (reservationId) => read('organizers.guest_materials', { reservation_id: reservationId }),
    questions: (reservationId, guestId) => read('organizers.guest_questions', { reservation_id: reservationId, guest_id: guestId }),
    lodging: (reservationId, guestId) => read('booking.portal_lodging', { reservation_id: reservationId, guest_id: guestId }),
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
