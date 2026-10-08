/**
 * Tipos de las fases 4 y 5 (API.md §13), sin dependencias: los usan `portal.ts`, `normalize.ts` y sus pruebas (que el
 * typecheck de la raíz compila sin los alias de Vite).
 */
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

/** Programa del retiro (`booking.portal_program`, Booking §23). */
export interface ProgramItem { id: string; day: string; starts_at: string | null; ends_at: string | null; title: string; place: string | null; public_note: string | null; kind: string; position?: number }

/** Plato publicado (`food.portal_menu`, Food §7.5): nombre y descripción públicos; los alérgenos, solo si cocina los revisó. */
export interface Dish { menu_item_id?: string; name: string; description?: string | null; category?: string | null; diet_tags?: string[] | null; allergens?: string[] | null; allergens_checked?: boolean }

/** Menú publicado (`food.portal_menu`, Food §7.5). Guests solo ve los menús validados o cerrados. */
export interface Menu {
  available?: boolean; status: 'provisional' | 'confirmado' | null;
  services: Array<{ service_id?: string; date: string; type: string; time: string | null; dishes: Dish[] }>;
}

/** El lugar de Ikisai (`central.portal_place_projection`, Central §2.9): nombre, dirección del lugar, mapa y plano. */
export interface Place { name: string | null; address: string | null; map_url: string | null; site_plan_file_id: string | null; site_plan_mime: string | null; site_plan_size: number | null }

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

/**
 * Alojamiento (`booking.portal_lodging`, Booking §23.1). Los ajustes son de Booking: `choice` (`off`, `choose` o `request`),
 * `choose_until` (día, inclusive, en hora de Madrid), `open` (la elección sigue abierta) y `preferences` (se piden preferencias).
 */
export interface Lodging {
  choice?: 'off' | 'choose' | 'request'; choose_until?: string | null; open?: boolean; preferences?: boolean;
  mine: { space_name: string; zone: string | null; bed_label: string | null; status: 'confirmed' | 'requested'; source?: string } | null;
  preference: { text: string | null; ground_floor: boolean } | null;
  rooms: Array<{ space_id: string; name: string; zone: string | null; kind?: string; capacity?: number | null; en_suite: boolean; small_en_suite?: boolean;
    option_key: string | null; open?: boolean; supplement?: boolean; beds_total: number; beds_free: number;
    beds: Array<{ bed_id: string; label: string; kind: string; free: boolean; mine?: boolean }> }>;
}
