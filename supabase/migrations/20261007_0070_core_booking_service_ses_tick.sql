-- Ikisai Core · identidad de servicio de Booking y planificador genérico para las apps (peticiones de Booking, SES-2).
-- 1) Booking avisa a Tasks del plazo legal de SES desde su worker (sin persona): escribe en Tasks como «Booking (sistema)».
-- 2) Cada app programa sus propios ticks con core.schedule_tick(app, ruta, cron, sonda): la sonda es una función de la app
--    que devuelve boolean («¿hay trabajo?»), así pg_cron no despierta la Edge si no hace falta y Core no lee tablas de apps.

create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    else null end
$$;

create table if not exists core.scheduled_ticks (
  app text not null references core.apps(id),
  route text not null check (route ~ '^[a-z0-9_/-]{1,80}$'),
  cron text not null check (cron ~ '^[0-9*/,-]+( [0-9*/,-]+){4}$'),
  probe text check (probe is null or probe ~ '^[a-z_]+\.[a-z0-9_]+$'),
  created_at timestamptz not null default now(),
  primary key (app, route)
);
alter table core.scheduled_ticks enable row level security;
revoke all on core.scheduled_ticks from public, anon, authenticated;
grant all on core.scheduled_ticks to service_role;

-- Lo que ejecuta pg_cron: consulta la sonda (en el schema de la app) y solo entonces llama a la Edge.
create or replace function core.worker_tick_probe(p_app text, p_route text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v core.scheduled_ticks; v_work boolean;
begin
  select * into v from core.scheduled_ticks where app = p_app and route = p_route;
  if v.app is null then return null; end if;
  if v.probe is not null then
    if split_part(v.probe, '.', 1) <> p_app then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'probe outside app schema')); end if;
    execute format('select %I.%I()', split_part(v.probe, '.', 1), split_part(v.probe, '.', 2)) into v_work;
    if not coalesce(v_work, false) then return null; end if;
  end if;
  return core.worker_tick(p_app, p_route);
end $$;

-- Helper para las migraciones de app: programa (o reprograma) un tick. Sin pg_cron (pruebas) solo lo registra.
create or replace function core.schedule_tick(p_app text, p_route text, p_cron text, p_probe text default null)
returns void language plpgsql as $$
declare v_job text := 'ikisai-' || p_app || '-' || replace(p_route, '/', '-');
begin
  if not exists (select 1 from core.apps where id = p_app) then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  if p_probe is not null and split_part(p_probe, '.', 1) <> p_app then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'probe must live in the app schema')); end if;
  insert into core.scheduled_ticks (app, route, cron, probe) values (p_app, p_route, p_cron, p_probe)
  on conflict (app, route) do update set cron = excluded.cron, probe = excluded.probe;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute format('select cron.schedule(%L, %L, %L)', v_job, p_cron, format('select core.worker_tick_probe(%L, %L)', p_app, p_route));
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['core.service_grants(text)', 'core.worker_tick_probe(text, text)', 'core.schedule_tick(text, text, text, text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
