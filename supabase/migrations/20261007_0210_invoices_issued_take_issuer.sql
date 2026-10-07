-- Invoices · completar el emisor de las emitidas registradas sin él (ronda 38). Toca solo el schema invoices.
--
-- `invoices.take_issuer {ids}`: copia el emisor actual (la entidad de Central) en las emitidas indicadas que aún no lo
-- tienen. Nunca sobrescribe un emisor existente y no toca las anuladas (no se editan). La copia la pone la Edge en
-- `args.issuer` con los datos leídos de `central.common_entity_projection`; lo que mande el cliente se descarta allí.
-- Cada fila se actualiza con una operación de fila del núcleo, así que queda en el historial quién lo hizo.
-- Owner y editor.

create or replace function invoices.take_issuer(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args';
  v_issuer jsonb := a->'issuer';
  v_ids jsonb := a->'ids';
  v_id uuid;
  v invoices.issued_invoices;
  v_filled jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  if coalesce(p->>'role', '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', 'invoices.take_issuer')); end if;
  if v_issuer is null or jsonb_typeof(v_issuer) <> 'object' or nullif(v_issuer->>'tax_id', '') is null or nullif(v_issuer->>'legal_name', '') is null then
    perform core.fail('ENTITY_MISSING', 422, jsonb_build_object('reason', 'Faltan los datos de la entidad en Central'));
  end if;
  if v_ids is null or jsonb_typeof(v_ids) <> 'array' or jsonb_array_length(v_ids) = 0 or jsonb_array_length(v_ids) > 500 then
    perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'ids', 'reason', 'lista de 1 a 500 emitidas'));
  end if;
  for v_id in select distinct (x #>> '{}')::uuid from jsonb_array_elements(v_ids) x loop
    select * into v from invoices.issued_invoices where id = v_id and deleted_at is null for update;
    if v.id is null then v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'not_found');
    elsif v.issuer_tax_id is not null or v.issuer is not null then v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'has_issuer');
    elsif v.status = 'anulada' then v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'annulled');
    else
      perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.issued_invoices', 'id', v.id, 'expectedRevision', v.revision,
        'fields', jsonb_build_object('issuer_tax_id', v_issuer->>'tax_id', 'issuer_name', v_issuer->>'legal_name', 'issuer', v_issuer)));
      v_filled := v_filled || to_jsonb(v.id);
    end if;
    v := null;
  end loop;
  return jsonb_build_object('filled', v_filled, 'skipped', v_skipped);
end $$;
select core.allow_procedure('invoices', 'invoices.take_issuer');
revoke all on function invoices.take_issuer(jsonb) from public, anon, authenticated;
