-- Ikisai Central · fases 4 y 5 de los portales (X3 de Organizers y CE3 de Guests): el lugar y sus textos.
-- - Dirección del lugar de los retiros (`venue_address`), distinta del domicilio fiscal: los portales nunca ven la fiscal
--   (Ikisai puede ser un autónomo con domicilio en su casa). Si falta, los portales no muestran dirección ni mapa.
-- - Plano del centro como archivo de la Entidad (`site_plan_file_id`), servido a Guests y Organizers con C8
--   (`core.allow_portal_file`).
-- - Marcadores {{entidad.lugar}} y {{entidad.mapa}} (enlace a un mapa externo con la dirección del lugar, sin coordenadas).
-- - Proyección mínima del lugar para Organizers (cartel) y Guests (plano e información).
-- - Textos `portal.menu_note`, `portal.practical`, `guests.menu_notice` e `info.map_link` (borradores de Central), y
--   `info.arrival` pasa de {{entidad.domicilio}} a {{entidad.lugar}}.
-- Toca solo el schema central.

-- ---------------------------------------------------------------------------
-- Dirección del lugar (texto libre en una línea) y plano (imagen o PDF de Central, verificado; retención permanente).
-- ---------------------------------------------------------------------------
alter table central.entity add column venue_address text check (venue_address is null or char_length(venue_address) between 3 and 300);
alter table central.entity add column site_plan_file_id uuid;

select core.register_table('central', 'central', 'entity', array['legal_name','trade_name','tax_id','address_line','postal_code','city',
  'province','country','email','phone','website','logo_file_id','iban','bizum','venue_address','site_plan_file_id'], '{reader,editor,owner}', '{owner}');
select core.register_file_field('central', 'central', 'entity', 'site_plan_file_id', 'permanent');

-- ---------------------------------------------------------------------------
-- Domicilio fiscal en una línea (para {{entidad.domicilio}}: textos legales y facturas) y enlace de mapa (búsqueda por la
-- dirección del lugar en un mapa externo; el owner puede sustituirlo por el enlace exacto en el texto `info.map_link`).
-- ---------------------------------------------------------------------------
create or replace function central.entity_address(e central.entity)
returns text language sql immutable as $$
  select nullif(concat_ws(', ', e.address_line, nullif(btrim(concat_ws(' ', e.postal_code, e.city)), ''), e.province,
    case when e.country is not null and e.country <> 'ES' then e.country end), '');
$$;

-- Codificación mínima para la consulta del enlace: espacios, comas y los caracteres que rompen una URL.
create or replace function central.map_url(p_address text)
returns text language sql immutable as $$
  select case when nullif(btrim(coalesce(p_address, '')), '') is null then null
    else 'https://www.google.com/maps/search/?api=1&query=' ||
      replace(replace(replace(replace(replace(replace(btrim(p_address), '%', '%25'), ' ', '+'), ',', '%2C'), '&', '%26'), '#', '%23'), '/', '%2F')
  end;
$$;

create or replace function central.render_text(p_body text)
returns text language plpgsql stable as $$
declare e central.entity; v_mail text; v_phone text; v_venue text;
begin
  select * into e from central.entity where deleted_at is null limit 1;
  -- El contacto es el mismo en los dos idiomas: sale del texto en español.
  select body into v_mail from central.texts where key = 'contact.email' and lang = 'es' and deleted_at is null;
  select body into v_phone from central.texts where key = 'contact.phone' and lang = 'es' and deleted_at is null;
  v_venue := nullif(btrim(e.venue_address), '');
  return replace(replace(replace(replace(replace(replace(replace(replace(replace(p_body,
    '{{entidad.razon_social}}', coalesce(e.legal_name, '—')),
    '{{entidad.nif}}', coalesce(e.tax_id, '—')),
    '{{entidad.domicilio}}', coalesce(central.entity_address(e), '—')),
    '{{entidad.lugar}}', coalesce(v_venue, '—')),
    '{{entidad.mapa}}', coalesce(central.map_url(v_venue), '—')),
    '{{entidad.iban}}', coalesce(central.format_iban(e.iban), '—')),
    '{{entidad.bizum}}', coalesce(nullif(btrim(e.bizum), ''), '—')),
    '{{contacto.correo}}', coalesce(btrim(v_mail), '—')),
    '{{contacto.telefono}}', coalesce(btrim(v_phone), '—'));
end $$;

-- ---------------------------------------------------------------------------
-- El lugar para los portales: nombre, dirección del lugar (cartel de Organizers), enlace del mapa y plano. Sin domicilio
-- fiscal ni datos bancarios. `map_url`: el texto `info.map_link` ya sustituido (por defecto, la búsqueda por la dirección del
-- lugar); sin dirección del lugar ni enlace propio, null.
-- ---------------------------------------------------------------------------
create view central.portal_place_projection as
select e.id as entity_id, coalesce(nullif(btrim(e.trade_name), ''), e.legal_name) as name, nullif(btrim(e.venue_address), '') as address,
       nullif(btrim(central.render_text(coalesce(m.body, '{{entidad.mapa}}'))), '—') as map_url,
       f.id as site_plan_file_id, f.mime as site_plan_mime, f.size as site_plan_size, e.revision as entity_revision, e.updated_at
  from central.entity e
  left join central.texts m on m.key = 'info.map_link' and m.lang = 'es' and m.deleted_at is null
  left join core.files f on f.id = e.site_plan_file_id and f.app = 'central' and f.status = 'verified'
 where e.deleted_at is null;

revoke all on central.portal_place_projection from public, anon, authenticated;
grant select on central.portal_place_projection to service_role;
select core.allow_read('central', 'central.portal_place_projection', 'view');
select core.allow_read('organizers', 'central.portal_place_projection', 'view');
select core.allow_read('guests', 'central.portal_place_projection', 'view');

-- ---------------------------------------------------------------------------
-- C8: el plano se sirve a los portales con `GET /api/v1/portal-files/:fileId`. Lo ve cualquier miembro del portal, pero solo
-- el plano vigente de la Entidad: ni otro archivo de Central ni un plano anterior.
-- ---------------------------------------------------------------------------
create or replace function central.site_plan_file(p_ctx jsonb)
returns boolean language sql stable as $$
  select exists (select 1 from central.entity e
                  where e.deleted_at is null and e.site_plan_file_id is not null
                    and e.site_plan_file_id::text = p_ctx->>'file_id');
$$;

select core.allow_portal_file('guests', 'central.site_plan_file');
select core.allow_portal_file('organizers', 'central.site_plan_file');

-- ---------------------------------------------------------------------------
-- Textos (borradores de Central; los revisa el usuario). Mismo criterio que las otras semillas.
-- Las claves «guests.…» se componen por partes: el lint las tomaría por referencias a otro schema.
-- `info.arrival` (semilla de 0570) usaba el domicilio fiscal: se cambia el marcador por el del lugar, sin tocar el resto del
-- texto (si el owner ya lo ha editado, se respeta lo demás).
-- ---------------------------------------------------------------------------
create or replace function central.seed_texts_portal_place()
returns int language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; s record; t central.texts;
begin
  for s in select * from (values
    ('portal.menu_note', 'es', 'mensaje', 'Aviso sobre el menú', 'El menú puede cambiar para adaptarse a alergias e intolerancias.', 36),
    ('portal.menu_note', 'en', 'mensaje', 'Note about the menu', 'The menu may change to accommodate allergies and intolerances.', 36),
    ('portal.practical', 'es', 'info', 'Información práctica', E'**Antes del retiro:** cada asistente recibe en su enlace personal la información para llegar y estar (llegada, qué traer, convivencia).\n\n**Durante el retiro:** el equipo de Ikisai atiende lo que necesite el grupo en el {{contacto.telefono}}.\n\n**Dónde:** {{entidad.lugar}}.', 37),
    ('portal.practical', 'en', 'info', 'Practical information', E'**Before the retreat:** each attendee receives, through their personal link, the information they need for getting here and their stay (arrival, what to bring, house rules).\n\n**During the retreat:** the Ikisai team is available for anything the group needs on {{contacto.telefono}}.\n\n**Where:** {{entidad.lugar}}.', 37),
    ('guests' || '.menu_notice', 'es', 'mensaje', 'Sobre el menú', 'El menú puede cambiar para adaptarse a las alergias e intolerancias del grupo. Si tienes alguna, comprueba que la has indicado en tus datos.', 75),
    ('guests' || '.menu_notice', 'en', 'mensaje', 'About the menu', 'The menu may change to accommodate the group''s allergies and intolerances. If you have any, please check that you have included them in your details.', 75),
    ('info.map_link', 'es', 'info', 'Cómo llegar (mapa)', '{{entidad.mapa}}', 99)
  ) as x(key, lang, kind, title, body, pos) loop
    if not exists (select 1 from central.texts where key = s.key and lang = s.lang and deleted_at is null) then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'central.texts', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('key', s.key, 'lang', s.lang, 'kind', s.kind, 'title', s.title, 'body', s.body, 'position', s.pos));
    end if;
  end loop;
  for t in select * from central.texts where key = 'info.arrival' and deleted_at is null and body like '%{{entidad.domicilio}}%' loop
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'central.texts', 'id', t.id, 'expectedRevision', t.revision,
      'fields', jsonb_build_object('body', replace(t.body, '{{entidad.domicilio}}', '{{entidad.lugar}}')));
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('central', 'migration:central-0596-portal-place', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;

do $$
begin
  if exists (select 1 from core.memberships where app = 'central') then perform central.seed_texts_portal_place(); end if;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
