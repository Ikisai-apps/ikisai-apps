-- Ikisai Central · la ficha de agente enlaza a su carril del Avance en Flow (cola de Core, 27-10): el proyecto de Flow donde
-- vive su Avance y la clave de su carril. Con los dos, la ficha abre flow.ikisai.com/#/p/<proyecto>/avance?carril=<carril>;
-- y el Avance enlaza la ficha con central.ikisai.com/#/accesos/agentes?agente=<id>. Solo guarda los dos identificadores.
-- Toca solo el schema central.

-- Formas de Flow (27-10): el proyecto es un uuid y el carril, ^[a-z][a-z0-9_]{1,30}$.
alter table central.agents add column if not exists flow_project uuid;
alter table central.agents add column if not exists flow_lane text check (flow_lane is null or flow_lane ~ '^[a-z][a-z0-9_]{1,30}$');
create unique index if not exists agents_flow_lane_idx on central.agents (flow_project, flow_lane) where deleted_at is null and flow_lane is not null;

select core.register_table('central', 'central', 'agents', array['display_name','user_id','mission','work_areas','responsible_kind',
  'responsible_person_id','responsible_service','active','successor_id','notes','flow_project','flow_lane'], '{reader,editor,owner}', '{owner}');

-- Para el Avance de Flow: de cada carril, la ficha del agente (para enlazarla). Solo ids y nombre.
create view central.agent_lanes_projection as
select a.flow_project, a.flow_lane, a.id as agent_id, a.display_name, a.active
  from central.agents a
 where a.deleted_at is null and a.flow_project is not null and a.flow_lane is not null;
revoke all on central.agent_lanes_projection from public, anon, authenticated;
grant select on central.agent_lanes_projection to service_role;
select core.allow_read('flow', 'central.agent_lanes_projection', 'view');
