-- Ikisai Central · fase P1 (RECURSOS.md §13): nivel de casa de cada persona, `direccion`, `staff` u `outsider`, o ninguno
-- (fuera del directorio). Solo se añade la columna, vacía: la asigna el usuario desde Personas con una vista previa editable
-- (propuesta por `relation` y `base_role`). Nada se borra: `relation`, `base_role` y `coverage` se conservan para lo que las
-- lea (sección 17); la pantalla cambia solo cuando alguna persona tiene nivel. No toca roles de acceso: eso es la fase O1.
-- Toca solo el schema central.

alter table central.people add column house_level text check (house_level is null or house_level in ('direccion', 'staff', 'outsider'));

select core.register_table('central', 'central', 'people', array['display_name','relation','base_role','coverage','availability',
  'availability_notes','active','committed_post','user_id','position','merged_into','house_level']);

-- `people_options` (Tasks) no cambia de contenido en P1: las mismas personas y columnas, más `house_level` al final.
create or replace view central.people_options as
select p.id as person_id, p.display_name as name, p.user_id, p.active, p.house_level
  from central.people p
 where p.deleted_at is null and p.active;
