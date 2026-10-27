-- Ikisai Flow · numerar huéspedes y marcar su presencia solo con huéspedes del evento (auditoría de seguridad del 27-10, FL12).
-- `assign_guest_numbers` y `mark_presence` aceptaban cualquier `guest_id`. Ahora preguntan a Booking por el núcleo
-- (`flow_guests_of`, con el ámbito de quien actúa) y fallan si alguno no es de ese evento. Un flujo sin evento no tiene
-- huéspedes: `409 NO_BOOKING_EVENT`.

create or replace function flow.check_event_guests(p jsonb, p_project uuid, p_guests uuid[]) returns void language plpgsql as $$
declare v_event uuid; v_out jsonb; v_missing uuid[];
begin
  select booking_event_id into v_event from flow.projects where id = p_project and deleted_at is null;
  if v_event is null then perform core.fail('NO_BOOKING_EVENT', 409, jsonb_build_object('project_id', p_project)); end if;
  if coalesce(array_length(p_guests, 1), 0) = 0 then return; end if;
  v_out := core.read('flow', (p->>'actor')::uuid, 'booking' || '.flow_guests_of', jsonb_build_object('event_id', v_event));
  select array_agg(g) into v_missing from unnest(p_guests) g
   where not exists (select 1 from jsonb_array_elements(coalesce(v_out->'items', '[]'::jsonb)) i where (i->>'guest_id')::uuid = g);
  if v_missing is not null then
    perform core.fail('GUEST_NOT_IN_EVENT', 422, jsonb_build_object('event_id', v_event, 'guest_ids', to_jsonb(v_missing[1:20])));
  end if;
end $$;

create or replace function flow.assign_guest_numbers(p jsonb) returns jsonb language plpgsql as $$
declare v_project uuid := flow.arg_uuid(p, 'project_id'); v_g jsonb; v_guest uuid; v_name text; v_c flow.customers; v_created int := 0; v_updated int := 0;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guest numbers are for the owner')); end if;
  perform flow.check_scope(p, v_project); -- hoy siempre owner (pasa); por coherencia con los demás procedimientos
  if not exists (select 1 from flow.projects where id = v_project and deleted_at is null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.projects', 'id', v_project));
  end if;
  if jsonb_typeof(p->'args'->'guests') <> 'array' or jsonb_array_length(p->'args'->'guests') > 1000 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'guests must be an array of up to 1000'));
  end if;
  -- FL12: solo huéspedes del evento del flujo, según Booking.
  perform flow.check_event_guests(p, v_project, array(select (g->>'guest_id')::uuid from jsonb_array_elements(p->'args'->'guests') g
                                                        where coalesce(g->>'guest_id', '') ~* '^[0-9a-f-]{36}$'));
  for v_g in select * from jsonb_array_elements(p->'args'->'guests') loop
    begin v_guest := (v_g->>'guest_id')::uuid; exception when others then v_guest := null; end;
    if v_guest is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'guest_id must be a uuid')); end if;
    v_name := nullif(left(btrim(coalesce(v_g->>'display_name', '')), 80), '');
    select * into v_c from flow.customers where project_id = v_project and guest_id = v_guest for update;
    if v_c.id is null then
      -- Token al azar que nadie conoce: el huésped entra por su invitación, que lo rota.
      perform flow.ins(p, 'flow.customers', jsonb_build_object('project_id', v_project, 'origin', 'guest', 'guest_id', v_guest, 'display_name', v_name,
        'token_hash', encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex')));
      v_created := v_created + 1;
    elsif v_c.display_name is distinct from v_name then
      perform flow.upd(p, 'flow.customers', v_c.id, v_c.revision, jsonb_build_object('display_name', v_name));
      v_updated := v_updated + 1;
    end if;
  end loop;
  perform flow.log(p, v_project, 'guest_numbers', null, null, jsonb_build_object('created', v_created, 'updated', v_updated));
  perform flow.proc_end();
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'customers', coalesce((
    select jsonb_agg(jsonb_build_object('guest_id', guest_id, 'number', number) order by number)
      from flow.customers where project_id = v_project and origin = 'guest' and deleted_at is null), '[]'::jsonb));
end $$;

create or replace function flow.mark_presence(p jsonb) returns jsonb language plpgsql as $$
declare
  v_project uuid := flow.arg_uuid(p, 'project_id'); v_guest uuid := flow.arg_uuid(p, 'guest_id'); v_step text := p->'args'->>'step';
  v_undo boolean := coalesce((p->'args'->>'undo')::boolean, false); v_m flow.presence_marks;
begin
  perform flow.proc_begin();
  perform flow.check_scope(p, v_project);
  if not exists (select 1 from flow.columns where project_id = v_project and deleted_at is null and behavior = 'guest_presence' and config->>'stage' = v_step) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'this flow has no such step', 'step', v_step));
  end if;
  perform flow.check_event_guests(p, v_project, array[v_guest]); -- FL12
  select * into v_m from flow.presence_marks where project_id = v_project and guest_id = v_guest and step = v_step and deleted_at is null for update;
  if v_undo then
    if v_m.id is not null then perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.presence_marks', 'id', v_m.id, 'expectedRevision', v_m.revision)); end if;
  elsif v_m.id is null then
    perform flow.ins(p, 'flow.presence_marks', jsonb_build_object('project_id', v_project, 'guest_id', v_guest, 'step', v_step, 'done_at', now(),
      'done_by', (p->>'actor')::uuid));
  end if;
  perform flow.proc_end();
  return jsonb_build_object('guest_id', v_guest, 'step', v_step, 'done', not v_undo);
end $$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
