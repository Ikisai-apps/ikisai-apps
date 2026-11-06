-- 0125 · Identidad de servicio de Central con escritura en Recursos (VG 6-11, pregunta 8 c y la casilla «también para todos los
-- eventos» de Booking): Booking pide a central-api (worker/space-use) que un espacio tenga un uso general y Central lo escribe en
-- resources.spaces como servicio, con `p_client_app` 'central' (0119), que es la única app a la que Recursos deja tocar la estructura.
-- Se amplían las concesiones del servicio 'central' y se sincronizan las ya registradas.

create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  with lanes as (select jsonb_build_array('victor', 'core', 'core_ops', 'ui_kit', 'central', 'flow', 'food', 'finance', 'tasks', 'booking', 'guests', 'organizers') as all_lanes)
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'tasks', 'role', 'editor'),
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('booking')))))
    when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('organizers')))))
    when 'core' then jsonb_build_object('displayName', 'Core (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'tasks', 'role', 'editor'),
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', (select all_lanes from lanes)))))
    when 'core_ops' then jsonb_build_object('displayName', 'Core Ops (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', (select all_lanes from lanes)))))
    when 'drive' then jsonb_build_object('displayName', 'Drive (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor'), jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'lector' then jsonb_build_object('displayName', 'Lector (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor')))
    when 'invoices' then jsonb_build_object('displayName', 'Finance (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'invoices', 'role', 'editor'),
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('finance')))))
    when 'food' then jsonb_build_object('displayName', 'Food (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'food', 'role', 'editor'),
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('food')))))
    when 'flow' then jsonb_build_object('displayName', 'Flow (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('flow')))))
    when 'guests' then jsonb_build_object('displayName', 'Guests (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('guests')))))
    when 'tasks' then jsonb_build_object('displayName', 'Tasks (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('tasks')))))
    when 'central' then jsonb_build_object('displayName', 'Central (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('central'))),
      -- 0125: Central escribe la estructura de espacios en Recursos como servicio (usos generales que pide Booking, central-U1).
      jsonb_build_object('app', 'resources', 'role', 'editor')))
    when 'uikit' then jsonb_build_object('displayName', 'UI-kit (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('ui_kit')))))
    else null end
$$;

select core.sync_service_grants();
