-- Ikisai Booking · O2, pantalla Estancias: con quién se puede crear una estancia. Las cuentas con nivel de casa (O1,
-- `core.house_levels`) y su nombre (`core.profiles`), sin leer `central.*` (respuesta de Core del 14-10-2026). Toca solo el
-- schema booking.

-- `{}` → `{items: [{account_id, name, level}]}`: outsiders, staff y dirección, por nombre.
create or replace function booking.house_people(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('account_id', h.user_id,
           'name', coalesce(nullif(btrim(pr.display_name), ''), 'Sin nombre'), 'level', h.level)
           order by coalesce(nullif(btrim(pr.display_name), ''), 'Sin nombre'), h.user_id), '[]'::jsonb))
    from core.house_levels h left join core.profiles pr on pr.user_id = h.user_id;
$$;

select core.allow_read('booking', 'booking.house_people', 'function', '{reader,editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
