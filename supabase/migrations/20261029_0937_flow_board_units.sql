-- Ikisai Flow · «Avance por aplicaciones» (decisión de VG del 27-10; MUELA/equipo/feedback/flow/AVANCE_EN_FLOW.md), paso 1:
-- las tarjetas del tablero de agentes son unidades de Flow (`flow.units`) de una columna `avance`.
-- - Columnas nuevas, indexadas por proyecto:
--   - `lane_key`: el carril (el agente: flow, food, booking…, core, core_ops, victor);
--   - `prio`: urgente | importante | secundario | opcional (o nada);
--   - `board_flag`: pr (esperando fusión) | backlog (VG: «no ahora»). Nunca `cancelled`: lo anulado es otra cosa.
-- - Tipos nuevos: `card` (tarjeta) y `recurring` (tarea recurrente «en servicio», que cuenta como hecha y no lleva urgencia).
--   Estado de siempre: pending · in_progress · done.
-- - Las tarjetas solo se escriben por procedimiento (`flow.board_card`, paso 2), nunca con insert o update directos.
-- - Carriles: quien escribe una tarjeta tiene que tener ese carril en `scopes.lanes` de su membresía de Flow (el owner,
--   todos), además del proyecto en su ámbito. Lo comprueba el guard, también dentro de los procedimientos.
-- - Plantilla `avance` v1: una columna «Avance» (pantalla propia en la app, paso 3).

alter table flow.units add column lane_key text check (lane_key is null or lane_key ~ '^[a-z][a-z0-9_]{1,30}$');
alter table flow.units add column prio text check (prio is null or prio in ('urgente', 'importante', 'secundario', 'opcional'));
alter table flow.units add column board_flag text check (board_flag is null or board_flag in ('pr', 'backlog'));

alter table flow.units drop constraint units_kind_check;
alter table flow.units add constraint units_kind_check check (kind in ('prep', 'task', 'station', 'card', 'recurring'));
-- Los títulos de las tarjetas son más largos que los de la barra (hasta 300).
alter table flow.units drop constraint units_label_check;
alter table flow.units add constraint units_label_check
  check (label is null or length(label) between 1 and (case when kind in ('card', 'recurring') then 300 else 120 end));
alter table flow.units add constraint units_card_shape check (
  kind not in ('card', 'recurring')
  or (label is not null and lane_key is not null and order_id is null and line_id is null and product_id is null and status in ('pending', 'in_progress', 'done')));
alter table flow.units add constraint units_recurring_prio check (kind <> 'recurring' or prio is null);

create index units_board_lane_idx on flow.units (project_id, lane_key) where lane_key is not null and deleted_at is null;
create index units_board_prio_idx on flow.units (project_id, prio) where prio is not null and deleted_at is null;
create index units_board_flag_idx on flow.units (project_id, board_flag) where board_flag is not null and deleted_at is null;

select core.register_table('flow', 'flow', 'units', array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','label','priority','status','assigned_to','done_at','done_by','payload','source_ref','lane_key','prio','board_flag'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);

/** ¿Puede esta persona escribir en ese carril del proyecto? Owner: todos. Si no: el proyecto en su ámbito y el carril en `scopes.lanes`. */
create or replace function flow.lane_allowed(p_actor uuid, p_project uuid, p_lane text) returns boolean language sql stable as $$
  select exists (
    select 1 from core.memberships m
     where m.app = 'flow' and m.user_id = p_actor
       and (m.role = 'owner'
            or (m.role in ('editor', 'outsider') and flow.in_scope(p_actor, p_project)
                and coalesce(m.scopes->'lanes', '[]'::jsonb) ? p_lane)))
$$;

-- El actor sale de la sesión del núcleo (el nombre del ajuste se compone para que el lint no lo tome por una referencia).
create or replace function flow.guard_board() returns trigger language plpgsql as $$
declare v_actor uuid := nullif(current_setting('core' || '.actor', true), '')::uuid;
begin
  if not (new.kind in ('card', 'recurring') or new.lane_key is not null
          or (tg_op = 'UPDATE' and (old.kind in ('card', 'recurring') or old.lane_key is not null))) then
    return new;
  end if;
  if not flow.in_proc() then perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units', 'reason', 'board cards')); end if;
  if v_actor is not null then
    if not flow.lane_allowed(v_actor, new.project_id, new.lane_key)
       or (tg_op = 'UPDATE' and old.lane_key is not null and not flow.lane_allowed(v_actor, old.project_id, old.lane_key)) then
      perform core.fail('LANE_FORBIDDEN', 403, jsonb_build_object('lane', coalesce(new.lane_key, old.lane_key)));
    end if;
  end if;
  return new;
end $$;
create trigger flow_board before insert or update on flow.units for each row execute function flow.guard_board();

insert into flow.template_columns (template_key, version, label_base, key, label, behavior, config, position)
select 'avance', 1, 'Avance por aplicaciones', 'avance', 'Avance', 'free_task', '{}'::jsonb, 1
 where not exists (select 1 from flow.template_columns where template_key = 'avance');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
