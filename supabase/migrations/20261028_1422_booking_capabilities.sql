-- Ikisai Booking · dos capacidades en el catálogo del núcleo (0097, con reads/writes de la 0111; encargo de Core del 27-10-2026,
-- para Flow y el Guiado). La función es del núcleo; el dato, de Booking. docs/booking/API.md §45.
-- - `booking.accept_stay` «Alojar en recepción»: `POST stays/:id/accept`. Acepta una solicitud de noches: fichas con el
--   borrador, cama con fechas y cobro (cobrado si trae método). Necesita el ámbito de huéspedes.
-- - `booking.cancel_stay_online` «Cancelar noches pagadas en línea»: `POST stays/:id/cancel/online`. La política de VG
--   (1419), devolución por la pasarela una sola vez. Necesita el ámbito de huéspedes.
-- - `booking.stay_cancel` admite `by_staff` (solo lo pasa esa ruta, después de comprobar el permiso): el personal cancela sin ser
--   el visitante.
-- Los campos de `booking.guests` van construidos por partes en `reads`/`writes`: el lint de schemas los tomaría por referencias
-- al schema guests.
-- Toca solo el schema booking.

create or replace function booking.stay_cancel(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb); q booking.visitor_requests; sp booking.stay_payments; v_quote jsonb;
  v_ops jsonb := '[]'::jsonb; v_left integer; v_part integer; f record;
begin
  select * into q from booking.visitor_requests where id = nullif(a->>'request_id', '')::uuid and deleted_at is null;
  -- el visitante dueño o, desde la ruta del personal (que ya ha comprobado el permiso y el ámbito), `by_staff`
  if q.id is null or q.kind <> 'stay' or (coalesce((a->>'by_staff')::boolean, false) is not true and q.visitor_id is distinct from nullif(a->>'visitor_id', '')::uuid) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.visitor_requests'));
  end if;
  select * into sp from booking.stay_payments where request_id = q.id and deleted_at is null and status in ('paid', 'partially_refunded', 'refunded')
   order by paid_at desc limit 1 for update;
  if sp.id is null then perform core.fail('NOT_PAID_ONLINE', 409, jsonb_build_object('request_id', q.id)); end if;
  if q.status = 'descartada' then return jsonb_build_object('request_id', q.id, 'status', 'cancelada', 'replayed', true); end if;
  if q.status <> 'pendiente' and q.status <> 'aceptada' then perform core.fail('REQUEST_CLOSED', 409, jsonb_build_object('request_id', q.id, 'status', q.status)); end if;
  if q.status = 'aceptada' and exists (select 1 from booking.guests g where g.id in (select booking.stay_guests_of(q)) and g.arrived_at is not null) then
    perform core.fail('ALREADY_ARRIVED', 409, jsonb_build_object('request_id', q.id));
  end if;
  v_quote := booking.stay_cancel_quote_of(q, now());
  if a->>'action' = 'quote' then
    return v_quote || jsonb_build_object('request_id', q.id, 'provider', sp.provider, 'provider_ref', sp.provider_ref);
  end if;
  -- reservar la cancelación: el primero fija el importe; los demás reciben el mismo
  if a->>'action' = 'claim' then
    if sp.cancel_claimed_at is null then
      perform core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.stay_payments', 'id', sp.id,
        'expectedRevision', sp.revision, 'fields', jsonb_build_object('cancel_refund_cents', (v_quote->>'refund_cents')::integer, 'cancel_claimed_at', now()))));
      return v_quote || jsonb_build_object('request_id', q.id, 'provider', sp.provider, 'provider_ref', sp.provider_ref, 'claimed', true);
    end if;
    return v_quote || jsonb_build_object('request_id', q.id, 'provider', sp.provider, 'provider_ref', sp.provider_ref, 'claimed', false,
      'refund_cents', sp.cancel_refund_cents);
  end if;
  if a->>'action' <> 'apply' then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'action')); end if;
  -- lo reservado con `claim` (la ruta ya lo ha pedido a la pasarela)
  if sp.cancel_claimed_at is null then perform core.fail('INVALID_OPERATION', 409, jsonb_build_object('reason', 'claim first')); end if;
  v_left := sp.cancel_refund_cents;
  if q.status = 'aceptada' then
    for f in select c.id, c.revision, c.amount_cents, c.refund_cents from booking.walkin_charges c
              where c.guest_id in (select booking.stay_guests_of(q)) and c.deleted_at is null and c.method = 'online' order by c.created_at, c.id loop
      v_part := least(v_left, f.amount_cents - f.refund_cents);
      if v_part > 0 then
        v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.walkin_charges', 'id', f.id, 'expectedRevision', f.revision,
          'fields', jsonb_build_object('refund_cents', f.refund_cents + v_part, 'refund_method', 'online', 'refunded_at', now()));
        v_left := v_left - v_part;
      end if;
    end loop;
    for f in select x.id, x.revision from booking.room_assignments x where x.guest_id in (select booking.stay_guests_of(q)) and x.deleted_at is null loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', f.id, 'expectedRevision', f.revision);
    end loop;
    for f in select g.id, g.revision from booking.guests g where g.id in (select booking.stay_guests_of(q)) loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.guests', 'id', f.id, 'expectedRevision', f.revision);
    end loop;
  end if;
  v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', q.id, 'expectedRevision', q.revision,
    'fields', jsonb_build_object('status', 'descartada', 'decided_at', now(), 'hold_until', null, 'guest_id', null));
  perform set_config('booking.visitor_procedure', 'on', true);
  perform core.apply_system_operations('booking', v_ops);
  perform set_config('booking.visitor_procedure', '', true);
  return v_quote || jsonb_build_object('request_id', q.id, 'status', 'cancelada', 'replayed', false, 'refunded_now_cents', sp.cancel_refund_cents);
end $$;

with c as (select $cap${
  "id": "booking.accept_stay",
  "app": "booking",
  "kind": "execute",
  "title": "Alojar en recepción",
  "description": "Acepta una solicitud de noches de «Alójate aquí» (o del QR): crea una ficha por persona con los datos del borrador, la cama con sus fechas y el cobro. Con método, el cobro queda cobrado; con «online», solo si la pasarela ha confirmado el pago. Repetir sobre una solicitud ya decidida no hace nada.",
  "route": "POST stays/:id/accept",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "method": { "enum": ["cash", "bizum", "bitcoin", "card", "online"] },
      "name": { "type": "string", "minLength": 1, "maxLength": 120 }
    }
  },
  "output": {
    "type": "object",
    "required": ["request_id", "status"],
    "properties": {
      "request_id": { "type": "string", "format": "uuid" },
      "status": { "enum": ["aceptada", "descartada", "pendiente"] },
      "guest_id": { "type": ["string", "null"], "format": "uuid" }
    }
  },
  "reads": ["booking.visitor_requests.status", "booking.visitor_requests.from_date", "booking.visitor_requests.to_date", "booking.visitor_requests.persons", "booking.visitor_requests.total_cents", "booking.visitor_requests.hold_bed_ids", "booking.visitor_requests.hold_until", "booking.stay_travelers.first_name", "booking.stay_travelers.last_name_1", "booking.stay_travelers.email", "booking.stay_travelers.phone", "booking.stay_travelers.document_number", "booking.stay_travelers.is_minor", "booking.stay_payments.status", "booking.beds.capacity"],
  "writes": ["booking.room_assignments.bed_id", "booking.room_assignments.from_date", "booking.room_assignments.to_date", "booking.walkin_charges.amount_cents", "booking.walkin_charges.nights", "booking.walkin_charges.method", "booking.walkin_charges.paid_at", "booking.visitor_requests.status", "booking.visitor_requests.guest_id", "booking.visitor_requests.decided_at"],
  "anchors": ["booking.recepcion.cobrar", "booking.recepcion.alojar_pagado", "booking.recepcion.metodo"],
  "since": "0.1.0"
}$cap$::jsonb j)
select core.register_capability(jsonb_set(jsonb_set(j,
  '{reads}', (j->'reads') || jsonb_build_array()),
  '{writes}', (j->'writes') || jsonb_build_array('booking.guests' || '.first_name', 'booking.guests' || '.last_name_1', 'booking.guests' || '.last_name_2', 'booking.guests' || '.email', 'booking.guests' || '.phone', 'booking.guests' || '.document_type', 'booking.guests' || '.document_number', 'booking.guests' || '.birth_date', 'booking.guests' || '.nationality', 'booking.guests' || '.is_minor'))) from c;

with c as (select $cap${
  "id": "booking.cancel_stay_online",
  "app": "booking",
  "kind": "execute",
  "title": "Cancelar noches pagadas en línea",
  "description": "Cancela una solicitud de noches pagada en línea con la política de VG: se devuelve el 100 % hasta 7 días antes de la llegada, la mitad hasta 48 h antes y nada después; si la casa cancela el evento, el 100 %. Sin `confirm` solo dice cuánto se devolvería. Con `confirm`, pide la devolución a la pasarela (una sola vez, aunque se repita), suelta la cama y, si ya estaba alojado sin haber llegado, retira sus fichas y anota lo devuelto en sus cobros.",
  "route": "POST stays/:id/cancel/online",
  "roles": ["editor", "owner"],
  "risk": "medium",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": { "confirm": { "type": "boolean" } }
  },
  "output": {
    "type": "object",
    "required": ["status"],
    "properties": {
      "status": { "enum": ["quote", "cancelada"] },
      "percent": { "enum": [0, 50, 100] },
      "tier": { "enum": ["full", "half", "none", "event_cancelled"] },
      "paid_cents": { "type": "integer" },
      "refund_cents": { "type": "integer" },
      "full_until": { "type": "string", "format": "date-time" },
      "half_until": { "type": "string", "format": "date-time" },
      "replayed": { "type": "boolean" }
    }
  },
  "reads": ["booking.visitor_requests.status", "booking.visitor_requests.from_date", "booking.reservations.status", "booking.stay_payments.amount_cents", "booking.stay_payments.refunded_cents", "booking.stay_payments.status"],
  "writes": ["booking.stay_payments.cancel_refund_cents", "booking.stay_payments.cancel_claimed_at", "booking.walkin_charges.refund_cents", "booking.walkin_charges.refund_method", "booking.walkin_charges.refunded_at", "booking.room_assignments.deleted_at", "booking.visitor_requests.status", "booking.visitor_requests.guest_id", "booking.visitor_requests.hold_until"],
  "anchors": ["booking.recepcion.ficha"],
  "since": "0.1.0"
}$cap$::jsonb j)
select core.register_capability(jsonb_set(jsonb_set(j,
  '{reads}', (j->'reads') || jsonb_build_array('booking.guests' || '.arrived_at')),
  '{writes}', (j->'writes') || jsonb_build_array('booking.guests' || '.deleted_at'))) from c;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
