-- Ikisai Central · `central.batch_by_owner` (1518) sabe si está dentro de un lote con `core.in_batch()` y usa el rol que el
-- núcleo pasa a los hooks (auditoría del 27-10, tercera pasada; núcleo 0105 y 0107).
-- `current_role() is not null` engañaba: fuera de un lote, tras el primero de la sesión, `core.role` vale '' y no null; y en los
-- caminos anidados `core.role` puede no ser el rol con el que empezó el lote. Desde la 0105 los hooks reciben `role`, el rol
-- inicial que autorizó el lote: es el que vale. Sin él (una llamada antigua), el de la sesión si hay lote; fuera de un lote, la
-- membresía, que entonces no ha cambiado.
-- Toca solo el schema central; `check_account_link` y `check_house_level_change` no cambian.

create or replace function central.batch_by_owner(p jsonb)
returns boolean language sql stable as $$
  select case when nullif(p->>'role', '') is not null then p->>'role' = 'owner'
              when core.in_batch() then core.current_role() = 'owner'
              else exists (select 1 from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid and m.role = 'owner') end
$$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
