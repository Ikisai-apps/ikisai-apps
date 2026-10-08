-- Ikisai Organizers · fase 4 de los portales: experiencia de Guests, materiales, preguntas y respuestas, y ofertas
-- (docs/organizers/API.md §15 y §16.2; contrato con Guests en docs/guests/API.md §13; decisiones de Core del 8-10-2026).
-- Toca solo el schema organizers. Las primeras tablas sincronizables de Organizers: todas llevan `reservation_id` de
-- Booking (sin FK entre schemas) y solo las ve y escribe quien organiza esa reserva (gancho de validación y `visible`).

create schema if not exists organizers;
revoke all on schema organizers from public;
revoke all on schema organizers from anon, authenticated;
grant usage on schema organizers to service_role;

-- ---------------------------------------------------------------------------
-- Experiencia de Guests: una fila por reserva, con módulos fijos (no un editor libre). Códigos como los lee Guests.
-- ---------------------------------------------------------------------------
create table organizers.experiences (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null,
  program_visible boolean not null default false,
  program_window text not null default 'always' check (program_window in ('before','during','after','always')),
  menu_visible boolean not null default false,
  menu_window text not null default 'always' check (menu_window in ('before','during','after','always')),
  materials_visible boolean not null default false,
  questions_visible boolean not null default false,
  lodging_visible boolean not null default false,
  lodging_capability text not null default 'view' check (lodging_capability in ('view','prefer','choose','request')),
  lodging_choose_until date,
  -- tipos de habitación que ofrece y lo que dice al huésped del precio: [{key, label, guest_note}] (§16.1, O3)
  lodging_options jsonb not null default '[]'::jsonb check (jsonb_typeof(lodging_options) = 'array' and jsonb_array_length(lodging_options) <= 12),
  map_visible boolean not null default false,
  organizer_message text check (organizer_message is null or length(organizer_message) <= 1000),
  message_lang text check (message_lang is null or message_lang in ('es','en'))
);
create unique index experiences_reservation_idx on organizers.experiences (reservation_id) where deleted_at is null;
select core.register_table('organizers', 'organizers', 'experiences', array['reservation_id','program_visible','program_window','menu_visible','menu_window',
  'materials_visible','questions_visible','lodging_visible','lodging_capability','lodging_choose_until','lodging_options','map_visible',
  'organizer_message','message_lang'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Materiales del organizador: archivo (PDF o imagen), enlace o texto, publicados o no y con su ventana.
-- ---------------------------------------------------------------------------
create table organizers.materials (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null,
  -- quien lo creó: los materiales y el logotipo se conservan para sus próximos retiros (biblioteca de su cuenta)
  owner_id uuid references auth.users(id),
  kind text not null check (kind in ('file','link','text')),
  title text not null check (length(btrim(title)) between 1 and 160),
  description text check (description is null or length(description) <= 1000),
  file_id uuid references core.files(id),
  url text check (url is null or (url ~ '^https://' and length(url) <= 600)),
  body text check (body is null or length(body) <= 4000),
  is_logo boolean not null default false,
  published boolean not null default false,
  "window" text not null default 'always' check ("window" in ('before','during','after','always')),
  position numeric not null default 0,
  constraint materials_kind_payload check (
    (kind = 'file' and file_id is not null) or (kind = 'link' and url is not null) or (kind = 'text' and body is not null))
);
create index materials_reservation_idx on organizers.materials (reservation_id, position) where deleted_at is null;
create unique index materials_one_logo on organizers.materials (reservation_id) where is_logo and deleted_at is null;
create index materials_owner_idx on organizers.materials (owner_id) where deleted_at is null;
select core.register_table('organizers', 'organizers', 'materials', array['reservation_id','owner_id','kind','title','description','file_id','url','body',
  'is_logo','published','window','position'], '{editor,owner}', '{editor,owner}');
select core.register_file_field('organizers', 'organizers', 'materials', 'file_id', 'operational');
select core.enable_file_gc('organizers');

-- ---------------------------------------------------------------------------
-- Preguntas del organizador y respuestas de sus huéspedes (sin salud, alergias ni documentos: eso lo pide Ikisai).
-- ---------------------------------------------------------------------------
create table organizers.questions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null,
  -- quien la creó: preguntas y configuración pueden quedarse como plantilla del organizador
  owner_id uuid references auth.users(id),
  type text not null check (type in ('text','choice','multi','yes_no','number','date')),
  label text not null check (length(btrim(label)) between 1 and 300),
  help text check (help is null or length(help) <= 600),
  -- opciones de `choice` y `multi`: [{value, label}] (de 2 a 12)
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 12),
  required boolean not null default false,
  opens_at date,
  closes_at date,
  published boolean not null default false,
  position numeric not null default 0,
  constraint questions_options check (type not in ('choice','multi') or jsonb_array_length(options) >= 2),
  constraint questions_window check (opens_at is null or closes_at is null or closes_at >= opens_at)
);
create index questions_reservation_idx on organizers.questions (reservation_id, position) where deleted_at is null;
create index questions_owner_idx on organizers.questions (owner_id) where deleted_at is null;
select core.register_table('organizers', 'organizers', 'questions', array['reservation_id','owner_id','type','label','help','options','required',
  'opens_at','closes_at','published','position'], '{editor,owner}', '{editor,owner}');

create table organizers.answers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null,
  question_id uuid not null references organizers.questions(id),
  guest_id uuid not null,
  value jsonb not null
);
create unique index answers_one_per_guest on organizers.answers (question_id, guest_id) where deleted_at is null;
-- El organizador las lee; solo las escribe el huésped con `guest_answer` (el gancho rechaza a cualquier otro).
select core.register_table('organizers', 'organizers', 'answers', array['reservation_id','question_id','guest_id','value'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Ofertas del organizador a sus asistentes (§16.2): para sus cálculos y su cartel. Nunca en Guests ni con cobro de Ikisai.
-- ---------------------------------------------------------------------------
create table organizers.offers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 600),
  price numeric(10,2) not null check (price >= 0),
  includes text check (includes is null or length(includes) <= 600),
  capacity integer check (capacity is null or capacity >= 0),
  expected integer check (expected is null or expected >= 0),
  available_from date,
  available_until date,
  on_poster boolean not null default true,
  position numeric not null default 0
);
create index offers_reservation_idx on organizers.offers (reservation_id, position) where deleted_at is null;
select core.register_table('organizers', 'organizers', 'offers', array['reservation_id','name','description','price','includes','capacity',
  'expected','available_from','available_until','on_poster','position'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Ámbito de cada lote de Organizers (gancho de validación del núcleo, sobre las filas del lote en core.changes):
-- - toda fila es de una reserva y `reservation_id` no cambia;
-- - el organizador escribe solo en las reservas de sus `scopes.grants` y nunca en las respuestas;
-- - `owner_id` de materiales y preguntas es quien los crea (el actor del alta) y no cambia;
-- - las respuestas las escribe solo el propio huésped, con su ámbito de Guests {reservation_id, guest_id}, sobre una
--   pregunta de esa reserva (`guest_answer`, por `apply_portal_operations`);
-- - el actor de servicio de Organizers (retención) y los lotes sin actor pasan.
-- ---------------------------------------------------------------------------
create or replace function organizers.validate_batch(p jsonb)
returns void language plpgsql as $$
declare
  v_actor uuid := nullif(p->>'actor', '')::uuid;
  v_res uuid;
  c record;
begin
  for c in select table_name, op, before, after from core.changes
            where app = p->>'app' and cursor = (p->>'cursor')::bigint and schema_name = 'organizers' and op <> 'call' loop
    if c.before is not null and (c.before->>'reservation_id' is distinct from c.after->>'reservation_id'
        or (c.table_name = 'answers' and (c.before->>'guest_id' is distinct from c.after->>'guest_id' or c.before->>'question_id' is distinct from c.after->>'question_id'))) then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.' || c.table_name));
    end if;
    if c.table_name in ('materials','questions') and c.before is not null and c.before->>'owner_id' is distinct from c.after->>'owner_id' then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.' || c.table_name, 'field', 'owner_id'));
    end if;
    if v_actor is null or v_actor = core.service_actor('organizers') then continue; end if;
    v_res := (c.after->>'reservation_id')::uuid;
    if c.table_name = 'answers' then
      if not core.portal_in_scope('guests', v_actor, v_res, (c.after->>'guest_id')::uuid)
         or not exists (select 1 from organizers.questions q where q.id = (c.after->>'question_id')::uuid and q.reservation_id = v_res) then
        perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
      end if;
    elsif not core.portal_in_scope('organizers', v_actor, v_res, null) then
      perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
    elsif c.table_name in ('materials','questions') and c.before is null and c.after->>'owner_id' is distinct from v_actor::text then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'organizers.' || c.table_name, 'field', 'owner_id'));
    end if;
  end loop;
end $$;

select core.add_validate_hook('organizers', 'organizers.validate_batch');

-- ---------------------------------------------------------------------------
-- Lecturas para Guests (registradas para el portal `guests`, con el ámbito del huésped {reservation_id, guest_id}).
-- Fuera de ámbito: OUT_OF_SCOPE. Las ventanas (antes, durante, después) las aplica Guests con las fechas de la reserva,
-- que no son de este schema: aquí van con cada elemento.
-- ---------------------------------------------------------------------------
create or replace function organizers.guest_scope(p jsonb)
returns uuid language plpgsql stable as $$
declare v_res uuid; v_guest uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; v_guest := nullif(p->'args'->>'guest_id', '')::uuid; exception when others then v_res := null; end;
  if v_res is null or not exists (
      select 1 from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) g
       where m.app = 'guests' and m.user_id = (p->>'actor')::uuid and g ->> 'reservation_id' = v_res::text
         and (v_guest is null or g ->> 'guest_id' = v_guest::text)) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  return v_res;
end $$;

-- Guest de la sesión en esa reserva (un huésped tiene un guest_id por reserva).
create or replace function organizers.guest_of(p jsonb, p_res uuid)
returns uuid language sql stable as $$
  select (g ->> 'guest_id')::uuid from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) g
   where m.app = 'guests' and m.user_id = (p->>'actor')::uuid and g ->> 'reservation_id' = p_res::text
     and (nullif(p->'args'->>'guest_id', '') is null or g ->> 'guest_id' = p->'args'->>'guest_id')
   limit 1;
$$;

create or replace function organizers.guest_experience_for(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid := organizers.guest_scope(p); e organizers.experiences;
begin
  select * into e from organizers.experiences where reservation_id = v_res and deleted_at is null;
  if e.id is null then return jsonb_build_object('revision', null, 'modules', null, 'organizer_message', null); end if;
  return jsonb_build_object('revision', e.revision,
    'modules', jsonb_build_object(
      'program', jsonb_build_object('visible', e.program_visible, 'window', e.program_window),
      'menu', jsonb_build_object('visible', e.menu_visible, 'window', e.menu_window),
      'materials', jsonb_build_object('visible', e.materials_visible),
      'questions', jsonb_build_object('visible', e.questions_visible),
      'lodging', jsonb_build_object('visible', e.lodging_visible, 'capability', e.lodging_capability, 'choose_until', e.lodging_choose_until, 'options', e.lodging_options),
      'map', jsonb_build_object('visible', e.map_visible)),
    'organizer_message', case when e.organizer_message is null then null else jsonb_build_object('text', e.organizer_message, 'lang', coalesce(e.message_lang, 'es')) end);
end $$;

create or replace function organizers.guest_materials(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid := organizers.guest_scope(p);
begin
  if not exists (select 1 from organizers.experiences where reservation_id = v_res and deleted_at is null and materials_visible) then
    return jsonb_build_object('items', '[]'::jsonb);
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'title', m.title, 'description', m.description, 'window', m."window",
        'file', case when m.kind = 'file' then (select jsonb_build_object('id', f.id, 'name', f.filename, 'mime', f.mime, 'size', f.size) from core.files f where f.id = m.file_id) end,
        'url', m.url, 'body', m.body) order by m.position, m.created_at)
      from organizers.materials m where m.reservation_id = v_res and m.deleted_at is null and m.published and not m.is_logo), '[]'::jsonb));
end $$;

-- Resolutor de `portal-files` (C8, O1): un huésped puede abrir un archivo si es de un material publicado de su retiro,
-- con el módulo de materiales visible. La ventana (antes, durante, después) la aplica Guests con las fechas de Booking.
create or replace function organizers.guest_material_file(p jsonb)
returns boolean language sql stable as $$
  select exists (
    select 1 from organizers.materials m
      join organizers.experiences e on e.reservation_id = m.reservation_id and e.deleted_at is null and e.materials_visible
     where m.file_id = (p->>'file_id')::uuid and m.deleted_at is null and m.published and not m.is_logo
       and exists (select 1 from core.memberships cm, jsonb_array_elements(coalesce(cm.scopes -> 'grants', '[]'::jsonb)) g
                    where cm.app = 'guests' and cm.user_id = (p->>'actor')::uuid and g ->> 'reservation_id' = m.reservation_id::text));
$$;

create or replace function organizers.guest_questions(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid := organizers.guest_scope(p); v_guest uuid := organizers.guest_of(p, v_res); v_today date := (now() at time zone 'Europe/Madrid')::date;
begin
  if not exists (select 1 from organizers.experiences where reservation_id = v_res and deleted_at is null and questions_visible) then
    return jsonb_build_object('items', '[]'::jsonb);
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'revision', q.revision, 'type', q.type, 'label', q.label, 'help', q.help, 'options', q.options,
        'required', q.required, 'open', (q.opens_at is null or q.opens_at <= v_today) and (q.closes_at is null or v_today <= q.closes_at),
        'answer', (select jsonb_build_object('value', a.value, 'revision', a.revision, 'updated_at', a.updated_at) from organizers.answers a
                    where a.question_id = q.id and a.guest_id = v_guest and a.deleted_at is null)) order by q.position, q.created_at)
      from organizers.questions q where q.reservation_id = v_res and q.deleted_at is null and q.published), '[]'::jsonb));
end $$;

-- Forma de una respuesta según el tipo de pregunta; null si no vale.
create or replace function organizers.answer_ok(q organizers.questions, v jsonb)
returns boolean language plpgsql immutable as $$
begin
  case q.type
    when 'text' then return jsonb_typeof(v) = 'string' and length(v #>> '{}') <= 2000;
    when 'yes_no' then return jsonb_typeof(v) = 'boolean';
    when 'number' then return jsonb_typeof(v) = 'number';
    when 'date' then return jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$';
    when 'choice' then return jsonb_typeof(v) = 'string' and exists (select 1 from jsonb_array_elements(q.options) o where o->>'value' = v #>> '{}');
    when 'multi' then return jsonb_typeof(v) = 'array' and jsonb_array_length(v) <= 12
      and not exists (select 1 from jsonb_array_elements_text(v) x where not exists (select 1 from jsonb_array_elements(q.options) o where o->>'value' = x));
    else return false;
  end case;
end $$;

-- Acción del huésped (K4): crea o cambia su respuesta, con el usuario del portal como actor. `value: null` la borra.
create or replace function organizers.guest_answer(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_q organizers.questions; v_res uuid; v_guest uuid; v_a organizers.answers; v_value jsonb := p->'args'->'value';
  v_today date := (now() at time zone 'Europe/Madrid')::date; v_ops jsonb; v_out jsonb; v_id uuid;
begin
  begin select * into v_q from organizers.questions where id = (p->'args'->>'question_id')::uuid and deleted_at is null and published; exception when others then v_q := null; end;
  if v_q.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('question_id', p->'args'->>'question_id')); end if;
  v_res := organizers.guest_scope(jsonb_set(p, '{args,reservation_id}', to_jsonb(v_q.reservation_id::text)));
  v_guest := organizers.guest_of(p, v_res);
  if v_guest is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('question_id', v_q.id)); end if;
  if not ((v_q.opens_at is null or v_q.opens_at <= v_today) and (v_q.closes_at is null or v_today <= v_q.closes_at)) then
    perform core.fail('QUESTION_CLOSED', 422, jsonb_build_object('question_id', v_q.id));
  end if;
  select * into v_a from organizers.answers where question_id = v_q.id and guest_id = v_guest and deleted_at is null;
  if v_value is null or v_value = 'null'::jsonb then
    if v_a.id is null then return jsonb_build_object('revision', null, 'cursor', null); end if;
    v_ops := jsonb_build_array(jsonb_build_object('op', 'delete', 'table', 'organizers.answers', 'id', v_a.id,
      'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_a.revision)));
  else
    if not organizers.answer_ok(v_q, v_value) then perform core.fail('INVALID_ANSWER', 422, jsonb_build_object('question_id', v_q.id, 'type', v_q.type)); end if;
    if v_a.id is null then
      v_id := gen_random_uuid();
      v_ops := jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'organizers.answers', 'id', v_id,
        'fields', jsonb_build_object('reservation_id', v_res, 'question_id', v_q.id, 'guest_id', v_guest, 'value', v_value)));
    else
      v_id := v_a.id;
      v_ops := jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'organizers.answers', 'id', v_a.id,
        'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_a.revision), 'fields', jsonb_build_object('value', v_value)));
    end if;
  end if;
  v_out := core.apply_portal_operations('organizers', v_ops);
  -- Borrada, no hay revisión que devolver; si no, la de la fila escrita (para el siguiente `expectedRevision`).
  return jsonb_build_object('revision', (select revision from organizers.answers where id = v_id and deleted_at is null), 'cursor', v_out->'cursor');
end $$;

select core.allow_read('guests', 'organizers.guest_experience_for', 'function', '{editor,owner}');
select core.allow_read('guests', 'organizers.guest_materials', 'function', '{editor,owner}');
select core.allow_read('guests', 'organizers.guest_questions', 'function', '{editor,owner}');
select core.allow_read('guests', 'organizers.guest_answer', 'action', '{editor,owner}');
select core.allow_portal_file('guests', 'organizers.guest_material_file');

revoke all on all tables in schema organizers from public, anon, authenticated;
revoke all on all functions in schema organizers from public, anon, authenticated;
grant all on all tables in schema organizers to service_role;
grant execute on all functions in schema organizers to service_role;
alter table organizers.experiences enable row level security;
alter table organizers.materials enable row level security;
alter table organizers.questions enable row level security;
alter table organizers.answers enable row level security;
alter table organizers.offers enable row level security;
