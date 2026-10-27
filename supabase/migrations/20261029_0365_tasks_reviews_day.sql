-- Ikisai Tasks · las revisiones de apertura del día, para el recorrido de Flow «Preparación y revisión de apertura» (segundo
-- flujo de VG; encargo de Core, 27-10-2026; docs/tasks/API.md §59). Toca solo el schema tasks y, del núcleo, solo usa fail,
-- allow_read y register_capability.
-- - tasks.reviews_of_day(args {date?}): las revisiones que quien lee ve y que tocan ese día: las de un proyecto que vence ese
--   día y las que siguen sin abrir de días anteriores (lo que no se abrió no se olvida). Por revisión: su plantilla, el evento,
--   el estado, si está lista para abrir y sus totales (ítems, críticos verificados, hechos, con fallo, sin mirar). Los ítems y
--   sus pasos los da `tasks.review_projection` (§46.4) y se marcan con `tasks.review_item_result` (§46.3): bien, o con
--   incidencia («fail» con su nota). Fecha por defecto: hoy en Europa/Madrid.
-- - Capacidad `tasks.reviews_day` (`GET reviews/day`), con reads; y las dos de siempre ya declaran los suyos (0364).

create or replace function tasks.reviews_of_day(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  v_day date;
  v_out jsonb;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  begin
    v_day := coalesce(nullif(v_args->>'date', '')::date, (now() at time zone 'Europe/Madrid')::date);
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'date is AAAA-MM-DD'));
  end;
  select coalesce(jsonb_agg(x.item order by x.due nulls last, x.title, x.id), '[]'::jsonb) into v_out from (
    select pr.due, rv.title, rv.id, jsonb_build_object(
      'reviewId', rv.id, 'projectId', rv.project_id, 'tabId', rv.tab_id, 'title', rv.title, 'eventRef', rv.event_ref, 'due', pr.due,
      'template', jsonb_build_object('id', tp.id, 'name', tp.name), 'status', rv.status, 'overdue', pr.due < v_day and rv.status <> 'opened',
      'ready', rv.status in ('ready', 'opened') or t.crit = t.crit_done,
      'totals', jsonb_build_object('items', t.items, 'critical', t.crit, 'criticalDone', t.crit_done, 'done', t.done, 'failed', t.failed, 'pending', t.pending)
    ) item
    from tasks.reviews rv
    join tasks.projects pr on pr.id = rv.project_id and pr.deleted_at is null
    left join tasks.review_templates tp on tp.id = rv.template_id
    cross join lateral (
      select count(*)::int items, (count(*) filter (where i.critical))::int crit,
             (count(*) filter (where i.critical and i.state in ('ok', 'verified')))::int crit_done,
             (count(*) filter (where i.state in ('ok', 'verified')))::int done, (count(*) filter (where i.state = 'failed'))::int failed,
             (count(*) filter (where i.state = 'pending'))::int pending
        from tasks.review_items i where i.review_id = rv.id and i.deleted_at is null) t
    where rv.deleted_at is null and tasks.scope_project(v_scopes, rv.tab_id, rv.project_id)
      and (pr.due = v_day or (pr.due < v_day and rv.status <> 'opened'))
    limit 200
  ) x;
  return jsonb_build_object('date', v_day, 'reviews', v_out);
end $$;
select core.allow_read('tasks', 'tasks.reviews_of_day', 'function', '{reader,editor,owner}');

revoke all on function tasks.reviews_of_day(jsonb) from public, anon, authenticated;
grant execute on function tasks.reviews_of_day(jsonb) to service_role;

select core.register_capability($cap${
  "id": "tasks.reviews_day",
  "app": "tasks",
  "kind": "read",
  "title": "Las revisiones de apertura del día en Tasks",
  "description": "Las revisiones de apertura que ve la persona y que tocan ese día (las que vencen ese día y las que siguen sin abrir de antes), con su plantilla, el evento, el estado, si está lista para abrir y sus totales. Sus ítems, con tasks.review_projection; marcar uno, con tasks.review_item_result.",
  "route": "GET reviews/day",
  "roles": ["reader", "editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": { "date": { "type": "string", "format": "date" } }
  },
  "output": {
    "type": "object",
    "required": ["date", "reviews"],
    "properties": {
      "date": { "type": "string", "format": "date" },
      "reviews": { "type": "array", "items": { "type": "object", "required": ["reviewId", "title", "status", "ready", "totals"], "properties": {
        "reviewId": { "type": "string", "format": "uuid" }, "projectId": { "type": "string", "format": "uuid" }, "title": { "type": "string" },
        "eventRef": { "type": ["string", "null"] }, "due": { "type": ["string", "null"] }, "template": { "type": "object" },
        "status": { "enum": ["open", "ready", "opened"] }, "overdue": { "type": "boolean" }, "ready": { "type": "boolean" },
        "totals": { "type": "object", "properties": { "items": { "type": "integer" }, "critical": { "type": "integer" }, "criticalDone": { "type": "integer" },
          "done": { "type": "integer" }, "failed": { "type": "integer" }, "pending": { "type": "integer" } } } } } }
    }
  },
  "reads": ["tasks.projects.due", "tasks.review_items.critical", "tasks.review_items.state", "tasks.review_templates.name", "tasks.reviews.event_ref", "tasks.reviews.status", "tasks.reviews.template_id", "tasks.reviews.title"],
  "writes": [],
  "anchors": ["tasks.revision.abrir"],
  "since": "0.1.0"
}$cap$::jsonb);
