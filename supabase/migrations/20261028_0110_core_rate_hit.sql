-- 0110 · Límite de intentos para el código por correo (aviso de seguridad del 27-10, al rebasar Booking #1016): un contador
-- genérico por clave y ventana. `core.rate_hit(clave, límite, ventana)` cuenta un intento y dice si cabe. La Edge lo usa para
-- el envío (por correo y por IP) y la verificación (por correo y por IP) del código; sirve para cualquier otro límite.
create table if not exists core.rate_hits (
  key text primary key,
  hits int not null default 0,
  window_start timestamptz not null default now()
);
create index if not exists rate_hits_window_idx on core.rate_hits (window_start);

create or replace function core.rate_hit(p_key text, p_limit int, p_window interval)
returns boolean language plpgsql as $$
declare v_hits int;
begin
  if p_key is null or p_limit is null or p_limit < 1 or p_window is null then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'rate_hit needs key, limit and window'));
  end if;
  -- Limpieza barata de vez en cuando: ventanas de hace más de un día.
  if random() < 0.02 then delete from core.rate_hits where window_start < now() - interval '1 day'; end if;
  insert into core.rate_hits (key, hits, window_start) values (p_key, 1, now())
  on conflict (key) do update set
    hits = case when core.rate_hits.window_start < now() - p_window then 1 else core.rate_hits.hits + 1 end,
    window_start = case when core.rate_hits.window_start < now() - p_window then now() else core.rate_hits.window_start end
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- Vuelta a cero de una clave (p. ej., al emitir un código nuevo, los intentos de verificar el anterior ya no cuentan).
create or replace function core.rate_reset(p_key text) returns void language sql as $$ delete from core.rate_hits where key = p_key $$;

create or replace function public.core_rate_hit(p_key text, p_limit int, p_window_seconds int) returns boolean
language sql security definer set search_path = '' as $$ select core.rate_hit(p_key, p_limit, make_interval(secs => p_window_seconds)) $$;
create or replace function public.core_rate_reset(p_key text) returns void
language sql security definer set search_path = '' as $$ select core.rate_reset(p_key) $$;
revoke all on table core.rate_hits from public, anon, authenticated;
revoke all on function core.rate_hit(text, int, interval), core.rate_reset(text), public.core_rate_hit(text, int, int), public.core_rate_reset(text) from public, anon, authenticated;
grant execute on function public.core_rate_hit(text, int, int), public.core_rate_reset(text) to service_role;
