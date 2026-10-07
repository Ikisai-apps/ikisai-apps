-- Ikisai Central · «Textos y contacto» (decisión del usuario, 7-10-2026): los textos legales, avisos, declaraciones y datos de
-- contacto que ven las personas y los portales se editan siempre desde Central, nunca fijos en el código.
-- Referencia: docs/central/API.md §2.12. Toca solo el schema central.

-- ---------------------------------------------------------------------------
-- Textos (sincronizados): escribe solo el owner, leen todos los miembros.
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
  kind text not null check (kind in ('legal','mensaje','contacto')),
  position numeric not null default 0
);
create unique index texts_key_idx on central.texts (key) where deleted_at is null;
create trigger texts_forbid_rekey before update on central.texts for each row execute function central.forbid_reparent('key');

select core.register_table('central', 'central', 'texts', array['key','title','body','kind','position'], '{reader,editor,owner}', '{owner}');

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
  version text not null,
  kind text not null,
  title text not null,
  body text not null,
  rendered_body text not null
);
create unique index text_versions_key_idx on central.text_versions (key, version);

select core.register_table('central', 'central', 'text_versions', array[]::text[], '{}', '{}');

-- Marcadores: {{entidad.razon_social}}, {{entidad.nif}}, {{entidad.domicilio}}, {{contacto.correo}}, {{contacto.telefono}}.
-- Lo que falta se escribe «—» (la Entidad o el contacto aún sin rellenar).
create or replace function central.render_text(p_body text)
returns text language plpgsql stable as $$
declare e central.entity; v_mail text; v_phone text; v_address text;
begin
  select * into e from central.entity where deleted_at is null limit 1;
  select body into v_mail from central.texts where key = 'contact.email' and deleted_at is null;
  select body into v_phone from central.texts where key = 'contact.phone' and deleted_at is null;
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
    insert into central.text_versions (text_id, key, version, kind, title, body, rendered_body, updated_by)
    values (new.id, new.key, new.version, new.kind, new.title, new.body, central.render_text(new.body), new.updated_by)
    on conflict (key, version) do nothing;
  end if;
  return null;
end $$;
create trigger texts_archive after insert or update on central.texts for each row execute function central.archive_text_version();

-- ---------------------------------------------------------------------------
-- Proyección para los portales y Booking: textos vivos ya con los marcadores sustituidos. Sin datos personales.
-- ---------------------------------------------------------------------------
create view central.common_texts_projection as
select t.key, t.title, central.render_text(t.body) as body, t.version, t.kind, t.updated_at
  from central.texts t
 where t.deleted_at is null;

revoke all on central.common_texts_projection from public, anon, authenticated;
grant select on central.common_texts_projection to service_role;
select core.allow_read('central', 'central.common_texts_projection', 'view');
select core.allow_read('organizers', 'central.common_texts_projection', 'view');
select core.allow_read('guests', 'central.common_texts_projection', 'view');
select core.allow_read('booking', 'central.common_texts_projection', 'view');

-- Una versión concreta tal como se guardó (`args: {key, version}`; sin `version`, la vigente): para mostrar una declaración
-- tal como se aceptó. → {key, version, kind, title, body, createdAt} o NOT_FOUND.
create or replace function central.text_version(p_ctx jsonb)
returns jsonb language plpgsql stable as $$
declare v central.text_versions; v_key text := p_ctx->'args'->>'key'; v_version text := p_ctx->'args'->>'version';
begin
  if v_key is null then perform core.fail('NOT_FOUND', 404); end if;
  if v_version is null then
    select version into v_version from central.texts where key = v_key and deleted_at is null;
  end if;
  select * into v from central.text_versions where key = v_key and version = v_version;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('key', v_key, 'version', v_version)); end if;
  return jsonb_build_object('key', v.key, 'version', v.version, 'kind', v.kind, 'title', v.title, 'body', v.rendered_body, 'createdAt', v.created_at);
end $$;
select core.allow_read('central', 'central.text_version', 'function');
select core.allow_read('organizers', 'central.text_version', 'function');
select core.allow_read('guests', 'central.text_version', 'function');
select core.allow_read('booking', 'central.text_version', 'function');

-- Historial de un texto para la pantalla de Central (`args: {key}`): versiones, más reciente primero.
create or replace function central.text_history(p_ctx jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'title', v.title, 'body', v.rendered_body, 'createdAt', v.created_at)
    order by substring(v.version from 2)::int desc), '[]'::jsonb))
    from central.text_versions v where v.key = p_ctx->'args'->>'key';
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
    ('contact.email', 'contacto', 'Correo de contacto', 'organiza@ikisai.com', 10),
    ('contact.phone', 'contacto', 'Teléfono de contacto', '614 76 57 96', 20),
    -- La clave se compone por partes: el lint tomaría «organizers.…» por una referencia a otro schema.
    ('organizers' || '.declaration', 'legal', 'Declaración de quien organiza',
     'Facilito estos datos con conocimiento de mis asistentes y solo para organizar su estancia en Ikisai. Cada asistente recibirá la información sobre protección de datos al abrir su enlace personal.', 30),
    ('portal.privacy', 'legal', 'Protección de datos', $privacy$**Información sobre protección de datos**

**Responsable:** {{entidad.razon_social}} (NIF {{entidad.nif}}), {{entidad.domicilio}}. Contacto: {{contacto.correo}} · {{contacto.telefono}}.

**Para qué usamos tus datos:** para organizar tu estancia en Ikisai (alojamiento, comidas y actividades) y, cuando la estancia es un servicio de alojamiento, para cumplir la obligación legal de registrar a los viajeros y comunicarlo al Ministerio del Interior (Real Decreto 933/2021).

**Base legal:** la prestación del servicio que has contratado, directamente o a través de quien organiza tu retiro, y el cumplimiento de una obligación legal.

**Quién los ve:** el equipo de Ikisai que gestiona tu estancia. Quien organiza tu retiro solo ve tu nombre, si has completado tus datos y lo que él mismo haya escrito; tus alergias, solo si tú lo permites. Cuando la ley lo exige, se comunican al Ministerio del Interior (SES.HOSPEDAJES). No vendemos ni cedemos tus datos para publicidad.

**Cuánto tiempo:** los datos del registro de viajeros, tres años desde el final de tu estancia, como exige la ley; el resto, como mucho seis meses después de tu estancia. Después se borran o se anonimizan.

**Tus derechos:** puedes pedir acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a {{contacto.correo}}. Si crees que no hemos atendido bien tu solicitud, puedes reclamar ante la Agencia Española de Protección de Datos (www.aepd.es).$privacy$, 40)
  ) as t(key, kind, title, body, pos) loop
    if not exists (select 1 from central.texts where key = s.key and deleted_at is null) then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'central.texts', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('key', s.key, 'kind', s.kind, 'title', s.title, 'body', s.body, 'position', s.pos));
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
