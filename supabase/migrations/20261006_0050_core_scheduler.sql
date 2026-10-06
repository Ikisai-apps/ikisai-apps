-- Ikisai Core · planificador dentro de Supabase (pg_cron + pg_net) en lugar de GitHub Actions.
-- El workflow `scheduler.yml` (cada 5 minutos, dos trabajos) consumía unos 576 minutos de Actions al día y agotó la cuota
-- del repositorio privado el 6 de octubre de 2026. Ahora la base de datos llama a las rutas `worker/*` de cada Edge.
-- La clave de worker vive en Supabase Vault con el nombre `ikisai_worker_key` (la carga Core desde private/, nunca en Git).
-- En PGlite (pruebas) no existen pg_cron ni pg_net: la migración solo crea las funciones y no programa nada.

create or replace function core.worker_tick(p_app text, p_route text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_key text; v_url text;
begin
  if p_app !~ '^[a-z][a-z0-9_]{1,30}$' or p_route !~ '^[a-z0-9_/-]{1,80}$' then perform core.fail('INVALID_OPERATION', 422); end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ikisai_worker_key' limit 1;
  if v_key is null then raise warning 'ikisai_worker_key no está en Vault: % % omitido', p_app, p_route; return null; end if;
  v_url := 'https://ctytaorylbninfyupfsn.supabase.co/functions/v1/' || p_app || '-api/api/v1/worker/' || p_route;
  return net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Ikisai-Worker-Key', v_key), timeout_milliseconds := 30000);
end $$;
revoke all on function core.worker_tick(text, text) from public, anon, authenticated;
grant execute on function core.worker_tick(text, text) to service_role;

-- Tareas programadas: (nombre, cron, app, ruta). Para añadir una, una migración core nueva con otra fila.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron/pg_net no disponibles: planificador no programado (entorno de pruebas)';
    return;
  end if;
  execute 'create extension if not exists pg_net';
  execute 'create extension if not exists pg_cron';
  execute $q$select cron.schedule('ikisai-booking-calendar-tick', '*/5 * * * *', $c$select core.worker_tick('booking', 'calendar/tick')$c$)$q$;
  execute $q$select cron.schedule('ikisai-tasks-imports-cleanup', '17 * * * *', $c$select core.worker_tick('tasks', 'imports/cleanup')$c$)$q$;
end $$;
