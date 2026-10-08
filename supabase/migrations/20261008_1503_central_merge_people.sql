-- Ikisai Central · una persona, una ficha, una cuenta (decisión del usuario del 8-10-2026). Cuando el alta descubre que el
-- correo ya tiene cuenta enlazada a otra ficha, es la misma persona duplicada: `central.merge_people` fusiona dos fichas en
-- una sola transacción. La que se queda (`into`) recibe los datos reservados que le falten, los registros y documentos, los
-- equipos y las responsabilidades (obligaciones, documentos clave, decisiones); la otra (`from`) va a la papelera, con
-- `merged_into` apuntando a la que queda (restaurable, aunque vacía: lo suyo ya está en la otra).
-- Nunca dos fichas enlazadas a la misma cuenta: ya lo garantiza el índice único `people_user_idx` (0500).
-- Toca solo el schema central.

alter table central.people add column merged_into uuid references central.people(id);

-- `merged_into` solo lo escribe el procedimiento: la validación de la Edge no lo admite desde la app.
select core.register_table('central', 'central', 'people', array['display_name','relation','base_role','coverage','availability',
  'availability_notes','active','committed_post','user_id','position','merged_into']);

-- Campos de una fila que se pueden copiar a otra persona (las columnas escribibles registradas, sin `person_id`).
create or replace function central.copyable_fields(p_table text, p_row jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(k, p_row->k), '{}'::jsonb)
    from core.synced_tables s, unnest(s.writable_columns) k
   where s.app = 'central' and s.schema_name || '.' || s.table_name = p_table and k <> 'person_id' and p_row ? k;
$$;

create or replace function central.merge_people(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role'; v_req text := p->>'requestId';
  v_cursor bigint := (p->>'cursor')::bigint;
  v_from central.people; v_into central.people; fp central.person_private; ip central.person_private;
  r record; v_fields jsonb; v_moved jsonb := '{}'::jsonb; n int;
begin
  if v_role <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only the owner merges people')); end if;
  select * into v_from from central.people where id = (p->'args'->>'from')::uuid and deleted_at is null for update;
  select * into v_into from central.people where id = (p->'args'->>'into')::uuid and deleted_at is null for update;
  if v_from.id is null or v_into.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('reason', 'both people must exist and be alive')); end if;
  if v_from.id = v_into.id then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a person cannot be merged into itself')); end if;
  if v_from.user_id is not null and v_into.user_id is not null and v_from.user_id <> v_into.user_id then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'both people have different accounts'));
  end if;

  -- Datos reservados: si la que queda no tiene, se copian; si tiene, se completan sus huecos. Los de la otra, a la papelera.
  select * into fp from central.person_private where person_id = v_from.id and deleted_at is null;
  select * into ip from central.person_private where person_id = v_into.id and deleted_at is null;
  if fp.id is not null then
    if ip.id is null then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'insert', 'table', 'central.person_private',
        'id', gen_random_uuid(), 'fields', central.copyable_fields('central.person_private', to_jsonb(fp)) || jsonb_build_object('person_id', v_into.id)));
    else
      select coalesce(jsonb_object_agg(k, to_jsonb(fp)->k), '{}'::jsonb) into v_fields
        from jsonb_object_keys(central.copyable_fields('central.person_private', to_jsonb(fp))) k
       where (to_jsonb(ip)->>k) is null or (to_jsonb(ip)->>k) = '';
      v_fields := jsonb_strip_nulls(v_fields);
      if v_fields <> '{}'::jsonb then
        perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'update', 'table', 'central.person_private',
          'id', ip.id, 'expectedRevision', ip.revision, 'fields', v_fields));
      end if;
    end if;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'delete', 'table', 'central.person_private', 'id', fp.id, 'expectedRevision', fp.revision));
    v_moved := v_moved || jsonb_build_object('private', 1);
  end if;

  -- Documentación y formación (con sus archivos): copias en la que queda; las originales, a la papelera.
  n := 0;
  for r in select * from central.person_records where person_id = v_from.id and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'insert', 'table', 'central.person_records',
      'id', gen_random_uuid(), 'fields', central.copyable_fields('central.person_records', to_jsonb(r)) || jsonb_build_object('person_id', v_into.id)));
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'delete', 'table', 'central.person_records', 'id', r.id, 'expectedRevision', r.revision));
    n := n + 1;
  end loop;
  v_moved := v_moved || jsonb_build_object('records', n);

  -- Equipos: los que la que queda no tenía.
  n := 0;
  for r in select * from central.person_teams where person_id = v_from.id and deleted_at is null loop
    if not exists (select 1 from central.person_teams where person_id = v_into.id and team_id = r.team_id and deleted_at is null) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'insert', 'table', 'central.person_teams',
        'id', gen_random_uuid(), 'fields', jsonb_build_object('person_id', v_into.id, 'team_id', r.team_id)));
      n := n + 1;
    end if;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'delete', 'table', 'central.person_teams', 'id', r.id, 'expectedRevision', r.revision));
  end loop;
  v_moved := v_moved || jsonb_build_object('teams', n);

  -- Responsabilidades: pasan a la que queda.
  n := 0;
  for r in select 'central.requirements' as t, id, revision from central.requirements where responsible_person_id = v_from.id and deleted_at is null
           union all select 'central.key_documents', id, revision from central.key_documents where responsible_person_id = v_from.id and deleted_at is null
           union all select 'central.decisions', id, revision from central.decisions where responsible_person_id = v_from.id and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'update', 'table', r.t, 'id', r.id,
      'expectedRevision', r.revision, 'fields', jsonb_build_object('responsible_person_id', v_into.id)));
    n := n + 1;
  end loop;
  v_moved := v_moved || jsonb_build_object('responsibilities', n);

  -- La otra ficha, a la papelera, apuntando a la que queda (y soltando su cuenta, si la tenía).
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'update', 'table', 'central.people', 'id', v_from.id,
    'expectedRevision', v_from.revision, 'fields', jsonb_build_object('merged_into', v_into.id, 'user_id', null)));
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'delete', 'table', 'central.people', 'id', v_from.id,
    'expectedRevision', v_from.revision + 1));

  -- La que queda: completa lo que la otra tuviera y ella no (notas de disponibilidad, puesto comprometido, activa, cuenta).
  v_fields := jsonb_strip_nulls(jsonb_build_object(
    'availability_notes', case when v_into.availability_notes is null then v_from.availability_notes end,
    'committed_post', case when v_from.committed_post and not v_into.committed_post then true end,
    'active', case when v_from.active and not v_into.active then true end,
    'user_id', case when v_into.user_id is null then v_from.user_id end));
  if v_fields <> '{}'::jsonb then
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'update', 'table', 'central.people', 'id', v_into.id,
      'expectedRevision', v_into.revision, 'fields', v_fields));
  end if;

  return jsonb_build_object('into', v_into.id, 'from', v_from.id, 'moved', v_moved);
end $$;

select core.allow_procedure('central', 'central.merge_people');

-- Fichas fusionadas, para las apps que guardan una persona de Central (Tasks, responsables): si tienen `person_id` de una
-- ficha fusionada, pueden pasar a `merged_into`. Sin datos reservados.
create view central.people_merges as
select p.id as person_id, p.merged_into, p.updated_at
  from central.people p
 where p.merged_into is not null;

revoke all on central.people_merges from public, anon, authenticated;
grant select on central.people_merges to service_role;
select core.allow_read('central', 'central.people_merges', 'view');
select core.allow_read('tasks', 'central.people_merges', 'view');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
