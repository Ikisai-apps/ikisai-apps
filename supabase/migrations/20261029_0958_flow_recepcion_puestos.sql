-- Ikisai Flow · recepción «por puestos» del alojamiento libre (decisión de VG, 28-10), como la barra: un flujo con un carril
-- por puesto, alimentado por la lectura de Booking `booking.reception_board` y con tarjetas que abren la pantalla real de
-- Booking. Una solicitud saca trabajo en varios puestos a la vez; no hay tarjeta que viaje. Los datos son de Booking.
-- - Piezas nuevas (inspect_confirm): `rec_solicitud` (Solicitud y cobro), `rec_camas` (Camas, con comidas y extras),
--   `rec_registro` (Registro de viajeros), `rec_peticiones` (Peticiones de huéspedes, continuo) y `rec_salida` (Salida).
-- - Plantilla `alojamiento` v1 con los cinco puestos.
-- Toca solo el schema flow.

create or replace function flow.piece_behavior(p_key text) returns text language sql immutable as $$
  select case p_key
    when 'order' then 'inspect_confirm' when 'service' then 'inspect_confirm'
    when 'prep' then 'quick_steps' when 'ingredients' then 'quick_steps'
    when 'logistics' then 'free_task'
    when 'arrival' then 'guest_presence' when 'bed' then 'guest_presence' when 'signature' then 'guest_presence' when 'departure' then 'guest_presence'
    when 'review' then 'inspect_confirm'
    when 'rec_solicitud' then 'inspect_confirm' when 'rec_camas' then 'inspect_confirm' when 'rec_registro' then 'inspect_confirm'
    when 'rec_peticiones' then 'inspect_confirm' when 'rec_salida' then 'inspect_confirm'
  end
$$;

insert into flow.template_columns (template_key, version, label_base, key, label, behavior, config, position)
select x.* from (values
  ('alojamiento', 1, 'Alojamiento libre', 'rec_solicitud', 'Solicitud y cobro', 'inspect_confirm', '{}'::jsonb, 1),
  ('alojamiento', 1, 'Alojamiento libre', 'rec_camas', 'Camas', 'inspect_confirm', '{}'::jsonb, 2),
  ('alojamiento', 1, 'Alojamiento libre', 'rec_registro', 'Registro', 'inspect_confirm', '{}'::jsonb, 3),
  ('alojamiento', 1, 'Alojamiento libre', 'rec_peticiones', 'Peticiones', 'inspect_confirm', '{}'::jsonb, 4),
  ('alojamiento', 1, 'Alojamiento libre', 'rec_salida', 'Salida', 'inspect_confirm', '{}'::jsonb, 5)
) as x(template_key, version, label_base, key, label, behavior, config, position)
 where not exists (select 1 from flow.template_columns where template_key = 'alojamiento');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
