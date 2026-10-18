-- Cuenta de servicio `food` («Food (sistema)», editora en Food): el worker del consumo a las 24 h (P17 de Food) descuenta
-- con `resources.consume`; su membresía en Recursos se deriva de la de Food. La cuenta de Auth la crea la Edge la primera vez
-- que hay trabajo (`ensureServiceActor`, como Feedback).
create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', '[]'::jsonb)
    when 'core' then jsonb_build_object('displayName', 'Core (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'drive' then jsonb_build_object('displayName', 'Drive (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor'), jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'lector' then jsonb_build_object('displayName', 'Lector (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor')))
    when 'food' then jsonb_build_object('displayName', 'Food (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'food', 'role', 'editor')))
    else null end
$$;
revoke all on function core.service_grants(text) from public, anon, authenticated;
grant execute on function core.service_grants(text) to service_role;
