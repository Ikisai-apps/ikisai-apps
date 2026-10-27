-- Ikisai Flow · «Crear tarea de Logística» (capacidad flow.logistics_task) comprueba el ámbito (auditoría 27-10, FL7).
-- flow-api pregunta, antes de dar de alta, si quien llama tiene ese proyecto en su ámbito. args = { project_id }
create or replace function flow.project_access_read(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('in_scope', exists (select 1 from flow.projects where id = (p->'args'->>'project_id')::uuid and deleted_at is null)
                                        and flow.in_scope((p->>'actor')::uuid, (p->'args'->>'project_id')::uuid))
$$;
select core.allow_read('flow', 'flow.project_access_read', 'function', '{editor,owner}');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
