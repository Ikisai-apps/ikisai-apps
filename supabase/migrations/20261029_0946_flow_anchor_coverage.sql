-- Ikisai Flow · cobertura de anclajes y reglas (petición de Core para el Revisor de Central; contrato §«Cobertura de campos», núcleo 0111).
-- `flow.anchor_coverage {app?}` (lectura, solo metadatos):
-- - anchors: por anclaje usado en pasos (o tramos «ir a otra app») de recorridos publicados, los recorridos y pasos que lo usan
--   → Central lo marca «directo»;
-- - rules: los automatismos de Flow, con lo que observan y lo que escriben como {app, entity, prop} → «automático».
-- Flow no tiene un motor de reglas genérico: las reglas son sus automatismos reales, declarados aquí y mantenidos con ellos.

create or replace function flow.rules_catalog() returns jsonb language sql immutable as $$
  select '[
    {"id": "flow.prevision_ingredientes", "name": "Generar tareas de ingredientes desde la previsión de Food",
     "observes": [{"app": "food", "entity": "carta_line", "prop": "expected_units"}, {"app": "food", "entity": "recipe", "prop": "components"}],
     "writes": [{"app": "flow", "entity": "unit", "prop": "qty"}, {"app": "flow", "entity": "buffer", "prop": "target"}]},
    {"id": "flow.consumo_carta", "name": "Descontar existencias al terminar lo preparado",
     "observes": [{"app": "flow", "entity": "unit", "prop": "status"}],
     "writes": [{"app": "flow", "entity": "buffer", "prop": "qty"}]},
    {"id": "flow.reponer_mesa", "name": "Proponer reponer mesa o comprar al bajar del umbral",
     "observes": [{"app": "flow", "entity": "buffer", "prop": "qty"}],
     "writes": [{"app": "flow", "entity": "unit", "prop": "status"}]},
    {"id": "flow.cierre_food", "name": "Cierre del día: ventas por línea de la carta a Food",
     "observes": [{"app": "flow", "entity": "order_line", "prop": "quantity"}],
     "writes": [{"app": "food", "entity": "carta_line", "prop": "sales"}]},
    {"id": "flow.cierre_finance", "name": "Cierre del día y justificantes a Finance",
     "observes": [{"app": "flow", "entity": "payment", "prop": "amount_cents"}],
     "writes": [{"app": "invoices", "entity": "app_entry", "prop": "amount_cents"}]},
    {"id": "flow.checkin", "name": "Llegada y salida de huéspedes desde el check-in",
     "observes": [{"app": "flow", "entity": "presence_mark", "prop": "step"}],
     "writes": [{"app": "booking", "entity": "guest", "prop": "arrived_at"}, {"app": "booking", "entity": "guest", "prop": "left_at"}]}
  ]'::jsonb
$$;

-- args = { app? }: solo lo que toca a esa app (anclajes con ese prefijo; reglas que la observan o escriben).
create or replace function flow.anchor_coverage_read(p jsonb) returns jsonb language sql stable as $$
  with uses as (
    select coalesce(s.anchor, st.target_anchor) as anchor, d.key as flow_key, d.name as flow_name, v.version, st.position as stage, st.kind as stage_kind, s.key as step
      from flow.definitions d
      join flow.definition_versions v on v.definition_id = d.id and v.status = 'published' and v.deleted_at is null
      join flow.definition_stages st on st.version_id = v.id and st.deleted_at is null
      left join flow.definition_steps s on s.stage_id = st.id and s.deleted_at is null
     where d.deleted_at is null and coalesce(s.anchor, st.target_anchor) is not null
  ), arg as (select nullif(p->'args'->>'app', '') as app)
  select jsonb_build_object(
    'anchors', coalesce((
      select jsonb_agg(jsonb_build_object('anchor_id', u.anchor, 'app', split_part(u.anchor, '.', 1), 'uses', u.uses) order by u.anchor)
        from (select anchor, jsonb_agg(jsonb_build_object('flow_key', flow_key, 'flow_name', flow_name, 'version', version, 'stage', stage,
                       'stage_kind', stage_kind, 'step', step) order by flow_key, stage) as uses
                from uses group by anchor) u, arg
       where arg.app is null or split_part(u.anchor, '.', 1) = arg.app), '[]'::jsonb),
    'rules', coalesce((
      select jsonb_agg(r) from jsonb_array_elements(flow.rules_catalog()) r, arg
       where arg.app is null
          or exists (select 1 from jsonb_array_elements(r->'observes') o where o->>'app' = arg.app)
          or exists (select 1 from jsonb_array_elements(r->'writes') w where w->>'app' = arg.app)), '[]'::jsonb))
$$;
select core.allow_read('flow', 'flow.anchor_coverage_read', 'function', '{reader,editor,owner}');
select core.allow_read('central', 'flow.anchor_coverage_read', 'function', '{editor,owner}');

select core.register_capability(jsonb_build_object(
  'id', 'flow' || '.anchor_coverage', 'app', 'flow', 'kind', 'read', 'title', 'Cobertura de anclajes y reglas de Flow',
  'description', 'Por anclaje usado en pasos de recorridos publicados, los recorridos y pasos que lo usan; y los automatismos de Flow con lo que observan y escriben (entity.prop). Solo metadatos.',
  'route', 'POST anchor-coverage', 'roles', jsonb_build_array('reader', 'editor', 'owner'), 'risk', 'low', 'idempotent', true,
  'input', '{"type":"object","properties":{"app":{"type":"string"}}}'::jsonb,
  'output', '{"type":"object","properties":{"anchors":{"type":"array"},"rules":{"type":"array"}}}'::jsonb,
  'anchors', jsonb_build_array('flow.recorridos'), 'since', '0946'));

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
