-- Ikisai Central · fase P1 (RECURSOS.md §13.3): catálogo de oficios en árbol y capacidades (persona × oficio con nivel).
-- - `central.trades`: árbol de hasta 3 niveles («Fontanería › ACS»), nombre único entre hermanos, se archiva (`active`), no
--   se borra con hijos o capacidades vivas. `source_label_id`: la etiqueta «Tipo: Acción» de Tasks de la que viene (P2).
-- - `central.person_trades`: capacidad con nivel 0 «aprende», 1 «sabe», 2 «experto» (la estrella de la prioridad de Tasks,
--   `createLevelStar` del kit, tres pasos) y nota opcional. Una viva por persona y oficio.
-- - `central.trade_kit`: el «kit» del oficio (artículos de Recursos), solo el sitio previsto: sin pantalla hasta R3.
-- - Lecturas para Tasks (P2): `central.trade_options` y `central.capability_options`.
-- - La fusión de fichas (`central.merge_people`, 1503) pasa también las capacidades.
-- Escriben el owner y el editor con ámbito `people`, como los equipos; leen todos los miembros. Toca solo el schema central.

create table central.trades (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  parent_id uuid references central.trades(id) check (parent_id is null or parent_id <> id),
  name text not null check (length(btrim(name)) between 1 and 80),
  position numeric not null default 0,
  active boolean not null default true,
  notes text check (notes is null or length(notes) <= 500),
  source_label_id uuid
);
create unique index trades_name_idx on central.trades (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name))) where deleted_at is null;
create unique index trades_source_idx on central.trades (source_label_id) where deleted_at is null and source_label_id is not null;
create index trades_parent_idx on central.trades (parent_id) where deleted_at is null;

select core.register_table('central', 'central', 'trades', array['parent_id','name','position','active','notes','source_label_id']);

create table central.person_trades (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  person_id uuid not null references central.people(id),
  trade_id uuid not null references central.trades(id),
  level smallint not null default 1 check (level between 0 and 2),
  note text check (note is null or length(note) <= 300)
);
create unique index person_trades_pair_idx on central.person_trades (person_id, trade_id) where deleted_at is null;
create index person_trades_trade_idx on central.person_trades (trade_id) where deleted_at is null;
create trigger person_trades_forbid_reparent_person before update on central.person_trades
  for each row execute function central.forbid_reparent('person_id');
create trigger person_trades_forbid_reparent_trade before update on central.person_trades
  for each row execute function central.forbid_reparent('trade_id');

select core.register_table('central', 'central', 'person_trades', array['person_id','trade_id','level','note']);

-- Kit del oficio: artículos de Recursos (`resources.items`, fase R3) como sugerencia. Sin FK: es otro schema que aún no existe.
create table central.trade_kit (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  trade_id uuid not null references central.trades(id),
  item_id uuid not null,
  quantity numeric check (quantity is null or quantity > 0),
  note text check (note is null or length(note) <= 300)
);
create unique index trade_kit_pair_idx on central.trade_kit (trade_id, item_id) where deleted_at is null;
create trigger trade_kit_forbid_reparent before update on central.trade_kit
  for each row execute function central.forbid_reparent('trade_id');

select core.register_table('central', 'central', 'trade_kit', array['trade_id','item_id','quantity','note']);

-- Permiso de escritura e invariantes, al final de cada lote.
create or replace function central.check_trades(p jsonb)
returns void language plpgsql as $$
declare v_id uuid; v_member core.memberships;
begin
  if exists (select 1 from core.changes c where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
              and c.schema_name = 'central' and c.table_name in ('trades', 'person_trades', 'trade_kit')) then
    select * into v_member from core.memberships where app = 'central' and user_id = (p->>'actor')::uuid;
    if p->>'actor' is not null and v_member.role is distinct from 'owner' and not (v_member.role = 'editor' and coalesce(v_member.scopes->>'people', '') = 'true') then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.trades', 'reason', 'owner or editor with people scope'));
    end if;
  end if;

  -- Árbol: sin ciclos y como mucho 3 niveles; la madre, viva.
  select t.id into v_id from central.trades t
   where t.deleted_at is null and t.parent_id is not null
     and not exists (select 1 from central.trades m where m.id = t.parent_id and m.deleted_at is null) limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.trades', 'id', v_id)); end if;
  with recursive up(id, anc, depth) as (
    select t.id, t.parent_id, 1 from central.trades t where t.deleted_at is null
    union all
    select up.id, m.parent_id, up.depth + 1 from up join central.trades m on m.id = up.anc where up.depth < 5
  )
  select id into v_id from up where anc = id or (anc is not null and depth >= 3) limit 1;
  if v_id is not null then perform core.fail('INVALID_TREE', 422, jsonb_build_object('table', 'central.trades', 'id', v_id, 'reason', 'cycle or more than 3 levels')); end if;

  -- Capacidades y kit: su persona y su oficio, vivos.
  select x.id into v_id from central.person_trades x
    join central.people p on p.id = x.person_id
    join central.trades t on t.id = x.trade_id
   where x.deleted_at is null and (p.deleted_at is not null or t.deleted_at is not null) limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.person_trades', 'id', v_id)); end if;
  select x.id into v_id from central.trade_kit x join central.trades t on t.id = x.trade_id
   where x.deleted_at is null and t.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.trade_kit', 'id', v_id)); end if;
end $$;

select core.add_validate_hook('central', 'central.check_trades');

-- Ruta legible de un oficio: «Fontanería › ACS».
create or replace function central.trade_path(p_id uuid)
returns text language sql stable as $$
  with recursive up(id, parent_id, name, depth) as (
    select id, parent_id, name, 0 from central.trades where id = p_id
    union all
    select t.id, t.parent_id, t.name, up.depth + 1 from central.trades t join up on t.id = up.parent_id where up.depth < 5
  )
  select string_agg(name, ' › ' order by depth desc) from up;
$$;

-- ---------------------------------------------------------------------------
-- Lecturas para Tasks (P2), sin datos reservados: oficios activos con su ruta, y capacidades de personas vivas, activas y con
-- nivel de casa en oficios activos.
-- ---------------------------------------------------------------------------
create view central.trade_options as
select t.id as trade_id, t.parent_id, t.name, central.trade_path(t.id) as path, t.position, t.source_label_id
  from central.trades t
 where t.deleted_at is null and t.active;

create view central.capability_options as
select x.person_id, x.trade_id, x.level
  from central.person_trades x
  join central.people p on p.id = x.person_id and p.deleted_at is null and p.active and p.house_level is not null
  join central.trades t on t.id = x.trade_id and t.deleted_at is null and t.active
 where x.deleted_at is null;

revoke all on central.trade_options, central.capability_options from public, anon, authenticated;
grant select on central.trade_options, central.capability_options to service_role;
select core.allow_read('central', 'central.trade_options', 'view');
select core.allow_read('tasks', 'central.trade_options', 'view');
select core.allow_read('central', 'central.capability_options', 'view');
select core.allow_read('tasks', 'central.capability_options', 'view');

-- ---------------------------------------------------------------------------
-- Fusión de fichas (1503) con las capacidades.
-- ---------------------------------------------------------------------------
create or replace function central.merge_people(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role'; v_req text := p->>'requestId';
  v_cursor bigint := (p->>'cursor')::bigint;
  v_from central.people; v_into central.people; fp central.person_private; ip central.person_private;
  r record; v_fields jsonb; v_moved jsonb := '{}'::jsonb; n int; v_cap record;
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

  -- Capacidades (P1): las que la que queda no tenía pasan a ella; si las dos sabían el mismo oficio, se queda el nivel más alto
  -- y la nota que haya. Las de la otra, a la papelera.
  n := 0;
  for r in select * from central.person_trades where person_id = v_from.id and deleted_at is null loop
    select id, revision, level, note into v_cap from central.person_trades where person_id = v_into.id and trade_id = r.trade_id and deleted_at is null;
    if v_cap.id is null then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'insert', 'table', 'central.person_trades',
        'id', gen_random_uuid(), 'fields', jsonb_build_object('person_id', v_into.id, 'trade_id', r.trade_id, 'level', r.level, 'note', r.note)));
      n := n + 1;
    elsif r.level > v_cap.level or (v_cap.note is null and r.note is not null) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'update', 'table', 'central.person_trades',
        'id', v_cap.id, 'expectedRevision', v_cap.revision, 'fields', jsonb_build_object('level', greatest(r.level, v_cap.level), 'note', coalesce(v_cap.note, r.note))));
    end if;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cursor, jsonb_build_object('op', 'delete', 'table', 'central.person_trades', 'id', r.id, 'expectedRevision', r.revision));
  end loop;
  v_moved := v_moved || jsonb_build_object('trades', n);

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

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
