-- Ikisai Booking · O2, parte 1: estancias de outsider y del staff (coordinacion/ampliacion/RECURSOS.md §15.2; tabla
-- «hoy / después» aprobada por el usuario el 14-10-2026, coordinacion/booking/o2/O2_PREPARACION.md).
-- Una estancia no es una reserva: sin evento, propuesta, cobro ni ciclo de estados, así que reservas, calendario, Finance e
-- indicadores no cambian. Decisiones del usuario: un choque con un retiro es un **aviso, no un bloqueo** (`BED_OVERBOOKED`
-- sigue siendo solo entre retiros); las estancias **no** cuentan en la disponibilidad del organizador por fin de semana;
-- no se comunican a SES (el outsider no es cliente).
-- Para Guests (su O4 §3): lecturas y acciones de outsider con el ámbito del actor (`core.house_levels.level = 'outsider'`,
-- O1), sus retiros con la clave de persona estable (`guests.person_key`) y la presencia del staff sin nombres.
-- Además, el arreglo de `bed_free` con huésped nulo (caracterización de O2). Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Clave de persona estable dentro de una cuenta (la familia, Guests §2.3)
-- ---------------------------------------------------------------------------
alter table booking.guests add column person_key uuid;
create index guests_person_key_idx on booking.guests (person_key) where person_key is not null and deleted_at is null;
select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by','anonymized_at','diet_reviewed_at','signature_text_version','preview',
  'room_preference','needs_ground_floor','person_key'],
  '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Estancias: noches [desde, hasta), como las reservas
-- ---------------------------------------------------------------------------
create table booking.stays (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  -- outsider: gente de fuera por trato personal · staff: presencia de quien trabaja en casa (normalmente sin cama)
  kind text not null default 'outsider' check (kind in ('outsider','staff')),
  -- la cuenta del outsider o del miembro del staff
  account_id uuid not null references auth.users(id),
  from_date date not null,
  to_date date not null,
  space_id uuid references booking.spaces(id),
  bed_id uuid references booking.beds(id),
  resource_space_id uuid,
  resource_bed_id uuid,
  -- quién la creó: el propio outsider desde Guests o el personal (sale de quién escribe, nunca del cliente)
  source text not null default 'staff' check (source in ('guest','staff')),
  check (to_date > from_date)
);
create index stays_account_idx on booking.stays (account_id, from_date) where deleted_at is null;
create index stays_bed_idx on booking.stays (bed_id, from_date) where deleted_at is null and bed_id is not null;
create trigger stays_forbid_reparent before update on booking.stays
  for each row execute function booking.forbid_reparent('account_id');
select core.register_table('booking', 'booking', 'stays', array['kind','account_id','from_date','to_date','space_id','bed_id','resource_space_id','resource_bed_id']);

-- Quién viene en la estancia (la familia). La misma `person_key` que en las fichas de huésped de la cuenta.
create table booking.stay_persons (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  stay_id uuid not null references booking.stays(id),
  person_key uuid not null default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120)
);
create unique index stay_persons_once on booking.stay_persons (stay_id, person_key) where deleted_at is null;
create trigger stay_persons_forbid_reparent before update on booking.stay_persons
  for each row execute function booking.forbid_reparent('stay_id');
select core.register_table('booking', 'booking', 'stay_persons', array['stay_id','person_key','name']);

-- Cama por defecto de un outsider. La fija el personal; una estancia nueva sin cama la usa.
create table booking.outsider_defaults (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  account_id uuid not null references auth.users(id),
  space_id uuid references booking.spaces(id),
  bed_id uuid references booking.beds(id),
  resource_space_id uuid,
  resource_bed_id uuid
);
create unique index outsider_defaults_account_idx on booking.outsider_defaults (account_id) where deleted_at is null;
create trigger outsider_defaults_forbid_reparent before update on booking.outsider_defaults
  for each row execute function booking.forbid_reparent('account_id');
select core.register_table('booking', 'booking', 'outsider_defaults', array['account_id','space_id','bed_id','resource_space_id','resource_bed_id']);

-- Notas con hora de la estancia de un outsider («llego a las 22:00»). Las ponen él y el personal.
create table booking.stay_notes (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  account_id uuid not null references auth.users(id),
  at timestamptz not null,
  note text not null check (char_length(btrim(note)) between 1 and 500),
  -- quién la escribió (lo fija el trigger)
  author_id uuid references auth.users(id),
  author_kind text not null default 'staff' check (author_kind in ('outsider','staff'))
);
create index stay_notes_account_idx on booking.stay_notes (account_id, at) where deleted_at is null;
create trigger stay_notes_forbid_reparent before update on booking.stay_notes
  for each row execute function booking.forbid_reparent('account_id');
select core.register_table('booking', 'booking', 'stay_notes', array['account_id','at','note']);

-- ---------------------------------------------------------------------------
-- Reglas de fila
-- ---------------------------------------------------------------------------
-- Cama y espacio coherentes: con cama, el espacio es el suyo. Sirve para estancias y camas por defecto.
create or replace function booking.stay_place(p_table text, p_id uuid, p_space uuid, p_bed uuid)
returns uuid language plpgsql stable as $$
declare v_b booking.beds;
begin
  if p_bed is null then return p_space; end if;
  select * into v_b from booking.beds where id = p_bed and deleted_at is null and active;
  if v_b.id is null or (p_space is not null and p_space <> v_b.space_id) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', p_table, 'id', p_id, 'field', 'bed_id'));
  end if;
  return v_b.space_id;
end $$;

create or replace function booking.stay_row()
returns trigger language plpgsql as $$
declare v_writer text := booking.writer(); d booking.outsider_defaults;
begin
  if v_writer = 'organizer' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'booking.stays')); end if;
  if tg_op = 'INSERT' then
    new.source := case when v_writer = 'guest' then 'guest' else 'staff' end;
    -- sin sitio, la cama por defecto del outsider
    if new.kind = 'outsider' and new.space_id is null and new.bed_id is null and new.resource_space_id is null and new.resource_bed_id is null then
      select * into d from booking.outsider_defaults where account_id = new.account_id and deleted_at is null;
      if d.id is not null then
        new.space_id := d.space_id; new.bed_id := d.bed_id; new.resource_space_id := d.resource_space_id; new.resource_bed_id := d.resource_bed_id;
      end if;
    end if;
  else
    new.source := old.source;
  end if;
  if tg_op = 'INSERT' or new.bed_id is distinct from old.bed_id or new.space_id is distinct from old.space_id then
    new.space_id := booking.stay_place('booking.stays', new.id, new.space_id, new.bed_id);
  end if;
  return new;
end $$;
create trigger stays_row before insert or update on booking.stays
  for each row execute function booking.stay_row();

create or replace function booking.outsider_default_row()
returns trigger language plpgsql as $$
begin
  if booking.writer() <> 'staff' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'booking.outsider_defaults')); end if;
  if tg_op = 'INSERT' or new.bed_id is distinct from old.bed_id or new.space_id is distinct from old.space_id then
    new.space_id := booking.stay_place('booking.outsider_defaults', new.id, new.space_id, new.bed_id);
  end if;
  return new;
end $$;
create trigger outsider_defaults_row before insert or update on booking.outsider_defaults
  for each row execute function booking.outsider_default_row();

create or replace function booking.stay_note_row()
returns trigger language plpgsql as $$
begin
  if booking.writer() = 'organizer' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'booking.stay_notes')); end if;
  if tg_op = 'INSERT' then
    -- (`updated_by` lo pone el núcleo con quien escribe)
    new.author_id := new.updated_by;
    new.author_kind := case when booking.writer() = 'guest' then 'outsider' else 'staff' end;
  else
    new.author_id := old.author_id; new.author_kind := old.author_kind;
  end if;
  return new;
end $$;
create trigger stay_notes_row before insert or update on booking.stay_notes
  for each row execute function booking.stay_note_row();

-- Escritura doble con Recursos (R2), como en las asignaciones: también para estancias y camas por defecto.
create or replace function booking.space_refs_sync()
returns trigger language plpgsql as $$
declare v_space_changed boolean; v_res_changed boolean;
begin
  v_space_changed := tg_op = 'INSERT' and new.space_id is not null or tg_op = 'UPDATE' and new.space_id is distinct from old.space_id;
  v_res_changed := tg_op = 'INSERT' and new.resource_space_id is not null or tg_op = 'UPDATE' and new.resource_space_id is distinct from old.resource_space_id;
  if v_space_changed and not v_res_changed then
    new.resource_space_id := booking.resource_twin('booking.space', new.space_id);
  elsif v_res_changed and not v_space_changed then
    new.space_id := booking.booking_twin('booking.space', new.resource_space_id);
  end if;
  if tg_table_name in ('room_assignments', 'stays', 'outsider_defaults') then
    if (tg_op = 'INSERT' and new.bed_id is not null or tg_op = 'UPDATE' and new.bed_id is distinct from old.bed_id)
       and not (tg_op = 'INSERT' and new.resource_bed_id is not null or tg_op = 'UPDATE' and new.resource_bed_id is distinct from old.resource_bed_id) then
      new.resource_bed_id := booking.resource_twin('booking.bed', new.bed_id);
    elsif (tg_op = 'INSERT' and new.resource_bed_id is not null or tg_op = 'UPDATE' and new.resource_bed_id is distinct from old.resource_bed_id)
       and not (tg_op = 'INSERT' and new.bed_id is not null or tg_op = 'UPDATE' and new.bed_id is distinct from old.bed_id) then
      new.bed_id := booking.booking_twin('booking.bed', new.resource_bed_id);
    end if;
  end if;
  return new;
end $$;
-- (después de `*_row`, que pone la cama por defecto y el espacio de la cama: los triggers van por orden alfabético)
create trigger stays_space_refs before insert or update on booking.stays
  for each row execute function booking.space_refs_sync();
create trigger outsider_defaults_space_refs before insert or update on booking.outsider_defaults
  for each row execute function booking.space_refs_sync();

-- ---------------------------------------------------------------------------
-- Ocupación
-- ---------------------------------------------------------------------------
-- ¿Está libre la cama en las noches de la reserva? Sin contar las asignaciones de `p_guest` (la que va a sustituir).
-- Arreglo: con huésped nulo (el organizador mira la habitación entera) cuentan también las asignaciones de grupo, que
-- antes se escapaban por `guest_id is distinct from null`. Y cuenta una estancia en la cama: así un huésped no elige la
-- cama de un outsider. (Guardar una estancia nunca se bloquea: el choque es un aviso.)
create or replace function booking.bed_free(p_bed uuid, p_event uuid, p_guest uuid)
returns boolean language sql stable as $$
  with mine as (
    select r.start_date d_from, r.end_date d_to from booking.events e join booking.reservations r on r.id = e.reservation_id where e.id = p_event)
  select not exists (
    select 1 from booking.room_assignments a
      join booking.events e on e.id = a.event_id and e.deleted_at is null
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
      cross join mine
     where a.bed_id = p_bed and a.deleted_at is null and (p_guest is null or a.guest_id is distinct from p_guest)
       and coalesce(a.from_date, r.start_date) < mine.d_to and mine.d_from < coalesce(a.to_date, r.end_date))
  and not exists (
    select 1 from booking.stays s cross join mine
     where s.bed_id = p_bed and s.deleted_at is null and s.from_date < mine.d_to and mine.d_from < s.to_date);
$$;

-- Con qué choca una estancia en su cama (o en su habitación, si un retiro la tiene entera sin cama): retiros vivos y
-- otras estancias. Es un aviso: la lista la ve el personal; el outsider solo `clash: true`.
create or replace function booking.stay_clashes(p_stay booking.stays)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(c order by c->>'from', c->>'kind'), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'retiro', 'reservation_id', r.id, 'title', r.title,
             'from', coalesce(a.from_date, r.start_date), 'to', coalesce(a.to_date, r.end_date)) c
      from booking.room_assignments a
      join booking.events e on e.id = a.event_id and e.deleted_at is null
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
     where p_stay.deleted_at is null and a.deleted_at is null and p_stay.space_id is not null
       and ((p_stay.bed_id is not null and a.bed_id = p_stay.bed_id) or (a.bed_id is null and a.space_id = p_stay.space_id))
       and coalesce(a.from_date, r.start_date) < p_stay.to_date and p_stay.from_date < coalesce(a.to_date, r.end_date)
     group by r.id, r.title, coalesce(a.from_date, r.start_date), coalesce(a.to_date, r.end_date)
    union all
    select jsonb_build_object('kind', 'estancia', 'stay_id', s.id, 'from', s.from_date, 'to', s.to_date)
      from booking.stays s
     where p_stay.deleted_at is null and p_stay.bed_id is not null and s.bed_id = p_stay.bed_id and s.id <> p_stay.id and s.deleted_at is null
       and s.from_date < p_stay.to_date and p_stay.from_date < s.to_date) x(c);
$$;

-- Para el personal (Inicio, ficha y Estancias): las estancias vivas que chocan, con su lista.
create or replace function booking.stays_clashing(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_from date; v_to date;
begin
  begin v_from := coalesce((p->'args'->>'from')::date, (now() at time zone 'Europe/Madrid')::date); v_to := coalesce((p->'args'->>'to')::date, v_from + 366);
  exception when others then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from')); end;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('stay_id', s.id, 'account_id', s.account_id, 'kind', s.kind, 'from', s.from_date, 'to', s.to_date, 'clashes', c.list)
             order by s.from_date)
      from booking.stays s cross join lateral (select booking.stay_clashes(s) list) c
     where s.deleted_at is null and s.from_date < v_to and v_from < s.to_date and jsonb_array_length(c.list) > 0), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Portal Guests · ámbito del outsider y de la cuenta
-- ---------------------------------------------------------------------------
-- Solo una cuenta con nivel de casa outsider, desde Guests. Devuelve el actor.
create or replace function booking.portal_outsider(p jsonb)
returns uuid language plpgsql stable as $$
declare v_actor uuid := nullif(p->>'actor', '')::uuid;
begin
  if p->>'app' is distinct from 'guests' or v_actor is null
     or not exists (select 1 from core.house_levels h where h.user_id = v_actor and h.level = 'outsider') then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reason', 'outsider only'));
  end if;
  return v_actor;
end $$;

-- Rango `{from, to}` de una lectura (por defecto, de hoy a tres meses; como mucho, 400 días).
create or replace function booking.portal_range(p jsonb, out d_from date, out d_to date)
language plpgsql stable as $$
begin
  begin
    d_from := coalesce(nullif(p->'args'->>'from', '')::date, (now() at time zone 'Europe/Madrid')::date);
    d_to := coalesce(nullif(p->'args'->>'to', '')::date, d_from + 92);
  exception when others then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from')); end;
  if d_to < d_from or d_to - d_from > 400 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'to')); end if;
end $$;

-- Fichas de huésped de las entradas del actor en Guests.
create or replace function booking.account_guests(p_actor uuid)
returns setof booking.guests language sql stable as $$
  select g.* from booking.guests g
   where g.deleted_at is null and g.id::text in (
     select gr ->> 'guest_id' from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) gr
      where m.app = 'guests' and m.user_id = p_actor);
$$;

-- Claves de persona que ya son de la cuenta: las de sus fichas y las de sus estancias (también pasadas).
create or replace function booking.account_person_keys(p_actor uuid)
returns setof uuid language sql stable as $$
  select person_key from booking.account_guests(p_actor) where person_key is not null
  union
  select sp.person_key from booking.stay_persons sp join booking.stays s on s.id = sp.stay_id where s.account_id = p_actor;
$$;

-- Personas de una acción: `[{person_key?, name}]`. Una clave que llega tiene que ser ya de la cuenta (si no,
-- OUT_OF_SCOPE); sin clave, se crea. Devuelve `[{person_key, name}]` sin repetidas.
create or replace function booking.portal_persons(p_actor uuid, p_persons jsonb)
returns jsonb language plpgsql stable as $$
declare v_item jsonb; v_out jsonb := '[]'::jsonb; v_key uuid; v_name text;
begin
  if p_persons is null or jsonb_typeof(p_persons) = 'null' then return null; end if;
  if jsonb_typeof(p_persons) <> 'array' or jsonb_array_length(p_persons) > 12 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'persons')); end if;
  for v_item in select * from jsonb_array_elements(p_persons) loop
    v_name := btrim(coalesce(v_item->>'name', ''));
    if v_name = '' or char_length(v_name) > 120 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'persons.name')); end if;
    begin v_key := nullif(v_item->>'person_key', '')::uuid; exception when others then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'persons.person_key')); end;
    if v_key is null then
      v_key := gen_random_uuid();
    elsif v_key not in (select booking.account_person_keys(p_actor)) then
      perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('person_key', v_key));
    end if;
    if not exists (select 1 from jsonb_array_elements(v_out) o where o->>'person_key' = v_key::text) then
      v_out := v_out || jsonb_build_object('person_key', v_key, 'name', v_name);
    end if;
  end loop;
  return v_out;
end $$;

create or replace function booking.stay_persons_json(p_stay uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('person_key', sp.person_key, 'name', sp.name) order by sp.created_at, sp.name), '[]'::jsonb)
    from booking.stay_persons sp where sp.stay_id = p_stay and sp.deleted_at is null;
$$;

create or replace function booking.portal_stay_json(s booking.stays)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', s.id, 'revision', s.revision, 'from', s.from_date, 'to', s.to_date, 'source', s.source,
    'persons', booking.stay_persons_json(s.id),
    'space_name', (select booking.space_public_name(x) from booking.spaces x where x.id = s.space_id),
    'zone', (select x.zone from booking.spaces x where x.id = s.space_id),
    'bed_label', (select b.label from booking.beds b where b.id = s.bed_id),
    'clash', jsonb_array_length(booking.stay_clashes(s)) > 0);
$$;

-- Estancia viva del outsider (inexistente y ajena responden igual).
create or replace function booking.portal_stay_row(p_actor uuid, p_id uuid)
returns booking.stays language plpgsql stable as $$
declare s booking.stays;
begin
  select * into s from booking.stays where id = p_id and deleted_at is null and kind = 'outsider' and account_id = p_actor;
  if s.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('stay_id', p_id)); end if;
  return s;
end $$;

create or replace function booking.portal_uuid_arg(p jsonb, p_field text)
returns uuid language plpgsql stable as $$
declare v uuid;
begin
  begin v := nullif(p->'args'->>p_field, '')::uuid; exception when others then v := null; end;
  if v is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', p_field)); end if;
  return v;
end $$;

-- Operaciones que dejan las personas de una estancia como `p_persons` (borra las que sobran y crea o renombra el resto).
create or replace function booking.stay_persons_ops(p_stay uuid, p_persons jsonb)
returns jsonb language plpgsql stable as $$
declare v_ops jsonb := '[]'::jsonb; r record; v_item jsonb; v_cur booking.stay_persons;
begin
  for r in select id, revision, person_key from booking.stay_persons where stay_id = p_stay and deleted_at is null loop
    if not exists (select 1 from jsonb_array_elements(p_persons) o where o->>'person_key' = r.person_key::text) then
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.stay_persons', 'id', r.id, 'expectedRevision', r.revision);
    end if;
  end loop;
  for v_item in select * from jsonb_array_elements(p_persons) loop
    select * into v_cur from booking.stay_persons where stay_id = p_stay and person_key = (v_item->>'person_key')::uuid and deleted_at is null;
    if v_cur.id is null then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.stay_persons', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('stay_id', p_stay, 'person_key', v_item->>'person_key', 'name', v_item->>'name'));
    elsif v_cur.name is distinct from v_item->>'name' then
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.stay_persons', 'id', v_cur.id, 'expectedRevision', v_cur.revision,
        'fields', jsonb_build_object('name', v_item->>'name'));
    end if;
  end loop;
  return v_ops;
end $$;

-- ---------------------------------------------------------------------------
-- Portal Guests · lecturas
-- ---------------------------------------------------------------------------
-- Todas las entradas del actor (cualquier huésped, no solo outsiders), para pintar su calendario de una vez.
create or replace function booking.portal_my_retreats(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid;
begin
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('reservation_id', r.id, 'guest_id', g.id, 'person_key', g.person_key, 'name', g.first_name,
             'title', r.title, 'start_date', r.start_date, 'end_date', r.end_date, 'status', r.status, 'mode', booking.guest_mode(r.id))
             order by r.start_date nulls last, g.created_at)
      from booking.account_guests(v_actor) g
      join booking.events e on e.id = g.event_id and e.deleted_at is null
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null
     where booking.portal_in_scope('guests', v_actor, r.id, g.id)), '[]'::jsonb));
end $$;

create or replace function booking.portal_my_stays(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := booking.portal_outsider(p); v_range record;
begin
  select * into v_range from booking.portal_range(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(booking.portal_stay_json(s) order by s.from_date, s.created_at)
      from booking.stays s
     where s.deleted_at is null and s.kind = 'outsider' and s.account_id = v_actor
       and s.from_date < v_range.d_to and v_range.d_from < s.to_date), '[]'::jsonb),
    'default_bed', (select jsonb_build_object('space_name', (select booking.space_public_name(x) from booking.spaces x where x.id = d.space_id),
        'bed_label', (select b.label from booking.beds b where b.id = d.bed_id))
      from booking.outsider_defaults d where d.account_id = v_actor and d.deleted_at is null));
end $$;

-- Presencia del staff por día, sin quién (aprobado).
create or replace function booking.portal_staff_presence(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := booking.portal_outsider(p); v_range record;
begin
  select * into v_range from booking.portal_range(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('date', d::date, 'present',
             exists (select 1 from booking.stays s where s.deleted_at is null and s.kind = 'staff' and s.from_date <= d::date and d::date < s.to_date)) order by d)
      from generate_series(v_range.d_from, v_range.d_to - 1, interval '1 day') d), '[]'::jsonb));
end $$;

create or replace function booking.portal_stay_notes(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := booking.portal_outsider(p); v_range record;
begin
  select * into v_range from booking.portal_range(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', n.id, 'revision', n.revision, 'at', n.at, 'text', n.note,
             'mine', n.author_id is not distinct from v_actor, 'by', n.author_kind) order by n.at, n.created_at)
      from booking.stay_notes n
     where n.deleted_at is null and n.account_id = v_actor
       and n.at >= (v_range.d_from::timestamp at time zone 'Europe/Madrid') and n.at < (v_range.d_to::timestamp at time zone 'Europe/Madrid')), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Portal Guests · acciones del outsider
-- ---------------------------------------------------------------------------
-- Crea o mueve una estancia. Sin sitio, la cama por defecto. `persons` (opcional) deja la lista tal cual.
create or replace function booking.portal_stay_save(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_actor uuid := booking.portal_outsider(p); v_id uuid := booking.portal_uuid_arg(p, 'id'); s booking.stays;
  v_from date; v_to date; v_persons jsonb; v_ops jsonb := '[]'::jsonb; v_out jsonb; v_fields jsonb;
begin
  begin v_from := (p->'args'->>'from')::date; v_to := (p->'args'->>'to')::date; exception when others then v_from := null; end;
  if v_from is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from')); end if;
  if v_to is null or v_to <= v_from or v_to - v_from > 180 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'to')); end if;
  v_persons := booking.portal_persons(v_actor, p->'args'->'persons');
  select * into s from booking.stays where id = v_id;
  if s.id is null then
    v_ops := jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.stays', 'id', v_id,
      'fields', jsonb_build_object('kind', 'outsider', 'account_id', v_actor, 'from_date', v_from, 'to_date', v_to)));
  else
    s := booking.portal_stay_row(v_actor, v_id);
    v_fields := '{}'::jsonb;
    if s.from_date <> v_from then v_fields := v_fields || jsonb_build_object('from_date', v_from); end if;
    if s.to_date <> v_to then v_fields := v_fields || jsonb_build_object('to_date', v_to); end if;
    if v_fields <> '{}'::jsonb then
      v_ops := jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.stays', 'id', v_id,
        'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, s.revision), 'fields', v_fields));
    end if;
  end if;
  if v_persons is not null then v_ops := v_ops || booking.stay_persons_ops(v_id, v_persons); end if;
  if v_ops <> '[]'::jsonb then v_out := booking.portal_apply('guest', v_ops); end if;
  select * into s from booking.stays where id = v_id;
  return jsonb_build_object('id', s.id, 'revision', s.revision, 'clash', jsonb_array_length(booking.stay_clashes(s)) > 0, 'cursor', v_out->'cursor');
end $$;

-- Separa a unas personas de la estancia en otra, con otras fechas y la misma cama, en un solo lote.
create or replace function booking.portal_stay_split(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_actor uuid := booking.portal_outsider(p); s booking.stays := booking.portal_stay_row(v_actor, booking.portal_uuid_arg(p, 'id'));
  v_keys uuid[]; v_total int; v_from date; v_to date; v_new uuid := gen_random_uuid(); v_ops jsonb; r booking.stay_persons; n booking.stays;
begin
  begin
    select array_agg(distinct k::uuid) into v_keys from jsonb_array_elements_text(p->'args'->'person_keys') k;
    v_from := (p->'args'->>'from')::date; v_to := (p->'args'->>'to')::date;
  exception when others then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'person_keys')); end;
  if v_from is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from')); end if;
  if v_to is null or v_to <= v_from or v_to - v_from > 180 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'to')); end if;
  select count(*) into v_total from booking.stay_persons where stay_id = s.id and deleted_at is null;
  -- al menos una persona y no todas (eso es mover la estancia), y todas de esta estancia
  if v_keys is null or cardinality(v_keys) >= v_total
     or exists (select 1 from unnest(v_keys) k where not exists (select 1 from booking.stay_persons sp where sp.stay_id = s.id and sp.person_key = k and sp.deleted_at is null)) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'person_keys'));
  end if;
  v_ops := jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.stays', 'id', v_new,
    'fields', jsonb_strip_nulls(jsonb_build_object('kind', 'outsider', 'account_id', v_actor, 'from_date', v_from, 'to_date', v_to,
      'space_id', s.space_id, 'bed_id', s.bed_id, 'resource_space_id', s.resource_space_id, 'resource_bed_id', s.resource_bed_id))));
  for r in select * from booking.stay_persons where stay_id = s.id and deleted_at is null and person_key = any(v_keys) order by created_at loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.stay_persons', 'id', r.id, 'expectedRevision', r.revision)
                   || jsonb_build_object('op', 'insert', 'table', 'booking.stay_persons', 'id', gen_random_uuid(),
                        'fields', jsonb_build_object('stay_id', v_new, 'person_key', r.person_key, 'name', r.name));
  end loop;
  perform booking.portal_apply('guest', v_ops);
  select * into n from booking.stays where id = v_new;
  return booking.portal_stay_json(n);
end $$;

create or replace function booking.portal_stay_remove(p jsonb)
returns jsonb language plpgsql as $$
declare v_actor uuid := booking.portal_outsider(p); s booking.stays := booking.portal_stay_row(v_actor, booking.portal_uuid_arg(p, 'id'));
  v_ops jsonb := '[]'::jsonb; r record; v_out jsonb;
begin
  for r in select id, revision from booking.stay_persons where stay_id = s.id and deleted_at is null loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.stay_persons', 'id', r.id, 'expectedRevision', r.revision);
  end loop;
  v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.stays', 'id', s.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, s.revision));
  v_out := booking.portal_apply('guest', v_ops);
  return jsonb_build_object('id', s.id, 'cursor', v_out->'cursor');
end $$;

-- Notas: el outsider crea las suyas y solo cambia o quita las suyas (las del personal las ve).
create or replace function booking.portal_stay_note_save(p jsonb)
returns jsonb language plpgsql as $$
declare v_actor uuid := booking.portal_outsider(p); v_id uuid := booking.portal_uuid_arg(p, 'id'); n booking.stay_notes;
  v_at timestamptz; v_text text := btrim(coalesce(p->'args'->>'text', '')); v_out jsonb;
begin
  begin v_at := (p->'args'->>'at')::timestamptz; exception when others then v_at := null; end;
  if v_at is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'at')); end if;
  if v_text = '' or char_length(v_text) > 500 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'text')); end if;
  select * into n from booking.stay_notes where id = v_id;
  if n.id is null then
    v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.stay_notes', 'id', v_id,
      'fields', jsonb_build_object('account_id', v_actor, 'at', v_at, 'note', v_text))));
  else
    if n.deleted_at is not null or n.account_id <> v_actor or n.author_id is distinct from v_actor then
      perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('note_id', v_id));
    end if;
    v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.stay_notes', 'id', v_id,
      'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, n.revision), 'fields', jsonb_build_object('at', v_at, 'note', v_text))));
  end if;
  return jsonb_build_object('id', v_id, 'revision', (select revision from booking.stay_notes where id = v_id), 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_stay_note_remove(p jsonb)
returns jsonb language plpgsql as $$
declare v_actor uuid := booking.portal_outsider(p); v_id uuid := booking.portal_uuid_arg(p, 'id'); n booking.stay_notes; v_out jsonb;
begin
  select * into n from booking.stay_notes where id = v_id and deleted_at is null and account_id = v_actor and author_id = v_actor;
  if n.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('note_id', v_id)); end if;
  v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'delete', 'table', 'booking.stay_notes', 'id', v_id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, n.revision))));
  return jsonb_build_object('id', v_id, 'cursor', v_out->'cursor');
end $$;

-- ---------------------------------------------------------------------------
-- Portal Guests · agrupar fichas de la misma persona (cualquier huésped con varias entradas)
-- ---------------------------------------------------------------------------
-- `{guest_ids, person_key?}`: las fichas, todas de las entradas del actor y de retiros distintos, quedan con la misma
-- clave (la que llega, si ya es de la cuenta; si no, la que ya tenga alguna; si no, una nueva).
create or replace function booking.portal_person_link(p jsonb)
returns jsonb language plpgsql as $$
declare v_actor uuid := (p->>'actor')::uuid; v_ids uuid[]; v_key uuid; v_ops jsonb := '[]'::jsonb; g booking.guests; v_out jsonb;
begin
  begin
    select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(p->'args'->'guest_ids') x;
    v_key := nullif(p->'args'->>'person_key', '')::uuid;
  exception when others then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'guest_ids')); end;
  if v_ids is null or cardinality(v_ids) > 50 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'guest_ids')); end if;
  if exists (select 1 from unnest(v_ids) i where i not in (select id from booking.account_guests(v_actor))) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reason', 'guest_ids'));
  end if;
  if v_key is not null and v_key not in (select booking.account_person_keys(v_actor)) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('person_key', v_key));
  end if;
  v_key := coalesce(v_key, (select person_key from booking.guests where id = any(v_ids) and person_key is not null order by created_at limit 1), gen_random_uuid());
  -- una persona no está dos veces en un mismo retiro
  if exists (select 1 from booking.guests where id = any(v_ids) group by event_id having count(*) > 1)
     or exists (select 1 from booking.guests o where o.person_key = v_key and o.deleted_at is null and not (o.id = any(v_ids))
                  and o.event_id in (select event_id from booking.guests where id = any(v_ids))) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'guest_ids', 'reason', 'same retreat'));
  end if;
  for g in select * from booking.guests where id = any(v_ids) and person_key is distinct from v_key loop
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', g.id, 'expectedRevision', g.revision,
      'fields', jsonb_build_object('person_key', v_key));
  end loop;
  if v_ops <> '[]'::jsonb then v_out := booking.portal_apply('guest', v_ops); end if;
  return jsonb_build_object('person_key', v_key, 'cursor', v_out->'cursor');
end $$;

-- ---------------------------------------------------------------------------
-- Registro
-- ---------------------------------------------------------------------------
select core.allow_read('booking', 'booking.stays_clashing', 'function', '{reader,editor,owner}');
select core.allow_read('guests', 'booking.portal_my_retreats', 'function', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_my_stays', 'function', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_staff_presence', 'function', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_stay_notes', 'function', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_stay_save', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_stay_split', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_stay_remove', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_stay_note_save', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_stay_note_remove', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_person_link', 'action', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
