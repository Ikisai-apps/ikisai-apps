-- Ikisai Central · propuestas del agente sobre su ficha (X1, vg-51; núcleo 0120). Central no admite agentes: el agente propone
-- desde su propia app con `target_app = 'central'` y, al aprobarla, el núcleo aplica el lote en Central con la decisora como
-- actora y el requestId `proposal:<id>`. Como la propuesta no pasa por la Edge de Central, la regla va aquí, en la base. En un
-- lote de propuesta:
--   - solo se actualizan fichas de agente (`central.agents`) de una cuenta de agente;
--   - solo cambian `mission`, `work_areas` y `notes`;
--   - decide el owner de Central o la cuenta de la persona responsable de esa ficha.
-- «Solo su propia ficha» necesita saber quién propuso (`core.proposal_author()`, pedido a Core el 06-11).
-- La decisora es el actor del lote y sus permisos lo acotan: para que la persona responsable (editora de Central) pueda aplicar
-- la propuesta, el editor pasa a poder escribir en `central.agents`, pero solo dentro de un lote de propuesta. Fuera de él, como
-- hasta ahora, solo el owner (también en la Edge). Toca solo central.

select core.register_table('central', 'central', 'agents', array['display_name','user_id','mission','work_areas','responsible_kind',
  'responsible_person_id','responsible_service','active','successor_id','notes','flow_project','flow_lane'], '{reader,editor,owner}', '{editor,owner}');

create or replace function central.check_agent_proposals(p jsonb)
returns void language plpgsql as $$
declare v_change record; v_card central.agents; v_extra text;
begin
  if coalesce(core.current_request_id(), '') not like 'proposal:%' then
    -- Fuera de una propuesta, las fichas de agente solo las toca el owner (o el sistema: cargas y servicios).
    if not core.is_system_call() and (select pr.kind from core.profiles pr where pr.user_id = (p->>'actor')::uuid) is distinct from 'service'
       and exists (select 1 from core.changes c where c.app = 'central' and c.cursor = (p->>'cursor')::bigint and c.schema_name = 'central' and c.table_name = 'agents')
       and coalesce(nullif(p->>'role', ''), (select m.role from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid)) is distinct from 'owner' then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.agents', 'reason', 'only the owner changes agent cards'));
    end if;
    return;
  end if;
  for v_change in select c.schema_name, c.table_name, c.op, c.row_id, c.before, c.after from core.changes c
                   where c.app = 'central' and c.cursor = (p->>'cursor')::bigint loop
    if v_change.schema_name <> 'central' or v_change.table_name <> 'agents' or v_change.op <> 'update' then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', v_change.schema_name || '.' || v_change.table_name, 'reason', 'an agent only proposes changes to its own card'));
    end if;
    select string_agg(k, ', ') into v_extra from jsonb_object_keys(coalesce(v_change.after, '{}'::jsonb)) k
     where k not in ('mission', 'work_areas', 'notes', 'revision', 'updated_at', 'updated_by')
       and (v_change.after->k) is distinct from (v_change.before->k);
    if v_extra is not null then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.agents', 'reason', 'an agent does not propose ' || v_extra));
    end if;
    select * into v_card from central.agents a where a.id = v_change.row_id;
    if v_card.user_id is null or not exists (select 1 from core.profiles pr where pr.user_id = v_card.user_id and pr.kind = 'agent') then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.agents', 'reason', 'only agent cards take proposals'));
    end if;
    if not exists (select 1 from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid and m.role = 'owner')
       and not exists (select 1 from central.people pe where pe.id = v_card.responsible_person_id and pe.user_id = (p->>'actor')::uuid and pe.deleted_at is null) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.agents', 'reason', 'owner or the agent responsible decides'));
    end if;
  end loop;
end $$;

select core.add_validate_hook('central', 'central.check_agent_proposals');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
