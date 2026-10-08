-- Ikisai Central · personas del equipo como opciones para otras apps (FB_2026_015, decisión del usuario del 8-10-2026): en
-- Tasks también pueden ser responsables las personas sin cuenta. Solo fichas vivas y activas; el nombre es el de la ficha
-- (la ficha manda, FB_2026_013) y `user_id` es null si no tiene cuenta. Sin datos reservados (ni contacto, ni vinculación,
-- ni documentación). Toca solo el schema central.

create view central.people_options as
select p.id as person_id, p.display_name as name, p.user_id, p.active
  from central.people p
 where p.deleted_at is null and p.active;

revoke all on central.people_options from public, anon, authenticated;
grant select on central.people_options to service_role;
select core.allow_read('central', 'central.people_options', 'view');
select core.allow_read('tasks', 'central.people_options', 'view');
