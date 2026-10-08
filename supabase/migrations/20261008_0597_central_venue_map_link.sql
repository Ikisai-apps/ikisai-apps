-- Ikisai Central · enlace exacto del mapa del lugar (FB_2026_010). El owner pega en la Entidad la URL de Google Maps (u otro
-- mapa conocido) y manda sobre la búsqueda por dirección en {{entidad.mapa}} y en `portal_place_projection.map_url`.
-- Sin mapa embebido: los portales no cargan terceros. Toca solo el schema central.

-- https de un servicio de mapas conocido y sin espacios. La misma regla está en `_domain/central` (VENUE_MAP_URL).
alter table central.entity add column venue_map_url text check (venue_map_url is null or (char_length(venue_map_url) <= 500 and venue_map_url ~
  '^https://((www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?/maps|maps\.google\.[a-z]{2,3}(\.[a-z]{2})?/|maps\.app\.goo\.gl/|goo\.gl/maps/|(www\.)?openstreetmap\.org/|maps\.apple\.com/)[^[:space:]]*$'));

select core.register_table('central', 'central', 'entity', array['legal_name','trade_name','tax_id','address_line','postal_code','city',
  'province','country','email','phone','website','logo_file_id','iban','bizum','venue_address','site_plan_file_id','venue_map_url'],
  '{reader,editor,owner}', '{owner}');

-- {{entidad.mapa}}: el enlace exacto si lo hay; si no, la búsqueda por la dirección del lugar; nunca el domicilio fiscal.
create or replace function central.venue_map(e central.entity)
returns text language sql immutable as $$
  select coalesce(nullif(btrim(e.venue_map_url), ''), central.map_url(nullif(btrim(e.venue_address), '')));
$$;

create or replace function central.render_text(p_body text)
returns text language plpgsql stable as $$
declare e central.entity; v_mail text; v_phone text;
begin
  select * into e from central.entity where deleted_at is null limit 1;
  -- El contacto es el mismo en los dos idiomas: sale del texto en español.
  select body into v_mail from central.texts where key = 'contact.email' and lang = 'es' and deleted_at is null;
  select body into v_phone from central.texts where key = 'contact.phone' and lang = 'es' and deleted_at is null;
  return replace(replace(replace(replace(replace(replace(replace(replace(replace(p_body,
    '{{entidad.razon_social}}', coalesce(e.legal_name, '—')),
    '{{entidad.nif}}', coalesce(e.tax_id, '—')),
    '{{entidad.domicilio}}', coalesce(central.entity_address(e), '—')),
    '{{entidad.lugar}}', coalesce(nullif(btrim(e.venue_address), ''), '—')),
    '{{entidad.mapa}}', coalesce(central.venue_map(e), '—')),
    '{{entidad.iban}}', coalesce(central.format_iban(e.iban), '—')),
    '{{entidad.bizum}}', coalesce(nullif(btrim(e.bizum), ''), '—')),
    '{{contacto.correo}}', coalesce(btrim(v_mail), '—')),
    '{{contacto.telefono}}', coalesce(btrim(v_phone), '—'));
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
