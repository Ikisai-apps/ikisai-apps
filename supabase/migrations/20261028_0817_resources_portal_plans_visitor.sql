-- Ikisai Recursos · el mapa de zonas para el visitante que se aloja (VG, 27-10-2026: «sin sesión, nunca; con la identidad
-- mínima de quien se ha registrado en una jornada abierta, sí»). Toca solo el schema resources.
-- `resources.portal_plans` (0809, 0814 a 0816: geometría, nombres públicos y tipo de cama; nunca personas ni ocupación) se
-- registra como lectura pública **solo para código de Edge** (sin el tercer argumento de `allow_public_read`: el navegador no
-- la puede pedir por `GET public/<nombre>`). La sirve guests-api en `GET public/plans`, que exige el visitante (`X-Visitor`),
-- que el evento ofrezca noches y que el visitante haya entrado en él, y firma los dibujos.
select core.allow_public_read('resources_portal_plans', 'resources.portal_plans');
