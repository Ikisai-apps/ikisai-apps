-- Ikisai Guests · indicadores del portal de huéspedes para el panel de Dirección de Central (P7, encargo de Core del
-- 27-10-2026; contrato en docs/central/API.md §7.2; claves y fórmulas en docs/guests/API.md §9.20). Toca solo el schema
-- guests, que nace aquí con esta vista: Guests no tiene tablas. Los números salen de `booking.guests_kpi_projection`
-- (agregados por reserva que publica Booking para esto; nunca nombres, contactos ni importes).
-- `period = 'actual'`: la foto de hoy (hora de Madrid). Retiros «de ahora»: los que no han terminado y empiezan en los
-- próximos 30 días (los que están en curso, incluidos); «recientes»: los que empezaron en los últimos 30 días.

create schema if not exists guests;
revoke all on schema guests from public;
revoke all on schema guests from anon, authenticated;
grant usage on schema guests to service_role;

create view guests.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
r as (select p.* from booking.guests_kpi_projection p),
upcoming as (select r.* from r, today where r.end_date >= today.d and r.start_date <= today.d + 30),
recent as (select r.* from r, today where r.start_date between today.d - 30 and today.d)
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, k.period_end,
       k.direction, 'https://booking.ikisai.com/#/reservas'::text as link, now() as computed_at
  from (values
    -- Huéspedes que ya han entrado al portal (han aceptado el aviso de protección de datos), sobre los de los retiros de ahora.
    ('guests.portal_entered_pct', 'Huéspedes que han entrado al portal',
      (select case when sum(guests) > 0 then round(100.0 * sum(entered) / sum(guests), 1) end from upcoming),
      'pct', (select d + 30 from today), 'up'),
    ('guests.portal_entered', 'Huéspedes que han entrado al portal (personas)',
      (select coalesce(sum(entered), 0) from upcoming)::numeric, 'persons', (select d + 30 from today), 'up'),
    ('guests.signatures_done', 'Partes firmados',
      (select coalesce(sum(signed), 0) from upcoming)::numeric, 'persons', (select d + 30 from today), 'up'),
    ('guests.signatures_pending', 'Partes sin firmar',
      (select coalesce(sum(unsigned), 0) from upcoming)::numeric, 'persons', (select d + 30 from today), 'down'),
    ('guests.retreats_signatures_pending', 'Retiros con partes sin firmar',
      (select count(*) from upcoming where unsigned > 0)::numeric, 'count', (select d + 30 from today), 'down'),
    -- Partes enviados a SES y retiros que aún tienen llegadas sin enviar, de los que empezaron en los últimos 30 días.
    ('guests.ses_sent_30d', 'Partes enviados a SES (últimos 30 días)',
      (select coalesce(sum(ses_sent), 0) from recent)::numeric, 'persons', (select d from today), 'up'),
    ('guests.retreats_ses_pending', 'Retiros con partes por enviar a SES',
      (select count(*) from recent where ses_pending > 0)::numeric, 'count', (select d from today), 'down')
  ) as k(kpi, label, value, unit, period_end, direction);

revoke all on guests.central_kpi_projection from public, anon, authenticated;
grant select on guests.central_kpi_projection to service_role;
select core.allow_read('central', 'guests.central_kpi_projection', 'view', '{owner}');
