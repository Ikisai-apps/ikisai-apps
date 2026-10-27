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
/**
 * Actividad del programa (`booking.portal_program`, Booking §23). `audience` y `audience_guest_ids` (MUELA-065): para quién
 * es (`todos` por defecto); con `personas`, solo los huéspedes del ámbito de quien lee. `resource_space_id`: el espacio de
 * Recursos, para el plano cuando el portal pueda leer los dibujos.
 */
export interface ProgramItem {
  id: string; day: string; starts_at: string | null; ends_at: string | null; title: string; place: string | null; public_note: string | null; kind: string; position?: number;
  audience?: 'todos' | 'adultos' | 'menores' | 'personas' | null; audience_guest_ids?: string[] | null; resource_space_id?: string | null;
}

/** Plato publicado (`food.portal_menu`, Food §7.5): nombre y descripción públicos; los alérgenos, solo si cocina los revisó. */
export interface Dish { menu_item_id?: string; photo_thumb_file_id?: string | null; name: string; description?: string | null; category?: string | null; diet_tags?: string[] | null; allergens?: string[] | null; allergens_checked?: boolean }

/** Menú publicado (`food.portal_menu`, Food §7.5). Guests solo ve los menús validados o cerrados. */
export interface Menu {
  available?: boolean; status: 'provisional' | 'confirmado' | null;
  services: Array<{ service_id?: string; date: string; type: string; time: string | null; dishes: Dish[] }>;
}

/** Un dibujo del mapa de zonas (`GET plans`, Recursos §2): el archivo ya firmado por la Edge de Guests (10 minutos). */
export interface PortalPlan {
  id: string; buildingId: string; floor: string | null; position: number; width: number; height: number;
  fileId: string | null; mime: string | null; sha256: string | null; url: string | null;
  /** Finca y decoración (Recursos 0814): el plano de la finca es `estate`; retícula, alturas y curvas de nivel con su cota. */
  kind?: 'building' | 'estate';
  grid?: { metersPerUnit: number; originX?: number; originY?: number } | null;
  bands?: Array<{ name: string; y0: number; y1: number }> | null;
  contours?: Array<{ spaceId: string; label: string; elevationM: number | null; x: number; y: number; points?: Array<[number, number]> }> | null;
}
/** Icono de decoración, ya firmado (10 minutos). */
export interface PortalIcon { id: string; name: string; category: string; defaultSize: number; fileId: string | null; mime: string | null; url: string | null }
/** Pieza de la decoración general (Recursos 0814): celda en su escala, tamaño y giro. */
export interface PortalDecor { id: string; planId: string; iconId: string | null; cellX: number; cellY: number; scale: number; size: number; rotation: number }
/** Silueta, sección o foto de un edificio o exterior, ya firmada. */
export interface PortalImage {
  id: string; spaceId: string; kind: 'silueta' | 'seccion' | 'foto' | string; title: string | null; position: number; url: string | null;
  /** Apps de las que es la silueta de cabecera (Recursos 0816; la elige Central en «Imágenes del centro»). */
  headerFor?: string[];
}
/** Un espacio con su forma en el dibujo (solo nombres públicos y geometría; las camas, sin ocupación). */
export interface PortalSpace {
  id: string; parentId: string | null; kind: string; name: string; planId: string | null; planShape: { points: Array<[number, number]> } | null; position: number;
  /** Tipo de cama (Recursos 0816), para su icono en el mapa. */
  bedKind?: string;
}
export interface PortalPlans { plans: PortalPlan[]; spaces: PortalSpace[]; icons?: PortalIcon[]; decor?: PortalDecor[]; images?: PortalImage[] }

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
  /** Ficha de equipo (Booking §29.4): solo camas de equipo; sin ninguna, la asigna el equipo. */
  team?: boolean;
  /** `resource_space_id` y `resource_bed_id` (Booking #680): su pareja en Recursos, para el mapa; null si no la hay. */
  mine: { space_name: string; zone: string | null; bed_label: string | null; status: 'confirmed' | 'requested'; source?: string; resource_space_id?: string | null; resource_bed_id?: string | null } | null;
  preference: { text: string | null; ground_floor: boolean } | null;
  rooms: Array<{ space_id: string; resource_space_id?: string | null; name: string; zone: string | null; kind?: string; capacity?: number | null; en_suite: boolean; small_en_suite?: boolean;
    option_key: string | null; open?: boolean; supplement?: boolean; beds_total: number; beds_free: number;
    /** Supletorias activadas por el organizador (BG13): van en `beds` con `kind: 'supletoria'` y se cuentan aparte. */
    extra_total?: number; extra_free?: number;
    beds: Array<{ bed_id: string; resource_bed_id?: string | null; label: string; kind: string; free: boolean; mine?: boolean }> }>;
}
