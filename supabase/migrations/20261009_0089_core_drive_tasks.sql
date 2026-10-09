-- La cuenta de servicio `drive` también es editora en Tasks: Finance avisa en Tasks › Gestiones de las facturas que llegan
-- por Drive (`invoices.drive_review`, `invoices.drive_blocked`). Si la cuenta ya existe, se le añade el acceso aquí,
-- porque `core.register_service_actor` solo da los accesos al crearla.
create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', '[]'::jsonb)
    when 'core' then jsonb_build_object('displayName', 'Core (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'drive' then jsonb_build_object('displayName', 'Drive (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor'), jsonb_build_object('app', 'tasks', 'role', 'editor')))
    else null end
$$;
revoke all on function core.service_grants(text) from public, anon, authenticated;

insert into core.memberships (app, user_id, role)
select 'tasks', p.user_id, 'editor' from core.profiles p
 where p.kind = 'service' and p.service_name = 'drive'
on conflict (app, user_id) do nothing;
