-- Ikisai Flow · cocina sin tocar el móvil (decisión de VG del 27-10, «B») y resolutor de ámbito para Booking.
-- - Con `complete_on_delivery` en la config de Servicio (la v2, por plantilla): quien entrega puede dar por hechas las
--   unidades que queden del pedido y entregarlo de una vez (`flow.deliver_all`). Las unidades se terminan por el mismo
--   unit_step de siempre (consumo de ingredientes incluido), a nombre de quien entrega; en Preparación se van solas.
-- - Los ajustes de plantilla (0909, 0910 y este) se aplican también a las versiones ya creadas que no los tengan.
-- - `flow.in_scope(actor, kind, id)`: resolutor de ámbito del núcleo (core 0098). Con kind 'booking_event', si la persona
--   tiene en su ámbito algún flujo de ese evento. Booking lo usa en `booking.flow_guests_of`.
-- La v1 no cambia.

insert into flow.template_column_patches (template_key, min_version, column_key, config_patch) values
  ('barra', 2, 'service', '{"complete_on_delivery": true}'::jsonb);

-- Versiones ya creadas (no congeladas): reciben los ajustes que les faltan, sin pisar lo que ya tengan.
update flow.columns c set config = tp.patch || c.config
  from (select pr.id as project_id, t.column_key, jsonb_object_agg(e.key, e.value) as patch
          from flow.projects pr
          join flow.template_column_patches t on t.template_key = pr.template_key and t.min_version <= pr.template_version and t.deleted_at is null,
               jsonb_each(t.config_patch) e
         where pr.deleted_at is null and not pr.frozen
         group by pr.id, t.column_key) tp
 where c.project_id = tp.project_id and c.key = tp.column_key and c.deleted_at is null;

-- ---------------------------------------------------------------------------
-- Dar por hecho y entregar. args = { order_id, ident, expected_revision? }
-- ---------------------------------------------------------------------------
create or replace function flow.deliver_all(p jsonb) returns jsonb language plpgsql as $$
declare v_order flow.orders; v_u flow.units; v_line flow.order_lines; v_done int := 0; v_out jsonb;
begin
  perform flow.proc_begin();
  v_order := flow.lock_order(p);
  if not exists (select 1 from flow.columns where project_id = v_order.project_id and key = 'service' and deleted_at is null
                   and coalesce((config->>'complete_on_delivery')::boolean, false)) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'this flow delivers with deliver_order'));
  end if;
  if v_order.status = 'delivered' then perform core.fail('ORDER_ALREADY_DELIVERED', 409, jsonb_build_object('order_id', v_order.id)); end if;
  if v_order.status <> 'paid' then perform core.fail('ORDER_NOT_PAID', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;
  -- Terminar lo que quede, por unit_step (pendiente → en curso → hecho), a nombre de quien entrega.
  for v_u in select * from flow.units where order_id = v_order.id and deleted_at is null and kind = 'prep' and status in ('pending','in_progress') order by idx loop
    if v_u.status = 'pending' then
      perform flow.unit_step(jsonb_set(p, '{args}', jsonb_build_object('unit_id', v_u.id, 'from', 'pending')));
    end if;
    perform flow.unit_step(jsonb_set(p, '{args}', jsonb_build_object('unit_id', v_u.id, 'from', 'in_progress')));
    perform flow.proc_begin(); -- unit_step cierra su propio tramo de procedimiento
    v_done := v_done + 1;
  end loop;
  for v_line in select * from flow.order_lines where order_id = v_order.id and deleted_at is null and delivered_qty < quantity for update loop
    perform flow.upd(p, 'flow.order_lines', v_line.id, v_line.revision, jsonb_build_object('delivered_qty', v_line.quantity));
  end loop;
  v_out := flow.deliver_order(jsonb_set(p, '{args}', jsonb_build_object('order_id', v_order.id, 'ident', p->'args'->>'ident')));
  return v_out || jsonb_build_object('completed_units', v_done);
end $$;
select core.allow_procedure('flow', 'flow.deliver_all');

-- ---------------------------------------------------------------------------
-- Resolutor de ámbito para el núcleo
-- ---------------------------------------------------------------------------
create or replace function flow.in_scope(p_actor uuid, p_kind text, p_id text) returns boolean language sql stable as $$
  select case p_kind
    when 'booking_event' then exists (
      select 1 from flow.projects pr
       where pr.deleted_at is null and pr.booking_event_id::text = p_id and flow.in_scope(p_actor, pr.id))
    else false end
$$;
select core.allow_scope_resolver('flow', 'flow.in_scope');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
