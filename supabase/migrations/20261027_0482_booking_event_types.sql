-- Ikisai Booking · tres tipos de reserva con sentido (encargo de VG del 26-10-2026, plan aprobado por Core):
-- - `retiro`: la actividad principal (antes también convivencia, formacion, encuentro, actividad_divulgativa y alquiler_grupo).
-- - `jornadas_abiertas`: evento abierto, con venta a la carta y alojamiento a la carta sobre la marcha (antes, `otro`).
-- - `familiar`: de la casa, sin precios ni alojamiento; come del menú de casa de Food.
-- El mapeo se aplica también a las tarifas (`rates.event_types`, sin repetir). La proyección de Food lleva el valor nuevo
-- (el trigger de 0006 sube su revisión). Toca solo el schema booking.

alter table booking.reservations drop constraint if exists reservations_event_type_check;

update booking.reservations set event_type = case
    when event_type = 'otro' then 'jornadas_abiertas'
    else 'retiro' end
 where event_type not in ('retiro', 'jornadas_abiertas', 'familiar');

alter table booking.reservations add constraint reservations_event_type_check
  check (event_type in ('retiro', 'jornadas_abiertas', 'familiar'));

update booking.rates r set event_types = (
    select array_agg(distinct m order by m) from (
      select case when t in ('retiro', 'jornadas_abiertas', 'familiar') then t when t = 'otro' then 'jornadas_abiertas' else 'retiro' end m
        from unnest(r.event_types) t) x)
 where r.event_types is not null and cardinality(r.event_types) > 0
   and exists (select 1 from unnest(r.event_types) t where t not in ('retiro', 'jornadas_abiertas', 'familiar'));
