/**
 * Clientes de reservas anteriores (B-35, VG 05-11: «elegir qué cliente es y que se rellene el contacto»; B-44 c: la base de
 * clientes son los contactos que ya hay en Booking, sin Central ni Finance). Un cliente por nombre de contacto (sin
 * mayúsculas, tildes ni espacios de más), con el teléfono y el correo de su reserva más reciente que los tenga.
 */
/** Como `normalizeName` del kit (sin cargar el kit en las pruebas de Node): minúsculas, sin tildes y espacios simples. */
const normalizeName = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface PastClient { name: string; phone: string | null; email: string | null; title: string; date: string | null }

type Row = Record<string, any>;
const clean = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Los clientes de las demás reservas vivas, de la más reciente a la más antigua. */
export function pastClients(reservations: readonly Row[], exceptId: string | null = null): PastClient[] {
  const recent = reservations
    .filter((r) => !r.deleted_at && r.id !== exceptId && clean(r.contact_name))
    .sort((a, b) => String(b.start_date ?? b.created_at ?? '').localeCompare(String(a.start_date ?? a.created_at ?? '')));
  const byName = new Map<string, PastClient>();
  for (const r of recent) {
    const key = normalizeName(clean(r.contact_name)!);
    const known = byName.get(key);
    if (!known) { byName.set(key, { name: clean(r.contact_name)!, phone: clean(r.contact_phone), email: clean(r.contact_email), title: String(r.title ?? ''), date: r.start_date ?? null }); continue; }
    // si la más reciente no tenía teléfono o correo, los de una anterior
    known.phone ??= clean(r.contact_phone);
    known.email ??= clean(r.contact_email);
  }
  return [...byName.values()];
}

/** El cliente con ese nombre (sin mayúsculas, tildes ni espacios de más), si lo hay. */
export function clientNamed(clients: readonly PastClient[], name: unknown): PastClient | null {
  const text = clean(name);
  return text ? clients.find((c) => normalizeName(c.name) === normalizeName(text)) ?? null : null;
}
