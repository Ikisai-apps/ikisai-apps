-- Ikisai Central · P2 (personas y oficios en Tasks, aprobada por el usuario el 18-10-2026): comprobaciones de existencia
-- para los hooks de otras apps, como `resources.spaces` en R2. Solo leen; no devuelven datos de la ficha.
--   central.person_alive(id): la persona existe, no está borrada y está activa.
--   central.trade_alive(id): el oficio existe, no está borrado y está activo.
create or replace function central.person_alive(p_id uuid)
returns boolean language sql stable as $$
  select exists (select 1 from central.people where id = p_id and deleted_at is null and active)
$$;

create or replace function central.trade_alive(p_id uuid)
returns boolean language sql stable as $$
  select exists (select 1 from central.trades where id = p_id and deleted_at is null and active)
$$;
