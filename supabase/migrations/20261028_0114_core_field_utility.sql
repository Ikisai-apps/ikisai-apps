-- 0114 · Utilidad de los campos sin decidir campo a campo (VG, 27-10 noche: «4500 cosas que analizar… esto tenemos que resolverlo
-- automáticamente»). `core.field_coverage` añade a cada campo: `estimate` (frecuencia y audiencia heredadas de la funcionalidad más
-- cercana del catálogo de uso o del estimado de la app, 0113), `activations30d` (uso real en producción) y `candidate` (verdadero
-- solo si no lo cubre Flow ni una capacidad, no se ha usado en 30 días, no es obligatorio y ningún estimado lo protege). El Revisor
-- de Central enseña por defecto solo los candidatos agrupados por pantalla, y la decisión de Dirección es por grupo.
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
      select jsonb_agg(row_to_json(q)::jsonb order by q."app", q."fieldId") from (
        -- candidato a revisar: sin cobertura de Flow ni capacidad, sin uso en 30 días, no obligatorio y sin un estimado que lo proteja
        select r.*, (r.class in ('unknown', 'independent') and r."activations30d" = 0 and coalesce(lower(r.required), '') not in ('true', 'yes', 'si', 'sí', 'required', '1')
                     and jsonb_array_length(r.capabilities) = 0
                     and coalesce(r.estimate->>'frequency', '') not in ('rare_critical', 'do_not_evaluate')) as candidate
        from (
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
               -- utilidad heredada (decisión de VG del 27-10: nada campo a campo): el estimado o la decisión de la funcionalidad
               -- más cercana en el catálogo de uso (el propio campo, su pantalla o su app); si aún no está en el catálogo, el estimado guardado
               coalesce(
                 (select jsonb_build_object('featureId', u.feature_id, 'frequency', u.frequency, 'audience', u.audience, 'decided', u.decided_at is not null)
                    from core.usage_features u where u.app = f.app and (u.feature_id = f.field_id or f.field_id like u.feature_id || '.%')
                    order by length(u.feature_id) desc limit 1),
                 (select jsonb_build_object('featureId', e.feature_id, 'frequency', e.frequency, 'audience', e.audience, 'decided', false)
                    from core.usage_estimates e where e.app = f.app and (e.feature_id = f.field_id or f.field_id like e.feature_id || '.%')
                    order by length(e.feature_id) desc limit 1)) as estimate,
               -- uso real: activaciones en producción en los últimos 30 días del campo o de sus hijos
               coalesce((select sum(d.activations)::int from core.usage_daily d where d.context = 'production' and d.day >= current_date - 30
                  and (d.feature_id = f.field_id or d.feature_id like f.field_id || '.%')), 0) as "activations30d",
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
      ) r) q), '[]'::jsonb),
    'capabilities', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'app', c.app, 'kind', c.kind, 'title', c.title, 'reads', to_jsonb(c.reads), 'writes', to_jsonb(c.writes), 'anchors', c.anchors) order by c.id)
                               from core.capabilities c where c.deprecated_at is null and (p_app is null or c.app = p_app)), '[]'::jsonb),
    'declared', jsonb_build_object(
      'fields', (select count(*) from core.field_inventory f where f.active and (p_app is null or f.app = p_app)),
      'withEntityProp', (select count(*) from core.field_inventory f where f.active and f.entity is not null and f.prop is not null and (p_app is null or f.app = p_app)),
      'capabilitiesWithReadsWrites', (select count(*) from core.capabilities c where c.deprecated_at is null and (cardinality(c.reads) > 0 or cardinality(c.writes) > 0) and (p_app is null or c.app = p_app))));
end $$;
