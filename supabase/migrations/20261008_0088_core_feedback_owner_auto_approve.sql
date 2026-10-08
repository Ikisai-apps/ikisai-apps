-- Decisión del usuario (8-10-2026): el Revisor sirve para el feedback de los demás. Lo que envía un administrador
-- (owner de Central) entra ya aprobado, con él como revisor; no tiene que revisarse a sí mismo.
create or replace function core.feedback_before_insert()
returns trigger language plpgsql as $$
declare v_admin boolean := new.reporter_user_id is not null
  and exists (select 1 from core.memberships where app = 'central' and user_id = new.reporter_user_id and role = 'owner')
  and coalesce((select kind from core.profiles where user_id = new.reporter_user_id), 'human') = 'human';
begin
  new.review_status := case when new.subject = 'application' and not v_admin then 'new' else 'approved' end;
  if new.subject = 'application' and v_admin then
    new.reviewed_by := new.reporter_user_id; new.reviewed_at := now();
  end if;
  if new.context ? 'routeRaw' then
    new.route_raw := left(nullif(split_part(new.context->>'routeRaw', '?', 1), ''), 300);
    new.context := new.context - 'routeRaw';
  end if;
  return new;
end $$;

-- Los que ya esperaban revisión y los envió un administrador, aprobados.
update core.feedback_reports r set review_status = 'approved', reviewed_by = r.reporter_user_id, reviewed_at = now(), updated_at = now()
 where r.review_status = 'new' and r.status = 'open' and r.reporter_user_id is not null
   and exists (select 1 from core.memberships m where m.app = 'central' and m.user_id = r.reporter_user_id and m.role = 'owner');
