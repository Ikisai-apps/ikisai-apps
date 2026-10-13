-- Ikisai Booking · fase R2 de Recursos, paso 1 (visto bueno del usuario, 13-10-2026): enlazar con `resources.spaces` sin
-- cambiar nada visible. Interruptor `spaces_source` (por defecto `booking`, como hoy), columnas `resource_*` junto a las de
-- siempre con **escritura doble** (cada lado se deduce del otro por `source_refs`: `booking.space:<uuid>`,
-- `booking.bed:<uuid>`), vista previa del enlace (que la app del owner aplica con un lote normal). Nada se borra: apagar el interruptor
-- vuelve a lo de hoy. Toca solo el schema booking (lee `resources.spaces`, #477).

-- ---------------------------------------------------------------------------
-- Interruptor (una fila; solo el owner lo cambia)
-- ---------------------------------------------------------------------------
create table booking.module_settings (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  -- de dónde salen espacios y camas: `booking` (hoy) o `resources` (R2, tras la verificación del usuario)
  spaces_source text not null default 'booking' check (spaces_source in ('booking','resources'))
);
create unique index module_settings_one_idx on booking.module_settings ((true)) where deleted_at is null;
select core.register_table('booking', 'booking', 'module_settings', array['spaces_source'], '{owner}', '{owner}');
insert into booking.module_settings (spaces_source) values ('booking');

create or replace function booking.spaces_source()
returns text language sql stable as $$
  select coalesce((select spaces_source from booking.module_settings where deleted_at is null limit 1), 'booking');
$$;

-- ---------------------------------------------------------------------------
-- Parejas por `source_refs`
-- ---------------------------------------------------------------------------
-- Espacio de Recursos que viene de una fila de Booking (`booking.space:<uuid>` o `booking.bed:<uuid>`).
-- (plpgsql: se resuelve al ejecutar; esta migración va antes que la de `resources` en el orden de archivos)
create or replace function booking.resource_twin(p_kind text, p_id uuid)
returns uuid language plpgsql stable as $$
begin
  return (select s.id from resources.spaces s
   where p_id is not null and (p_kind || ':' || p_id::text) = any(s.source_refs) and s.deleted_at is null
   order by s.created_at limit 1);
end $$;

-- Fila de Booking de la que viene un espacio de Recursos (si la hay y sigue viva).
create or replace function booking.booking_twin(p_kind text, p_resource uuid)
returns uuid language plpgsql stable as $$
declare v_ref text; v_id uuid;
begin
  if p_resource is null then return null; end if;
  select r into v_ref from resources.spaces s, unnest(s.source_refs) r where s.id = p_resource and r like p_kind || ':%' limit 1;
  if v_ref is null then return null; end if;
  begin v_id := substr(v_ref, length(p_kind) + 2)::uuid; exception when others then return null; end;
  if p_kind = 'booking.space' then
    return (select id from booking.spaces where id = v_id and deleted_at is null);
  end if;
  return (select id from booking.beds where id = v_id and deleted_at is null);
end $$;

-- ---------------------------------------------------------------------------
-- Columnas nuevas (las de siempre siguen; `space_id` puede faltar si el espacio solo existe en Recursos)
-- ---------------------------------------------------------------------------
alter table booking.room_assignments add column resource_space_id uuid, add column resource_bed_id uuid;
alter table booking.room_assignments alter column space_id drop not null;
alter table booking.room_assignments add constraint room_assignments_some_space check (space_id is not null or resource_space_id is not null);
select core.register_table('booking', 'booking', 'room_assignments', array['event_id','space_id','bed_id','guest_id','group_label','persons','from_date','to_date','notes','status',
  'resource_space_id','resource_bed_id']);

alter table booking.open_rooms add column resource_space_id uuid;
alter table booking.open_rooms alter column space_id drop not null;
alter table booking.open_rooms add constraint open_rooms_some_space check (space_id is not null or resource_space_id is not null);
select core.register_table('booking', 'booking', 'open_rooms', array['event_id','space_id','option_key','supplement','resource_space_id']);

alter table booking.program_items add column resource_space_id uuid;
alter table booking.program_items drop constraint program_items_place;
alter table booking.program_items add constraint program_items_place check ((space_id is null and resource_space_id is null) or place_text is null);
select core.register_table('booking', 'booking', 'program_items', array['event_id','day','starts_at','ends_at','title','space_id','place_text',
  'public_note','internal_note','kind','optional','position','resource_space_id']);

-- Escritura doble: el lado que cambia manda y el otro se deduce. Si el otro lado no tiene pareja, queda vacío (la vista
-- previa lo enseña como dudoso).
create or replace function booking.space_refs_sync()
returns trigger language plpgsql as $$
declare v_space_changed boolean; v_res_changed boolean;
begin
  v_space_changed := tg_op = 'INSERT' and new.space_id is not null or tg_op = 'UPDATE' and new.space_id is distinct from old.space_id;
  v_res_changed := tg_op = 'INSERT' and new.resource_space_id is not null or tg_op = 'UPDATE' and new.resource_space_id is distinct from old.resource_space_id;
  if v_space_changed and not v_res_changed then
    new.resource_space_id := booking.resource_twin('booking.space', new.space_id);
  elsif v_res_changed and not v_space_changed then
    new.space_id := booking.booking_twin('booking.space', new.resource_space_id);
  end if;
  if tg_table_name = 'room_assignments' then
    if (tg_op = 'INSERT' and new.bed_id is not null or tg_op = 'UPDATE' and new.bed_id is distinct from old.bed_id)
       and not (tg_op = 'INSERT' and new.resource_bed_id is not null or tg_op = 'UPDATE' and new.resource_bed_id is distinct from old.resource_bed_id) then
      new.resource_bed_id := booking.resource_twin('booking.bed', new.bed_id);
    elsif (tg_op = 'INSERT' and new.resource_bed_id is not null or tg_op = 'UPDATE' and new.resource_bed_id is distinct from old.resource_bed_id)
       and not (tg_op = 'INSERT' and new.bed_id is not null or tg_op = 'UPDATE' and new.bed_id is distinct from old.bed_id) then
      new.bed_id := booking.booking_twin('booking.bed', new.resource_bed_id);
    end if;
  end if;
  return new;
end $$;
create trigger room_assignments_space_refs before insert or update on booking.room_assignments
  for each row execute function booking.space_refs_sync();
create trigger open_rooms_space_refs before insert or update on booking.open_rooms
  for each row execute function booking.space_refs_sync();
create trigger program_items_space_refs before insert or update on booking.program_items
  for each row execute function booking.space_refs_sync();

-- Coherencia del lado de Recursos al final del lote: los espacios existen y siguen vivos; la cama cuelga del espacio.
create or replace function booking.check_resource_refs(p jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select a.id into v_id from booking.room_assignments a
    left join resources.spaces s on s.id = a.resource_space_id
    left join resources.spaces b on b.id = a.resource_bed_id
   where a.deleted_at is null and ((a.resource_space_id is not null and (s.id is null or s.deleted_at is not null))
      or (a.resource_bed_id is not null and (b.id is null or b.deleted_at is not null or b.parent_id is distinct from a.resource_space_id))) limit 1;
  if v_id is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.room_assignments', 'id', v_id, 'field', 'resource_space_id')); end if;
  select o.id into v_id from booking.open_rooms o left join resources.spaces s on s.id = o.resource_space_id
   where o.deleted_at is null and o.resource_space_id is not null and (s.id is null or s.deleted_at is not null) limit 1;
  if v_id is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.open_rooms', 'id', v_id, 'field', 'resource_space_id')); end if;
  select i.id into v_id from booking.program_items i left join resources.spaces s on s.id = i.resource_space_id
   where i.deleted_at is null and i.resource_space_id is not null and (s.id is null or s.deleted_at is not null) limit 1;
  if v_id is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.program_items', 'id', v_id, 'field', 'resource_space_id')); end if;
end $$;
select core.add_validate_hook('booking', 'booking.check_resource_refs');

-- ---------------------------------------------------------------------------
-- Vista previa del enlace (owner, sin escribir). Lo «por enlazar» lo aplica la app del owner con un `commit` normal
-- (`resource_space_id` / `resource_bed_id` por fila, con su revisión): queda en el historial y se puede deshacer.
-- ---------------------------------------------------------------------------
create or replace function booking.r2_link_rows()
returns table (tbl text, row_id uuid, revision bigint, field text, booking_id uuid, booking_name text, resource_id uuid, resource_name text, status text)
language plpgsql stable as $$
begin
  return query
  with refs as (
    select 'booking.room_assignments' tbl, a.id row_id, a.revision, 'space' field, a.space_id booking_id, a.resource_space_id current_res, 'booking.space' kind
      from booking.room_assignments a where a.deleted_at is null
    union all
    select 'booking.room_assignments', a.id, a.revision, 'bed', a.bed_id, a.resource_bed_id, 'booking.bed'
      from booking.room_assignments a where a.deleted_at is null and a.bed_id is not null
    union all
    select 'booking.open_rooms', o.id, o.revision, 'space', o.space_id, o.resource_space_id, 'booking.space' from booking.open_rooms o where o.deleted_at is null
    union all
    select 'booking.program_items', i.id, i.revision, 'space', i.space_id, i.resource_space_id, 'booking.space' from booking.program_items i where i.deleted_at is null and i.space_id is not null
  )
  select r.tbl, r.row_id, r.revision, r.field, r.booking_id,
         coalesce((select s.name from booking.spaces s where s.id = r.booking_id), (select b.label from booking.beds b where b.id = r.booking_id)),
         coalesce(r.current_res, t.twin), (select x.name from resources.spaces x where x.id = coalesce(r.current_res, t.twin)),
         case when r.current_res is not null then 'enlazada'
              when t.twin is null then 'sin_pareja'
              when r.field = 'bed' and (select kind from resources.spaces where id = t.twin) <> 'cama' then 'tipo_distinto'
              else 'por_enlazar' end
    from refs r cross join lateral (select booking.resource_twin(r.kind, r.booking_id) twin) t;
end $$;

create or replace function booking.r2_preview(p jsonb)
returns jsonb language plpgsql stable as $$
begin
  return jsonb_build_object(
    'source', booking.spaces_source(),
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from booking.r2_link_rows() group by 1) c), '{}'::jsonb),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.status <> 'sin_pareja', x.tbl, x.booking_name) from booking.r2_link_rows() x where x.status <> 'enlazada'), '[]'::jsonb),
    'spaces_without_twin', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'zone', s.zone) order by s.name)
      from booking.spaces s where s.deleted_at is null and booking.resource_twin('booking.space', s.id) is null), '[]'::jsonb),
    'beds_without_twin', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'space', s.name) order by s.name, b.label)
      from booking.beds b join booking.spaces s on s.id = b.space_id where b.deleted_at is null and booking.resource_twin('booking.bed', b.id) is null), '[]'::jsonb));
end $$;

select core.allow_read('booking', 'booking.r2_preview', 'function', '{owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
