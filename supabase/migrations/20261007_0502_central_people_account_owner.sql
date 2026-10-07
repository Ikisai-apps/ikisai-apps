-- Ikisai Central · enlazar o desenlazar la cuenta de una persona es cosa del owner de Central (revisión de Core, ronda 5).
-- La Edge ya lo rechaza en beforeCommit; esta comprobación lo impone también en la base, para cualquier camino que
-- llegue a core.commit. Toca solo el schema central.

create or replace function central.check_account_link(p jsonb)
returns void language plpgsql as $$
declare v_row uuid;
begin
  -- Cambios de `user_id` en este lote: alta con valor o modificación (borrar o restaurar la fila no lo cambia).
  select c.row_id into v_row
    from core.changes c
   where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
     and c.schema_name = 'central' and c.table_name = 'people'
     and (c.before->>'user_id') is distinct from (c.after->>'user_id')
   limit 1;
  if v_row is null then return; end if;
  if not exists (select 1 from core.memberships m
                  where m.app = 'central' and m.user_id = (p->>'actor')::uuid and m.role = 'owner') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.people', 'id', v_row, 'field', 'user_id',
      'reason', 'only the central owner links accounts'));
  end if;
end $$;

select core.add_validate_hook('central', 'central.check_account_link');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
