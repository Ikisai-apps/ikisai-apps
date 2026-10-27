-- 0112 · Cuenta de servicio de Finance (petición de Finance del 27-10 para finance-18, PR 3): el webhook de Stripe marca la
-- emitida como cobrada con historial y sincronización a través de core.apply_system_operations('invoices', ops), que exige
-- core.service_actor('invoices'). Hasta ahora solo existían 'drive' y 'lector' como editoras de Finance, y el historial diría
-- «Drive (sistema)» en un cobro. Se añade 'invoices' → «Finance (sistema)», editora de invoices. El resto no cambia.
create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', '[]'::jsonb)
    when 'core' then jsonb_build_object('displayName', 'Core (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'drive' then jsonb_build_object('displayName', 'Drive (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor'), jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'lector' then jsonb_build_object('displayName', 'Lector (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor')))
    when 'invoices' then jsonb_build_object('displayName', 'Finance (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor')))
    when 'food' then jsonb_build_object('displayName', 'Food (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'food', 'role', 'editor')))
    when 'flow' then jsonb_build_object('displayName', 'Flow (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'flow', 'role', 'editor')))
    else null end
$$;
