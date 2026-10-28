-- Ikisai Flow · «Preparación y revisión de apertura» (segundo flujo de VG; diseño de Tasks en
-- MUELA/equipo/feedback/tasks/REVISION_APERTURA.md y docs/tasks/API.md §46.3, §46.4 y §59). Los datos viven en Tasks: Flow
-- solo compone con las capacidades del catálogo (`tasks.reviews_day`, `tasks.review_projection`, `tasks.review_item_result`)
-- y el token de la persona.
-- - Pieza nueva `review` («Revisión de apertura», inspect_confirm): la pantalla lee las revisiones del día y sus ítems por
--   zona, y marca cada uno «Bien» o «Incidencia».
-- - Plantilla `apertura` v1: «Preparación» (tareas libres) y «Revisión».
-- Sin datos de Tasks en Flow. Toca solo el schema flow.

create or replace function flow.piece_behavior(p_key text) returns text language sql immutable as $$
  select case p_key
    when 'order' then 'inspect_confirm' when 'service' then 'inspect_confirm'
    when 'prep' then 'quick_steps' when 'ingredients' then 'quick_steps'
    when 'logistics' then 'free_task'
    when 'arrival' then 'guest_presence' when 'bed' then 'guest_presence' when 'signature' then 'guest_presence' when 'departure' then 'guest_presence'
    when 'review' then 'inspect_confirm'
  end
$$;

insert into flow.template_columns (template_key, version, label_base, key, label, behavior, config, position)
select x.* from (values
  ('apertura', 1, 'Preparación y revisión de apertura', 'logistics', 'Preparación', 'free_task', '{"manual": true}'::jsonb, 1),
  ('apertura', 1, 'Preparación y revisión de apertura', 'review', 'Revisión', 'inspect_confirm', '{}'::jsonb, 2)
) as x(template_key, version, label_base, key, label, behavior, config, position)
 where not exists (select 1 from flow.template_columns where template_key = 'apertura');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
