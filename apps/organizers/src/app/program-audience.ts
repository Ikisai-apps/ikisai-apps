/**
 * «Para quién» de cada actividad del programa (MUELA-065, PR 3; Booking #664, API de Booking §23). Puro y sin navegador
 * (`tests/organizers/program-audience.test.ts`).
 * - `audience`: `todos` (por defecto), `adultos`, `menores` o `personas`; con `personas`, `audience_guest_ids` lleva de 1
 *   a 100 huéspedes del retiro. Con los demás, la lista va vacía (Booking la vacía también al cambiar).
 * - Lo que se enseña: «Para todos» no se escribe en la lista (es lo de siempre); el resto sí («Solo adultos», «Solo: Leo»).
 * - Los textos se traducen con el `t` que se pase (la clave es el español, como en el resto de la app).
 */
type Tr = (spanish: string, vars?: Record<string, string | number>) => string;
const plain: Tr = (s, vars) => s.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (vars && k in vars ? String(vars[k]) : m));

export type Audience = 'todos' | 'adultos' | 'menores' | 'personas';
export const AUDIENCES: readonly Audience[] = ['todos', 'adultos', 'menores', 'personas'];
export const MAX_AUDIENCE_GUESTS = 100;

/** Lo que llega de Booking, tolerante con lo de antes de #664 (sin el dato = «todos»). */
export function audienceOf(item: { audience?: string | null; audience_guest_ids?: string[] | null }): { audience: Audience; ids: string[] } {
  const audience = AUDIENCES.includes(item.audience as Audience) ? (item.audience as Audience) : 'todos';
  return { audience, ids: audience === 'personas' ? [...(item.audience_guest_ids ?? [])] : [] };
}

/** Nombre de cada opción del selector. */
export function audienceLabel(audience: Audience, t: Tr = plain): string {
  return audience === 'adultos' ? t('Solo adultos') : audience === 'menores' ? t('Solo menores') : audience === 'personas' ? t('Algunas personas') : t('Todos');
}

/**
 * La etiqueta de la lista del día, o `null` para «Todos». Con `personas`, los nombres (como mucho 3 y «y N más»); los
 * que ya no están en la lista de asistentes no se nombran.
 */
export function audienceText(item: { audience?: string | null; audience_guest_ids?: string[] | null }, nameOf: (id: string) => string | null, t: Tr = plain): string | null {
  const { audience, ids } = audienceOf(item);
  if (audience === 'todos') return null;
  if (audience !== 'personas') return audienceLabel(audience, t);
  const names = ids.map(nameOf).filter((x): x is string => !!x);
  if (!names.length) return t('Solo algunas personas');
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? t('Solo: {nombres} y {n} más', { nombres: shown, n: names.length - 3 }) : t('Solo: {nombres}', { nombres: shown });
}

/** Lo que se envía a `portal_program_save`, o el error que se enseña en la hoja. */
export function audienceFields(audience: Audience, selected: readonly string[], t: Tr = plain): { ok: true; fields: { audience: Audience; audience_guest_ids: string[] } } | { ok: false; error: string } {
  if (audience !== 'personas') return { ok: true, fields: { audience, audience_guest_ids: [] } };
  const ids = [...new Set(selected)];
  if (!ids.length) return { ok: false, error: t('Elige al menos a una persona.') };
  if (ids.length > MAX_AUDIENCE_GUESTS) return { ok: false, error: t('Como mucho {n} personas.', { n: MAX_AUDIENCE_GUESTS }) };
  return { ok: true, fields: { audience, audience_guest_ids: ids } };
}
