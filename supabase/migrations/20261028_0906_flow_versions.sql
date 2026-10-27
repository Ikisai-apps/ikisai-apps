-- Ikisai Flow · versiones de flujo (decisión de VG del 27-10, paso 0 de la cola).
-- - Cada proyecto dice de qué plantilla es y en qué versión (template_key, template_version) y si está congelado.
-- - La barra actual pasa a ser «Barra · v1», congelada: su configuración (columnas, config, comportamientos) no cambia, y
--   las pruebas de tests/flow son su regresión fija. Sus datos de servicio (pedidos, catálogo desde Food, tareas) siguen.
-- - «Nueva versión del flujo» (owner) crea la siguiente copiando la configuración (columnas, config, catálogo y su reparto,
--   reglas de consumo, puntos de existencias vacíos, enlaces y portada); nunca pedidos, clientes, pagos ni cierres. Nace
--   en modo pruebas, ligada al mismo evento, sin atender la carta pública.
-- - La carta pública la atiende el proyecto marcado `serves_public` (uno como mucho), no «el más reciente»: así una versión
--   nueva no se queda con la carta en pleno evento.

alter table flow.projects add column template_key text check (template_key is null or template_key ~ '^[a-z][a-z0-9_]{1,30}$');
alter table flow.projects add column template_version integer check (template_version is null or template_version >= 1);
alter table flow.projects add column frozen boolean not null default false;
alter table flow.projects add column serves_public boolean not null default false;
create unique index projects_template_version_uidx on flow.projects (template_key, template_version) where deleted_at is null and template_key is not null;
create unique index projects_serves_public_uidx on flow.projects (serves_public) where deleted_at is null and serves_public;
select core.register_table('flow', 'flow', 'projects', array['name','status','notes','booking_event_id','starts_on','ends_on','cover_image','test_mode','food_menu_id','tasks_project_id','template_key','template_version','frozen','serves_public'], '{reader,editor,owner,outsider}', '{owner}', false);

update flow.projects set name = 'Barra · v1', template_key = 'barra', template_version = 1, frozen = true, serves_public = true
 where id = '0f10a000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Congelado: la configuración no cambia (ni desde el cliente ni desde un procedimiento); los datos de servicio, sí.
-- ---------------------------------------------------------------------------
create or replace function flow.guard_frozen() returns trigger language plpgsql as $$
declare v_frozen boolean;
begin
  if tg_table_name = 'projects' then
    if tg_op = 'UPDATE' and old.frozen and flow.changed(to_jsonb(old), to_jsonb(new), array['template_key','template_version','frozen']) then
      perform core.fail('FLOW_FROZEN', 409, jsonb_build_object('project_id', old.id, 'reason', 'a frozen version keeps its template'));
    end if;
    if tg_op = 'UPDATE' and not old.frozen and new.frozen is distinct from old.frozen and flow.changed(to_jsonb(old), to_jsonb(new), array['template_key','template_version']) then
      perform core.fail('FLOW_FROZEN', 409, jsonb_build_object('project_id', old.id));
    end if;
    return new;
  end if;
  select frozen into v_frozen from flow.projects where id = new.project_id;
  if coalesce(v_frozen, false) then
    perform core.fail('FLOW_FROZEN', 409, jsonb_build_object('project_id', new.project_id, 'table', 'flow.' || tg_table_name,
      'reason', 'the configuration of a frozen version does not change; create a new version'));
  end if;
  return new;
end $$;
create trigger flow_frozen before update on flow.projects for each row execute function flow.guard_frozen();
create trigger flow_frozen before insert or update on flow.columns for each row execute function flow.guard_frozen();

-- ---------------------------------------------------------------------------
-- La carta pública: el proyecto que la atiende.
-- ---------------------------------------------------------------------------
create or replace function flow.public_menu(p jsonb) returns jsonb language sql stable as $$
  with project as (
    select id, name from flow.projects where deleted_at is null and status = 'active' and serves_public order by created_at desc, id desc limit 1
  )
  select jsonb_build_object(
    'project', (select name from project),
    'projectId', (select id from project),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'scope', pr.scope, 'code', pr.code, 'name', pr.name, 'description', pr.description,
               'priceCents', pr.price_cents, 'position', pr.position, 'imageKey', pr.image_key,
               'allergens', to_jsonb(pr.allergens), 'allergensChecked', pr.allergens_checked) order by pr.scope, pr.position, pr.code)
        from flow.products pr join project on project.id = pr.project_id
       where pr.deleted_at is null and pr.active), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Nueva versión del flujo. args = { source_project_id, project_id (uuid del cliente), name? }. Solo el owner.
-- ---------------------------------------------------------------------------
create or replace function flow.new_version(p jsonb) returns jsonb language plpgsql as $$
declare
  v_src flow.projects; v_new uuid := flow.arg_uuid(p, 'project_id'); v_version int; v_name text; v_col flow.columns;
  v_prod flow.products; v_new_prod uuid; v_map jsonb := '{}'::jsonb; v_comp flow.product_components; v_rule flow.consumption_rules; v_buf flow.buffers;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a new version is for the owner')); end if;
  select * into v_src from flow.projects where id = flow.arg_uuid(p, 'source_project_id') and deleted_at is null;
  if v_src.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.projects')); end if;
  if v_src.template_key is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'the source has no template')); end if;
  select coalesce(max(template_version), 0) + 1 into v_version from flow.projects where template_key = v_src.template_key and deleted_at is null;
  v_name := coalesce(nullif(btrim(p->'args'->>'name'), ''), regexp_replace(v_src.name, '\s*·\s*v\d+$', '') || ' · v' || v_version);
  perform flow.ins(p, 'flow.projects', jsonb_build_object('name', v_name, 'status', 'active', 'notes', v_src.notes,
    'booking_event_id', v_src.booking_event_id, 'starts_on', v_src.starts_on, 'ends_on', v_src.ends_on, 'cover_image', v_src.cover_image,
    'test_mode', true, 'food_menu_id', v_src.food_menu_id, 'tasks_project_id', v_src.tasks_project_id,
    'template_key', v_src.template_key, 'template_version', v_version, 'frozen', false, 'serves_public', false), v_new);
  for v_col in select * from flow.columns where project_id = v_src.id and deleted_at is null order by position loop
    perform flow.ins(p, 'flow.columns', jsonb_build_object('project_id', v_new, 'key', v_col.key, 'label', v_col.label, 'behavior', v_col.behavior,
      'position', v_col.position, 'config', v_col.config));
  end loop;
  for v_prod in select * from flow.products where project_id = v_src.id and deleted_at is null order by scope, position loop
    v_new_prod := flow.ins(p, 'flow.products', jsonb_build_object('project_id', v_new, 'scope', v_prod.scope, 'code', v_prod.code, 'name', v_prod.name,
      'description', v_prod.description, 'price_cents', v_prod.price_cents, 'active', v_prod.active, 'prepared', v_prod.prepared, 'position', v_prod.position,
      'image_key', v_prod.image_key, 'source_line_id', v_prod.source_line_id, 'allergens', to_jsonb(v_prod.allergens), 'allergens_checked', v_prod.allergens_checked));
    v_map := v_map || jsonb_build_object(v_prod.id::text, v_new_prod);
    for v_comp in select * from flow.product_components where product_id = v_prod.id and deleted_at is null order by position loop
      perform flow.ins(p, 'flow.product_components', jsonb_build_object('product_id', v_new_prod, 'station', v_comp.station, 'ingredient', v_comp.ingredient, 'position', v_comp.position));
    end loop;
  end loop;
  for v_rule in select * from flow.consumption_rules where project_id = v_src.id and deleted_at is null loop
    if v_map ? v_rule.product_id::text then
      perform flow.ins(p, 'flow.consumption_rules', jsonb_build_object('project_id', v_new, 'product_id', (v_map->>v_rule.product_id::text)::uuid,
        'item_key', v_rule.item_key, 'name', v_rule.name, 'unit', v_rule.unit, 'per_unit', v_rule.per_unit));
    end if;
  end loop;
  -- Puntos de existencias: los mismos, vacíos.
  for v_buf in select * from flow.buffers where project_id = v_src.id and deleted_at is null loop
    perform flow.ins(p, 'flow.buffers', jsonb_build_object('project_id', v_new, 'key', v_buf.key, 'item_key', v_buf.item_key, 'name', v_buf.name,
      'unit', v_buf.unit, 'location', v_buf.location, 'capacity', v_buf.capacity, 'level', 0, 'threshold_pct', v_buf.threshold_pct));
  end loop;
  perform flow.proc_end();
  return jsonb_build_object('project_id', v_new, 'template_key', v_src.template_key, 'template_version', v_version, 'name', v_name);
end $$;
select core.allow_procedure('flow', 'flow.new_version');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
