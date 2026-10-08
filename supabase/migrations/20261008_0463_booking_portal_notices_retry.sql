-- Ikisai Booking · las peticiones a Tasks iban por el proxy de Pages, que pierde `X-Ikisai-Worker-Key` (401): ningún aviso
-- del portal llegó. Con la Edge directa (misma PR), se reactivan los avisos no enviados que agotaron sus 20 intentos para
-- que salgan en el primer tick tras publicar. Los proyectos del retiro y los avisos de SES reintentan sin límite.
-- Toca solo el schema booking.
update booking.portal_notices set attempts = 0 where notified_at is null and attempts > 0;
