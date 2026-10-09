-- Cuenta de servicio `lector` («Lector (sistema)», editora en Finance): la Edge de invoices aplica la lectura de un
-- documento (`readAndFill`) al borrador de quien lo sube y escribe el resumen `import_meta.reading` (fase 1 del lector).
create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', '[]'::jsonb)
    when 'core' then jsonb_build_object('displayName', 'Core (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'drive' then jsonb_build_object('displayName', 'Drive (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor'), jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'lector' then jsonb_build_object('displayName', 'Lector (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor')))
    else null end
$$;
revoke all on function core.service_grants(text) from public, anon, authenticated;
