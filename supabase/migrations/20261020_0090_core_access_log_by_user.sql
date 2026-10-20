-- Ikisai Core · registro de accesos filtrado por cuenta y «lo grave» (P12 de Central, Bloque 2: MUELA-085).
-- core.admin_access_log gana dos filtros opcionales; sin ellos devuelve lo mismo que antes:
--   · p_user: lo que hizo esa cuenta (actor_id), lo que la afecta (meta.userId) y lo que hizo una clave suya;
--   · p_only = 'grave': claves revocadas, cuentas desactivadas y accesos quitados (la misma regla que pinta en rojo Central).
-- Permisos como antes: core.require_admin.

create index if not exists access_events_actor_idx on core.access_events (actor_id, id desc);
create index if not exists access_events_meta_user_idx on core.access_events ((meta->>'userId'), id desc);
create index if not exists access_events_key_idx on core.access_events (key_id, id desc);

drop function if exists public.core_admin_access_log(uuid, text, bigint, int);
drop function if exists core.admin_access_log(uuid, text, bigint, int);

create or replace function core.admin_access_log(p_actor uuid, p_app text, p_before bigint, p_limit int, p_user uuid default null, p_only text default null)
returns jsonb language plpgsql stable as $$
declare v_limit int := greatest(1, least(coalesce(p_limit, 100), 500)); v_items jsonb; v_count int;
begin
  perform core.require_admin(p_actor);
  if p_only is not null and p_only <> 'grave' then perform core.fail('INVALID_FILTER', 422, jsonb_build_object('only', p_only)); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'app', e.app, 'event', e.event, 'actorId', e.actor_id, 'keyId', e.key_id, 'meta', e.meta) order by e.id desc), '[]'::jsonb), count(*)
    into v_items, v_count
    from (select * from core.access_events a
           where (p_app is null or a.app = p_app)
             and (p_before is null or a.id < p_before)
             and (p_user is null or a.actor_id = p_user or a.meta->>'userId' = p_user::text
                  or a.key_id in (select k.id from core.agent_keys k where k.user_id = p_user))
             and (p_only is null or a.event = 'key_revoked'
                  or (a.event = 'member_changed' and (a.meta->>'event' = 'account_disabled' or a.meta->>'removed' = 'true')))
           order by a.id desc limit v_limit + 1) e;
  if v_count > v_limit then v_items := (select jsonb_agg(t.x order by t.o) from jsonb_array_elements(v_items) with ordinality as t(x, o) where t.o <= v_limit); end if;
  return jsonb_build_object('items', coalesce(v_items, '[]'::jsonb), 'hasMore', v_count > v_limit,
    'nextBefore', case when v_count > v_limit then (v_items->(v_limit - 1)->>'id')::bigint else null end);
end $$;

create or replace function public.core_admin_access_log(p_actor uuid, p_app text, p_before bigint, p_limit int, p_user uuid default null, p_only text default null) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.admin_access_log(p_actor, p_app, p_before, p_limit, p_user, p_only) $$;

revoke all on function core.admin_access_log(uuid, text, bigint, int, uuid, text) from public, anon, authenticated;
grant execute on function core.admin_access_log(uuid, text, bigint, int, uuid, text) to service_role;
revoke all on function public.core_admin_access_log(uuid, text, bigint, int, uuid, text) from public, anon, authenticated;
grant execute on function public.core_admin_access_log(uuid, text, bigint, int, uuid, text) to service_role;
