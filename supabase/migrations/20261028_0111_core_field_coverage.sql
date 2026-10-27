-- 0111 · Cobertura de campos (traspaso §11.9; análisis de UI-kit en MUELA/equipo/feedback/ui-kit/COBERTURA_INPUTS_FLUJOS.md;
-- decisiones de VG del 27-10: duplicado = mismo entity.prop; la utilidad la declara Dirección en Central; «sin datos» pesa más
-- que «inútil»). Dos piezas:
--   A. Cada capacidad del catálogo (0097) declara qué `entity.prop` lee (`reads`) y escribe (`writes`). Sin eso no hay cobertura
--      indirecta: un paso de Flow que usa la capacidad cubre esos campos aunque no los pinte.
--   B. `core.field_coverage(actor, app?)`: para editores y owners, cada campo del inventario (0100) con las capacidades que lo
--      leen o escriben, si tiene uso propio (catálogo de uso, 0071), sus duplicados (mismo entity.prop) y una clase parcial:
--      `indirect` (alguna capacidad lo toca), `independent` (uso propio y ninguna capacidad), `unknown` (sin entity/prop o sin
--      datos). Las clases `direct` y `automatic` las pone quien lee (Central) cruzando con los anclajes de los pasos y las reglas
--      de Flow, que son datos de Flow y no del núcleo. Solo metadatos: nunca valores ni `raw`.

-- A --------------------------------------------------------------------------------------------------------------------------
alter table core.capabilities add column if not exists reads text[] not null default '{}';
alter table core.capabilities add column if not exists writes text[] not null default '{}';

create or replace function core.register_capability(p jsonb) returns void language plpgsql as $$
begin
  if split_part(p->>'id', '.', 1) <> (p->>'app') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'capability id must start with its app', 'id', p->>'id'));
  end if;
  insert into core.capabilities (id, app, version, kind, title, description, route, roles, risk, idempotent, reversible, input_schema, output_schema, anchors, since, reads, writes)
  values (p->>'id', p->>'app', coalesce((p->>'version')::int, 1), coalesce(p->>'kind', 'execute'), p->>'title', coalesce(p->>'description', ''), p->>'route',
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'roles', '["editor","owner"]'::jsonb)) x), '{editor,owner}'),
          coalesce(p->>'risk', 'low'), coalesce((p->>'idempotent')::boolean, false), coalesce((p->>'reversible')::boolean, false),
          coalesce(p->'input', '{}'::jsonb), coalesce(p->'output', '{}'::jsonb), coalesce(p->'anchors', '[]'::jsonb), p->>'since',
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'reads', '[]'::jsonb)) x), '{}'),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'writes', '[]'::jsonb)) x), '{}'))
  on conflict (id) do update set version = excluded.version, kind = excluded.kind, title = excluded.title, description = excluded.description,
    route = excluded.route, roles = excluded.roles, risk = excluded.risk, idempotent = excluded.idempotent, reversible = excluded.reversible,
    input_schema = excluded.input_schema, output_schema = excluded.output_schema, anchors = excluded.anchors, since = coalesce(core.capabilities.since, excluded.since),
    reads = excluded.reads, writes = excluded.writes, deprecated_at = null, updated_at = now();
end $$;

-- B --------------------------------------------------------------------------------------------------------------------------
create or replace function core.field_coverage(p_actor uuid, p_app text default null, p_duplicates text default 'exact')
returns jsonb language plpgsql stable as $$
begin
  -- p_duplicates: 'exact' (mismo entity.prop; decisión de VG del 27-10) o 'label' (además, misma etiqueta normalizada en la misma
  -- app), preparado para ampliar cuando el ruido de los exactos sea mínimo.
  if p_duplicates not in ('exact', 'label') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'duplicates mode must be exact or label'));
  end if;
  if p_actor is null or not exists (select 1 from core.memberships m where m.user_id = p_actor and m.role in ('editor', 'owner')) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'field coverage is for editors and owners'));
  end if;
  return jsonb_build_object(
    'fields', coalesce((
      select jsonb_agg(row_to_json(r)::jsonb order by r."app", r."fieldId") from (
        select f.field_id as "fieldId", f.app, f.screen, f.route, f.anchor_id as "anchorId", f.label, f.type, f.entity, f.prop,
               f.sensitivity, f.required, f.last_seen as "lastSeen",
               -- capacidades vivas que leen o escriben este entity.prop
               coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'app', c.app, 'kind', c.kind,
                           'how', case when (f.entity || '.' || f.prop) = any (c.writes) then 'writes' else 'reads' end) order by c.id)
                  from core.capabilities c
                 where c.deprecated_at is null and f.entity is not null and f.prop is not null
                   and ((f.entity || '.' || f.prop) = any (c.reads) or (f.entity || '.' || f.prop) = any (c.writes))), '[]'::jsonb) as capabilities,
               -- uso propio: una funcionalidad del catálogo de uso con el mismo id (o un hijo) vista en alguna versión
               exists (select 1 from core.usage_features u where u.app = f.app and (u.feature_id = f.field_id or u.feature_id like f.field_id || '.%')
                         and (u.catalogued or u.last_seen_release is not null)) as used,
               -- duplicados: otros campos activos con el mismo entity.prop (decisión de VG: solo por entity.prop)
               coalesce((select jsonb_agg(g.field_id order by g.field_id) from core.field_inventory g
                  where g.active and g.field_id <> f.field_id
                    and ((f.entity is not null and f.prop is not null and g.entity = f.entity and g.prop = f.prop)
                         or (p_duplicates = 'label' and g.app = f.app and f.label is not null and lower(trim(g.label)) = lower(trim(f.label))))), '[]'::jsonb) as duplicates,
               case
                 when f.entity is null or f.prop is null then 'unknown'
                 when exists (select 1 from core.capabilities c where c.deprecated_at is null
                                and ((f.entity || '.' || f.prop) = any (c.reads) or (f.entity || '.' || f.prop) = any (c.writes))) then 'indirect'
                 when exists (select 1 from core.usage_features u where u.app = f.app and (u.feature_id = f.field_id or u.feature_id like f.field_id || '.%')
                                and (u.catalogued or u.last_seen_release is not null)) then 'independent'
                 else 'unknown'
               end as class
          from core.field_inventory f
         where f.active and (p_app is null or f.app = p_app)
         limit 5000
      ) r), '[]'::jsonb),
    'capabilities', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'app', c.app, 'kind', c.kind, 'title', c.title, 'reads', to_jsonb(c.reads), 'writes', to_jsonb(c.writes), 'anchors', c.anchors) order by c.id)
                               from core.capabilities c where c.deprecated_at is null and (p_app is null or c.app = p_app)), '[]'::jsonb),
    'declared', jsonb_build_object(
      'fields', (select count(*) from core.field_inventory f where f.active and (p_app is null or f.app = p_app)),
      'withEntityProp', (select count(*) from core.field_inventory f where f.active and f.entity is not null and f.prop is not null and (p_app is null or f.app = p_app)),
      'capabilitiesWithReadsWrites', (select count(*) from core.capabilities c where c.deprecated_at is null and (cardinality(c.reads) > 0 or cardinality(c.writes) > 0) and (p_app is null or c.app = p_app))));
end $$;

create or replace function public.core_field_coverage(p_actor uuid, p_app text default null, p_duplicates text default 'exact') returns jsonb
language sql stable security definer set search_path = '' as $$ select core.field_coverage(p_actor, p_app, p_duplicates) $$;
revoke all on function core.field_coverage(uuid, text, text), public.core_field_coverage(uuid, text, text) from public, anon, authenticated;
grant execute on function public.core_field_coverage(uuid, text, text) to service_role;
