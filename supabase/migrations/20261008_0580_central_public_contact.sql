-- Ikisai Central · contacto público sin sesión (C1): la Edge lo sirve en `GET /api/v1/public/contact?lang=` (lecturas
-- públicas del núcleo, `core.public_read`, migración 0079) para las pantallas de enlace no válido de Organizers y Guests.
-- Solo los textos de tipo `contacto` (correo y teléfono), en el idioma pedido (`es` si no es `es` ni `en`; el inglés que falta
-- cae al español, como en la proyección), en el orden manual. Nada más: ni textos legales ni datos personales.
-- Toca solo el schema central. Va después de 20261008_0079 (las migraciones se aplican por nombre de archivo).

create or replace function central.public_contact(p_args jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'title', p.title, 'body', p.body, 'version', p.version)
           order by t.position, p.key), '[]'::jsonb)
    from central.common_texts_projection p
    join central.texts t on t.key = p.key and t.lang = 'es' and t.deleted_at is null
   where p.kind = 'contacto'
     and p.lang = case when p_args->>'lang' in ('es', 'en') then p_args->>'lang' else 'es' end;
$$;

revoke all on function central.public_contact(jsonb) from public, anon, authenticated;
grant execute on function central.public_contact(jsonb) to service_role;

select core.allow_public_read('contact', 'central.public_contact');
