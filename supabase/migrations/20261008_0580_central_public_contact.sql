-- Ikisai Central · contacto público sin sesión (C1): lo pide la ruta del kit `GET /api/v1/public/contact?lang=` para las
-- pantallas de enlace no válido de Organizers y Guests. Solo los textos de tipo `contacto` (correo y teléfono), en el idioma
-- pedido (`es` si no es `es` ni `en`; el inglés que falta cae al español, como en la proyección), en el orden manual.
-- Nada más: ni textos legales ni datos personales. Toca solo el schema central.
-- El lint reserva `public.*` a las migraciones de Core: el envoltorio `public.central_public_contact(p_lang)` lo publica Core
-- y llama a esta función.

create or replace function central.public_contact(p_lang text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'title', p.title, 'body', p.body, 'version', p.version)
           order by t.position, p.key), '[]'::jsonb)
    from central.common_texts_projection p
    join central.texts t on t.key = p.key and t.lang = 'es' and t.deleted_at is null
   where p.kind = 'contacto'
     and p.lang = case when p_lang in ('es', 'en') then p_lang else 'es' end;
$$;

revoke all on function central.public_contact(text) from public, anon, authenticated;
grant execute on function central.public_contact(text) to service_role;
