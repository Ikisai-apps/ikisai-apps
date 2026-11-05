-- Ikisai Central · Flow lee la lista de personas (decisión de VG, 28-10): en la caja de Flow, las personas de Central salen
-- como cuentas por defecto al «Cargar a cuenta» (abrir cuenta admite cualquier nombre). Igual que Tasks (1502 y 1509), con los
-- mismos roles. Solo lectura de `central.people_options`. Toca solo el schema central.

select core.allow_read('flow', 'central.people_options', 'view', '{reader,outsider,editor,owner}');
