-- Ikisai Food · fotos de los platos en los portales (C8, contrato §3.6; docs/food/API.md §7.5). Toca solo el schema food.
--
-- `food.portal_menu` devuelve además `photo_thumb_file_id` de cada plato, y el resolutor `food.portal_dish_photo` deja abrir
-- ese archivo con `GET /api/v1/portal-files/:fileId` solo si es la miniatura de un plato de un menú que ese miembro ve:
-- compartido con el organizador, de una reserva de su ámbito y, en Guests, validado o cerrado. Nunca la foto grande.

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
            'category', r.category, 'diet_tags', to_jsonb(r.diet_tags), 'allergens', to_jsonb(r.allergens), 'allergens_checked', r.allergens_checked,
            -- Miniatura: el portal la abre con GET /api/v1/portal-files/:fileId (C8, resolutor food.portal_dish_photo).
            'photo_thumb_file_id', r.photo_thumb_file_id)
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

create or replace function food.portal_dish_photo(p_ctx jsonb)
returns boolean language plpgsql stable as $$
declare v_file uuid; v_portal text := p_ctx->>'portal'; v_grant jsonb; v_res uuid; v_guest uuid;
begin
  begin v_file := (p_ctx->>'file_id')::uuid; exception when others then return false; end;
  for v_grant in select g from jsonb_array_elements(coalesce(p_ctx->'scopes'->'grants', '[]'::jsonb)) g loop
    begin
      v_res := (v_grant->>'reservation_id')::uuid;
      v_guest := nullif(v_grant->>'guest_id', '')::uuid;
    exception when others then continue; end;
    if v_res is null or not core.portal_in_scope(v_portal, (p_ctx->>'actor')::uuid, v_res, v_guest) then continue; end if;
    if exists (
      select 1 from food.portal_shared_menus(v_res) m
        join food.menu_services s on s.menu_id = m.id and s.deleted_at is null
        join food.menu_items i on i.service_id = s.id and i.deleted_at is null
        join food.recipes r on r.id = i.recipe_id
       where r.photo_thumb_file_id = v_file
         and (v_portal <> 'guests' or m.status in ('validado','cerrado'))) then
      return true;
    end if;
  end loop;
  return false;
end $$;

select core.allow_portal_file('organizers', 'food.portal_dish_photo');
select core.allow_portal_file('guests', 'food.portal_dish_photo');

revoke all on function food.portal_menu(jsonb), food.portal_dish_photo(jsonb) from public, anon, authenticated;
grant execute on function food.portal_menu(jsonb), food.portal_dish_photo(jsonb) to service_role;
