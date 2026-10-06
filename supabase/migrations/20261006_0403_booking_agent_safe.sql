-- Ikisai Booking · agentes de IA (contrato §3.1): la única acción inocua de Booking es reencolar la sincronización de
-- una reserva con Google Calendar (no cambia datos; el worker vuelve a calcular lo que debe haber). Se marca segura.
-- Confirmar una reserva (`booking.confirm_reservation`) sigue exigiendo aprobación: crea el evento operativo y lo publica.
select core.allow_read('booking', 'booking.calendar_retry', 'action', '{editor,owner}', false);
