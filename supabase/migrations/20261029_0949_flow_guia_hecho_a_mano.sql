-- Ikisai Flow · Guiado: un paso con anclaje cerrado a mano («Hecho», «Siguiente») o saltado (`manual`/`none`, sin `pending`)
-- cuenta como hecho al releer los pasos (UI-kit, #1100): el kit borra lo local al releer y, si no, el paso volvía a salir
-- pendiente en cada recarga. Cerrar el tramo «ir a otra app» sigue pidiendo `save` o `event` (guide_confirm no cambia).

create or replace function flow.guide_steps_read(p jsonb) returns jsonb language plpgsql stable as $$
declare v flow.executions; v_app text := nullif(p->'args'->>'app', ''); v_def text;
begin
  begin v := (select e from flow.executions e where e.id = (p->'args'->>'execution_id')::uuid and e.deleted_at is null);
  exception when others then v := null; end;
  if v.id is null or v.actor is distinct from (p->>'actor')::uuid then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.executions')); end if;
  select d.name into v_def from flow.definition_versions dv join flow.definitions d on d.id = dv.definition_id where dv.id = v.version_id;
  return jsonb_build_object('id', v.id, 'title', v_def, 'mode', v.mode, 'status', v.status,
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'title', s.title, 'explain', s.explain, 'anchor', s.anchor,
               'app', flow.step_app(s.anchor), 'essential', s.essential, 'stage', st.position,
               'done', exists (select 1 from flow.guide_receipts r where r.execution_id = v.id and r.step_id = s.id and r.deleted_at is null
                                and not r.pending)
                       or (flow.step_app(s.anchor) is null and (
                             exists (select 1 from jsonb_array_elements(v.stages) x where (x->>'position')::int = st.position and x->>'status' in ('done', 'practiced'))
                             or exists (select 1 from jsonb_array_elements(v.stages) x where (x->>'position')::int = st.position
                                          and jsonb_typeof((x->'values') #> string_to_array(s.key, '.')) not in ('null')))))
             order by st.position, s.position)
        from flow.definition_steps s join flow.definition_stages st on st.id = s.stage_id and st.deleted_at is null
       where s.version_id = v.version_id and s.deleted_at is null
         and (flow.step_app(s.anchor) is null or flow.step_app(s.anchor) = v_app)), '[]'::jsonb));
end $$;
