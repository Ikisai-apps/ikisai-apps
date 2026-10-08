-- Ikisai Food · el menú del retiro en los portales (fase 4; peticiones Fd2/FD1 y Fd3, docs/food/API.md §7.5).
-- Toca solo el schema food; lee `booking.food_event_projection` (excepción del lint, P14) para ligar reserva y evento.
--
-- Decisiones del usuario (8-10-2026): el organizador ve el menú solo cuando cocina lo comparte («Compartir con el
-- organizador»), y puede comentar un menú validado, pero su comentario lo devuelve a «por revisar».
--
-- Fd2/FD1 · food.portal_menu {reservation_id, guest_id?} para `organizers` y `guests` (solo lectura, con
--           core.portal_in_scope). Guests ve solo los menús confirmados y sin el resumen de restricciones.
-- Fd3     · food.portal_menu_comment {reservation_id, menu_item_id?, service_id?, kind, message?} (acción de `organizers`)
--           y food.portal_my_menu_comments {reservation_id}. Cocina los ve y los resuelve en Food.
-- Nunca salen cantidades, raciones, ingredientes, elaboración, notas internas, costes, compra, preparación ni personas.

-- Compartido con el organizador: lo marca cocina en la ficha del menú.
alter table food.menus add column organizer_shared boolean not null default false;
select core.register_table('food', 'food', 'menus', array[
  'event_id','source_event_revision','source_event_snapshot','status','validated_at','validated_by','validated_warnings',
  'preparation_generated_at','preparation_source_revisions','notes','closing_notes','organizer_shared']);

-- Comentarios del organizador. Los crea solo la acción de portal; en Food se marcan como vistos o resueltos y se responden.
create table food.menu_comments (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  menu_id uuid not null references food.menus(id) on delete cascade,
  service_id uuid references food.menu_services(id) on delete set null,
  menu_item_id uuid references food.menu_items(id) on delete set null,
  kind text not null check (kind in ('prefiero_que_no','comentario')),
  message text check (message is null or length(message) <= 1000),
  author_id uuid references auth.users(id),
  status text not null default 'nuevo' check (status in ('nuevo','visto','resuelto')),
  reply text check (reply is null or length(reply) <= 1000)
);
create index menu_comments_menu_idx on food.menu_comments (menu_id, created_at desc) where deleted_at is null;

-- Lo que dice el organizador no se reescribe: solo cambian el estado y la respuesta de cocina.
create or replace function food.guard_menu_comment()
returns trigger language plpgsql as $$
begin
  if (new.menu_id, new.service_id, new.menu_item_id, new.kind, new.message, new.author_id)
     is distinct from (old.menu_id, old.service_id, old.menu_item_id, old.kind, old.message, old.author_id) then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'food.menu_comments'));
  end if;
  return new;
end $$;
create trigger food_guard_menu_comment before update on food.menu_comments
  for each row execute function food.guard_menu_comment();

select core.register_table('food', 'food', 'menu_comments',
  array['menu_id','service_id','menu_item_id','kind','message','author_id','status','reply']);

-- ---------------------------------------------------------------------------
-- Ámbito: reserva del portal y menús compartidos de sus eventos
-- ---------------------------------------------------------------------------
-- Reserva de los argumentos, dentro del ámbito del enlace (en Guests, además, con su huésped). Fuera de ámbito o con un
-- id inválido, la misma respuesta: OUT_OF_SCOPE.
create or replace function food.portal_reservation(p jsonb)
returns uuid language plpgsql stable as $$
declare v_res uuid; v_guest uuid;
begin
  begin
    v_res := (p->'args'->>'reservation_id')::uuid;
    v_guest := nullif(p->'args'->>'guest_id', '')::uuid;
  exception when others then v_res := null; end;
  if v_res is null or not core.portal_in_scope(p->>'app', (p->>'actor')::uuid, v_res, v_guest) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  return v_res;
end $$;

-- Menús vivos y compartidos de los eventos de la reserva (normalmente uno).
create or replace function food.portal_shared_menus(p_reservation uuid)
returns setof food.menus language sql stable as $$
  select m.* from food.menus m
   where m.deleted_at is null and m.organizer_shared
     and m.event_id in (select e.event_id from booking.food_event_projection e where e.reservation_id = p_reservation);
$$;

-- ---------------------------------------------------------------------------
-- Fd2 / FD1 · lectura del menú
-- ---------------------------------------------------------------------------
create or replace function food.portal_menu(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid := food.portal_reservation(p); v_guests boolean := p->>'app' = 'guests'; v_menus uuid[];
begin
  -- Guests solo ve lo confirmado; el organizador, también la propuesta.
  select coalesce(array_agg(m.id), '{}') into v_menus from food.portal_shared_menus(v_res) m
   where not v_guests or m.status in ('validado','cerrado');
  return jsonb_build_object(
    'reservation_id', v_res,
    'available', cardinality(v_menus) > 0,
    -- «provisional» mientras algún menú siga en borrador o por revisar.
    'status', case when exists (select 1 from food.menus m where m.id = any(v_menus) and m.status in ('borrador','revisar')) then 'provisional' else 'confirmado' end,
    'menu_ids', to_jsonb(v_menus),
    'updated_at', (select max(m.updated_at) from food.menus m where m.id = any(v_menus)),
    'services', coalesce((select jsonb_agg(jsonb_build_object(
        'service_id', s.id, 'menu_id', s.menu_id, 'date', s.service_date, 'type', s.service_type, 'time', s.service_time,
        'dishes', coalesce((select jsonb_agg(jsonb_build_object(
            'menu_item_id', i.id, 'name', coalesce(nullif(btrim(r.public_name), ''), r.name), 'description', r.public_description,
            'category', r.category, 'diet_tags', to_jsonb(r.diet_tags), 'allergens', to_jsonb(r.allergens), 'allergens_checked', r.allergens_checked)
          order by i.position, i.created_at)
          from food.menu_items i join food.recipes r on r.id = i.recipe_id
         where i.service_id = s.id and i.deleted_at is null), '[]'::jsonb))
      order by s.service_date, s.position, s.service_time nulls last)
      from food.menu_services s where s.menu_id = any(v_menus) and s.deleted_at is null), '[]'::jsonb),
    -- Resumen agregado de lo que cocina tiene en cuenta (ya viene agregado de Booking; sin notas de cocina). Solo el organizador.
    'restrictions', case when v_guests then null else coalesce((select jsonb_agg(jsonb_build_object(
        'type', x->>'type', 'subject', x->>'subject', 'severity', x->>'severity', 'servings', x->'servings'))
      from booking.food_event_projection e, jsonb_array_elements(coalesce(e.dietary_restrictions, '[]'::jsonb)) x
     where e.reservation_id = v_res and cardinality(v_menus) > 0
       and e.event_id in (select m.event_id from food.menus m where m.id = any(v_menus))), '[]'::jsonb) end);
end $$;

-- ---------------------------------------------------------------------------
-- Fd3 · comentarios del organizador
-- ---------------------------------------------------------------------------
create or replace function food.portal_menu_comment(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_res uuid := food.portal_reservation(p);
  v_kind text := p->'args'->>'kind';
  v_msg text := nullif(btrim(coalesce(p->'args'->>'message', '')), '');
  v_item uuid; v_service uuid; v_menu food.menus; v_id uuid := gen_random_uuid(); v_ops jsonb; v_out jsonb;
begin
  if p->>'app' <> 'organizers' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'solo el organizador comenta el menú')); end if;
  if v_kind is null or v_kind not in ('prefiero_que_no','comentario') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'kind: prefiero_que_no o comentario'));
  end if;
  if v_kind = 'comentario' and v_msg is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'message')); end if;
  if length(v_msg) > 1000 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'message', 'max', 1000)); end if;
  begin
    v_item := nullif(p->'args'->>'menu_item_id', '')::uuid;
    v_service := nullif(p->'args'->>'service_id', '')::uuid;
  exception when others then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end;
  if v_kind = 'prefiero_que_no' and v_item is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'menu_item_id')); end if;

  -- El plato (o el servicio) tiene que ser de un menú compartido de esta reserva; sin ninguno, el único menú compartido.
  if v_item is not null then
    select s.id into v_service from food.menu_items i join food.menu_services s on s.id = i.service_id and s.deleted_at is null
     where i.id = v_item and i.deleted_at is null;
  end if;
  select m.* into v_menu from food.portal_shared_menus(v_res) m
   where v_service is null or m.id = (select s.menu_id from food.menu_services s where s.id = v_service and s.deleted_at is null)
   order by m.created_at limit 1;
  if v_menu.id is null or (v_item is not null and v_service is null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res, 'menu_item_id', v_item, 'service_id', v_service));
  end if;
  if v_menu.status = 'cerrado' then perform core.fail('MENU_CLOSED', 422, jsonb_build_object('menu_id', v_menu.id)); end if;

  v_ops := jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'food.menu_comments', 'id', v_id, 'fields', jsonb_strip_nulls(jsonb_build_object(
    'menu_id', v_menu.id, 'service_id', v_service, 'menu_item_id', v_item, 'kind', v_kind, 'message', v_msg, 'author_id', (p->>'actor')::uuid))));
  -- Decisión del usuario: un comentario sobre un menú validado lo devuelve a «por revisar».
  if v_menu.status = 'validado' then
    v_ops := v_ops || jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'food.menus', 'id', v_menu.id,
      'expectedRevision', v_menu.revision, 'fields', jsonb_build_object('status', 'revisar')));
  end if;
  v_out := core.apply_portal_operations('food', v_ops);
  return jsonb_build_object('id', v_id, 'status', 'nuevo', 'menu_status', case when v_menu.status = 'validado' then 'revisar' else v_menu.status end, 'cursor', v_out->'cursor');
end $$;

create or replace function food.portal_my_menu_comments(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid := food.portal_reservation(p);
begin
  if p->>'app' <> 'organizers' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'solo el organizador')); end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'menu_item_id', c.menu_item_id, 'service_id', c.service_id,
      'dish', (select coalesce(nullif(btrim(r.public_name), ''), r.name) from food.menu_items i join food.recipes r on r.id = i.recipe_id where i.id = c.menu_item_id),
      'kind', c.kind, 'message', c.message, 'status', c.status, 'reply', c.reply, 'created_at', c.created_at,
      'mine', c.author_id = (p->>'actor')::uuid) order by c.created_at desc)
    from food.menu_comments c join food.menus m on m.id = c.menu_id and m.deleted_at is null
   where c.deleted_at is null
     and m.event_id in (select e.event_id from booking.food_event_projection e where e.reservation_id = v_res)), '[]'::jsonb));
end $$;

select core.allow_read('organizers', 'food.portal_menu', 'function', '{editor,owner}');
select core.allow_read('guests', 'food.portal_menu', 'function', '{editor,owner}');
select core.allow_read('organizers', 'food.portal_menu_comment', 'action', '{editor,owner}');
select core.allow_read('organizers', 'food.portal_my_menu_comments', 'function', '{editor,owner}');

revoke all on function food.portal_reservation(jsonb), food.portal_shared_menus(uuid), food.portal_menu(jsonb),
  food.portal_menu_comment(jsonb), food.portal_my_menu_comments(jsonb), food.guard_menu_comment() from public, anon, authenticated;
grant execute on function food.portal_reservation(jsonb), food.portal_shared_menus(uuid), food.portal_menu(jsonb),
  food.portal_menu_comment(jsonb), food.portal_my_menu_comments(jsonb) to service_role;
