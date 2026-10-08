-- Ikisai Central · bloque condicional {{#entidad.bizum}}…{{/entidad.bizum}} (respuesta de Core del 8-10-2026). Lo de dentro solo
-- se ve si la Entidad tiene Bizum; si no, el bloque desaparece entero, sin dejar líneas vacías. Igual en `renderMarkers`
-- (`_domain/central/texts.ts`) para la vista previa. `payment.instructions` vuelve a llevar el Bizum, dentro del bloque.
-- Primera migración del segundo bloque de Central (1500–1599). Toca solo el schema central.

-- Bloques condicionales: con valor, se quitan las marcas; sin valor, se quita el bloque y los saltos de línea que lo
-- separaban del texto anterior (o, si va al principio, los que lo separaban del siguiente).
create or replace function central.render_blocks(p_body text, p_has_bizum boolean)
returns text language plpgsql immutable as $$
declare v text;
begin
  if p_body is null or position('{{#entidad.bizum}}' in p_body) = 0 then return p_body; end if;
  if p_has_bizum then
    return regexp_replace(p_body, '\{\{#entidad\.bizum\}\}(.*?)\{\{/entidad\.bizum\}\}', '\1', 'g');
  end if;
  v := regexp_replace(p_body, '\{\{#entidad\.bizum\}\}(.*?)\{\{/entidad\.bizum\}\}', chr(1), 'g');
  v := regexp_replace(v, E'\n*' || chr(1), '', 'g');
  return regexp_replace(v, E'^\n+', '');
end $$;

create or replace function central.render_text(p_body text)
returns text language plpgsql stable as $$
declare e central.entity; v_phone text; v_org text; v_guests text; v_staff text; v_suppliers text;
begin
  select * into e from central.entity where deleted_at is null limit 1;
  -- El contacto es el mismo en los dos idiomas: sale del texto en español.
  select body into v_phone from central.texts where key = 'contact.phone' and lang = 'es' and deleted_at is null;
  select body into v_org from central.texts where key = central.contact_email_key('organizers') and lang = 'es' and deleted_at is null;
  -- Alias: mientras no se haya sembrado el de organizadores, vale el antiguo `contact.email`.
  if v_org is null then select body into v_org from central.texts where key = 'contact.email' and lang = 'es' and deleted_at is null; end if;
  select body into v_guests from central.texts where key = central.contact_email_key('guests') and lang = 'es' and deleted_at is null;
  select body into v_staff from central.texts where key = central.contact_email_key('staff') and lang = 'es' and deleted_at is null;
  select body into v_suppliers from central.texts where key = central.contact_email_key('suppliers') and lang = 'es' and deleted_at is null;
  return replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    central.render_blocks(p_body, nullif(btrim(e.bizum), '') is not null),
    '{{entidad.razon_social}}', coalesce(e.legal_name, '—')),
    '{{entidad.nif}}', coalesce(e.tax_id, '—')),
    '{{entidad.domicilio}}', coalesce(central.entity_address(e), '—')),
    '{{entidad.lugar}}', coalesce(nullif(btrim(e.venue_address), ''), '—')),
    '{{entidad.mapa}}', coalesce(central.venue_map(e), '—')),
    '{{entidad.iban}}', coalesce(central.format_iban(e.iban), '—')),
    '{{entidad.bizum}}', coalesce(nullif(btrim(e.bizum), ''), '—')),
    '{{contacto.correo}}', coalesce(btrim(v_org), '—')),
    '{{contacto.organizadores}}', coalesce(btrim(v_org), '—')),
    '{{contacto.huespedes}}', coalesce(btrim(v_guests), '—')),
    '{{contacto.trabajadores}}', coalesce(btrim(v_staff), '—')),
    '{{contacto.proveedores}}', coalesce(btrim(v_suppliers), '—')),
    '{{contacto.telefono}}', coalesce(btrim(v_phone), '—'));
end $$;

-- ---------------------------------------------------------------------------
-- `payment.instructions`: el Bizum vuelve, dentro del bloque. Mismo criterio que 0599: solo si nadie lo ha editado a mano
-- (todas sus versiones con `updated_by` nulo) y si el texto sigue teniendo el párrafo donde va; si no, se respeta y se avisa.
-- ---------------------------------------------------------------------------
create or replace function central.apply_payment_bizum_block()
returns jsonb language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; v_skipped text[] := '{}'; t central.texts; v_body text;
begin
  for t in select * from central.texts where key = 'payment.instructions' and deleted_at is null order by lang loop
    if position('{{#entidad.bizum}}' in t.body) > 0 then continue; end if;
    v_body := case t.lang
      when 'es' then replace(t.body, E'\n\nSi tienes cualquier duda',
        E'\n\n{{#entidad.bizum}}**Por Bizum:** al {{entidad.bizum}}, con el mismo concepto.{{/entidad.bizum}}\n\nSi tienes cualquier duda')
      when 'en' then replace(t.body, '**By Bizum** (Spanish mobile payments) to {{entidad.bizum}}, with the same reference.',
        '{{#entidad.bizum}}**By Bizum** (Spanish mobile payments) to {{entidad.bizum}}, with the same reference.{{/entidad.bizum}}')
      else t.body end;
    if v_body = t.body or t.updated_by is not null
       or exists (select 1 from central.text_versions v where v.text_id = t.id and v.updated_by is not null) then
      v_skipped := v_skipped || (t.key || ':' || t.lang);
      continue;
    end if;
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'central.texts', 'id', t.id, 'expectedRevision', t.revision,
      'fields', jsonb_build_object('body', v_body));
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('central', 'migration:central-1500-bizum-block', v_ops);
  end if;
  if array_length(v_skipped, 1) > 0 then
    raise notice 'central 1500: payment.instructions sin cambiar (editado a mano o sin el párrafo esperado): %', array_to_string(v_skipped, ', ');
  end if;
  return jsonb_build_object('applied', jsonb_array_length(v_ops), 'skipped', to_jsonb(v_skipped));
end $$;

do $$
begin
  if exists (select 1 from core.memberships where app = 'central') then perform central.apply_payment_bizum_block(); end if;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
