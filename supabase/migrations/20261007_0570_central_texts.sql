-- Ikisai Central · «Textos y contacto» (decisión del usuario, 7-10-2026): los textos legales, avisos, declaraciones y datos de
-- contacto que ven las personas y los portales se editan siempre desde Central, nunca fijos en el código.
-- Por idioma (portales bilingües, PORTALES_V2.md): `es` obligatorio y `en` opcional, que cae a `es` si falta.
-- Referencia: docs/central/API.md §2.12. Toca solo el schema central.

-- ---------------------------------------------------------------------------
-- Textos (sincronizados): escribe solo el owner, leen todos los miembros.
-- Tipos: `legal`, `mensaje`, `contacto` e `info` (información práctica de los portales).
-- `version` la lleva el servidor: `v1` al crear y sube (`v2`, `v3`…) cuando cambia el título o el cuerpo.
-- ---------------------------------------------------------------------------
create table central.texts (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  key text not null check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$' and length(key) <= 60),
  title text not null check (length(btrim(title)) between 1 and 160),
  body text not null check (length(body) between 1 and 8000),
  version text not null default 'v1' check (version ~ '^v[1-9][0-9]{0,4}$'),
  kind text not null check (kind in ('legal','mensaje','contacto','info')),
  lang text not null default 'es' check (lang in ('es','en')),
  position numeric not null default 0
);
create unique index texts_key_idx on central.texts (key, lang) where deleted_at is null;
create trigger texts_forbid_rekey before update on central.texts for each row execute function central.forbid_reparent('key');
create trigger texts_forbid_relang before update on central.texts for each row execute function central.forbid_reparent('lang');

select core.register_table('central', 'central', 'texts', array['key','title','body','kind','lang','position'], '{reader,editor,owner}', '{owner}');

-- Un texto en inglés necesita su texto en español (el que se usa cuando falta una traducción).
create or replace function central.check_texts(p jsonb)
returns void language plpgsql as $$
declare v_key text;
begin
  select t.key into v_key from central.texts t
   where t.deleted_at is null and t.lang <> 'es'
     and not exists (select 1 from central.texts b where b.key = t.key and b.lang = 'es' and b.deleted_at is null) limit 1;
  if v_key is not null then perform core.fail('MISSING_BASE_LANGUAGE', 422, jsonb_build_object('key', v_key)); end if;
  select t.key into v_key from central.texts t join central.texts b on b.key = t.key and b.lang = 'es' and b.deleted_at is null
   where t.deleted_at is null and t.kind <> b.kind limit 1;
  if v_key is not null then perform core.fail('KIND_MISMATCH', 422, jsonb_build_object('key', v_key)); end if;
end $$;
select core.add_validate_hook('central', 'central.check_texts');

-- ---------------------------------------------------------------------------
-- Versiones guardadas (tabla cerrada: solo la escribe el disparador y se lee con `central.text_version`).
-- Guarda el cuerpo tal como se escribió y ya con los marcadores sustituidos en ese momento: una declaración aceptada se
-- muestra exactamente como se aceptó, aunque después cambien la Entidad o el contacto.
-- ---------------------------------------------------------------------------
create table central.text_versions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  text_id uuid not null references central.texts(id),
  key text not null,
  lang text not null,
  version text not null,
  kind text not null,
  title text not null,
  body text not null,
  rendered_body text not null
);
create unique index text_versions_key_idx on central.text_versions (key, lang, version);

select core.register_table('central', 'central', 'text_versions', array[]::text[], '{}', '{}');

-- Marcadores: {{entidad.razon_social}}, {{entidad.nif}}, {{entidad.domicilio}}, {{contacto.correo}}, {{contacto.telefono}}.
-- Lo que falta se escribe «—» (la Entidad o el contacto aún sin rellenar).
create or replace function central.render_text(p_body text)
returns text language plpgsql stable as $$
declare e central.entity; v_mail text; v_phone text; v_address text;
begin
  select * into e from central.entity where deleted_at is null limit 1;
  -- El contacto es el mismo en los dos idiomas: sale del texto en español.
  select body into v_mail from central.texts where key = 'contact.email' and lang = 'es' and deleted_at is null;
  select body into v_phone from central.texts where key = 'contact.phone' and lang = 'es' and deleted_at is null;
  v_address := nullif(concat_ws(', ', e.address_line, nullif(btrim(concat_ws(' ', e.postal_code, e.city)), ''), e.province,
    case when e.country is not null and e.country <> 'ES' then e.country end), '');
  return replace(replace(replace(replace(replace(p_body,
    '{{entidad.razon_social}}', coalesce(e.legal_name, '—')),
    '{{entidad.nif}}', coalesce(e.tax_id, '—')),
    '{{entidad.domicilio}}', coalesce(v_address, '—')),
    '{{contacto.correo}}', coalesce(btrim(v_mail), '—')),
    '{{contacto.telefono}}', coalesce(btrim(v_phone), '—'));
end $$;

-- Versión: sube al cambiar título o cuerpo (antes de guardar) y se archiva (después de guardar).
create or replace function central.bump_text_version()
returns trigger language plpgsql as $$
begin
  if new.title is distinct from old.title or new.body is distinct from old.body or new.kind is distinct from old.kind then
    new.version := 'v' || (coalesce(substring(old.version from '^v([0-9]+)$')::int, 1) + 1);
  else
    new.version := old.version;
  end if;
  return new;
end $$;
create trigger texts_version before update on central.texts for each row execute function central.bump_text_version();

create or replace function central.archive_text_version()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.version is distinct from old.version then
    insert into central.text_versions (text_id, key, lang, version, kind, title, body, rendered_body, updated_by)
    values (new.id, new.key, new.lang, new.version, new.kind, new.title, new.body, central.render_text(new.body), new.updated_by)
    on conflict (key, lang, version) do nothing;
  end if;
  return null;
end $$;
create trigger texts_archive after insert or update on central.texts for each row execute function central.archive_text_version();

-- ---------------------------------------------------------------------------
-- Proyección para los portales y Booking: textos vivos ya con los marcadores sustituidos. Sin datos personales.
-- ---------------------------------------------------------------------------
-- Una fila por clave y por idioma (`es`, `en`). Si falta el inglés, la fila `en` trae el texto en español con
-- `fallback = true` y `source_lang = 'es'`: quien guarde una aceptación guarda `source_lang` y `version`.
create view central.common_texts_projection as
select b.key, l.lang, coalesce(t.title, b.title) as title, central.render_text(coalesce(t.body, b.body)) as body,
       coalesce(t.version, b.version) as version, b.kind, coalesce(t.updated_at, b.updated_at) as updated_at,
       coalesce(t.lang, b.lang) as source_lang, (t.id is null and l.lang <> b.lang) as fallback
  from central.texts b
  cross join (values ('es'), ('en')) as l(lang)
  left join central.texts t on t.key = b.key and t.lang = l.lang and t.deleted_at is null
 where b.deleted_at is null and b.lang = 'es';

revoke all on central.common_texts_projection from public, anon, authenticated;
grant select on central.common_texts_projection to service_role;
select core.allow_read('central', 'central.common_texts_projection', 'view');
select core.allow_read('organizers', 'central.common_texts_projection', 'view');
select core.allow_read('guests', 'central.common_texts_projection', 'view');
select core.allow_read('booking', 'central.common_texts_projection', 'view');

-- Una versión concreta tal como se guardó (`args: {key, lang?, version?}`; `lang` por defecto `es`; sin `version`, la vigente
-- de ese idioma, o la del español si no hay traducción): para mostrar una declaración tal como se aceptó.
-- → {key, lang, version, kind, title, body, createdAt} o NOT_FOUND.
create or replace function central.text_version(p_ctx jsonb)
returns jsonb language plpgsql stable as $$
declare v central.text_versions; v_key text := p_ctx->'args'->>'key'; v_lang text := coalesce(p_ctx->'args'->>'lang', 'es');
        v_version text := p_ctx->'args'->>'version';
begin
  if v_key is null or v_lang not in ('es', 'en') then perform core.fail('NOT_FOUND', 404); end if;
  if v_version is null then
    select version into v_version from central.texts where key = v_key and lang = v_lang and deleted_at is null;
    if v_version is null and v_lang <> 'es' then
      v_lang := 'es';
      select version into v_version from central.texts where key = v_key and lang = 'es' and deleted_at is null;
    end if;
  end if;
  select * into v from central.text_versions where key = v_key and lang = v_lang and version = v_version;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('key', v_key, 'lang', v_lang, 'version', v_version)); end if;
  return jsonb_build_object('key', v.key, 'lang', v.lang, 'version', v.version, 'kind', v.kind, 'title', v.title, 'body', v.rendered_body, 'createdAt', v.created_at);
end $$;
select core.allow_read('central', 'central.text_version', 'function');
select core.allow_read('organizers', 'central.text_version', 'function');
select core.allow_read('guests', 'central.text_version', 'function');
select core.allow_read('booking', 'central.text_version', 'function');

-- Historial de un texto para la pantalla de Central (`args: {key, lang?}`): versiones, más reciente primero.
create or replace function central.text_history(p_ctx jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'title', v.title, 'body', v.rendered_body, 'createdAt', v.created_at)
    order by substring(v.version from 2)::int desc), '[]'::jsonb))
    from central.text_versions v where v.key = p_ctx->'args'->>'key' and v.lang = coalesce(p_ctx->'args'->>'lang', 'es');
$$;
select core.allow_read('central', 'central.text_history', 'function');

-- ---------------------------------------------------------------------------
-- Semilla (textos que pidió el usuario). No hace nada con una clave que ya exista. Se escribe con
-- core.apply_migration_operations: lote propio con cursor y core.changes, así que llega a los dispositivos.
-- Solo se ejecuta si Central ya tiene miembros (producción); las pruebas la llaman explícitamente.
-- ---------------------------------------------------------------------------
create or replace function central.seed_texts()
returns int language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; s record;
begin
  for s in select * from (values
    ('contact.email', 'es', 'contacto', 'Correo de contacto', 'organiza@ikisai.com', 10),
    ('contact.phone', 'es', 'contacto', 'Teléfono de contacto', '614 76 57 96', 20),
    -- La clave se compone por partes: el lint tomaría «organizers.…» por una referencia a otro schema.
    ('organizers' || '.declaration', 'es', 'legal', 'Declaración de quien organiza',
     'Facilito estos datos con conocimiento de mis asistentes y solo para organizar su estancia en Ikisai. Cada asistente recibirá la información sobre protección de datos al abrir su enlace personal.', 30),
    ('portal.privacy', 'es', 'legal', 'Protección de datos', $privacy$**Información sobre protección de datos**

**Responsable:** {{entidad.razon_social}} (NIF {{entidad.nif}}), {{entidad.domicilio}}. Contacto: {{contacto.correo}} · {{contacto.telefono}}.

**Para qué usamos tus datos:** para organizar tu estancia en Ikisai (alojamiento, comidas y actividades) y, cuando la estancia es un servicio de alojamiento, para cumplir la obligación legal de registrar a los viajeros y comunicarlo al Ministerio del Interior (Real Decreto 933/2021).

**Base legal:** la prestación del servicio que has contratado, directamente o a través de quien organiza tu retiro, y el cumplimiento de una obligación legal.

**Quién los ve:** el equipo de Ikisai que gestiona tu estancia. Quien organiza tu retiro solo ve tu nombre, si has completado tus datos y lo que él mismo haya escrito; tus alergias, solo si tú lo permites. Cuando la ley lo exige, se comunican al Ministerio del Interior (SES.HOSPEDAJES). No vendemos ni cedemos tus datos para publicidad.

**Cuánto tiempo:** los datos del registro de viajeros, tres años desde el final de tu estancia, como exige la ley; el resto, como mucho seis meses después de tu estancia. Después se borran o se anonimizan.

**Tus derechos:** puedes pedir acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a {{contacto.correo}}. Si crees que no hemos atendido bien tu solicitud, puedes reclamar ante la Agencia Española de Protección de Datos (www.aepd.es).$privacy$, 40),
    -- Inglés (borrador de Central; lo revisa el usuario).
    ('organizers' || '.declaration', 'en', 'legal', 'Organiser declaration',
     'I am providing this information with the knowledge of my attendees and solely to organise their stay at Ikisai. Each attendee will receive the data protection information when they open their personal link.', 30),
    ('portal.privacy', 'en', 'legal', 'Data protection', $privacy_en$**Data protection information**

**Controller:** {{entidad.razon_social}} (Tax ID {{entidad.nif}}), {{entidad.domicilio}}. Contact: {{contacto.correo}} · {{contacto.telefono}}.

**What we use your data for:** to organise your stay at Ikisai (accommodation, meals and activities) and, when your stay is an accommodation service, to comply with the legal obligation to register travellers and report them to the Spanish Ministry of the Interior (Royal Decree 933/2021).

**Legal basis:** the provision of the service you have booked, directly or through the organiser of your retreat, and compliance with a legal obligation.

**Who can see your data:** the Ikisai team that manages your stay. The organiser of your retreat only sees your name, whether you have completed your details and anything they have written themselves; your allergies, only if you allow it. When the law requires it, your data is reported to the Spanish Ministry of the Interior (SES.HOSPEDAJES). We do not sell your data or share it for advertising.

**How long we keep it:** traveller registration data, three years from the end of your stay, as required by law; everything else, at most six months after your stay. After that it is deleted or anonymised.

**Your rights:** you can request access, rectification, erasure, objection, restriction and portability by writing to {{contacto.correo}}. If you believe we have not handled your request properly, you can lodge a complaint with the Spanish Data Protection Agency (www.aepd.es).$privacy_en$, 40),
    -- Portal de huéspedes e información práctica (CE2). Las claves «guests.…» se componen por partes por el lint.
    ('guests' || '.data_why', 'es', 'mensaje', 'Por qué te pedimos estos datos', 'Te pedimos estos datos para preparar tu estancia (alojamiento y comidas) y porque la ley obliga a los alojamientos a registrar a sus huéspedes y comunicarlo al Ministerio del Interior. Solo pedimos lo necesario. Quien organiza tu retiro no ve tus datos de identidad.', 50),
    ('guests' || '.data_why', 'en', 'mensaje', 'Why we ask for this information', 'We ask for this information to prepare your stay (accommodation and meals) and because the law requires accommodation providers to register their guests and report them to the Spanish Ministry of the Interior. We only ask for what is necessary. The organiser of your retreat cannot see your identity details.', 50),
    ('guests' || '.signature_statement', 'es', 'legal', 'Declaración al firmar', 'Declaro que los datos que he facilitado son ciertos y completos. Con mi firma acepto el parte de entrada del alojamiento, que Ikisai conservará durante el plazo que exige la ley (Real Decreto 933/2021).', 60),
    ('guests' || '.signature_statement', 'en', 'legal', 'Declaration when signing', 'I declare that the information I have provided is true and complete. By signing, I accept the accommodation check-in record, which Ikisai will keep for the period required by law (Royal Decree 933/2021).', 60),
    ('guests' || '.allergies_notice', 'es', 'mensaje', 'Alergias e intolerancias', 'Cuéntanos tus alergias e intolerancias para que la cocina las tenga en cuenta. Hacemos lo posible por adaptar los menús, pero en una cocina compartida no podemos garantizar la ausencia total de trazas. Si tu alergia es grave, avísanos también en persona al llegar.', 70),
    ('guests' || '.allergies_notice', 'en', 'mensaje', 'Allergies and intolerances', 'Tell us about your allergies and intolerances so that the kitchen can take them into account. We do our best to adapt the menus, but in a shared kitchen we cannot guarantee that there will be no traces at all. If your allergy is severe, please also tell us in person when you arrive.', 70),
    ('info.arrival', 'es', 'info', 'Llegada y salida', E'La hora de llegada y de salida la acuerda quien organiza tu retiro. Si vas a llegar fuera de ese horario o te retrasas, avísanos en el {{contacto.telefono}}.\n\nDirección: {{entidad.domicilio}}.', 100),
    ('info.arrival', 'en', 'info', 'Arrival and departure', E'Arrival and departure times are agreed with the organiser of your retreat. If you will arrive outside those times or are running late, please call us on {{contacto.telefono}}.\n\nAddress: {{entidad.domicilio}}.', 100),
    ('info.parking', 'es', 'info', 'Cómo llegar y aparcar', 'Si vienes en coche, pregunta a quien organiza tu retiro o escríbenos a {{contacto.correo}} y te indicaremos dónde aparcar. Si podéis, compartid coche.', 110),
    ('info.parking', 'en', 'info', 'Getting here and parking', 'If you are coming by car, ask the organiser of your retreat or write to us at {{contacto.correo}} and we will tell you where to park. If you can, please share a car.', 110),
    ('info.facilities', 'es', 'info', 'Instalaciones', 'Al llegar, el equipo de Ikisai te enseñará los espacios que tu grupo tiene reservados: alojamiento, comedor y salas de actividad. Si necesitas algo durante la estancia, pregúntanos.', 120),
    ('info.facilities', 'en', 'info', 'Facilities', 'When you arrive, the Ikisai team will show you the spaces booked for your group: accommodation, dining room and activity rooms. If you need anything during your stay, just ask us.', 120),
    ('info.rules', 'es', 'info', 'Convivencia', 'Cuida los espacios y respeta el descanso de los demás. Sigue las indicaciones del equipo de Ikisai y de quien organiza tu retiro. Si algo se rompe o no funciona, avísanos cuanto antes.', 130),
    ('info.rules', 'en', 'info', 'House rules', 'Please look after the spaces and respect other people''s rest. Follow the instructions of the Ikisai team and of your retreat''s organiser. If something breaks or does not work, let us know as soon as possible.', 130),
    ('info.bring', 'es', 'info', 'Qué traer', 'Ropa cómoda, calzado para caminar, algo de abrigo para la noche, tu medicación habitual y lo que indique quien organiza tu retiro.', 140),
    ('info.bring', 'en', 'info', 'What to bring', 'Comfortable clothes, walking shoes, something warm for the evening, any regular medication you take, and anything your retreat organiser asks you to bring.', 140)
  ) as t(key, lang, kind, title, body, pos) loop
    if not exists (select 1 from central.texts where key = s.key and lang = s.lang and deleted_at is null) then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'central.texts', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('key', s.key, 'lang', s.lang, 'kind', s.kind, 'title', s.title, 'body', s.body, 'position', s.pos));
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('central', 'migration:central-0570-texts', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;

do $$
begin
  if exists (select 1 from core.memberships where app = 'central') then perform central.seed_texts(); end if;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
