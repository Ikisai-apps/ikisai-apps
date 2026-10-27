-- Ikisai Booking · seguridad B3 (auditoría de rutas del 27-10-2026): `booking.flow_guests_projection` (0486) estaba
-- registrada para Booking con los roles por defecto, y cualquier lector leía los huéspedes de todos los eventos (nombre,
-- cama, noches, firma). Nadie la lee por `read/…`: Flow usa `booking.flow_guests_of` (un evento de su ámbito) y
-- «Listo para Flow» (0492) la cuenta dentro del SQL. Se quita del registro de lecturas.
-- Toca solo el schema booking.
select core.disallow_read('booking', 'booking.flow_guests_projection');
