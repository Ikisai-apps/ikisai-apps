-- Ikisai Core · la ruta de una capacidad admite puntos (petición de Tasks, #814): las lecturas registradas se sirven en
-- `GET read/<schema.fn>`, y una capacidad de lectura puede apuntar ahí sin crear una ruta nueva.
alter table core.capabilities drop constraint if exists capabilities_route_check;
alter table core.capabilities add constraint capabilities_route_check check (route ~ '^(GET|POST) [a-z0-9_/:.-]+$');
