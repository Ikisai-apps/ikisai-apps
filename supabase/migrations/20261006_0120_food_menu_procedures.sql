-- Food · procedimientos de estado del menú y lectura del grafo de un menú (docs/food/API.md §3, §3.1, §4.1).
-- Toca solo el schema food. Todo error de dominio es 422; las escrituras van por core.apply_row_op.

-- Menú vivo con bloqueo de fila, o MENU_NOT_FOUND.
create or replace function food.menu_for_update(p_menu_id text)
returns food.menus language plpgsql as $$
declare v_menu food.menus;
begin
  select * into v_menu from food.menus where id = p_menu_id::uuid and deleted_at is null for update;
  if v_menu.id is null then
    perform core.fail('MENU_NOT_FOUND', 422, jsonb_build_object('menu_id', p_menu_id));
  end if;
  return v_menu;
end $$;

create or replace function food.update_menu(p jsonb, p_menu_id uuid, p_fields jsonb)
returns jsonb language sql as $$
  select core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'update', 'table', 'food.menus', 'id', p_menu_id,
      'expectedRevision', (p->'args'->>'expectedRevision')::bigint, 'fields', p_fields));
$$;

-- borrador ⇄ revisar, validado → revisar (reabrir), validado ⇄ cerrado. A validado solo se llega con validate_menu.
create or replace function food.set_menu_status(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_menu food.menus; v_to text := a->>'status';
begin
  v_menu := food.menu_for_update(a->>'menu_id');
  if v_to is null or (v_menu.status, v_to) not in (('borrador','revisar'), ('revisar','borrador'), ('validado','revisar'), ('validado','cerrado'), ('cerrado','validado')) then
    perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', v_menu.status, 'to', v_to));
  end if;
  perform food.update_menu(p, v_menu.id, jsonb_build_object('status', v_to));
  return jsonb_build_object('menu_id', v_menu.id, 'status', v_to);
end $$;

-- «He revisado los cambios del evento» en un menú todavía editable. La Edge ya ha comprobado que event_revision es la actual.
create or replace function food.acknowledge_event(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_menu food.menus; v_revision bigint := (a->>'event_revision')::bigint;
begin
  v_menu := food.menu_for_update(a->>'menu_id');
  if v_menu.status in ('validado','cerrado') then
    perform core.fail('MENU_LOCKED', 422, jsonb_build_object('menu_id', v_menu.id, 'status', v_menu.status));
  end if;
  if v_revision < v_menu.source_event_revision then
    perform core.fail('EVENT_CHANGED', 422, jsonb_build_object('currentRevision', v_menu.source_event_revision));
  end if;
  perform food.update_menu(p, v_menu.id, jsonb_build_object('source_event_revision', v_revision, 'source_event_snapshot', a->'event_snapshot'));
  return jsonb_build_object('menu_id', v_menu.id, 'source_event_revision', v_revision);
end $$;

-- Validar (o revalidar tras un cambio del evento). La Edge ya ha comprobado la revisión del evento y los avisos aceptados.
create or replace function food.validate_menu(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_menu food.menus; v_revision bigint := (a->>'event_revision')::bigint; v_now timestamptz := now();
begin
  v_menu := food.menu_for_update(a->>'menu_id');
  if v_menu.status not in ('borrador','revisar','validado') then
    perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', v_menu.status, 'to', 'validado'));
  end if;
  if v_revision < v_menu.source_event_revision then
    perform core.fail('EVENT_CHANGED', 422, jsonb_build_object('currentRevision', v_menu.source_event_revision));
  end if;
  if not exists (
    select 1 from food.menu_items mi join food.menu_services s on s.id = mi.service_id
    where s.menu_id = v_menu.id and s.deleted_at is null and mi.deleted_at is null) then
    perform core.fail('MENU_EMPTY', 422, jsonb_build_object('menu_id', v_menu.id));
  end if;
  perform food.update_menu(p, v_menu.id, jsonb_build_object(
    'status', 'validado', 'validated_at', v_now, 'validated_by', p->>'actor',
    'validated_warnings', coalesce(a->'acknowledged', '[]'::jsonb),
    'source_event_revision', v_revision, 'source_event_snapshot', a->'event_snapshot'));
  return jsonb_build_object('menu_id', v_menu.id, 'status', 'validado', 'validated_at', v_now);
end $$;

select core.allow_procedure('food', 'food.set_menu_status');
select core.allow_procedure('food', 'food.acknowledge_event');
select core.allow_procedure('food', 'food.validate_menu');

-- Grafo vivo de un menú para la Edge: menú, servicios, platos, sus recetas, líneas e ingredientes.
create or replace function food.menu_graph(p_ctx jsonb)
returns jsonb language sql stable as $$
  with m as (select * from food.menus where id = (p_ctx->'args'->>'menu_id')::uuid and deleted_at is null),
       s as (select * from food.menu_services where menu_id in (select id from m) and deleted_at is null),
       i as (select * from food.menu_items where service_id in (select id from s) and deleted_at is null),
       r as (select * from food.recipes where id in (select recipe_id from i)),
       l as (select * from food.recipe_ingredients where recipe_id in (select id from r) and deleted_at is null),
       g as (select * from food.ingredients where id in (select ingredient_id from l))
  select jsonb_build_object(
    'menu', (select to_jsonb(m) from m),
    'services', coalesce((select jsonb_agg(to_jsonb(s)) from s), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(to_jsonb(i)) from i), '[]'::jsonb),
    'recipes', coalesce((select jsonb_agg(to_jsonb(r)) from r), '[]'::jsonb),
    'recipe_ingredients', coalesce((select jsonb_agg(to_jsonb(l)) from l), '[]'::jsonb),
    'ingredients', coalesce((select jsonb_agg(to_jsonb(g)) from g), '[]'::jsonb));
$$;
select core.allow_read('food', 'food.menu_graph', 'function');
