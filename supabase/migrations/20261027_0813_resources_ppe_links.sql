-- Ikisai Recursos · EPI y lo que pide cada máquina (R3 de Tasks, FB_2026_071 «Vista de trabajo»; aceptada por Core el
-- 27-10-2026). Toca solo el schema resources.
-- - Tipo de artículo `epi` («EPI»; se cuenta, no se gasta). Cada EPI dice en `attributes.body_parts` qué protege: una o
--   varias de head, eyes, ears, mouth_nose, hands, feet, legs, knees, body, harness.
-- - `resources.item_links`: una máquina o herramienta pide un EPI (`kind = 'requires_ppe'`). Así, al añadir la máquina a
--   una tarea, la app puede enseñar sus EPI. Un vínculo por pareja y tipo; nunca de un artículo a sí mismo ni de vuelta.
-- - resources.check_item_links (hook de validación): los dos artículos existen, el ligado es un EPI y el que pide no lo
--   es; las partes del cuerpo son de la lista; un EPI con vínculos vivos no deja de ser EPI.

insert into resources.item_kinds (kind, label, consumable, position)
select 'epi', 'EPI', false, 105
 where not exists (select 1 from resources.item_kinds where kind = 'epi' and deleted_at is null);

create table resources.item_links (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  item_id uuid not null references resources.items(id),
  linked_item_id uuid not null references resources.items(id),
  kind text not null default 'requires_ppe' check (kind in ('requires_ppe')),
  position numeric not null default 0,
  notes text check (notes is null or length(notes) <= 500),
  check (item_id <> linked_item_id)
);
create unique index item_links_pair_idx on resources.item_links (item_id, linked_item_id, kind) where deleted_at is null;
create index item_links_linked_idx on resources.item_links (linked_item_id) where deleted_at is null;
select core.register_table('resources', 'resources', 'item_links', array['item_id', 'linked_item_id', 'kind', 'position', 'notes']);

create or replace function resources.ppe_body_parts_ok(p jsonb)
returns boolean language sql immutable as $$
  select p is null or (jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and 10
    and not exists (select 1 from jsonb_array_elements(p) e
                     where jsonb_typeof(e) <> 'string'
                        or e #>> '{}' not in ('head','eyes','ears','mouth_nose','hands','feet','legs','knees','body','harness'))
    and (select count(distinct e) from jsonb_array_elements(p) e) = jsonb_array_length(p))
$$;

create or replace function resources.check_item_links(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_change record;
  v_link resources.item_links;
  v_item resources.items;
  v_linked resources.items;
begin
  if not exists (select 1 from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources'
                  and c.table_name in ('items', 'item_links')) then
    return;
  end if;

  for v_change in select c.table_name, c.op, c.row_id from core.changes c
                   where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name in ('items', 'item_links')
                   order by c.seq loop
    if v_change.table_name = 'items' then
      select * into v_item from resources.items where id = v_change.row_id;
      if v_item.id is null or v_item.deleted_at is not null then continue; end if;
      if v_item.kind = 'epi' and not resources.ppe_body_parts_ok(v_item.attributes->'body_parts') then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('id', v_item.id, 'field', 'attributes.body_parts',
          'reason', 'one or more of head, eyes, ears, mouth_nose, hands, feet, legs, knees, body, harness'));
      end if;
      -- Un EPI que una máquina pide no deja de ser EPI (primero, quitar el vínculo).
      if v_item.kind <> 'epi' and exists (select 1 from resources.item_links l where l.linked_item_id = v_item.id and l.deleted_at is null and l.kind = 'requires_ppe') then
        perform core.fail('ITEM_IN_USE', 422, jsonb_build_object('id', v_item.id, 'reason', 'a machine requires this PPE'));
      end if;
      continue;
    end if;

    select * into v_link from resources.item_links where id = v_change.row_id;
    if v_link.id is null or v_link.deleted_at is not null then continue; end if;
    select * into v_item from resources.items where id = v_link.item_id;
    select * into v_linked from resources.items where id = v_link.linked_item_id;
    if v_item.id is null or v_item.deleted_at is not null or v_linked.id is null or v_linked.deleted_at is not null then
      perform core.fail('NOT_FOUND', 404, jsonb_build_object('linkId', v_link.id, 'reason', 'both items must exist'));
    end if;
    if v_link.kind = 'requires_ppe' and (v_linked.kind <> 'epi' or v_item.kind = 'epi') then
      perform core.fail('INVALID_LINK', 422, jsonb_build_object('linkId', v_link.id, 'reason', 'a non-PPE item requires a PPE item'));
    end if;
    if exists (select 1 from resources.item_links r where r.item_id = v_link.linked_item_id and r.linked_item_id = v_link.item_id
                and r.kind = v_link.kind and r.deleted_at is null) then
      perform core.fail('INVALID_LINK', 422, jsonb_build_object('linkId', v_link.id, 'reason', 'no reverse link'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('resources', 'resources.check_item_links');

revoke all on function resources.check_item_links(jsonb) from public, anon, authenticated;
revoke all on function resources.ppe_body_parts_ok(jsonb) from public, anon, authenticated;
grant execute on function resources.check_item_links(jsonb) to service_role;
grant execute on function resources.ppe_body_parts_ok(jsonb) to service_role;
