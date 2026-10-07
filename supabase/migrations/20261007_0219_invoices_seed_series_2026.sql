-- Invoices · series de emisión de 2026 (ronda 48, acordado con el usuario por medio de Core). Toca solo el schema invoices.
--
-- Finance continúa en 2026 la numeración de la hoja del usuario: su última factura fue `F_02_26`, así que la serie `F`
-- empieza con el último número 2 (la siguiente, `F_03_26`), y la de rectificativas `R` con 0 (`R_01_26`). Formato
-- `{serie}_{n:2}_{aa}`, solo para 2026 (`valid_year`). En 2027 se crea la serie del año con el formato estándar.
--
-- No hace nada con una serie que ya exista con ese código (aunque esté borrada o tenga emitidas). Se escribe con
-- core.apply_migration_operations (#274): lote propio con cursor y core.changes, así que llega a los dispositivos.

-- La guarda de 0212 bloqueaba ajustar una serie con el contador inicial puesto (p. ej. las sembradas aquí, último 2) aunque no
-- tuviera emitidas. Lo que la congela es tener facturas emitidas, no el contador: se ajusta mientras no las haya.
create or replace function invoices.guard_issued_series()
returns trigger language plpgsql as $$
begin
  if (new.closed_at is distinct from old.closed_at or new.closed_last_number is distinct from old.closed_last_number or new.counter_year is distinct from old.counter_year
      or new.counter_last is distinct from old.counter_last or new.counter_last_date is distinct from old.counter_last_date) and not invoices.issuing() then
    perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('reason', 'use invoices.close_series'));
  end if;
  if (new.mode is distinct from old.mode or new.format is distinct from old.format or new.yearly is distinct from old.yearly or upper(btrim(new.code)) <> upper(btrim(old.code)))
     and exists (select 1 from invoices.issued_invoices i where upper(btrim(i.series_code)) = upper(btrim(old.code)) and i.deleted_at is null and i.status <> 'borrador') then
    perform core.fail('SERIES_IN_USE', 409, jsonb_build_object('code', old.code));
  end if;
  return new;
end $$;

do $$
declare v_ops jsonb := '[]'::jsonb; s record;
begin
  for s in select * from (values ('F', 'ordinaria', 'Facturas 2026 (continúa la hoja)', 2), ('R', 'rectificativa', 'Rectificativas 2026', 0)) as t(code, kind, label, last_number) loop
    if not exists (select 1 from invoices.issued_series where upper(btrim(code)) = s.code) then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'invoices.issued_series', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('code', s.code, 'kind', s.kind, 'mode', 'emision', 'format', '{serie}_{n:2}_{aa}', 'yearly', true,
          'valid_year', 2026, 'description', s.label, 'counter_year', 2026, 'counter_last', s.last_number));
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('invoices', 'migration:invoices-0219-series-2026', v_ops);
  end if;
end $$;
