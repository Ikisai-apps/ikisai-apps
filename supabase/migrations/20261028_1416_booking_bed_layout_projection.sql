-- Ikisai Booking · cómo están colocadas las camas dentro de su habitación, para Central, Guests, Tasks y Organizers (Core,
-- 27-10-2026: VG no veía en Central las camas ordenadas como en Booking). La fuente es la de «Monta el dormitorio» (0477):
-- `spaces.layout` = {cols, rows} (la habitación en cuadrantes) y `beds.cell` = {x, y, rot} (la cama ocupa dos cuadrantes,
-- a lo ancho con rot 0 o a lo largo con rot 90).
-- `booking.bed_layout_projection` da una fila por cama activa con celda, en una habitación activa con disposición:
-- - `bed_id` y `space_id` (los de Booking) y `resource_bed_id` y `resource_space_id` (los de Recursos, si el espejo los tiene);
-- - `cols` y `rows` de la habitación;
-- - `x`, `y` y `rot` de la cama, y `label`.
-- Sin personas ni ocupación.
-- Toca solo el schema booking.

create or replace view booking.bed_layout_projection as
select b.id as bed_id, b.resource_id as resource_bed_id, s.id as space_id, s.resource_id as resource_space_id,
       (s.layout->>'cols')::integer as cols, (s.layout->>'rows')::integer as rows,
       (b.cell->>'x')::integer as x, (b.cell->>'y')::integer as y, (b.cell->>'rot')::integer as rot,
       b.label, b.updated_at
  from booking.beds b
  join booking.spaces s on s.id = b.space_id and s.deleted_at is null and s.active and s.layout is not null
 where b.deleted_at is null and b.active and b.cell is not null;

revoke all on booking.bed_layout_projection from public, anon, authenticated;
grant select on booking.bed_layout_projection to service_role;
select core.allow_read('central', 'booking.bed_layout_projection', 'view');
-- VG: un solo modelo de colocación de camas, el de Booking; lo derivan todas las apps que pintan el mapa de zonas
select core.allow_read('guests', 'booking.bed_layout_projection', 'view');
select core.allow_read('tasks', 'booking.bed_layout_projection', 'view');
select core.allow_read('organizers', 'booking.bed_layout_projection', 'view');
