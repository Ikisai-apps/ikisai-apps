-- Ikisai Recursos · balizas con texto y con imagen propia (encargo de VG desde el Montaje de Booking, 28-10-2026; la
-- paleta la hace UI-kit). Lo mínimo, sin rediseño:
-- - `resources.decor_items.label` (texto, 1 a 60 caracteres) y `file_id` (imagen propia, subida como los iconos: archivo
--   del módulo y verificado, en el bucket `resources-plans`; SVG, PNG, JPG, WebP o GIF de hasta 1 MB).
-- - `op` add y replace aceptan una baliza con icono del catálogo, con texto, con imagen o con varias cosas; `icon_id` deja
--   de ser obligatorio si hay texto o imagen.
-- - `set_event_decor` pasa `label` y `file_id` en la capa de evento.
-- Toca solo el schema resources.

alter table resources.decor_items
  add column label text check (label is null or length(btrim(label)) between 1 and 60),
  add column file_id uuid references core.files(id);
alter table resources.decor_items drop constraint decor_items_op;
alter table resources.decor_items add constraint decor_items_op check (
  (op = 'add' and replaces_item_id is null and (icon_id is not null or label is not null or file_id is not null))
  or (op = 'remove' and replaces_item_id is not null)
  or (op = 'replace' and replaces_item_id is not null and (icon_id is not null or label is not null or file_id is not null)));
select core.register_table('resources', 'resources', 'decor_items',
  array['plan_id', 'icon_id', 'cell_x', 'cell_y', 'scale', 'size', 'rotation', 'layer', 'event_id', 'op', 'replaces_item_id', 'label', 'file_id'],
  '{reader,editor,owner}', '{editor,owner}');
select core.register_file_field('resources', 'resources', 'decor_items', 'file_id', 'operational');

create or replace function resources.check_decor_item_files(p jsonb)
returns void language plpgsql as $$
declare v_cursor bigint := (p->>'cursor')::bigint;
begin
  if exists (select 1 from resources.decor_items d
               where d.deleted_at is null and d.file_id is not null
                 and d.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor
                                and c.schema_name = 'resources' and c.table_name = 'decor_items')
                 and not exists (select 1 from core.files f where f.id = d.file_id and f.app = 'resources' and f.status = 'verified'
                                   and f.mime in ('image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif') and f.size <= 1048576)) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.decor_items', 'field', 'file_id', 'reason', 'SVG, PNG, JPG, WebP or GIF up to 1 MB'));
  end if;
end $$;
select core.add_validate_hook('resources', 'resources.check_decor_item_files');

create or replace function resources.set_event_decor(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint; a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_event uuid; v_item jsonb; v_id uuid; v_row resources.decor_items; v_fields jsonb; v_out jsonb := '[]'::jsonb;
begin
  if v_actor is null or not exists (select 1 from core.memberships m where m.app = 'booking' and m.user_id = v_actor and m.role in ('editor', 'owner')) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'event decoration is set from Booking'));
  end if;
  begin v_event := (a->>'event_id')::uuid; exception when others then v_event := null; end;
  -- Que el evento exista lo comprueba booking-api antes de llamar (Recursos no lee tablas ni vistas de Booking).
  if v_event is null then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'event_id'));
  end if;
  if (a->'put' is not null and jsonb_typeof(a->'put') <> 'array') or (a->'delete' is not null and jsonb_typeof(a->'delete') <> 'array')
     or coalesce(jsonb_array_length(a->'put'), 0) + coalesce(jsonb_array_length(a->'delete'), 0) not between 1 and 200 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'put/delete', 'reason', 'between 1 and 200 changes'));
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(a->'put', '[]'::jsonb)) loop
    v_fields := jsonb_strip_nulls(jsonb_build_object(
      'plan_id', v_item->'plan_id', 'icon_id', v_item->'icon_id', 'cell_x', v_item->'cell_x', 'cell_y', v_item->'cell_y',
      'scale', v_item->'scale', 'size', v_item->'size', 'rotation', v_item->'rotation', 'op', v_item->'op',
      'replaces_item_id', v_item->'replaces_item_id', 'label', v_item->'label', 'file_id', v_item->'file_id'));
    begin v_id := (v_item->>'id')::uuid; exception when others then v_id := null; end;
    select * into v_row from resources.decor_items where id = v_id;
    if v_row.id is not null then
      if v_row.layer <> 'event' or v_row.event_id <> v_event then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.decor_items', 'id', v_id, 'reason', 'not a piece of this event'));
      end if;
      perform set_config('resources.event_decor_ids', concat_ws(',', nullif(current_setting('resources.event_decor_ids', true), ''), v_id::text), true);
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'resources.decor_items', 'id', v_id,
        'expectedRevision', coalesce(v_item->'expectedRevision', to_jsonb(v_row.revision)), 'fields', v_fields));
    else
      v_id := coalesce(v_id, gen_random_uuid());
      perform set_config('resources.event_decor_ids', concat_ws(',', nullif(current_setting('resources.event_decor_ids', true), ''), v_id::text), true);
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'resources.decor_items', 'id', v_id,
        'fields', v_fields || jsonb_build_object('layer', 'event', 'event_id', v_event)));
    end if;
    v_out := v_out || to_jsonb(v_id);
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(a->'delete', '[]'::jsonb)) loop
    begin v_id := (v_item #>> '{}')::uuid; exception when others then v_id := null; end;
    select * into v_row from resources.decor_items where id = v_id and deleted_at is null;
    if v_row.id is null or v_row.layer <> 'event' or v_row.event_id <> v_event then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.decor_items', 'id', v_id, 'reason', 'not a piece of this event'));
    end if;
    perform set_config('resources.event_decor_ids', concat_ws(',', nullif(current_setting('resources.event_decor_ids', true), ''), v_id::text), true);
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'delete', 'table', 'resources.decor_items', 'id', v_id,
      'expectedRevision', to_jsonb(v_row.revision)));
    v_out := v_out || to_jsonb(v_id);
  end loop;
  return jsonb_build_object('eventId', v_event, 'ids', v_out);
end $$;

revoke all on function resources.check_decor_item_files(jsonb) from public, anon, authenticated;
grant execute on function resources.check_decor_item_files(jsonb) to service_role;
