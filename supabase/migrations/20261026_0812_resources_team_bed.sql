-- Ikisai Recursos · «cama de equipo» (decisión de VG, 26-10-2026, accesos): la cama que pueden elegir el personal, la
-- organización y dirección cuando entran como huéspedes de un retiro; los huéspedes normales nunca la ven. Es un atributo
-- de la cama en Recursos (attributes.team_bed, booleano) que el espejo de Booking copia a booking.beds.team_bed.
-- Las camas no marcadas no cambian; sin ninguna marcada, esas personas no eligen cama (la asigna el personal).
update resources.space_kinds set attribute_keys = array_append(attribute_keys, 'team_bed')
where kind = 'cama' and not ('team_bed' = any(attribute_keys));
