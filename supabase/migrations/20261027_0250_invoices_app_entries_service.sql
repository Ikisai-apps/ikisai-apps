-- Finance · seguridad F1 (auditoría de rutas del 27-10): el origen de un apunte de otra app lo fija el servidor.
--
-- Fase 1 (esta): las apps envían por `POST worker/app-entries` (invoices-api) con su cuenta de servicio, y aquí se
-- comprueba que una cuenta de servicio solo escribe apuntes de su app (`core.service_actor(source_app)`). Mientras Flow y
-- Booking cambian su llamada, una persona editora aún puede llamar (como antes de esta migración).
-- Fase 2 (en cuanto Flow y Booking usen el worker): solo cuentas de servicio; las personas, 403.
-- El cuerpo de 0247/0248 no cambia: la comprobación va delante.

alter function invoices.record_app_entry(jsonb) rename to record_app_entry_0248;

create function invoices.record_app_entry(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_actor uuid := nullif(p->>'actor', '')::uuid;
  v_app text := btrim(coalesce(p->'args'->>'source_app', ''));
begin
  if exists (select 1 from core.profiles where user_id = v_actor and kind = 'service')
     and core.service_actor(v_app) is distinct from v_actor then
    perform core.fail('SOURCE_MISMATCH', 403, jsonb_build_object('field', 'source_app', 'reason', 'a service account only records entries of its own app'));
  end if;
  return invoices.record_app_entry_0248(p);
end $$;

revoke all on function invoices.record_app_entry(jsonb), invoices.record_app_entry_0248(jsonb) from public, anon, authenticated;
