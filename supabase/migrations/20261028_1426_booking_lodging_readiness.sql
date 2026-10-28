-- Ikisai Booking · camas listas para la apertura del alojamiento (petición de Flow, «Preparación y revisión de apertura»;
-- encargo de Core del 28-10-2026). Una cama está lista esa noche si está activa, colocada en el plano y sin limpieza pendiente;
-- la revisión de apertura de la habitación va por Tasks (`tasks.review_item_result`) y la cruza Flow.
-- - `booking.lodging_readiness({night, event_id?})` (editor, owner): por habitación con camas, cada cama con:
--   - si está activa y colocada (`cell`);
--   - si está ocupada o retenida esa noche (asignaciones vivas, estancias de outsider y retenciones de solicitudes:
--     `booking.free_beds`), y si es de ese evento;
--   - la limpieza que puede tener pendiente: la última salida anticipada de esa cama en los 7 días anteriores
--     (`planned_to_date`, 1402), con la referencia de la petición a Tasks (`booking:LIMP-<asignación>`).
--   El estado de la limpieza lo pone la Edge, preguntando a Tasks (`worker/requests/status`).
-- - Capacidad del catálogo `booking.lodging_readiness` (lectura), con reads (0111).
-- Toca solo el schema booking.

create or replace function booking.lodging_readiness(p jsonb)
returns jsonb language plpgsql stable as $$
declare a jsonb := coalesce(p->'args', '{}'::jsonb); v_night date; v_event uuid;
begin
  begin v_night := (a->>'night')::date; exception when others then v_night := null; end;
  if v_night is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'night')); end if;
  begin v_event := nullif(a->>'event_id', '')::uuid; exception when others then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'event_id')); end;
  return jsonb_build_object('night', v_night, 'event_id', v_event, 'rooms', coalesce((
    select jsonb_agg(jsonb_build_object('space_id', s.id, 'name', s.name, 'zone', s.zone, 'layout', s.layout,
             'resource_space_id', coalesce(s.resource_id, booking.resource_twin('booking.space', s.id)),
             'beds', (select jsonb_agg(jsonb_build_object('bed_id', b.id, 'label', b.label, 'kind', b.kind, 'capacity', b.capacity,
                        'active', b.active, 'placed', b.cell is not null,
                        'free', exists (select 1 from booking.free_beds(v_night, v_night + 1) f where f.bed_id = b.id),
                        'event', v_event is not null and exists (select 1 from booking.room_assignments ra where ra.bed_id = b.id and ra.event_id = v_event
                           and ra.deleted_at is null and ra.from_date <= v_night and v_night < ra.to_date),
                        'cleaning_ref', (select 'booking:LIMP-' || ra.id from booking.room_assignments ra
                           where ra.bed_id = b.id and ra.deleted_at is null and ra.planned_to_date is not null
                             and ra.to_date <= v_night and ra.to_date > v_night - 7 order by ra.to_date desc, ra.updated_at desc limit 1))
                      order by b.position, b.label)
                      from booking.beds b where b.space_id = s.id and b.deleted_at is null))
           order by s.zone nulls last, s.position, s.name)
      from booking.spaces s
     where s.deleted_at is null and s.active and exists (select 1 from booking.beds b where b.space_id = s.id and b.deleted_at is null)), '[]'::jsonb));
end $$;
select core.allow_read('booking', 'booking.lodging_readiness', 'function', '{editor,owner}');

select core.register_capability($cap${
  "id": "booking.lodging_readiness",
  "app": "booking",
  "kind": "read",
  "title": "Camas listas para la apertura",
  "description": "Para una noche, cada habitación con camas y, por cama: si está activa, si está colocada en el plano, si está libre (ni ocupada ni retenida), si es del evento y si tiene la limpieza pendiente en Tasks (la de la última salida anticipada). Una cama está lista si está activa, colocada, libre o del evento y sin limpieza pendiente. La revisión de apertura de la habitación va por Tasks.",
  "route": "GET lodging/readiness",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": ["night"],
    "additionalProperties": false,
    "properties": { "night": { "type": "string", "format": "date" }, "event_id": { "type": "string", "format": "uuid" } }
  },
  "output": {
    "type": "object",
    "required": ["night", "rooms"],
    "properties": {
      "night": { "type": "string", "format": "date" },
      "cleaning": { "enum": ["tasks", "unavailable"] },
      "rooms": { "type": "array", "items": { "type": "object", "properties": {
        "space_id": { "type": "string" }, "resource_space_id": { "type": ["string", "null"] }, "name": { "type": "string" },
        "beds": { "type": "integer" }, "places": { "type": "integer" }, "ready": { "type": "integer" }, "free": { "type": "integer" },
        "occupied": { "type": "integer" }, "pending_cleaning": { "type": "integer" }, "unplaced": { "type": "integer" }, "inactive": { "type": "integer" },
        "bed_list": { "type": "array" } } } }
    }
  },
  "reads": ["booking.spaces.name", "booking.spaces.layout", "booking.beds.active", "booking.beds.cell", "booking.beds.capacity", "booking.beds.label",
            "booking.room_assignments.bed_id", "booking.room_assignments.from_date", "booking.room_assignments.to_date", "booking.room_assignments.planned_to_date",
            "booking.visitor_requests.hold_bed_ids", "booking.visitor_requests.hold_until"],
  "writes": [],
  "anchors": ["booking.espacios.dormitorio", "booking.recepcion"],
  "since": "0.1.0"
}$cap$::jsonb);

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
