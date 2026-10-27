-- Ikisai Booking · «Recepción» del alojamiento como la barra (VG 27-10-2026; va sobre 1400). Recepción busca el número,
-- completa, cobra y aloja en un gesto: `booking.join_from_visitor({request_id, decision: 'accept', method?})` deja a la
-- persona alojada de verdad. En el mismo lote se crean:
-- - una ficha por persona con su borrador (`stay_travelers`, que se borra al pasarlo); sin borrador, la primera con el
--   nombre de la solicitud y el resto como acompañantes. Lo que falte se completa en Huéspedes;
-- - la asignación de cama con las fechas pedidas, en este orden:
--   - las camas retenidas, si el bloqueo sigue vivo;
--   - las elegidas, si siguen libres;
--   - si no, camas libres en ese momento. Si ya no hay, 409 `NO_AVAILABILITY` y no se crea nada;
-- - el cobro de cada asignación (`walkin_charges`, noches × precio de la tarifa por las personas de esa cama). Con
--   `method` (`cash` | `bizum` | `bitcoin` | `card`) queda ya cobrado (`paid_at`); sin él, pendiente. La ficha lo manda a
--   Finance con las cabeceras de servidor (#867).
-- El bloqueo se suelta al pasar la solicitud a «aceptada»: la validación del lote ya no lo ve.
-- Además:
-- - el cobro en recepción admite Bitcoin (`bitcoin`), como la caja de Flow. A Finance va con la misma clave de método;
-- - `booking.visitor_claim({visitor_id, request_id})`, para «Tu ficha está lista» de Guests, devuelve
--   `{guest_id, reservation_id}` solo si la solicitud es de ese visitante, está aceptada y tiene ficha. Lo llama el núcleo
--   (sistema).
-- Toca solo el schema booking.

alter table booking.walkin_charges drop constraint walkin_charges_method_check;
alter table booking.walkin_charges add constraint walkin_charges_method_check check (method is null or method in ('cash', 'bizum', 'card', 'bitcoin'));

create or replace function booking.join_from_visitor(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb); v_req booking.visitor_requests; v_guest uuid; v_name text; v_id uuid;
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role'; v_rid text := p->>'requestId'; v_cur bigint := (p->>'cursor')::bigint;
  v_beds uuid[]; v_left integer; v_n integer := 0; v_in integer; v_guests uuid[] := '{}'; v_assign uuid; v_night integer; v_nights integer;
  v_method text := nullif(v_args->>'method', ''); v_fields jsonb; t booking.stay_travelers;
  f record; b record;
begin
  begin v_id := (v_args->>'request_id')::uuid; exception when others then v_id := null; end;
  select * into v_req from booking.visitor_requests where id = v_id and deleted_at is null;
  if v_req.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.visitor_requests', 'id', v_args->>'request_id')); end if;
  if v_req.status <> 'pendiente' then return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'guest_id', v_req.guest_id); end if;
  perform set_config('booking.visitor_procedure', 'on', true);
  if v_req.kind = 'contact' and v_args->>'decision' in ('done', 'reject') then
    perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', case when v_args->>'decision' = 'done' then 'atendida' else 'descartada' end, 'decided_at', now())));
    perform set_config('booking.visitor_procedure', '', true);
    return jsonb_build_object('request_id', v_req.id, 'status', case when v_args->>'decision' = 'done' then 'atendida' else 'descartada' end, 'guest_id', null);
  end if;
  if v_req.kind = 'contact' then
    perform set_config('booking.visitor_procedure', '', true);
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'decision', 'reason', 'un dato se atiende o se descarta'));
  end if;
  if v_args->>'decision' = 'accept' then
    if v_method is not null and v_method not in ('cash', 'bizum', 'bitcoin', 'card') then
      perform set_config('booking.visitor_procedure', '', true);
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'method'));
    end if;
    v_name := left(coalesce(nullif(btrim(v_args->>'name'), ''), v_req.name, 'Visitante'), 120);
    if v_req.kind <> 'stay' then
      v_guest := gen_random_uuid();
      perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
        jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_guest, 'fields', jsonb_build_object('event_id', v_req.event_id, 'first_name', v_name)));
    else
      -- una ficha por persona, con su borrador si lo hay (y el borrador se borra al pasarlo)
      for v_n in 1 .. v_req.persons loop
        v_id := gen_random_uuid();
        select * into t from booking.stay_travelers where request_id = v_req.id and position = v_n and deleted_at is null;
        v_fields := jsonb_strip_nulls(jsonb_build_object('event_id', v_req.event_id,
          'first_name', coalesce(nullif(btrim(t.first_name), ''), case when v_n = 1 then v_name else left(format('Acompañante %s de %s', v_n - 1, v_name), 120) end),
          'last_name_1', t.last_name_1, 'last_name_2', t.last_name_2, 'sex', t.sex, 'document_type', t.document_type, 'document_number', t.document_number,
          'document_support_number', t.document_support_number, 'nationality', t.nationality, 'birth_date', t.birth_date,
          'residence_address', t.residence_address, 'residence_postal_code', t.residence_postal_code, 'residence_city', t.residence_city,
          'residence_country', t.residence_country, 'phone', t.phone, 'email', t.email, 'kinship', t.kinship))
          || case when t.id is not null and t.is_minor then jsonb_build_object('is_minor', true) else '{}'::jsonb end;
        perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur, jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id, 'fields', v_fields));
        if t.id is not null then
          perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
            jsonb_build_object('op', 'delete', 'table', 'booking.stay_travelers', 'id', t.id, 'expectedRevision', t.revision));
        end if;
        v_guests := v_guests || v_id;
      end loop;
      v_guest := v_guests[1];
      -- las camas: las retenidas si el bloqueo sigue vivo; las elegidas si siguen libres; si no, las libres ahora
      if v_req.hold_until is not null and v_req.hold_until > now() and coalesce(cardinality(v_req.hold_bed_ids), 0) > 0 then
        v_beds := v_req.hold_bed_ids;
      elsif coalesce(cardinality(v_req.hold_bed_ids), 0) > 0
        and not exists (select 1 from unnest(v_req.hold_bed_ids) c(id) where c.id not in (select x.bed_id from booking.free_beds(v_req.from_date, v_req.to_date) x))
        and (select coalesce(sum(greatest(coalesce(bb.capacity, 1), 1)), 0) from booking.beds bb where bb.id = any (v_req.hold_bed_ids)) >= v_req.persons then
        v_beds := v_req.hold_bed_ids;
      else
        v_beds := '{}'; v_left := v_req.persons;
        for f in select * from booking.free_beds(v_req.from_date, v_req.to_date) order by space_id, bed_id loop
          exit when v_left <= 0;
          v_beds := v_beds || f.bed_id; v_left := v_left - f.places;
        end loop;
        if v_left > 0 then
          perform set_config('booking.visitor_procedure', '', true);
          perform core.fail('NO_AVAILABILITY', 409, jsonb_build_object('request_id', v_req.id, 'persons', v_req.persons));
        end if;
      end if;
      v_nights := v_req.to_date - v_req.from_date;
      v_night := v_req.total_cents / greatest(v_nights * v_req.persons, 1);
      v_left := v_req.persons; v_n := 1;
      for b in select bb.id, bb.space_id, greatest(coalesce(bb.capacity, 1), 1) as places from booking.beds bb where bb.id = any (v_beds) order by bb.space_id, bb.id loop
        exit when v_left <= 0;
        v_in := least(b.places, v_left);
        v_assign := gen_random_uuid();
        perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
          jsonb_build_object('op', 'insert', 'table', 'booking.room_assignments', 'id', v_assign, 'fields', jsonb_build_object(
            'event_id', v_req.event_id, 'space_id', b.space_id, 'bed_id', b.id, 'guest_id', v_guests[v_n], 'persons', v_in,
            'from_date', v_req.from_date, 'to_date', v_req.to_date)));
        perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
          jsonb_build_object('op', 'insert', 'table', 'booking.walkin_charges', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
            'event_id', v_req.event_id, 'assignment_id', v_assign, 'guest_id', v_guests[v_n], 'nights', v_nights,
            'price_cents', v_night * v_in, 'amount_cents', v_night * v_in * v_nights)
            || case when v_method is not null then jsonb_build_object('method', v_method, 'paid_at', now()) else '{}'::jsonb end));
        v_left := v_left - v_in; v_n := v_n + v_in;
      end loop;
    end if;
    perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', 'aceptada', 'guest_id', v_guest, 'decided_at', now())));
  elsif v_args->>'decision' = 'reject' then
    perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', 'descartada', 'decided_at', now())));
  else
    perform set_config('booking.visitor_procedure', '', true);
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'decision'));
  end if;
  perform set_config('booking.visitor_procedure', '', true);
  return jsonb_build_object('request_id', v_req.id, 'status', case when v_guest is null then 'descartada' else 'aceptada' end, 'guest_id', v_guest);
end $$;

-- «Tu ficha está lista» (Guests): la ficha de la solicitud aceptada de ese visitante.
create or replace function booking.visitor_claim(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('guest_id', q.guest_id, 'reservation_id', e.reservation_id)
    from booking.visitor_requests q join booking.events e on e.id = q.event_id
    join booking.guests g on g.id = q.guest_id and g.deleted_at is null
   where q.deleted_at is null and q.status = 'aceptada' and q.guest_id is not null
     and q.id = nullif(coalesce(p->'args'->>'request_id', p->>'request_id'), '')::uuid
     and q.visitor_id = nullif(coalesce(p->'args'->>'visitor_id', p->>'visitor_id'), '')::uuid
$$;
select core.allow_read('booking', 'booking.visitor_claim', 'action', '{}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
