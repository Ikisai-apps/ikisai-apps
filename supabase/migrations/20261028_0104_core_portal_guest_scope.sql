-- Ikisai Core · seguridad B4 (auditoría de rutas del 27-10-2026; la hace Booking por encargo de Core, detrás de la 0103):
-- - `core.portal_link_issue`: un enlace de Guests que emite Booking exige lo mismo que ver huéspedes en Booking: owner, o
--   editor con `scopes.guests` (la regla de `booking.actor_sees_guests`, 0472, escrita aquí sobre core.memberships). Sin
--   esto, un editor sin el ámbito emitía el enlace de cualquier huésped, lo canjeaba él mismo y veía su ficha completa.
-- - `core.portal_links_list`: el lector de Booking ya no lista los enlaces (FORBIDDEN); editor o más.
-- Lo demás de las dos funciones no cambia (0064). Solo SQL; el kit (`_kit/portal.ts`) no se toca.

create or replace function core.portal_link_issue(p_issuer_app text, p_actor uuid, p_app text, p_user uuid, p_digest text, p_scope jsonb, p_label text, p_display_name text)
returns jsonb language plpgsql as $$
declare v_role text; v_scopes jsonb; v_link core.portal_links; v_until timestamptz;
begin
  if p_app not in ('organizers', 'guests') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown portal')); end if;
  if p_digest !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_scope) <> 'object' then perform core.fail('INVALID_OPERATION', 422); end if;
  select role, scopes into v_role, v_scopes from core.memberships where app = p_issuer_app and user_id = p_actor;
  if v_role is null or v_role = 'reader' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'cannot issue portal links')); end if;
  if p_issuer_app = 'organizers' then
    -- Un organizador solo emite enlaces de huésped de sus propias reservas.
    if p_app <> 'guests' or not exists (select 1 from core.memberships m where m.app = 'organizers' and m.user_id = p_actor
          and (m.scopes->'grants') @> jsonb_build_array(jsonb_build_object('reservation_id', p_scope->'reservation_id'))) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'organizers issue guest links for their own reservations only'));
    end if;
  elsif p_issuer_app = 'booking' then
    -- B4: el enlace de un huésped abre su ficha; lo emite solo quien puede ver huéspedes en Booking.
    if p_app = 'guests' and not (v_role = 'owner' or coalesce(v_scopes->'guests' = 'true'::jsonb, false)) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guests scope required'));
    end if;
  else
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'issuer not allowed'));
  end if;
  if (select kind from core.profiles where user_id = p_user) = 'agent' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'agents cannot use portals')); end if;
  insert into core.portal_links (app, user_id, digest, scope, label, created_by, issuer_app)
  values (p_app, p_user, p_digest, p_scope, nullif(btrim(coalesce(p_label, '')), ''), p_actor, p_issuer_app) returning * into v_link;
  perform core.portal_grant(p_app, p_user, p_scope, p_display_name);
  v_until := core.portal_link_valid_until(v_link);
  perform core.log_access(p_app, p_actor, null, 'member_invited', jsonb_build_object('userId', p_user, 'portalLink', v_link.id, 'scope', p_scope, 'by', p_issuer_app));
  return jsonb_build_object('linkId', v_link.id, 'app', p_app, 'userId', p_user, 'scope', p_scope, 'validUntil', v_until);
end $$;

create or replace function core.portal_links_list(p_issuer_app text, p_actor uuid, p_reservation uuid)
returns jsonb language plpgsql stable as $$
declare v_role text;
begin
  select role into v_role from core.memberships where app = p_issuer_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403); end if;
  -- B4: los enlaces (a quién y con qué ámbito) solo los lista editor o más
  if p_issuer_app = 'booking' and v_role = 'reader' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'editor or owner required')); end if;
  if p_issuer_app = 'organizers' and not exists (select 1 from core.memberships m where m.app = 'organizers' and m.user_id = p_actor
        and (m.scopes->'grants') @> jsonb_build_array(jsonb_build_object('reservation_id', p_reservation))) then
    perform core.fail('FORBIDDEN', 403);
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('linkId', l.id, 'app', l.app, 'userId', l.user_id, 'label', l.label, 'scope', l.scope,
            'createdAt', l.created_at, 'lastUsedAt', l.last_used_at, 'revokedAt', l.revoked_at, 'extendedUntil', l.extended_until,
            'validUntil', core.portal_link_valid_until(l), 'issuerApp', l.issuer_app) order by l.created_at desc), '[]'::jsonb)
          from core.portal_links l where l.scope->>'reservation_id' = p_reservation::text
            and (p_issuer_app = 'booking' or l.app = 'guests'));
end $$;
