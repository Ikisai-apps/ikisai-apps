-- Ikisai Central · fase O4: el nivel de casa da los roles (coordinacion/ampliacion/RECURSOS.md §13.2 y §15.1; tabla
-- «hoy / después» aprobada por el usuario el 13-10-2026). Central solo escribe `central.people.house_level`; el núcleo
-- (0092, `core.apply_house_level`) decide qué rol da cada nivel en cada app, nunca rebaja y al quitarlo devuelve solo lo
-- que dio. Hoy solo deriva el outsider: Tasks `outsider` y Guests `editor`.

-- Nivel que cuenta para los accesos: el de una ficha viva, activa y no fusionada. Inactiva, en la papelera o fusionada → ninguno.
create or replace function central.effective_house_level(p central.people)
returns text language sql immutable as $$
  select case when p.active and p.deleted_at is null and p.merged_into is null then p.house_level end
$$;

-- Al poner, cambiar o quitar el nivel, enlazar o desenlazar la cuenta, desactivar, borrar, restaurar o fusionar la ficha.
-- Si cambia la cuenta, la vieja se queda primero sin nivel. La fusión mueve la cuenta a la ficha que queda, con su nivel.
create or replace function central.sync_house_level()
returns trigger language plpgsql as $$
declare
  v_new text := central.effective_house_level(new);
  v_old text;
begin
  if tg_op = 'UPDATE' then
    v_old := central.effective_house_level(old);
    if old.user_id is not distinct from new.user_id and v_old is not distinct from v_new then return null; end if;
    if old.user_id is not null and old.user_id is distinct from new.user_id then
      perform core.apply_house_level(old.user_id, null, new.updated_by);
    end if;
  end if;
  if new.user_id is not null then
    perform core.apply_house_level(new.user_id, v_new, new.updated_by);
  end if;
  return null;
end $$;

create trigger people_house_level after insert or update of house_level, user_id, active, deleted_at, merged_into on central.people
  for each row execute function central.sync_house_level();

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;

-- Quienes ya tienen nivel y cuenta (hoy, los outsiders) reciben lo que da su nivel. Idempotente.
select core.apply_house_level(user_id, house_level)
from central.people
where house_level is not null and user_id is not null and active and deleted_at is null and merged_into is null;
