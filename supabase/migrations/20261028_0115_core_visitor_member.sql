-- 0115 · Visitante atado a un miembro con sesión (decisión de VG, 27-10 noche: dirección y staff entran en ven.ikisai.com y ven lo
-- mismo que un huésped, con su identidad). Un miembro (persona con pertenencia en alguna app) liga su visitante del móvil a su
-- cuenta de Auth, igual que el correo verificado liga la de un huésped (0106): mismo `auth_user_id`, misma recuperación entre
-- móviles. `core.visitor_me` dice `member` (quién es) y las apps pueden preguntar `core.visitor_member(visitor)` desde sus
-- procedimientos para, por ejemplo, marcar un pedido como prueba.

alter table core.visitor_events drop constraint if exists visitor_events_event_check;
alter table core.visitor_events add constraint visitor_events_event_check check (event in ('created','token_added','token_revoked','email_requested','email_saved','email_recovered','email_forgotten','linked','unlinked','claimed','claim_redeemed','member_bound'));

create or replace function core.visitor_member_link(p_visitor uuid, p_user uuid)
returns jsonb language plpgsql as $$
declare v_out jsonb;
begin
  if p_user is null or not exists (select 1 from core.memberships m where m.user_id = p_user and m.role in ('reader', 'editor', 'owner'))
     or exists (select 1 from core.profiles p where p.user_id = p_user and p.kind = 'service') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only members (people) bind a visitor to themselves'));
  end if;
  v_out := core.visitor_email_link(p_visitor, p_user);
  insert into core.visitor_events (visitor_id, event, meta) values ((v_out->>'visitorId')::uuid, 'member_bound', jsonb_build_object('userId', p_user));
  return v_out;
end $$;

-- El miembro al que está atado un visitante (null si es un huésped o un visitante anónimo). Para los procedimientos de las apps.
create or replace function core.visitor_member(p_visitor uuid) returns uuid language sql stable as $$
  select v.auth_user_id from core.visitors v
   where v.id = p_visitor and v.revoked_at is null and v.auth_user_id is not null
     -- mismo filtro que visitor_member_link: solo personas con rol de equipo; un outsider (huésped con cuenta de portal) no es miembro
     and exists (select 1 from core.memberships m where m.user_id = v.auth_user_id and m.role in ('reader', 'editor', 'owner'))
     and not exists (select 1 from core.profiles p where p.user_id = v.auth_user_id and p.kind = 'service')
$$;

create or replace function core.visitor_me(p_visitor uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('visitorId', v.id, 'emailSaved', v.auth_user_id is not null, 'authUserId', v.auth_user_id,
                            'devices', (select count(*) from core.visitor_tokens t where t.visitor_id = v.id and t.revoked_at is null),
                            'guestIds', core.visitor_guest_ids(v.id),
                            'eventCodes', (select coalesce(jsonb_agg(w.event_code order by w.last_at desc), '[]'::jsonb) from core.visitor_visits w where w.visitor_id = v.id),
                            'member', (select jsonb_build_object('userId', p.user_id, 'displayName', p.display_name,
                                                                  'apps', (select jsonb_agg(jsonb_build_object('app', m.app, 'role', m.role) order by m.app) from core.memberships m where m.user_id = p.user_id))
                                         from core.profiles p where p.user_id = core.visitor_member(v.id)))
    from core.visitors v where v.id = p_visitor and v.revoked_at is null
$$;

create or replace function public.core_visitor_member_link(p_visitor uuid, p_user uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.visitor_member_link(p_visitor, p_user) $$;
revoke all on function core.visitor_member_link(uuid, uuid), core.visitor_member(uuid), public.core_visitor_member_link(uuid, uuid) from public, anon, authenticated;
grant execute on function public.core_visitor_member_link(uuid, uuid), core.visitor_member(uuid) to service_role;
