-- Ikisai Booking · ampliación V2, bloque 3: tarifario, condiciones comerciales y propuestas versionadas.
-- Referencia: docs/booking/API.md §15.2 (visto bueno de Core, rondas 15 y 17). Toca solo el schema booking.
-- Precios con IVA incluido por defecto y tarifa sugerida y cambiable línea a línea; ambas cosas se cambian sin migración
-- (`prices_include_vat` y `vat_rate` en las condiciones; la sugerencia es solo de la interfaz).
-- Respuestas del usuario (ronda 18): IVA incluido (10 %), la app sugiere y el equipo aplica un descuento en % o cambia el
-- importe a mano; un catálogo de extras (sonido, supletorias, cambios de camas, movimientos de mobiliario…) en la capa `extra`.

-- ---------------------------------------------------------------------------
-- Tarifario (C03 §8.5–§8.7). Solo el owner escribe.
-- ---------------------------------------------------------------------------
create table booking.rates (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  name text not null check (length(btrim(name)) between 1 and 120),
  layer text not null check (layer in ('recinto','por_persona','servicio','ajuste','extra')),
  unit text not null check (unit in ('persona_noche','persona_dia','dia','noche','estancia','unidad','porcentaje')),
  amount numeric(12,2) not null check (unit = 'porcentaje' or amount >= 0),
  -- servicio de la reserva del que depende la sugerencia (null = siempre)
  service text check (service is null or service in ('alojamiento','comidas','centro_interpretacion','exterior','piscina','montaje','tecnico','cama_supletoria')),
  min_persons integer check (min_persons is null or min_persons >= 0),
  max_persons integer check (max_persons is null or max_persons >= 0),
  event_types text[],
  valid_from date,
  valid_to date,
  includes text,
  excludes text,
  active boolean not null default true,
  position numeric not null default 0,
  constraint rates_persons check (min_persons is null or max_persons is null or max_persons >= min_persons),
  constraint rates_dates check (valid_from is null or valid_to is null or valid_to >= valid_from),
  constraint rates_percent check (unit <> 'porcentaje' or (amount between -100 and 100))
);
create index rates_position_idx on booking.rates (layer, position) where deleted_at is null;
create trigger rates_assign_code before insert on booking.rates
  for each row execute function booking.assign_code('TAR');

select core.register_table('booking', 'booking', 'rates', array['name','layer','unit','amount','service','min_persons','max_persons',
  'event_types','valid_from','valid_to','includes','excludes','active','position'], '{editor,owner}', '{owner}');

-- ---------------------------------------------------------------------------
-- Condiciones comerciales (C03 §9–§10) y tramos de cancelación (C03 §10.3). Solo el owner escribe.
-- Unas condiciones usadas por una propuesta enviada ya no cambian (la propuesta impresa debe seguir diciendo lo mismo):
-- se crean unas nuevas.
-- ---------------------------------------------------------------------------
create table booking.conditions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) between 1 and 120),
  deposit_percent numeric(5,2) not null default 30 check (deposit_percent between 0 and 100),
  deposit_minimum numeric(12,2) not null default 0 check (deposit_minimum >= 0),
  deposit_days integer not null default 5 check (deposit_days >= 0),
  deposit_days_short integer not null default 2 check (deposit_days_short >= 0),
  short_notice_days integer not null default 15 check (short_notice_days >= 0),
  prices_include_vat boolean not null default true,
  vat_rate numeric(5,2) not null default 10 check (vat_rate between 0 and 100),
  text text,
  is_default boolean not null default false,
  active boolean not null default true
);
create unique index conditions_one_default on booking.conditions ((true)) where is_default and deleted_at is null;

select core.register_table('booking', 'booking', 'conditions', array['name','deposit_percent','deposit_minimum','deposit_days',
  'deposit_days_short','short_notice_days','prices_include_vat','vat_rate','text','is_default','active'], '{editor,owner}', '{owner}');

create table booking.cancellation_tiers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  conditions_id uuid not null references booking.conditions(id),
  min_days_before integer not null check (min_days_before >= 0),
  deposit_refund_pct numeric(5,2) not null check (deposit_refund_pct between 0 and 100),
  extra_costs boolean not null default false,
  position numeric not null default 0
);
create index cancellation_tiers_conditions_idx on booking.cancellation_tiers (conditions_id) where deleted_at is null;
create trigger cancellation_tiers_forbid_reparent before update on booking.cancellation_tiers
  for each row execute function booking.forbid_reparent('conditions_id');

select core.register_table('booking', 'booking', 'cancellation_tiers', array['conditions_id','min_days_before','deposit_refund_pct',
  'extra_costs','position'], '{editor,owner}', '{owner}');

-- ---------------------------------------------------------------------------
-- Propuestas por reserva, versionadas, y sus líneas.
-- Los totales, la señal y `sent_at` los fija `booking.send_proposal`; `status` pasa a enviada, aceptada o sustituida
-- solo por procedimiento. Un borrador se edita libremente; una enviada ya no (PROPOSAL_LOCKED).
-- ---------------------------------------------------------------------------
create table booking.proposals (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id),
  version integer not null,
  status text not null default 'borrador' check (status in ('borrador','enviada','aceptada','rechazada','caducada','sustituida')),
  nature text not null default 'orientativa' check (nature in ('orientativa','cerrada')),
  conditions_id uuid references booking.conditions(id),
  start_date date,
  end_date date,
  persons integer check (persons is null or persons >= 0),
  subtotal numeric(12,2),
  adjustments numeric(12,2),
  vat_amount numeric(12,2),
  total numeric(12,2) check (total is null or total >= 0),
  deposit_amount numeric(12,2) check (deposit_amount is null or deposit_amount >= 0),
  valid_until date,
  includes text,
  excludes text,
  notes text,
  sent_at timestamptz,
  decided_at timestamptz,
  constraint proposals_dates check (start_date is null or end_date is null or end_date >= start_date)
);
create unique index proposals_version on booking.proposals (reservation_id, version);
create unique index proposals_one_accepted on booking.proposals (reservation_id) where status = 'aceptada' and deleted_at is null;
create trigger proposals_forbid_reparent before update on booking.proposals
  for each row execute function booking.forbid_reparent('reservation_id');

create table booking.proposal_lines (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  proposal_id uuid not null references booking.proposals(id),
  rate_id uuid references booking.rates(id),
  description text not null check (length(btrim(description)) between 1 and 300),
  unit text not null check (unit in ('persona_noche','persona_dia','dia','noche','estancia','unidad','porcentaje')),
  quantity numeric(10,2) not null default 1 check (quantity >= 0),
  unit_amount numeric(12,2) not null,
  discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  -- cantidad × importe unitario menos el descuento, en céntimos; null en las líneas de porcentaje (se calculan sobre el subtotal al enviar)
  amount numeric(12,2),
  position numeric not null default 0,
  constraint proposal_lines_percent check (unit <> 'porcentaje' or (unit_amount between -100 and 100))
);
create index proposal_lines_proposal_idx on booking.proposal_lines (proposal_id, position) where deleted_at is null;
create trigger proposal_lines_forbid_reparent before update on booking.proposal_lines
  for each row execute function booking.forbid_reparent('proposal_id');

-- Versión siguiente por reserva, salvo que llegue fijada.
create or replace function booking.proposal_version()
returns trigger language plpgsql as $$
begin
  if new.version is null then
    perform pg_advisory_xact_lock(hashtext('booking.proposals:' || new.reservation_id::text));
    select coalesce(max(version), 0) + 1 into new.version from booking.proposals where reservation_id = new.reservation_id;
  end if;
  return new;
end $$;
create trigger proposals_version before insert on booking.proposals
  for each row execute function booking.proposal_version();

-- ¿Está escribiendo un procedimiento de propuestas? (marca local de la transacción)
create or replace function booking.in_proposal_procedure()
returns boolean language sql stable as $$
  select coalesce(current_setting('booking.proposal_procedure', true), '') = 'on';
$$;

create or replace function booking.guard_proposal()
returns trigger language plpgsql as $$
declare
  v_fixed constant text[] := array['subtotal','adjustments','vat_amount','total','deposit_amount','sent_at'];
  v_meta constant text[] := array['revision','updated_at','updated_by'];
  v_new jsonb := to_jsonb(new); v_old jsonb;
begin
  if booking.in_proposal_procedure() then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'borrador' or new.subtotal is not null or new.adjustments is not null or new.vat_amount is not null
       or new.total is not null or new.deposit_amount is not null or new.sent_at is not null then
      perform core.fail('PROPOSAL_LOCKED', 422, jsonb_build_object('id', new.id, 'reason', 'una propuesta nace como borrador'));
    end if;
    return new;
  end if;
  v_old := to_jsonb(old);
  if old.status = 'borrador' then
    if new.status <> 'borrador' or new.version <> old.version
       or exists (select 1 from unnest(v_fixed) k where v_new -> k is distinct from v_old -> k) then
      perform core.fail('PROPOSAL_LOCKED', 422, jsonb_build_object('id', new.id, 'reason', 'el envío y la aceptación van por procedimiento'));
    end if;
    return new;
  end if;
  -- enviada: solo se marca rechazada o caducada a mano; después, solo notas
  if old.status = 'enviada' and new.status in ('rechazada','caducada') then
    if (v_new - v_meta - 'status' - 'decided_at' - 'notes') <> (v_old - v_meta - 'status' - 'decided_at' - 'notes') then
      perform core.fail('PROPOSAL_LOCKED', 422, jsonb_build_object('id', new.id, 'status', old.status));
    end if;
    return new;
  end if;
  if (v_new - v_meta - 'notes' - case when old.status = 'enviada' then 'decided_at' else '' end)
     <> (v_old - v_meta - 'notes' - case when old.status = 'enviada' then 'decided_at' else '' end) then
    perform core.fail('PROPOSAL_LOCKED', 422, jsonb_build_object('id', new.id, 'status', old.status));
  end if;
  return new;
end $$;
create trigger proposals_guard before insert or update on booking.proposals
  for each row execute function booking.guard_proposal();

create or replace function booking.guard_proposal_line()
returns trigger language plpgsql as $$
declare v_status text;
begin
  if new.unit = 'porcentaje' then new.amount := null;
  else new.amount := round(new.quantity * new.unit_amount * (100 - new.discount_pct) / 100, 2);
  end if;
  if booking.in_proposal_procedure() then return new; end if;
  select status into v_status from booking.proposals where id = new.proposal_id;
  if v_status is distinct from 'borrador' then
    perform core.fail('PROPOSAL_LOCKED', 422, jsonb_build_object('table', 'booking.proposal_lines', 'id', new.id, 'status', v_status));
  end if;
  return new;
end $$;
create trigger proposal_lines_guard before insert or update on booking.proposal_lines
  for each row execute function booking.guard_proposal_line();

-- Condiciones usadas por una propuesta ya enviada: solo cambian `active` e `is_default`; sus tramos, nada.
create or replace function booking.conditions_in_use(p_id uuid)
returns boolean language sql stable as $$
  select exists (select 1 from booking.proposals where conditions_id = p_id and status <> 'borrador');
$$;

create or replace function booking.guard_conditions()
returns trigger language plpgsql as $$
begin
  if booking.conditions_in_use(old.id)
     and (to_jsonb(new) - array['revision','updated_at','updated_by','active','is_default']) <> (to_jsonb(old) - array['revision','updated_at','updated_by','active','is_default']) then
    perform core.fail('CONDITIONS_IN_USE', 422, jsonb_build_object('id', old.id));
  end if;
  return new;
end $$;
create trigger conditions_guard before update on booking.conditions
  for each row execute function booking.guard_conditions();

create or replace function booking.guard_cancellation_tier()
returns trigger language plpgsql as $$
begin
  if booking.conditions_in_use(new.conditions_id) then
    perform core.fail('CONDITIONS_IN_USE', 422, jsonb_build_object('id', new.conditions_id, 'table', 'booking.cancellation_tiers'));
  end if;
  return new;
end $$;
create trigger cancellation_tiers_guard before insert or update on booking.cancellation_tiers
  for each row execute function booking.guard_cancellation_tier();

select core.register_table('booking', 'booking', 'proposals', array['reservation_id','status','nature','conditions_id','start_date',
  'end_date','persons','subtotal','adjustments','vat_amount','total','deposit_amount','valid_until','includes','excludes','notes',
  'sent_at','decided_at'], '{editor,owner}', '{editor,owner}');
select core.register_table('booking', 'booking', 'proposal_lines', array['proposal_id','rate_id','description','unit','quantity',
  'unit_amount','discount_pct','position'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Totales de una propuesta. Debe coincidir con `proposalTotals` del dominio (_domain/booking/rates.ts):
--   líneas fijas: cantidad × unitario × (1 − descuento), a céntimos; subtotal = su suma;
--   ajustes = suma de subtotal × porcentaje × cantidad / 100, cada uno a céntimos; neto = subtotal + ajustes;
--   con IVA incluido, total = neto y el IVA se desglosa; si no, total = neto + IVA;
--   señal = mín(total, máx(total × porcentaje, mínimo)), y 0 si el total es 0.
-- ---------------------------------------------------------------------------
create or replace function booking.proposal_totals(p_proposal_id uuid)
returns jsonb language plpgsql stable as $$
declare
  v_p booking.proposals; v_c booking.conditions;
  v_subtotal numeric; v_adjust numeric; v_net numeric; v_vat numeric; v_total numeric; v_deposit numeric;
begin
  select * into v_p from booking.proposals where id = p_proposal_id;
  select * into v_c from booking.conditions where id = v_p.conditions_id;
  select coalesce(sum(round(quantity * unit_amount * (100 - discount_pct) / 100, 2)), 0) into v_subtotal
    from booking.proposal_lines where proposal_id = p_proposal_id and deleted_at is null and unit <> 'porcentaje';
  select coalesce(sum(round(v_subtotal * unit_amount * quantity / 100, 2)), 0) into v_adjust
    from booking.proposal_lines where proposal_id = p_proposal_id and deleted_at is null and unit = 'porcentaje';
  v_net := v_subtotal + v_adjust;
  if coalesce(v_c.prices_include_vat, true) then
    v_total := v_net;
    v_vat := round(v_net - v_net / (1 + coalesce(v_c.vat_rate, 0) / 100), 2);
  else
    v_vat := round(v_net * coalesce(v_c.vat_rate, 0) / 100, 2);
    v_total := v_net + v_vat;
  end if;
  v_deposit := case when v_total <= 0 then 0
    else least(v_total, greatest(round(v_total * coalesce(v_c.deposit_percent, 0) / 100, 2), coalesce(v_c.deposit_minimum, 0))) end;
  return jsonb_build_object('subtotal', v_subtotal, 'adjustments', v_adjust, 'vat_amount', v_vat, 'total', v_total, 'deposit_amount', v_deposit);
end $$;

-- ---------------------------------------------------------------------------
-- Procedimientos (`call`). Los tres exigen aprobación humana si los lanza un agente.
-- ---------------------------------------------------------------------------
create or replace function booking.lock_proposal(p_args jsonb)
returns booking.proposals language plpgsql as $$
declare v_id uuid; v_p booking.proposals;
begin
  begin v_id := (p_args->>'proposal_id')::uuid; exception when others then v_id := null; end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'proposal_id must be a uuid')); end if;
  select * into v_p from booking.proposals where id = v_id for update;
  if v_p.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.proposals', 'id', v_id)); end if;
  if v_p.deleted_at is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', 'booking.proposals', 'id', v_id)); end if;
  return v_p;
end $$;

-- Copia una propuesta (o crea una vacía desde la reserva) en un borrador nuevo con el id que manda el cliente.
create or replace function booking.new_proposal_version(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_res booking.reservations; v_from booking.proposals; v_new uuid; v_rid uuid; v_cond uuid; v_line record; v_version integer;
begin
  begin v_new := (v_args->>'proposal_id')::uuid; v_rid := (v_args->>'reservation_id')::uuid; exception when others then v_new := null; end;
  if v_new is null or v_rid is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reservation_id and proposal_id must be uuids')); end if;
  select * into v_res from booking.reservations where id = v_rid;
  if v_res.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.reservations', 'id', v_rid)); end if;
  if v_res.deleted_at is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', 'booking.reservations', 'id', v_rid)); end if;

  if v_args ? 'from_proposal_id' and v_args->>'from_proposal_id' is not null then
    v_from := booking.lock_proposal(jsonb_build_object('proposal_id', v_args->>'from_proposal_id'));
    if v_from.reservation_id <> v_rid then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'from_proposal_id es de otra reserva')); end if;
  end if;

  select id into v_cond from booking.conditions where is_default and active and deleted_at is null;
  perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'booking.proposals', 'id', v_new,
    'fields', jsonb_strip_nulls(jsonb_build_object(
      'reservation_id', v_rid,
      'nature', coalesce(v_from.nature, 'orientativa'),
      'conditions_id', coalesce(v_from.conditions_id, v_cond),
      'start_date', coalesce(v_from.start_date, v_res.start_date),
      'end_date', coalesce(v_from.end_date, v_res.end_date),
      'persons', coalesce(v_from.persons, v_res.expected_guests),
      'valid_until', v_from.valid_until, 'includes', v_from.includes, 'excludes', v_from.excludes, 'notes', v_from.notes))));

  if v_from.id is not null then
    for v_line in select * from booking.proposal_lines where proposal_id = v_from.id and deleted_at is null order by position loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'booking.proposal_lines',
        'id', gen_random_uuid(), 'fields', jsonb_strip_nulls(jsonb_build_object('proposal_id', v_new, 'rate_id', v_line.rate_id,
          'description', v_line.description, 'unit', v_line.unit, 'quantity', v_line.quantity, 'unit_amount', v_line.unit_amount, 'discount_pct', v_line.discount_pct, 'position', v_line.position))));
    end loop;
  end if;

  select version into v_version from booking.proposals where id = v_new;
  return jsonb_build_object('proposal_id', v_new, 'reservation_id', v_rid, 'version', v_version, 'from_proposal_id', v_from.id);
end $$;

create or replace function booking.send_proposal(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_p booking.proposals; v_other booking.proposals; v_totals jsonb;
begin
  v_p := booking.lock_proposal(v_args);
  if v_p.status <> 'borrador' then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('id', v_p.id, 'status', v_p.status)); end if;
  if v_p.conditions_id is null then perform core.fail('PROPOSAL_INCOMPLETE', 422, jsonb_build_object('id', v_p.id, 'missing', jsonb_build_array('conditions_id'))); end if;
  if not exists (select 1 from booking.proposal_lines where proposal_id = v_p.id and deleted_at is null) then
    perform core.fail('PROPOSAL_INCOMPLETE', 422, jsonb_build_object('id', v_p.id, 'missing', jsonb_build_array('lines')));
  end if;
  v_totals := booking.proposal_totals(v_p.id);
  if (v_totals->>'total')::numeric < 0 then perform core.fail('PROPOSAL_NEGATIVE', 422, jsonb_build_object('id', v_p.id, 'total', v_totals->'total')); end if;

  perform set_config('booking.proposal_procedure', 'on', true);
  for v_other in select * from booking.proposals where reservation_id = v_p.reservation_id and id <> v_p.id and status = 'enviada' and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'booking.proposals',
      'id', v_other.id, 'expectedRevision', v_other.revision, 'fields', jsonb_build_object('status', 'sustituida')));
  end loop;
  perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'booking.proposals',
    'id', v_p.id, 'expectedRevision', coalesce((v_args->>'expectedRevision')::bigint, v_p.revision),
    'fields', v_totals || jsonb_build_object('status', 'enviada', 'sent_at', now())));
  perform set_config('booking.proposal_procedure', 'off', true);
  return jsonb_build_object('proposal_id', v_p.id, 'status', 'enviada') || v_totals;
end $$;

-- Aceptar: el único punto en que la propuesta toca los importes de la reserva (queda en core.changes).
create or replace function booking.accept_proposal(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_p booking.proposals; v_other booking.proposals; v_fin booking.reservation_finance; v_fields jsonb;
begin
  v_p := booking.lock_proposal(v_args);
  if v_p.status <> 'enviada' then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('id', v_p.id, 'status', v_p.status)); end if;

  perform set_config('booking.proposal_procedure', 'on', true);
  for v_other in select * from booking.proposals where reservation_id = v_p.reservation_id and id <> v_p.id
      and status in ('borrador','enviada','aceptada') and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'booking.proposals',
      'id', v_other.id, 'expectedRevision', v_other.revision, 'fields', jsonb_build_object('status', 'sustituida')));
  end loop;
  perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'booking.proposals',
    'id', v_p.id, 'expectedRevision', coalesce((v_args->>'expectedRevision')::bigint, v_p.revision),
    'fields', jsonb_build_object('status', 'aceptada', 'decided_at', now())));
  perform set_config('booking.proposal_procedure', 'off', true);

  select * into v_fin from booking.reservation_finance where id = v_p.reservation_id for update;
  v_fields := jsonb_build_object('final_amount', v_p.total, 'deposit_required', v_p.deposit_amount);
  if v_fin.id is null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'booking.reservation_finance',
      'id', v_p.reservation_id, 'fields', v_fields || jsonb_build_object('budget_amount', v_p.total)));
  else
    if v_fin.budget_amount is null then v_fields := v_fields || jsonb_build_object('budget_amount', v_p.total); end if;
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'booking.reservation_finance',
      'id', v_fin.id, 'expectedRevision', v_fin.revision, 'fields', v_fields));
  end if;
  return jsonb_build_object('proposal_id', v_p.id, 'reservation_id', v_p.reservation_id, 'status', 'aceptada',
    'final_amount', v_p.total, 'deposit_required', v_p.deposit_amount);
end $$;

select core.allow_procedure('booking', 'booking.new_proposal_version');
select core.allow_procedure('booking', 'booking.send_proposal');
select core.allow_procedure('booking', 'booking.accept_proposal');

-- ---------------------------------------------------------------------------
-- Invariantes del bloque, al final de cada lote: nada vivo colgando de algo borrado; una propuesta enviada o
-- aceptada no se borra.
-- ---------------------------------------------------------------------------
create or replace function booking.check_rates_invariants(p jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select l.id into v_id from booking.proposal_lines l join booking.proposals x on x.id = l.proposal_id
   where l.deleted_at is null and x.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.proposal_lines', 'id', v_id)); end if;

  select x.id into v_id from booking.proposals x join booking.reservations r on r.id = x.reservation_id
   where x.deleted_at is null and r.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.proposals', 'id', v_id)); end if;

  select x.id into v_id from booking.proposals x join booking.conditions c on c.id = x.conditions_id
   where x.deleted_at is null and c.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.proposals', 'id', v_id)); end if;

  select t.id into v_id from booking.cancellation_tiers t join booking.conditions c on c.id = t.conditions_id
   where t.deleted_at is null and c.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.cancellation_tiers', 'id', v_id)); end if;

  select x.id into v_id from booking.proposals x
   where x.deleted_at is not null and x.status in ('enviada','aceptada') limit 1;
  if v_id is not null then perform core.fail('PROPOSAL_LOCKED', 422, jsonb_build_object('table', 'booking.proposals', 'id', v_id)); end if;
end $$;

select core.add_validate_hook('booking', 'booking.check_rates_invariants');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
