-- Ikisai Organizers · propuestas del equipo de Ikisai (decisión de VG del 26-10-2026; PETICIONES B20 y K8).
--
-- Dirección figura como coorganizadora de cualquier retiro (ámbito «todos», `{"all": true}` en `scopes.grants`). Ve y
-- edita la experiencia y las ofertas, pero lo que cambia en un retiro que no es suyo NO se escribe: queda como sugerencia
-- del núcleo («Propuesta del equipo de Ikisai», contrato §3.10) y el organizador la acepta o la descarta desde su ficha.
-- Al aceptar, el lote se aplica como un commit del organizador (`core.suggestion_decide`), que sí tiene permiso propio.
--
-- 1. El gancho de ámbito pide permiso PROPIO para escribir en `organizers.*` (no basta «todos»): `SUGGESTION_REQUIRED`.
-- 2. El tipo de sugerencia `propuesta_equipo`, que solo envía quien tiene el nivel de casa «dirección».

-- ¿Tiene el actor un permiso propio sobre la reserva (una entrada `{reservation_id}` en su pertenencia a Organizers)?
-- «Todos» no cuenta: con él se propone, no se escribe.
create or replace function organizers.own_grant(p_actor uuid, p_reservation uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) g
     where m.app = 'organizers' and m.user_id = p_actor and g ->> 'reservation_id' = p_reservation::text);
$$;

-- Igual que en la 0700, salvo el permiso propio para las filas del organizador.
create or replace function organizers.validate_batch(p jsonb)
returns void language plpgsql as $$
declare
  v_actor uuid := nullif(p->>'actor', '')::uuid;
  v_res uuid;
  c record;
begin
  for c in select table_name, op, before, after from core.changes
            where app = p->>'app' and cursor = (p->>'cursor')::bigint and schema_name = 'organizers' and op <> 'call' loop
    if c.before is not null and (c.before->>'reservation_id' is distinct from c.after->>'reservation_id'
        or (c.table_name = 'answers' and (c.before->>'guest_id' is distinct from c.after->>'guest_id' or c.before->>'question_id' is distinct from c.after->>'question_id'))) then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.' || c.table_name));
    end if;
    if c.table_name in ('materials','questions') and c.before is not null and c.before->>'owner_id' is distinct from c.after->>'owner_id' then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.' || c.table_name, 'field', 'owner_id'));
    end if;
    if v_actor is null or v_actor = core.service_actor('organizers') then continue; end if;
    v_res := (c.after->>'reservation_id')::uuid;
    if c.table_name = 'answers' then
      if not core.portal_in_scope('guests', v_actor, v_res, (c.after->>'guest_id')::uuid)
         or not exists (select 1 from organizers.questions q where q.id = (c.after->>'question_id')::uuid and q.reservation_id = v_res) then
        perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
      end if;
    elsif not organizers.own_grant(v_actor, v_res) then
      -- Con «todos» (dirección) se ve, pero se propone: la sugerencia la aplica el organizador al aceptarla.
      if core.portal_in_scope('organizers', v_actor, v_res, null) then
        perform core.fail('SUGGESTION_REQUIRED', 403, jsonb_build_object('reservation_id', v_res, 'kind', 'propuesta_equipo'));
      end if;
      perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
    elsif c.table_name in ('materials','questions') and c.before is null and c.after->>'owner_id' is distinct from v_actor::text then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'organizers.' || c.table_name, 'field', 'owner_id'));
    end if;
  end loop;
end $$;

select core.register_suggestion_kind('organizers', 'propuesta_equipo', 'Propuesta del equipo de Ikisai',
  array['organizers.experiences', 'organizers.materials', 'organizers.questions', 'organizers.offers'],
  '{insert,update,delete}', '{}', '{editor,owner}', null, 'direccion');

revoke all on all functions in schema organizers from public, anon, authenticated;
grant execute on all functions in schema organizers to service_role;
