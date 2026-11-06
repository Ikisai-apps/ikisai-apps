-- Ikisai Central · «También para todos los eventos» (VG, 06-11; central-U1, acordado con Booking): Booking pide a Central que
-- añada un uso a un espacio con `POST central-api worker/space-use`. La Edge de Central lee aquí el espacio (vivo, su revisión y
-- sus usos) como «Central (sistema)», que es editor en resources (núcleo 0125), y escribe el uso con core_commit en resources
-- con client_app central. Lectura de solo ese espacio; sin datos de personas. Toca solo central (lee resources.spaces).

create or replace function central.space_use_target(p_ctx jsonb)
returns jsonb language plpgsql stable as $$
declare v_id text := p_ctx->'args'->>'id'; v_row jsonb;
begin
  if v_id is null or v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform core.fail('INVALID_ARGS', 422);
  end if;
  select jsonb_build_object('id', s.id, 'revision', s.revision, 'uses', to_jsonb(s.uses)) into v_row
    from resources.spaces s where s.id = v_id::uuid and s.deleted_at is null;
  return jsonb_build_object('space', v_row);
end $$;
select core.allow_read('resources', 'central.space_use_target', 'function', '{editor,owner}');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
