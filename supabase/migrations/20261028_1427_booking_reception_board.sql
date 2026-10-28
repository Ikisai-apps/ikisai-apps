-- Ikisai Booking · recepción «por puestos» (petición de Flow para la recepción de VG; autorizado por Core el 28-10-2026).
-- `booking.reception_board({event_id, day})` (editor y owner con el ámbito de huéspedes; la ruta lo comprueba) da las tarjetas de
-- trabajo de ese evento y ese día, una por puesto donde haya trabajo:
-- - solicitud_cobro: solicitudes de noches por decidir o pagadas en línea sin alojar, y cobros alojados sin cobrar;
-- - camas: camas que preparar para las llegadas del día, supletorias pedidas, comidas (restricciones) y extras contratados;
-- - registro: huéspedes que duermen esa noche con datos del parte por completar o con el documento sin ver;
-- - peticiones: un dato que deja un visitante y lo que pide quien organiza (una por petición);
-- - salida: quien sale ese día.
-- Cada tarjeta: {puesto, ref (id estable), title, subtitle, status: pendiente|en_curso|hecho, route (#/… de Booking), anchor}.
-- Sin datos personales de más: el número y el nombre de pila.
-- Capacidad del catálogo `booking.reception_board` (lectura), con reads.
-- Toca solo el schema booking.

create or replace function booking.reception_board(p jsonb)
returns jsonb language plpgsql stable as $$
declare a jsonb := coalesce(p->'args', '{}'::jsonb); v_event uuid; v_day date; v_res uuid; v_mode text; v_items jsonb := '[]'::jsonb;
begin
  begin v_event := (a->>'event_id')::uuid; exception when others then v_event := null; end;
  begin v_day := (a->>'day')::date; exception when others then v_day := null; end;
  if v_event is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'event_id')); end if;
  if v_day is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'day')); end if;
  select e.reservation_id into v_res from booking.events e where e.id = v_event and e.deleted_at is null;
  if v_res is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.events', 'id', v_event)); end if;
  v_mode := booking.guest_mode(v_res);

  -- solicitud y cobro: lo que está por decidir esa noche (o pagado en línea y sin alojar)
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'solicitud_cobro', 'ref', 'solicitud:' || q.id,
      'title', 'Nº ' || coalesce(q.number::text, '—') || ' · ' || split_part(btrim(q.name), ' ', 1),
      'subtitle', concat_ws(' · ', to_char(q.from_date, 'DD/MM') || '–' || to_char(q.to_date, 'DD/MM'), q.persons || ' pers.',
        case booking.stay_status_of(q) when 'pagada' then 'pagada en línea' when 'caducada' then 'retención caducada' else 'por cobrar' end),
      'status', case when booking.stay_status_of(q) = 'pagada' then 'en_curso' else 'pendiente' end,
      'route', '#/recepcion', 'anchor', case when booking.stay_status_of(q) = 'pagada' then 'booking.recepcion.alojar_pagado' else 'booking.recepcion.cobrar' end)
      order by q.number)
    from booking.visitor_requests q
   where q.event_id = v_event and q.deleted_at is null and q.kind = 'stay' and q.status = 'pendiente'
     and q.from_date <= v_day and v_day < q.to_date), '[]'::jsonb);
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'solicitud_cobro', 'ref', 'cobro:' || c.id,
      'title', split_part(btrim(g.first_name), ' ', 1), 'subtitle', 'Alojado sin cobrar · ' || to_char(c.amount_cents / 100.0, 'FM999990.00') || ' €',
      'status', 'pendiente', 'route', '#/recepcion', 'anchor', 'booking.recepcion.cobrar') order by g.first_name)
    from booking.walkin_charges c join booking.guests g on g.id = c.guest_id and g.deleted_at is null
    join booking.room_assignments ra on ra.id = c.assignment_id and ra.deleted_at is null
   where c.event_id = v_event and c.deleted_at is null and c.paid_at is null and ra.from_date <= v_day and v_day < ra.to_date), '[]'::jsonb);

  -- camas: preparar las de quien llega ese día, supletorias pedidas, comidas y extras
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'camas', 'ref', 'cama:' || ra.id,
      'title', concat_ws(' · ', booking.space_public_name(s), b.label),
      'subtitle', 'Llega ' || coalesce(split_part(btrim(g.first_name), ' ', 1), coalesce(ra.group_label, 'un grupo')),
      'status', case when g.arrived_at is not null then 'hecho' else 'pendiente' end,
      'route', '#/espacios', 'anchor', 'booking.espacios.dormitorio') order by s.name, b.label)
    from booking.room_assignments ra join booking.spaces s on s.id = ra.space_id left join booking.beds b on b.id = ra.bed_id
    left join booking.guests g on g.id = ra.guest_id
   where ra.event_id = v_event and ra.deleted_at is null and ra.from_date = v_day), '[]'::jsonb);
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'camas', 'ref', 'supletoria:' || x.id,
      'title', 'Supletoria · ' || coalesce(b.label, ''), 'subtitle', case x.status when 'requested' then 'Pedida' else 'Piden quitarla' end,
      'status', 'pendiente', 'route', '#/reservas/' || v_res, 'anchor', 'booking.reserva.alojamiento'))
    from booking.event_extra_beds x left join booking.beds b on b.id = x.bed_id
   where x.event_id = v_event and x.deleted_at is null and x.status in ('requested', 'release_requested')), '[]'::jsonb);
  v_items := v_items || coalesce((select jsonb_build_array(jsonb_build_object('puesto', 'camas', 'ref', 'comidas:' || v_event || ':' || v_day,
      'title', 'Comidas', 'subtitle', count(*) || ' restricciones alimentarias', 'status', 'pendiente',
      'route', '#/huespedes/' || v_event, 'anchor', 'booking.huespedes.lista'))
    from booking.dietary_restrictions d where d.event_id = v_event and d.deleted_at is null having count(*) > 0), '[]'::jsonb);
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'camas', 'ref', 'extra:' || x.id,
      'title', 'Extra · ' || coalesce(r.name, 'extra'), 'subtitle', 'Cantidad ' || trim(to_char(x.quantity, 'FM999990.##')),
      'status', 'pendiente', 'route', '#/reservas/' || v_res, 'anchor', 'booking.reserva.peticiones') order by r.name)
    from booking.reservation_extra_requests x left join booking.rates r on r.id = x.rate_id
   where x.reservation_id = v_res and x.deleted_at is null), '[]'::jsonb);

  -- registro de viajeros: quien duerme esa noche y tiene el parte por completar o el documento sin ver
  if v_mode <> 'ninguno' then
    v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'registro', 'ref', 'registro:' || g.id,
        'title', split_part(btrim(g.first_name), ' ', 1),
        'subtitle', case when cardinality(booking.guest_missing(g, v_mode)) > 0 then 'Faltan ' || cardinality(booking.guest_missing(g, v_mode)) || ' datos del parte'
                         else 'Documento sin ver' end,
        'status', case when g.arrived_at is not null then 'en_curso' else 'pendiente' end,
        'route', '#/huespedes/' || v_event || '/' || g.id, 'anchor', 'booking.huespedes.ficha.document_number') order by g.first_name)
      from booking.guests g
     where g.event_id = v_event and g.deleted_at is null and g.portal_role is null and g.left_at is null
       and exists (select 1 from booking.room_assignments ra where ra.guest_id = g.id and ra.deleted_at is null and ra.from_date <= v_day and v_day < ra.to_date)
       and (cardinality(booking.guest_missing(g, v_mode)) > 0 or (v_mode = 'ses' and not g.is_minor and g.document_checked_at is null))), '[]'::jsonb);
  end if;

  -- peticiones: un dato de un visitante (sin atender) y lo que pide quien organiza (sin responder)
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'peticiones', 'ref', 'dato:' || q.id,
      'title', coalesce(split_part(btrim(q.name), ' ', 1), 'Visitante'), 'subtitle', left(coalesce(q.note, 'Ha dejado un dato'), 80),
      'status', 'pendiente', 'route', '#/reservas/' || v_res, 'anchor', 'booking.reserva.visitantes') order by q.created_at)
    from booking.visitor_requests q where q.event_id = v_event and q.deleted_at is null and q.kind = 'contact' and q.status = 'pendiente'), '[]'::jsonb);
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'peticiones', 'ref', 'portal:' || x.id,
      'title', case x.kind when 'quiere_confirmar' then 'Quiere confirmar' else 'Comentario de quien organiza' end, 'subtitle', left(coalesce(x.message, ''), 80),
      'status', case x.status when 'vista' then 'en_curso' else 'pendiente' end, 'route', '#/reservas/' || v_res, 'anchor', 'booking.reserva.peticiones') order by x.created_at)
    from booking.portal_requests x where x.reservation_id = v_res and x.deleted_at is null and x.status in ('enviada', 'vista')), '[]'::jsonb);

  -- salida: quien sale ese día
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('puesto', 'salida', 'ref', 'salida:' || g.id,
      'title', split_part(btrim(g.first_name), ' ', 1), 'subtitle', concat_ws(' · ', booking.space_public_name(s), b.label),
      'status', case when g.left_at is not null then 'hecho' else 'pendiente' end, 'route', '#/recepcion', 'anchor', 'booking.recepcion.sale') order by g.first_name)
    from booking.guests g join booking.room_assignments ra on ra.guest_id = g.id and ra.deleted_at is null
    join booking.spaces s on s.id = ra.space_id left join booking.beds b on b.id = ra.bed_id
   where g.event_id = v_event and g.deleted_at is null and coalesce(ra.planned_to_date, ra.to_date) = v_day), '[]'::jsonb);

  return jsonb_build_object('event_id', v_event, 'day', v_day, 'items', v_items);
end $$;
select core.allow_read('booking', 'booking.reception_board', 'function', '{editor,owner}');

select core.register_capability($cap${
  "id": "booking.reception_board",
  "app": "booking",
  "kind": "read",
  "title": "Recepción por puestos",
  "description": "Las tarjetas de trabajo de un evento y un día en la recepción, una por puesto donde haya trabajo: solicitud y cobro, camas (con supletorias pedidas, comidas y extras), registro de viajeros, peticiones y salida. Cada tarjeta lleva título, subtítulo, estado (pendiente, en curso, hecho) y la ruta y el anclaje de la pantalla de Booking donde se hace. Solo el número y el nombre de pila.",
  "route": "GET reception/board",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": ["event_id", "day"],
    "additionalProperties": false,
    "properties": { "event_id": { "type": "string", "format": "uuid" }, "day": { "type": "string", "format": "date" } }
  },
  "output": {
    "type": "object",
    "required": ["items"],
    "properties": { "items": { "type": "array", "items": { "type": "object", "required": ["puesto", "ref", "title", "status", "route"], "properties": {
      "puesto": { "enum": ["solicitud_cobro", "camas", "registro", "peticiones", "salida"] }, "ref": { "type": "string" }, "title": { "type": "string" },
      "subtitle": { "type": ["string", "null"] }, "status": { "enum": ["pendiente", "en_curso", "hecho"] }, "route": { "type": "string" }, "anchor": { "type": ["string", "null"] } } } } }
  },
  "reads": ["booking.visitor_requests.status", "booking.visitor_requests.number", "booking.visitor_requests.name", "booking.visitor_requests.from_date",
            "booking.visitor_requests.to_date", "booking.visitor_requests.note", "booking.walkin_charges.paid_at", "booking.walkin_charges.amount_cents",
            "booking.room_assignments.from_date", "booking.room_assignments.to_date", "booking.room_assignments.planned_to_date", "booking.event_extra_beds.status",
            "booking.dietary_restrictions.event_id", "booking.reservation_extra_requests.quantity", "booking.portal_requests.status", "booking.portal_requests.message"],
  "writes": [],
  "anchors": ["booking.recepcion"],
  "since": "0.1.0"
}$cap$::jsonb);

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
