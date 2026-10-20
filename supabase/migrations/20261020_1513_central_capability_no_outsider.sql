-- Central · privacidad (revisión de Tasks, 20-10-2026): `central.capability_options` deja de estar abierta al outsider de
-- Tasks. Los grados de habilidad del personal («Aprende», «Sabe», «Experto») son datos internos de personas; la `1509` los
-- abría al outsider junto a `people_options` y `trade_options`, que siguen abiertas (quién hace sus tareas y su oficio).
-- Queda como la disponibilidad: lector, editor y owner de Tasks. Referencia: docs/central/API.md §2.13. Toca solo central.
select core.allow_read('tasks', 'central.capability_options', 'view', '{reader,editor,owner}');
