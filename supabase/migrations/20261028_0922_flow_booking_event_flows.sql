-- Ikisai Flow · qué flujos tiene cada evento, para la tarjeta «Listo para Flow» de la ficha del evento (Booking #832).
-- Solo proyectos vivos y ligados a un evento. Booking lo lee igual que `flow.booking_service_projection`; no escribe aquí.
create view flow.booking_event_flows_projection as
  select pr.booking_event_id as event_id, pr.id as project_id, pr.name, pr.template_key, pr.updated_at
    from flow.projects pr
   where pr.deleted_at is null and pr.booking_event_id is not null;
select core.allow_read('booking', 'flow.booking_event_flows_projection', 'view', '{reader,editor,owner}');
