-- Ikisai Central · un correo por público (decisión del usuario del 8-10-2026), editable en «Textos y contacto»:
--   organizadores (organiza@), huéspedes (ven@), trabajadores (cuida@) y proveedores (provee@). El de facturas es el correo
--   de la Entidad (lo escribe el usuario). El teléfono sigue siendo uno solo (`contact.phone`).
-- - Claves `contact.<público>.email` (tipo `contacto`, en español; el contacto es el mismo en los dos idiomas).
--   `contact.email` pasa a ser el de organizadores: se copia su valor a la clave nueva y la antigua va a la papelera.
-- - Marcadores {{contacto.organizadores}}, {{contacto.huespedes}}, {{contacto.trabajadores}} y {{contacto.proveedores}};
--   {{contacto.correo}} queda como alias del de organizadores. Los textos que lo usaban pasan al público que los lee: el aviso
--   de protección de datos y la información práctica del huésped, a {{contacto.huespedes}}; el resto, a {{contacto.organizadores}}.
-- - `central.public_contact` filtra por `p_args->>'audience'`: el correo de ese público y el teléfono.
-- Las claves con el nombre de un portal se componen por partes: el lint las tomaría por referencias a otro schema.
-- Toca solo el schema central.

create or replace function central.contact_email_key(p_audience text)
returns text language sql immutable as $$
  select 'contact.' || p_audience || '.email';
$$;

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
  return replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(p_body,
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

-- Contacto público sin sesión (C1): el correo del público pedido y el teléfono, en el idioma pedido (el inglés que falta cae al
-- español). Sin público o con uno desconocido, el de organizadores (lo que devolvía antes `contact.email`, que vale como alias
-- mientras no exista la clave nueva).
create or replace function central.public_contact(p_args jsonb)
returns jsonb language sql stable as $$
  with a as (select central.contact_email_key(case when p_args->>'audience' in ('organizers', 'guests', 'staff', 'suppliers')
                                                   then p_args->>'audience' else 'organizers' end) as email_key)
  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'title', p.title, 'body', p.body, 'version', p.version)
           order by t.position, p.key), '[]'::jsonb)
    from central.common_texts_projection p
    join central.texts t on t.key = p.key and t.lang = 'es' and t.deleted_at is null
    cross join a
   where p.kind = 'contacto'
     and p.lang = case when p_args->>'lang' in ('es', 'en') then p_args->>'lang' else 'es' end
     and (p.key in ('contact.phone', a.email_key)
          or (p.key = 'contact.email' and a.email_key = central.contact_email_key('organizers')
              and not exists (select 1 from central.texts o where o.key = a.email_key and o.lang = 'es' and o.deleted_at is null)));
$$;

-- ---------------------------------------------------------------------------
-- Semilla (mismo criterio que las otras: no duplica y solo se ejecuta si Central ya tiene miembros; las pruebas la llaman).
-- ---------------------------------------------------------------------------
create or replace function central.seed_contact_audiences()
returns int language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; s record; t central.texts; v_guest_text boolean;
begin
  -- `contact.email` → correo de organizadores. La clave no se puede cambiar (texts_forbid_rekey): se copia el valor actual a
  -- la clave nueva (primero el español, que la traducción lo necesita) y la antigua va a la papelera (primero el inglés).
  for t in select * from central.texts c where c.key = 'contact.email' and c.deleted_at is null
             and not exists (select 1 from central.texts o where o.key = central.contact_email_key('organizers') and o.lang = c.lang and o.deleted_at is null)
           order by (c.lang = 'es') desc loop
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'central.texts', 'id', gen_random_uuid(),
      'fields', jsonb_build_object('key', central.contact_email_key('organizers'), 'lang', t.lang, 'kind', t.kind, 'body', t.body, 'position', t.position,
        'title', case when t.title in ('Correo de contacto', 'Contact email') then case when t.lang = 'en' then 'Email for organisers' else 'Correo para organizadores' end else t.title end));
  end loop;
  for t in select * from central.texts c where c.key = 'contact.email' and c.deleted_at is null order by (c.lang = 'es') loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'central.texts', 'id', t.id, 'expectedRevision', t.revision);
  end loop;
  for s in select * from (values
    ('organizers', 'Correo para organizadores', 'organiza@ikisai.com', 10),
    ('guests', 'Correo para huéspedes', 'ven@ikisai.com', 11),
    ('staff', 'Correo para el equipo', 'cuida@ikisai.com', 12),
    ('suppliers', 'Correo para proveedores', 'provee@ikisai.com', 13)
  ) as x(audience, title, body, pos) loop
    if not exists (select 1 from central.texts where key = central.contact_email_key(s.audience) and lang = 'es' and deleted_at is null)
       and not (s.audience = 'organizers' and exists (select 1 from central.texts where key = 'contact.email' and lang = 'es' and deleted_at is null)) then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'central.texts', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('key', central.contact_email_key(s.audience), 'lang', 'es', 'kind', 'contacto', 'title', s.title, 'body', s.body, 'position', s.pos));
    end if;
  end loop;
  -- {{contacto.correo}} → el correo del público que lee el texto (el resto del texto no se toca).
  for t in select * from central.texts where deleted_at is null and body like '%{{contacto.correo}}%' loop
    v_guest_text := t.key = 'portal.privacy' or t.key like 'info.%' or t.key like 'guests' || '.%';
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'central.texts', 'id', t.id, 'expectedRevision', t.revision,
      'fields', jsonb_build_object('body', replace(t.body, '{{contacto.correo}}',
        case when v_guest_text then '{{contacto.huespedes}}' else '{{contacto.organizadores}}' end)));
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('central', 'migration:central-0598-contact-audiences', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;

do $$
begin
  if exists (select 1 from core.memberships where app = 'central') then perform central.seed_contact_audiences(); end if;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
