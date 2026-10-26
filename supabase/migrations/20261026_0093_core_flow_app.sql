-- Ikisai Core · alta de la app Flow en el registro común (RELEVO-001 §6).
-- Solo el registro y su lugar en el lanzador: el schema `flow` y sus tablas los crea el equipo de Flow en su rango
-- (0900–0999). La descripción llegará con su especificación funcional, en otra migración.

select core.ensure_app('flow', 'Ikisai Flow', 'flow.ikisai.com');
update core.apps set kind = 'internal', sort = 45 where id = 'flow';
insert into core.app_state (app, cursor) values ('flow', 0) on conflict do nothing;
