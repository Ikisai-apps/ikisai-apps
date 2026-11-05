-- 0712 · Avisos de comentarios (0709): con el aviso apagado, el tick no corre cada 15 minutos para nada (X5 del
-- TRIAJE_05-11, decisión de VG). La sonda no puede leer el entorno de la Edge (`IKISAI_ORGANIZER_MAIL`), así que el worker,
-- al verlo apagado, apunta una pausa de 6 horas y la sonda no lo vuelve a llamar hasta entonces. Al encenderlo, el primer
-- aviso sale como mucho 6 horas después. Toca solo el schema organizers.

-- Interna: sin roles, como comment_notices (0709). Una sola fila (`key = 'comment_notices'`).
create table if not exists organizers.worker_pauses (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key in ('comment_notices')),
  until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  revision bigint not null default 1
);
select core.register_table('organizers', 'organizers', 'worker_pauses', array[]::text[], '{}', '{}', true);

create or replace function organizers.comment_notices_has_work()
returns boolean language sql stable as $$
  select not exists (select 1 from organizers.worker_pauses w where w.key = 'comment_notices' and w.until > now())
     and exists (select 1 from organizers.comment_notices_pending(1))
$$;

-- El worker, con el aviso apagado: pausa de `hours` horas (de 1 a 24; 6 por omisión).
create or replace function organizers.comment_notices_pause(p jsonb)
returns jsonb language plpgsql as $$
declare v_hours int := greatest(1, least(coalesce((p->'args'->>'hours')::int, 6), 24)); v_until timestamptz := now() + make_interval(hours => v_hours);
begin
  insert into organizers.worker_pauses (key, until) values ('comment_notices', v_until)
  on conflict (key) do update set until = excluded.until;
  return jsonb_build_object('paused_until', v_until);
end $$;

select core.allow_read('organizers', 'organizers.comment_notices_pause', 'action', '{}');

revoke all on all functions in schema organizers from public, anon, authenticated;
grant execute on all functions in schema organizers to service_role;
