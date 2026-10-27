-- 0107 · Los eventos que ha visitado un visitante (petición de Guests): al recuperar el acceso en otro móvil, «Mis eventos» se
-- rehace desde el núcleo en vez de perderse con el móvil. Solo códigos públicos de evento y fechas; nada personal.
create table core.visitor_visits (
  visitor_id uuid not null references core.visitors(id) on delete cascade,
  event_code text not null check (event_code ~ '^[A-Za-z0-9_-]{1,40}$'),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (visitor_id, event_code)
);
alter table core.visitor_visits enable row level security;
revoke all on core.visitor_visits from public, anon, authenticated;
grant all on core.visitor_visits to service_role;

-- Anota una visita (como mucho 50 eventos por visitante; el más antiguo cae).
create or replace function core.visitor_visit(p_visitor uuid, p_event_code text)
returns void language plpgsql as $$
begin
  if p_event_code !~ '^[A-Za-z0-9_-]{1,40}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'bad event code')); end if;
  if not exists (select 1 from core.visitors where id = p_visitor and revoked_at is null) then perform core.fail('VISITOR_INVALID', 401); end if;
  insert into core.visitor_visits (visitor_id, event_code) values (p_visitor, p_event_code)
  on conflict (visitor_id, event_code) do update set last_at = now();
  delete from core.visitor_visits v where v.visitor_id = p_visitor and v.event_code not in (
    select event_code from core.visitor_visits where visitor_id = p_visitor order by last_at desc limit 50);
end $$;

-- El alta por QR ya cuenta como primera visita.
create or replace function core.visitor_create(p_token_hash text, p_event_code text default null)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'token hash must be sha-256 hex')); end if;
  if (select count(*) from core.visitors where created_at > now() - interval '1 minute') >= 120
     or (p_event_code is not null and (select count(*) from core.visitors where event_code = p_event_code and created_at > now() - interval '1 minute') >= 60) then
    perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many visitors created'));
  end if;
  insert into core.visitors (event_code) values (nullif(p_event_code, '')) returning id into v_id;
  insert into core.visitor_tokens (visitor_id, token_hash) values (v_id, p_token_hash);
  insert into core.visitor_events (visitor_id, event, meta) values (v_id, 'created', jsonb_build_object('eventCode', nullif(p_event_code, '')));
  if nullif(p_event_code, '') is not null then insert into core.visitor_visits (visitor_id, event_code) values (v_id, p_event_code) on conflict do nothing; end if;
  return v_id;
end $$;

create or replace function core.visitor_me(p_visitor uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('visitorId', v.id, 'emailSaved', v.auth_user_id is not null, 'authUserId', v.auth_user_id,
                            'devices', (select count(*) from core.visitor_tokens t where t.visitor_id = v.id and t.revoked_at is null),
                            'guestIds', core.visitor_guest_ids(v.id),
                            'eventCodes', (select coalesce(jsonb_agg(w.event_code order by w.last_at desc), '[]'::jsonb) from core.visitor_visits w where w.visitor_id = v.id))
    from core.visitors v where v.id = p_visitor and v.revoked_at is null
$$;

create or replace function public.core_visitor_visit(p_visitor uuid, p_event_code text) returns void
language sql security definer set search_path = '' as $$ select core.visitor_visit(p_visitor, p_event_code) $$;
revoke all on function core.visitor_visit(uuid, text), public.core_visitor_visit(uuid, text) from public, anon, authenticated;
grant execute on function public.core_visitor_visit(uuid, text) to service_role;
