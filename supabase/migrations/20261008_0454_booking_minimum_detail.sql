-- Ikisai Booking · cierre de la fase 2 de Organizers: más campos en el detalle de la reserva (B14) y enviar una propuesta por
-- debajo del mínimo comercial solo confirmando con un motivo, que queda guardado (decisión de Core, 8-10-2026). Toca solo booking.

alter table booking.proposals add column below_minimum_reason text check (below_minimum_reason is null or length(below_minimum_reason) <= 500);
select core.register_table('booking', 'booking', 'proposals', array['reservation_id','status','nature','conditions_id','start_date',
  'end_date','persons','subtotal','adjustments','vat_amount','total','deposit_amount','valid_until','includes','excludes','notes',
  'sent_at','decided_at','below_minimum_reason'], '{editor,owner}', '{editor,owner}');

create or replace function booking.portal_reservation_detail(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_r booking.reservations; v_e booking.events;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select * into v_r from booking.reservations where id = v_res and deleted_at is null;
  if v_r.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  select * into v_e from booking.events where reservation_id = v_res and deleted_at is null;
  return jsonb_build_object(
    'id', v_r.id, 'code', v_r.code, 'title', v_r.title, 'status', v_r.status, 'start_date', v_r.start_date, 'end_date', v_r.end_date,
    'revision', v_r.revision, 'event_type', v_r.event_type, 'dates_definitive', v_r.dates_definitive, 'organizer_notes', v_r.organizer_notes,
    'special_setup', v_r.special_setup, 'technical_support', v_r.technical_support,
    'expected_guests', v_r.expected_guests, 'final_guests', v_e.final_guests, 'minors_count', v_r.minors_count,
    'arrival_time', v_e.arrival_time, 'departure_time', v_e.departure_time,
    'meal_plan', coalesce(v_e.meal_plan_confirmed, v_r.meal_plan_requested), 'meal_plan_confirmed', v_e.meal_plan_confirmed is not null,
    'menu_style', coalesce(v_e.menu_style_confirmed, v_r.menu_style_requested), 'menu_style_confirmed', v_e.menu_style_confirmed is not null,
    'uses_accommodation', v_r.uses_accommodation, 'requires_meals', v_r.requires_meals, 'uses_interpretation_center', v_r.uses_interpretation_center,
    'uses_outdoors', v_r.uses_outdoors, 'uses_pool', v_r.uses_pool,
    'mode', booking.guest_mode(v_res), 'confirmed', v_e.id is not null,
    'lodging', coalesce((select jsonb_agg(jsonb_build_object('space', s.name, 'kind', s.kind, 'zone', s.zone, 'persons', x.persons) order by s.zone nulls last, s.position)
      from (select a.space_id, sum(a.persons)::int persons from booking.room_assignments a where a.event_id = v_e.id and a.deleted_at is null group by a.space_id) x
      join booking.spaces s on s.id = x.space_id), '[]'::jsonb));
end $$;

create or replace function booking.send_proposal(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_p booking.proposals; v_other booking.proposals; v_totals jsonb; v_minimum numeric;
  v_reason text := nullif(btrim(coalesce(v_args->>'below_minimum_reason', '')), '');
begin
  v_p := booking.lock_proposal(v_args);
  if v_p.status <> 'borrador' then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('id', v_p.id, 'status', v_p.status)); end if;
  if v_p.conditions_id is null then perform core.fail('PROPOSAL_INCOMPLETE', 422, jsonb_build_object('id', v_p.id, 'missing', jsonb_build_array('conditions_id'))); end if;
  if not exists (select 1 from booking.proposal_lines where proposal_id = v_p.id and deleted_at is null) then
    perform core.fail('PROPOSAL_INCOMPLETE', 422, jsonb_build_object('id', v_p.id, 'missing', jsonb_build_array('lines')));
  end if;
  v_totals := booking.proposal_totals(v_p.id);
  if (v_totals->>'total')::numeric < 0 then perform core.fail('PROPOSAL_NEGATIVE', 422, jsonb_build_object('id', v_p.id, 'total', v_totals->'total')); end if;

  -- por debajo del mínimo comercial: se puede enviar como excepción, confirmando con un motivo que queda en la propuesta
  select minimum_total into v_minimum from booking.conditions where id = v_p.conditions_id;
  if v_minimum is not null and (v_totals->>'total')::numeric < v_minimum and v_reason is null then
    perform core.fail('BELOW_MINIMUM', 422, jsonb_build_object('id', v_p.id, 'total', v_totals->'total', 'minimum', v_minimum));
  end if;
  if v_reason is not null and (v_minimum is null or (v_totals->>'total')::numeric >= v_minimum) then v_reason := null; end if;

  perform set_config('booking.proposal_procedure', 'on', true);
  for v_other in select * from booking.proposals where reservation_id = v_p.reservation_id and id <> v_p.id and status = 'enviada' and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'booking.proposals',
      'id', v_other.id, 'expectedRevision', v_other.revision, 'fields', jsonb_build_object('status', 'sustituida')));
  end loop;
  perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'booking.proposals',
    'id', v_p.id, 'expectedRevision', coalesce((v_args->>'expectedRevision')::bigint, v_p.revision),
    'fields', v_totals || jsonb_build_object('status', 'enviada', 'sent_at', now(), 'below_minimum_reason', left(v_reason, 500))));
  perform set_config('booking.proposal_procedure', 'off', true);
  return jsonb_build_object('proposal_id', v_p.id, 'status', 'enviada') || v_totals;
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
