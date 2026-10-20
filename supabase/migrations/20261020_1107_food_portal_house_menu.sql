-- Ikisai Food · FD2: el menú de casa para Guests (petición de Guests; Core, 20-10-2026; docs/food/API.md §7.6).
--
-- food.portal_house_menu {from?, to?} → { from, to, services: [{ date, type, time, dishes: [{ name, quick, allergens,
-- allergens_checked }] }] }. Solo lectura, para Guests (outsider, editor y owner).
--
-- - Rango: desde hoy (hora de Madrid) en adelante y como mucho 60 días. Sin `from`, hoy; sin `to`, `from` + 60 días.
--   Un `from` anterior a hoy empieza hoy; un `to` más allá del límite se recorta.
-- - Alérgenos con la regla de #597: siempre los declarados, con `allergens_checked` para que Guests diga «sin revisar por
--   cocina». Nunca `null` por no estar revisados.
-- - No salen costes, raciones, ingredientes, elaboración, notas, recetas internas ni nombres de personas.

create or replace function food.portal_house_menu(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_today date := (now() at time zone 'Europe/Madrid')::date;
  v_from date; v_to date;
begin
  if p->>'app' <> 'guests' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'solo Guests lee el menú de casa')); end if;
  begin
    v_from := coalesce(nullif(p->'args'->>'from', '')::date, v_today);
    v_to := nullif(p->'args'->>'to', '')::date;
  exception when others then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from/to', 'reason', 'fecha AAAA-MM-DD'));
  end;
  v_from := greatest(v_from, v_today);
  v_to := least(coalesce(v_to, v_from + 60), v_today + 60);
  if v_to < v_from then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'to', 'reason', 'to antes que from')); end if;
  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'services', coalesce((select jsonb_agg(jsonb_build_object(
        'date', s.service_date, 'type', s.service_type, 'time', s.service_time,
        'dishes', coalesce((select jsonb_agg(jsonb_build_object(
            'name', coalesce(nullif(btrim(r.public_name), ''), r.name), 'quick', r.quick,
            'allergens', to_jsonb(coalesce(r.allergens, '{}')), 'allergens_checked', r.allergens_checked)
          order by i.position, i.created_at)
          from food.menu_items i join food.recipes r on r.id = i.recipe_id and r.deleted_at is null
         where i.service_id = s.id and i.deleted_at is null), '[]'::jsonb))
      order by s.service_date, s.position, s.service_time nulls last)
      from food.menu_services s join food.menus m on m.id = s.menu_id
     where m.kind = 'casa' and m.deleted_at is null and s.deleted_at is null
       and s.service_date between v_from and v_to), '[]'::jsonb));
end $$;

select core.allow_read('guests', 'food.portal_house_menu', 'function', '{outsider,editor,owner}');

revoke all on function food.portal_house_menu(jsonb) from public, anon, authenticated;
grant execute on function food.portal_house_menu(jsonb) to service_role;
