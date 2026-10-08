-- Ikisai Central · decisión del usuario del 8-10-2026: la protección de datos de los huéspedes (`portal.privacy`, es y en)
-- identifica al responsable solo con su nombre y el contacto, sin NIF ni domicilio fiscal. Las facturas y los documentos
-- fiscales no cambian ({{entidad.nif}} y {{entidad.domicilio}} siguen existiendo para ellos).
-- Mismo criterio que 0599: solo si nadie lo ha editado a mano en la app (todas sus versiones con `updated_by` nulo) y si
-- la línea sigue como la dejó la semilla; si no, se respeta y se avisa. Toca solo el schema central.

create or replace function central.apply_privacy_controller()
returns jsonb language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; v_skipped text[] := '{}'; v_left text[]; t central.texts; v_body text;
begin
  for t in select * from central.texts where key = 'portal.privacy' and deleted_at is null order by lang desc loop
    v_body := case t.lang
      when 'es' then replace(t.body, ' (NIF {{entidad.nif}}), {{entidad.domicilio}}. Contacto:', '. Contacto:')
      when 'en' then replace(t.body, ' (Tax ID {{entidad.nif}}), {{entidad.domicilio}}. Contact:', '. Contact:')
      else t.body end;
    if position('{{entidad.nif}}' in t.body) = 0 and position('{{entidad.domicilio}}' in t.body) = 0 then continue; end if;
    if v_body = t.body or t.updated_by is not null
       or exists (select 1 from central.text_versions v where v.text_id = t.id and v.updated_by is not null) then
      v_skipped := v_skipped || (t.key || ':' || t.lang);
      continue;
    end if;
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'central.texts', 'id', t.id, 'expectedRevision', t.revision,
      'fields', jsonb_build_object('body', v_body));
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('central', 'migration:central-1501-privacy-controller', v_ops);
  end if;
  if array_length(v_skipped, 1) > 0 then
    raise notice 'central 1501: portal.privacy sin cambiar (editado a mano o con otra redacción): %', array_to_string(v_skipped, ', ');
  end if;
  -- Ningún otro texto de los portales debería llevar NIF ni domicilio fiscal: si alguno los lleva, se avisa (no se toca).
  select array_agg(distinct key order by key) into v_left from central.texts
   where deleted_at is null and key <> 'portal.privacy' and (body like '%{{entidad.nif}}%' or body like '%{{entidad.domicilio}}%');
  if v_left is not null then
    raise notice 'central 1501: textos con NIF o domicilio fiscal (revisar si los ven los portales): %', array_to_string(v_left, ', ');
  end if;
  return jsonb_build_object('applied', jsonb_array_length(v_ops), 'skipped', to_jsonb(v_skipped), 'others', to_jsonb(coalesce(v_left, '{}')));
end $$;

do $$
begin
  if exists (select 1 from core.memberships where app = 'central') then perform central.apply_privacy_controller(); end if;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
