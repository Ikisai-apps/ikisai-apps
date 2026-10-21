-- Ikisai Core · `admin/agents` dice qué app emitió cada clave (petición P13 de Central): `issuedApp`, del evento `key_issued`
-- del registro de accesos (índice por key_id desde 0090). Así una clave con permisos en varias apps va al grupo de la app que
-- la emitió. Las claves sin evento (no debería haberlas) llevan `null`. Toca solo el schema core.

create or replace function core.admin_agents(p_actor uuid)
returns jsonb language plpgsql stable as $$
begin
  perform core.require_admin(p_actor);
  return (select coalesce(jsonb_agg(jsonb_build_object('keyId', k.id, 'userId', k.user_id, 'name', k.name, 'hint', k.hint, 'createdAt', k.created_at,
            'expiresAt', k.expires_at, 'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at,
            'issuedApp', (select e.app from core.access_events e where e.key_id = k.id and e.event = 'key_issued' order by e.id limit 1),
            'memberships', coalesce((select jsonb_agg(jsonb_build_object('app', m.app, 'role', m.role, 'scopes', m.scopes) order by m.app)
                                     from core.memberships m join core.apps a on a.id = m.app where m.user_id = k.user_id and a.kind <> 'module'), '[]'::jsonb))
          order by k.created_at desc), '[]'::jsonb) from core.agent_keys k);
end $$;
