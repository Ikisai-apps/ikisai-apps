-- Ikisai Booking · SES.HOSPEDAJES, paso 1: interruptores por reserva y ajuste global (docs/booking/API.md §17.1;
-- diseño del usuario en coordinacion/ampliacion/SES.md §2). Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Interruptores de la reserva
-- ---------------------------------------------------------------------------
alter table booking.reservations
  add column ses_enabled boolean not null default true,
  add column ses_disabled_reason text check (ses_disabled_reason is null or ses_disabled_reason in ('uso_privado','prueba','otro')),
  add column ses_disabled_note text check (ses_disabled_note is null or length(ses_disabled_note) <= 300),
  add column collect_guest_data boolean not null default true,
  -- sin comunicar a SES hace falta un motivo; con «otro», el texto
  add constraint reservations_ses_reason check (ses_enabled or (ses_disabled_reason is not null
    and (ses_disabled_reason <> 'otro' or length(btrim(coalesce(ses_disabled_note, ''))) > 0)));

select core.register_table('booking', 'booking', 'reservations', array[
  'title','event_type','status','priority','start_date','end_date','expected_guests','minors_count',
  'contact_name','contact_phone','contact_email','customer_type',
  'uses_accommodation','requires_meals','meal_plan_requested','menu_style_requested','meal_notes',
  'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support',
  'customer_notes','briefing_received','internal_notes','archived_at',
  'ses_enabled','ses_disabled_reason','ses_disabled_note','collect_guest_data']);

-- ---------------------------------------------------------------------------
-- Ajuste global: entorno de SES y pausa de envíos (una fila; lee editor/owner, escribe owner). Las credenciales y los
-- códigos de arrendador y establecimiento son secretos de la Edge (`SES_PRE_*`, `SES_PROD_*`), nunca columnas.
-- ---------------------------------------------------------------------------
create table booking.ses_settings (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  environment text not null default 'pre' check (environment in ('pre','prod')),
  paused boolean not null default false
);
create unique index ses_settings_single on booking.ses_settings ((true)) where deleted_at is null;
select core.register_table('booking', 'booking', 'ses_settings', array['environment','paused'], '{editor,owner}', '{owner}');
insert into booking.ses_settings (environment, paused) values ('pre', false);

-- ---------------------------------------------------------------------------
-- Modo de la reserva para lo que se pide a los huéspedes (espejo de `guestModeOf` del dominio):
-- `ses` (datos legales y firma), `operativo` (sin SES: nombre, contacto, alergias y dieta) o `ninguno` (sin lista).
-- ---------------------------------------------------------------------------
create or replace function booking.guest_mode(p_reservation uuid)
returns text language sql stable as $$
  select case when r.ses_enabled then 'ses' when r.collect_guest_data then 'operativo' else 'ninguno' end
    from booking.reservations r where r.id = p_reservation
  union all select 'ses' limit 1;
$$;

-- `ninguno`: no se pide nada.
create or replace function booking.guest_missing(g booking.guests, p_mode text)
returns text[] language plpgsql immutable as $$
declare v text[] := '{}';
begin
  if p_mode = 'ninguno' then return v; end if;
  if coalesce(btrim(g.first_name), '') = '' then v := array_append(v, 'first_name'); end if;
  if p_mode = 'operativo' then
    if coalesce(btrim(g.phone), '') = '' and coalesce(btrim(g.email), '') = '' then v := array_append(v, 'contact'); end if;
    return v;
  end if;
  if coalesce(btrim(g.last_name_1), '') = '' then v := array_append(v, 'last_name_1'); end if;
  if g.birth_date is null then v := array_append(v, 'birth_date'); end if;
  if coalesce(btrim(g.residence_address), '') = '' then v := array_append(v, 'residence_address'); end if;
  if coalesce(btrim(g.residence_postal_code), '') = '' then v := array_append(v, 'residence_postal_code'); end if;
  if coalesce(btrim(g.residence_city), '') = '' then v := array_append(v, 'residence_city'); end if;
  if coalesce(btrim(g.residence_country), '') = '' then v := array_append(v, 'residence_country'); end if;
  if coalesce(btrim(g.phone), '') = '' and coalesce(btrim(g.email), '') = '' then v := array_append(v, 'contact'); end if;
  if g.is_minor then
    if coalesce(btrim(g.kinship), '') = '' then v := array_append(v, 'kinship'); end if;
  else
    if g.document_type is null then v := array_append(v, 'document_type'); end if;
    if coalesce(btrim(g.document_number), '') = '' then v := array_append(v, 'document_number'); end if;
  end if;
  if g.document_type = 'DNI' and coalesce(btrim(g.last_name_2), '') = '' then v := array_append(v, 'last_name_2'); end if;
  if g.document_type in ('DNI','NIE') and coalesce(btrim(g.document_support_number), '') = '' then v := array_append(v, 'document_support_number'); end if;
  return v;
end $$;

-- Campos que un portal puede escribir según el modo: en `operativo`, solo nombre, apellido y contacto.
create or replace function booking.portal_clean_fields(p_fields jsonb, p_mode text)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(coalesce(p_fields, '{}'::jsonb))
   where key = any(booking.portal_guest_fields())
     and (p_mode = 'ses' or key in ('first_name','last_name_1','phone','email'));
$$;

-- ---------------------------------------------------------------------------
-- Acciones y lecturas de portal que dependen del modo (redefinidas desde la 0433)
-- ---------------------------------------------------------------------------
create or replace function booking.portal_add_guest(p jsonb)
returns jsonb language plpgsql as $$
declare v_res uuid; v_event uuid; v_id uuid; v_fields jsonb; v_mode text; v_out jsonb;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; v_id := (p->'args'->>'guest_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reservation_id and guest_id must be uuids')); end if;
  if not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  select e.id into v_event from booking.events e join booking.reservations r on r.id = e.reservation_id
   where e.reservation_id = v_res and e.deleted_at is null and r.deleted_at is null and r.status not in ('cancelada','perdida');
  if v_event is null then perform core.fail('RESERVATION_NOT_CONFIRMED', 422, jsonb_build_object('reservation_id', v_res)); end if;
  v_mode := booking.guest_mode(v_res);
  if v_mode = 'ninguno' then perform core.fail('GUEST_DATA_OFF', 422, jsonb_build_object('reservation_id', v_res)); end if;
  v_fields := booking.portal_clean_fields(p->'args'->'fields', v_mode);
  if coalesce(btrim(v_fields->>'first_name'), '') = '' then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'first_name')); end if;
  v_out := booking.portal_apply('organizer', booking.portal_declaration_ops(p, v_res) || jsonb_build_array(
    jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id, 'fields', v_fields || jsonb_build_object('event_id', v_event))));
  return jsonb_build_object('guest_id', v_id, 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_update_guest(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_fields jsonb; v_mode text; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  v_mode := booking.guest_mode(booking.portal_reservation_of(v_g));
  if v_mode = 'ninguno' then perform core.fail('GUEST_DATA_OFF', 422, jsonb_build_object('guest_id', v_g.id)); end if;
  v_fields := booking.portal_clean_fields(p->'args'->'fields', v_mode);
  if v_fields = '{}'::jsonb then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'no fields')); end if;
  v_out := booking.portal_apply('organizer', booking.portal_declaration_ops(p, booking.portal_reservation_of(v_g)) || jsonb_build_array(
    jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
      'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision), 'fields', v_fields)));
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_guest_update(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_fields jsonb; v_mode text; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  v_mode := booking.guest_mode(booking.portal_reservation_of(v_g));
  if v_mode = 'ninguno' then perform core.fail('GUEST_DATA_OFF', 422, jsonb_build_object('guest_id', v_g.id)); end if;
  v_fields := booking.portal_clean_fields(p->'args'->'fields', v_mode);
  if v_fields = '{}'::jsonb then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'no fields')); end if;
  v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision), 'fields', v_fields)));
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_guest_sign(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_file uuid; v_name text := btrim(coalesce(p->'args'->>'signed_by_name', '')); v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  -- sin comunicación a SES no hay parte que firmar (minimización)
  if booking.guest_mode(booking.portal_reservation_of(v_g)) <> 'ses' then
    perform core.fail('GUEST_DATA_OFF', 422, jsonb_build_object('guest_id', v_g.id, 'reason', 'signature'));
  end if;
  begin v_file := (p->'args'->>'file_id')::uuid; exception when others then v_file := null; end;
  if v_file is null or not exists (select 1 from core.files f where f.id = v_file and f.app = 'guests' and f.created_by = (p->>'actor')::uuid and f.status = 'verified') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'file must be a verified upload of this guest'));
  end if;
  if v_name = '' or length(v_name) > 200 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'signed_by_name')); end if;
  v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision),
    'fields', jsonb_build_object('signature_file_id', v_file, 'signed_at', now(), 'signed_by_name', v_name))));
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_guests(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_event uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select id into v_event from booking.events where reservation_id = v_res and deleted_at is null;
  if v_event is null then return jsonb_build_object('confirmed', false, 'mode', booking.guest_mode(v_res), 'items', '[]'::jsonb); end if;
  if booking.guest_mode(v_res) = 'ninguno' then return jsonb_build_object('confirmed', true, 'mode', 'ninguno', 'items', '[]'::jsonb); end if;
  return jsonb_build_object('confirmed', true, 'mode', booking.guest_mode(v_res), 'items', coalesce((
    select jsonb_agg(booking.portal_organizer_guest(g) order by g.created_at)
      from booking.guests g where g.event_id = v_event and g.deleted_at is null), '[]'::jsonb));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
