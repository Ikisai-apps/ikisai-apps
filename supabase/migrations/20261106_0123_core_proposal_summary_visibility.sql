-- 0123 · Propuestas hacia otra app: el resumen antes/después (datos de la app destino) solo lo ve quien tiene derecho a esos datos
-- (revisión de seguridad del 6-11 sobre 0122): el decisor nombrado o un editor/owner de la app destino. Los demás, incluido el
-- owner de la app de origen, reciben `summary: []` con `summaryHidden: true`. En la propia app no cambia nada.

create or replace function core.proposal_json_for(p core.proposals, p_actor uuid)
returns jsonb language sql stable as $$
  select case
    when p.target_app is null then core.proposal_json(p)
    when (p.decider_user_id is not null and p.decider_user_id = p_actor)
      or exists (select 1 from core.memberships m where m.app = p.target_app and m.user_id = p_actor and m.role in ('editor', 'owner'))
      then core.proposal_json(p)
    else core.proposal_json(p) || jsonb_build_object('summary', '[]'::jsonb, 'summaryHidden', true) end
$$;
