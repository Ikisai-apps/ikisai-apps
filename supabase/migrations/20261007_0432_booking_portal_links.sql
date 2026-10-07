-- Ikisai Booking · caducidad de los enlaces de los portales Organizers y Guests (contrato §3.6; Core, ronda 24).
-- El núcleo la consulta en cada canje: si las fechas de la reserva se mueven, el enlace se amplía o se reduce solo.

-- Fin de la reserva más 3 días (hasta el final de ese día, hora de Madrid). Sin fecha de salida todavía, 90 días desde
-- el alta de la reserva (el enlace del organizador se da en cuanto la reserva existe). `null` (= caducado) si la reserva
-- no existe, está borrada, cancelada o perdida.
create or replace function booking.portal_link_valid_until(p_scope jsonb)
returns timestamptz language plpgsql stable as $$
declare v_id uuid; v_res booking.reservations;
begin
  begin v_id := (p_scope->>'reservation_id')::uuid; exception when others then return null; end;
  if v_id is null then return null; end if;
  select * into v_res from booking.reservations where id = v_id;
  if v_res.id is null or v_res.deleted_at is not null or v_res.status in ('cancelada','perdida') then return null; end if;
  if v_res.end_date is null then return v_res.created_at + interval '90 days'; end if;
  return ((v_res.end_date + 4)::timestamp at time zone 'Europe/Madrid');
end $$;

select core.allow_portal_resolver('organizers', 'booking.portal_link_valid_until');
select core.allow_portal_resolver('guests', 'booking.portal_link_valid_until');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
