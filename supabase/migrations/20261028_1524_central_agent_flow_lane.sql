-- Ikisai Central · la ficha de agente enlaza a su carril del Avance en Flow (cola de Core, 27-10): el proyecto de Flow donde
-- vive su Avance y la clave de su carril. Con los dos, la ficha abre flow.ikisai.com/#/p/<proyecto>/avance?carril=<carril>;
-- y el Avance enlaza la ficha con central.ikisai.com/#/accesos/agentes?agente=<id>. Solo guarda los dos identificadores.
-- Toca solo el schema central.

alter table central.agents add column if not exists flow_project text check (flow_project is null or flow_project ~ '^[A-Za-z0-9_-]{1,64}$');
alter table central.agents add column if not exists flow_lane text check (flow_lane is null or flow_lane ~ '^[A-Za-z0-9_.-]{1,64}$');

select core.register_table('central', 'central', 'agents', array['display_name','user_id','mission','work_areas','responsible_kind',
  'responsible_person_id','responsible_service','active','successor_id','notes','flow_project','flow_lane'], '{reader,editor,owner}', '{owner}');
