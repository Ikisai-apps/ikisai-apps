-- Ikisai Booking · fase 2 de los portales, parte 2: diseño del retiro desde el portal, extras pedidos, tarifas para la
-- calculadora y peticiones sobre la propuesta (Organizers B7d, B9, B10 y B12; ajustes aprobados por Core el 7-10-2026).
-- El organizador diseña y pide; la propuesta y su aceptación son del personal. Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- B7d · notas del organizador en la reserva
-- ---------------------------------------------------------------------------
alter table booking.reservations add column organizer_notes text check (organizer_notes is null or length(organizer_notes) <= 2000);
select core.register_table('booking', 'booking', 'reservations', array[
  'title','event_type','status','priority','start_date','end_date','expected_guests','minors_count',
  'contact_name','contact_phone','contact_email','customer_type',
  'uses_accommodation','requires_meals','meal_plan_requested','menu_style_requested','meal_notes',
  'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support',
  'customer_notes','briefing_received','internal_notes','archived_at',
  'ses_enabled','ses_disabled_reason','ses_disabled_note','collect_guest_data','dates_definitive','organizer_notes']);

-- ---------------------------------------------------------------------------
-- B10 · catálogo visible en el portal y extras pedidos (aparte de la propuesta)
-- ---------------------------------------------------------------------------
alter table booking.rates
  add column portal_visible boolean not null default false,
  add column public_name text check (public_name is null or length(btrim(public_name)) between 1 and 120),
  add column public_description text check (public_description is null or length(public_description) <= 1000);
select core.register_table('booking', 'booking', 'rates', array['name','layer','unit','amount','service','min_persons','max_persons',
  'event_types','valid_from','valid_to','includes','excludes','active','position','portal_visible','public_name','public_description'], '{editor,owner}', '{owner}');

create table booking.reservation_extra_requests (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id),
  rate_id uuid not null references booking.rates(id),
  quantity numeric(10,2) not null default 1 check (quantity > 0),
  note text check (note is null or length(note) <= 500)
);
create index reservation_extra_requests_reservation_idx on booking.reservation_extra_requests (reservation_id) where deleted_at is null;
create trigger reservation_extra_requests_forbid_reparent before update on booking.reservation_extra_requests
  for each row execute function booking.forbid_reparent('reservation_id');
select core.register_table('booking', 'booking', 'reservation_extra_requests', array['reservation_id','rate_id','quantity','note'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- B9 · mínimo comercial por retiro en las condiciones (queda fijado con la propuesta)
-- ---------------------------------------------------------------------------
alter table booking.conditions add column minimum_total numeric(12,2) check (minimum_total is null or minimum_total >= 0);
select core.register_table('booking', 'booking', 'conditions', array['name','deposit_percent','deposit_minimum','deposit_days',
  'deposit_days_short','short_notice_days','prices_include_vat','vat_rate','text','is_default','active','minimum_total'], '{editor,owner}', '{owner}');

-- ---------------------------------------------------------------------------
-- B12 · peticiones del organizador sobre la propuesta («Quiero confirmar» o comentario). La aceptación es del personal.
-- ---------------------------------------------------------------------------
create table booking.portal_requests (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id),
  kind text not null check (kind in ('quiere_confirmar','comentario')),
  proposal_id uuid references booking.proposals(id),
  message text check (message is null or length(message) <= 2000),
  requested_by uuid references auth.users(id),
  status text not null default 'enviada' check (status in ('enviada','vista','respondida'))
);
create index portal_requests_reservation_idx on booking.portal_requests (reservation_id, created_at desc) where deleted_at is null;
create trigger portal_requests_forbid_reparent before update on booking.portal_requests
  for each row execute function booking.forbid_reparent('reservation_id');
select core.register_table('booking', 'booking', 'portal_requests', array['reservation_id','kind','proposal_id','message','requested_by','status'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- B7d · diseño del retiro desde el portal: solo en estudio o negociación y solo campos de diseño
-- ---------------------------------------------------------------------------
create or replace function booking.portal_update_draft(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_r booking.reservations; v_fields jsonb; v_ops jsonb := '[]'::jsonb; v_item jsonb; x record; v_rate booking.rates; v_out jsonb;
  v_allowed constant text[] := array['expected_guests','minors_count','meal_plan_requested','menu_style_requested','uses_accommodation','requires_meals',
    'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support','organizer_notes'];
begin
  v_r := booking.portal_reservation_row(p);
  if v_r.status not in ('en_estudio','negociacion') then perform core.fail('DRAFT_LOCKED', 422, jsonb_build_object('reservation_id', v_r.id, 'status', v_r.status)); end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_fields from jsonb_each(coalesce(p->'args'->'fields', '{}'::jsonb)) where key = any(v_allowed);
  if v_fields <> '{}'::jsonb then
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.reservations', 'id', v_r.id,
      'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_r.revision), 'fields', v_fields);
  end if;
  -- extras: la lista enviada sustituye a la anterior (solo tarifas visibles en el portal y activas)
  if jsonb_typeof(p->'args'->'extras') = 'array' then
    if jsonb_array_length(p->'args'->'extras') > 30 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'como mucho 30 extras')); end if;
    for x in select id, revision from booking.reservation_extra_requests where reservation_id = v_r.id and deleted_at is null loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.reservation_extra_requests', 'id', x.id, 'expectedRevision', x.revision);
    end loop;
    for v_item in select * from jsonb_array_elements(p->'args'->'extras') loop
      select * into v_rate from booking.rates where id = (v_item->>'rate_id')::uuid and deleted_at is null and active and portal_visible;
      if v_rate.id is null then perform core.fail('EXTRA_NOT_OFFERED', 422, jsonb_build_object('rate_id', v_item->>'rate_id')); end if;
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.reservation_extra_requests', 'id', gen_random_uuid(), 'fields', jsonb_strip_nulls(
        jsonb_build_object('reservation_id', v_r.id, 'rate_id', v_rate.id, 'quantity', coalesce((v_item->>'quantity')::numeric, 1), 'note', left(v_item->>'note', 500))));
    end loop;
  end if;
  if v_ops = '[]'::jsonb then return jsonb_build_object('reservation_id', v_r.id, 'revision', v_r.revision, 'cursor', null); end if;
  v_out := booking.portal_apply('organizer', v_ops);
  return jsonb_build_object('reservation_id', v_r.id, 'revision', (select revision from booking.reservations where id = v_r.id), 'cursor', v_out->'cursor');
end $$;

-- Extras pedidos por el organizador (para la ficha del portal).
create or replace function booking.portal_extra_requests(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations;
begin
  v_r := booking.portal_reservation_row(p);
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('rate_id', e.rate_id, 'quantity', e.quantity, 'note', e.note,
      'name', coalesce(r.public_name, r.name)) order by e.created_at)
    from booking.reservation_extra_requests e join booking.rates r on r.id = e.rate_id where e.reservation_id = v_r.id and e.deleted_at is null), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- B9 · tarifas para la calculadora del portal (el cálculo lo hace Organizers con @ikisai/domain-booking)
-- ---------------------------------------------------------------------------
create or replace function booking.portal_rates(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations; v_c booking.conditions; v_items jsonb;
begin
  v_r := booking.portal_reservation_row(p);
  select * into v_c from booking.conditions where is_default and active and deleted_at is null limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', coalesce(r.public_name, r.name), 'description', r.public_description,
      'layer', r.layer, 'unit', r.unit, 'amount', r.amount, 'service', r.service, 'min_persons', r.min_persons, 'max_persons', r.max_persons,
      'event_types', r.event_types, 'valid_from', r.valid_from, 'valid_to', r.valid_to, 'active', r.active, 'position', r.position) order by r.layer, r.position), '[]'::jsonb)
    into v_items from booking.rates r where r.deleted_at is null and r.active and r.portal_visible;
  return jsonb_build_object('available', jsonb_array_length(v_items) > 0, 'rates', v_items,
    'conditions', case when v_c.id is null then null else jsonb_build_object('prices_include_vat', v_c.prices_include_vat, 'vat_rate', v_c.vat_rate,
      'deposit_percent', v_c.deposit_percent, 'deposit_minimum', v_c.deposit_minimum, 'minimum_total', v_c.minimum_total) end);
end $$;

-- ---------------------------------------------------------------------------
-- B12 · propuestas enviadas o aceptadas para el portal, y peticiones del organizador
-- ---------------------------------------------------------------------------
create or replace function booking.portal_proposals(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations;
begin
  v_r := booking.portal_reservation_row(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'version', x.version, 'status', x.status, 'nature', x.nature, 'start_date', x.start_date, 'end_date', x.end_date,
        'persons', x.persons, 'subtotal', x.subtotal, 'adjustments', x.adjustments, 'vat_amount', x.vat_amount, 'total', x.total, 'deposit_amount', x.deposit_amount,
        'valid_until', x.valid_until, 'includes', x.includes, 'excludes', x.excludes, 'sent_at', x.sent_at, 'decided_at', x.decided_at,
        'conditions', (select jsonb_build_object('name', c.name, 'text', c.text, 'prices_include_vat', c.prices_include_vat, 'vat_rate', c.vat_rate,
            'deposit_percent', c.deposit_percent, 'deposit_minimum', c.deposit_minimum, 'deposit_days', c.deposit_days, 'deposit_days_short', c.deposit_days_short,
            'short_notice_days', c.short_notice_days,
            'tiers', coalesce((select jsonb_agg(jsonb_build_object('min_days_before', t.min_days_before, 'deposit_refund_pct', t.deposit_refund_pct, 'extra_costs', t.extra_costs)
              order by t.min_days_before desc) from booking.cancellation_tiers t where t.conditions_id = c.id and t.deleted_at is null), '[]'::jsonb))
          from booking.conditions c where c.id = x.conditions_id),
        'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l.description, 'unit', l.unit, 'quantity', l.quantity, 'unit_amount', l.unit_amount,
            'discount_pct', l.discount_pct, 'amount', l.amount) order by l.position) from booking.proposal_lines l where l.proposal_id = x.id and l.deleted_at is null), '[]'::jsonb))
      order by x.version desc)
      from booking.proposals x where x.reservation_id = v_r.id and x.deleted_at is null and x.status in ('enviada','aceptada')), '[]'::jsonb));
end $$;

create or replace function booking.portal_request(p jsonb)
returns jsonb language plpgsql as $$
declare v_r booking.reservations; v_kind text := p->'args'->>'kind'; v_proposal uuid; v_msg text := nullif(btrim(coalesce(p->'args'->>'message', '')), ''); v_id uuid := gen_random_uuid(); v_out jsonb;
begin
  v_r := booking.portal_reservation_row(p);
  if v_kind not in ('quiere_confirmar','comentario') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'kind: quiere_confirmar o comentario')); end if;
  if v_kind = 'comentario' and v_msg is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'message')); end if;
  begin v_proposal := nullif(p->'args'->>'proposal_id', '')::uuid; exception when others then v_proposal := null; end;
  if v_proposal is not null and not exists (select 1 from booking.proposals where id = v_proposal and reservation_id = v_r.id and status in ('enviada','aceptada') and deleted_at is null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('proposal_id', v_proposal));
  end if;
  v_out := booking.portal_apply('organizer', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.portal_requests', 'id', v_id, 'fields', jsonb_strip_nulls(
    jsonb_build_object('reservation_id', v_r.id, 'kind', v_kind, 'proposal_id', v_proposal, 'message', left(v_msg, 2000), 'requested_by', (p->>'actor')::uuid)))));
  insert into booking.portal_notices (reservation_id, kind, actor) values (v_r.id, v_kind, (p->>'actor')::uuid);
  return jsonb_build_object('id', v_id, 'status', 'enviada', 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_my_requests(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations;
begin
  v_r := booking.portal_reservation_row(p);
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'proposal_id', q.proposal_id, 'message', q.message,
      'status', q.status, 'created_at', q.created_at, 'mine', q.requested_by = (p->>'actor')::uuid) order by q.created_at desc)
    from booking.portal_requests q where q.reservation_id = v_r.id and q.deleted_at is null), '[]'::jsonb));
end $$;

select core.allow_read('organizers', 'booking.portal_update_draft', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_extra_requests', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_rates', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_proposals', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_request', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_my_requests', 'function', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
