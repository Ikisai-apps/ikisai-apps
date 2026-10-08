-- K7 (Organizers): cuenta de servicio `organizers` («Organizers (sistema)», sin pertenencias) para sus lotes del sistema
-- (borrado de las respuestas de huéspedes a los 6 meses del fin del retiro, tick `retention/tick`).
create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', '[]'::jsonb)
    else null end
$$;
revoke all on function core.service_grants(text) from public, anon, authenticated;
