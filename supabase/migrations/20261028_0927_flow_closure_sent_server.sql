-- Ikisai Flow · el envío del cierre del día lo anota el servidor (auditoría de seguridad del 27-10, FL9).
-- Antes el owner marcaba «enviado» desde el navegador con `flow.mark_closure_sent`, aunque no hubiera enviado nada. Ahora,
-- como en los justificantes (0917), flow-api lo anota con la respuesta de Food o Finance por el lote público del servidor,
-- que de un cierre solo puede cambiar sus campos de envío.

create or replace function flow.guard_closures() returns trigger language plpgsql as $$
begin
  if flow.in_proc() then return new; end if;
  if core.is_public_batch() and tg_op = 'UPDATE'
     and not flow.changed(to_jsonb(old), to_jsonb(new), array['project_id','day','data','closed_by','closed_at','deleted_at']) then
    return new;
  end if;
  perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.day_closures'));
end $$;
-- El lote público entra con rol editor: la tabla lo admite como escritor, y el guard sigue sin dejar escribir a nadie más
-- que a los procedimientos y a ese lote (solo campos de envío).
select core.register_table('flow', 'flow', 'day_closures',
  array['project_id','day','data','closed_by','closed_at','food_status','food_sent_at','food_result','finance_status','finance_sent_at','finance_result'],
  '{reader,editor,owner}', '{editor,owner}', true);
select core.allow_public_write('flow', 'flow.day_closures');

-- El permiso registrado lo retira el núcleo (`core.disallow_procedure`, pendiente): sin la función, la llamada falla igual.
drop function if exists flow.mark_closure_sent(jsonb);

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
