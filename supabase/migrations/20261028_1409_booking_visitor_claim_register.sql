-- Ikisai Booking · registra `booking.visitor_claim` (1401) en el núcleo para «Tu ficha está lista» de Guests (visitantes v2
-- de Core, 0106, #911). Core no puede nombrar una función de Booking en su migración (lint), así que la línea va aquí.
-- Necesita `core.allow_visitor_claim`, de la 0106: esta migración va detrás de ella.
-- `booking.visitor_claim` recibe {request_id, visitor_id} (en p o en p->'args') y devuelve {guest_id, reservation_id} de
-- una solicitud aceptada de ese visitante, o null.
-- Toca solo el schema booking.
select core.allow_visitor_claim('booking', 'booking.visitor_claim');
