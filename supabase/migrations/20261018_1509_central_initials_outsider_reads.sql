-- Ikisai Central · peticiones de Tasks para P2 y O1 (aprobadas por el usuario el 18-10-2026; coordinacion/central/RESPUESTAS.md).
-- 1. «Iniciales» en la ficha (`central.people.initials`): opcional, hasta 4 caracteres, sin espacios a los lados. Tasks las usa
--    en las chips y, si faltan, el nombre de pila. Salen en `people_options`, al final.
-- 2. Disponibilidad para ordenar «Quién sabe hacerlo»: vista aparte, `central.availability_options` (persona, valor y orden), y
--    no en `people_options` ni en `capability_options`, porque esas dos las lee también el outsider (punto 3) y la
--    disponibilidad de los demás no es de lo que necesita ver. Nunca las notas de disponibilidad (texto libre).
-- 3. `people_options`, `trade_options` y `capability_options` abiertas también al `outsider` de Tasks: ve en sus tareas quién
--    las hace y su oficio. Ninguna trae contacto, vinculación, documentación, notas ni disponibilidad (comprobado en las
--    pruebas columna a columna).
-- Toca solo el schema central.

alter table central.people add column initials text
  check (initials is null or (initials = btrim(initials) and length(initials) between 1 and 4));

select core.register_table('central', 'central', 'people', array['display_name','relation','base_role','coverage','availability',
  'availability_notes','active','committed_post','user_id','position','merged_into','house_level','initials']);

-- Las mismas personas y columnas, más `initials` al final.
create or replace view central.people_options as
select p.id as person_id, p.display_name as name, p.user_id, p.active, p.house_level, p.initials
  from central.people p
 where p.deleted_at is null and p.active;

-- Disponibilidad de las mismas personas, con su orden para «Quién sabe hacerlo»: alta, media, según calendario, baja y no
-- disponible (1 a 5).
create view central.availability_options as
select p.id as person_id, p.availability,
       case p.availability when 'alta' then 1 when 'media' then 2 when 'segun_calendario' then 3 when 'baja' then 4 else 5 end as availability_rank
  from central.people p
 where p.deleted_at is null and p.active;

revoke all on central.availability_options from public, anon, authenticated;
grant select on central.availability_options to service_role;
select core.allow_read('central', 'central.availability_options', 'view');
select core.allow_read('tasks', 'central.availability_options', 'view');

select core.allow_read('tasks', 'central.people_options', 'view', '{reader,outsider,editor,owner}');
select core.allow_read('tasks', 'central.trade_options', 'view', '{reader,outsider,editor,owner}');
select core.allow_read('tasks', 'central.capability_options', 'view', '{reader,outsider,editor,owner}');
