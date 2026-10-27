-- Ikisai Flow · ligar un flujo a un evento exige acceso a ese evento en Booking (auditoría de seguridad del 27-10, FL4).
-- Antes, el owner de Flow ligaba un flujo a cualquier evento y todo el ámbito del flujo veía sus huéspedes
-- (`booking.flow_guests_of`) y usaba el check-in. Ahora, al fijar o cambiar `booking_event_id`, quien lo hace tiene que:
-- - ver el evento en Booking (existe y está vivo en `booking.event_projection`), y
-- - ser miembro de Booking (reader, editor u owner) o estar en el personal de ese evento (`booking.event_staff_projection`).
-- Sin actor (sistema, migraciones), no se comprueba.

create or replace function flow.event_access(p_actor uuid, p_event uuid) returns boolean language sql stable as $$
  select exists (select 1 from booking.event_projection e where e.event_id = p_event)
     and (exists (select 1 from core.memberships m where m.app = 'booking' and m.user_id = p_actor and m.role in ('reader', 'editor', 'owner'))
          or exists (select 1 from booking.event_staff_projection s where s.event_id = p_event and s.user_id = p_actor))
$$;

create or replace function flow.guard_event_link() returns trigger language plpgsql as $$
begin
  if new.booking_event_id is null or new.updated_by is null then return new; end if;
  if tg_op = 'UPDATE' and new.booking_event_id is not distinct from old.booking_event_id then return new; end if;
  if not flow.event_access(new.updated_by, new.booking_event_id) then
    perform core.fail('EVENT_NOT_ACCESSIBLE', 403, jsonb_build_object('event_id', new.booking_event_id));
  end if;
  return new;
end $$;

create trigger flow_event_link before insert or update on flow.projects for each row execute function flow.guard_event_link();

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
