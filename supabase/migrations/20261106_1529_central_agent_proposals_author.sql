-- Ikisai Central · propuestas del agente: «solo su propia ficha» (X1, vg-51). Con `core.proposal_author()` (núcleo 0122) el hook
-- 1528 comprueba que la ficha que cambia es la del agente que propuso. Y reconoce el lote de propuesta por `core.proposal_id()`, que
-- pone el servidor, no por el requestId `proposal:%`, que lo elige el cliente (revisión de seguridad, Guests 06-11). Toca solo central.

create or replace function central.check_agent_proposals(p jsonb)
returns void language plpgsql as $$
declare v_change record; v_card central.agents; v_extra text;
begin
  -- Es propuesta solo si lo dice el núcleo (`core.proposal_id()`, lo pone el servidor al aplicar); el requestId lo elige el cliente.
  if core.proposal_id() is null then
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
    if v_card.user_id is null or v_card.user_id is distinct from core.proposal_author() then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.agents', 'reason', 'an agent only proposes changes to its own card'));
    end if;
    if not exists (select 1 from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid and m.role = 'owner')
       and not exists (select 1 from central.people pe where pe.id = v_card.responsible_person_id and pe.user_id = (p->>'actor')::uuid and pe.deleted_at is null) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.agents', 'reason', 'owner or the agent responsible decides'));
    end if;
  end loop;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
