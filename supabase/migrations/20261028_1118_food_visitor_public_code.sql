-- Food · ofertas de visitante por el código público del evento (auditoría de seguridad de Tasks del 27-10-2026, FO1;
-- MUELA/equipo/feedback/seguridad/AUDITORIA_RUTAS_27-10.md). Toca solo el schema food; lee booking.
--
-- `food_visitor_offers` buscaba por `events.code` (`EVT_<año>_<nnn>`, secuencial): cualquiera podía recorrer los eventos y
-- sus ofertas públicas, y la respuesta llevaba `event_id`. Ahora:
-- - busca por el código público del evento (Booking 0488: 10 caracteres al azar, el del QR), el mismo que ya manda Guests
--   en `event_code` y que usa `booking_event`; también acepta `code`. Lo que no tiene ese formato no se busca. Food solo
--   lee de Booking su proyección (`booking.food_event_projection`), que aún no trae `public_code`: se pide a Booking, y la
--   búsqueda se activa sola cuando la columna exista (antes, ningún código encuentra nada: el secuencial ya no vale);
-- - la respuesta no lleva `event_id` (ni arriba ni en cada oferta);
-- - un código desconocido, uno sin ofertas públicas y el código secuencial de antes responden igual: vacío.
create or replace function food.visitor_offers(p_args jsonb)
returns jsonb language plpgsql stable as $$
declare v_event uuid; v_code text := upper(btrim(coalesce(p_args->>'event_code', p_args->>'code', ''))); v_from date; v_to date; v_out jsonb;
begin
  begin
    v_from := nullif(p_args->>'from', '')::date;
    v_to := nullif(p_args->>'to', '')::date;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'from/to')); end;
  if v_code = '' or length(v_code) > 40 then perform core.fail('EVENT_NOT_FOUND', 404, jsonb_build_object('event_code', v_code)); end if;
  if v_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$' and exists (select 1 from information_schema.columns
       where table_schema = 'booking' and table_name = 'food_event_projection' and column_name = 'public_code') then
    execute 'select e.event_id from booking.food_event_projection e where e.public_code = $1 limit 1' into v_event using v_code;
  end if;
  if v_event is null then return jsonb_build_object('event_code', v_code, 'offers', '[]'::jsonb, 'days', '[]'::jsonb); end if;
  v_out := food.offers_payload('visitor', null, v_event, v_from, v_to);
  return jsonb_build_object('event_code', v_code,
    'offers', coalesce((select jsonb_agg(o - 'event_id' order by n) from jsonb_array_elements(v_out->'offers') with ordinality x(o, n)), '[]'::jsonb),
    'days', coalesce(v_out->'days', '[]'::jsonb));
end $$;
