-- Ikisai Tasks · regla de nombres de etiquetas (FB_2026_033; aprobada por el usuario el 13-10-2026; docs/tasks/API.md §27.2).
-- Toca solo el schema tasks y, del núcleo, solo llama a su registro de hooks.
--
-- Dentro de una familia, entre lo que se ve a la vez en un área (sus etiquetas propias y las General, `tab_id` nulo):
-- - madres únicas: dos etiquetas raíz (`parent_id` nulo) no se llaman igual;
-- - hijas únicas dentro de su madre: dos hijas de la misma madre no se llaman igual;
-- - la misma hija bajo madres distintas sí vale («Albergue › Baño» y «Salas › Baño»).
-- «La misma familia» es la que la app junta en un área (`familyKey` de apps/tasks/public/sync.js): la misma clave de
-- sistema o, sin clave, el mismo nombre sin mayúsculas ni espacios a los lados. Así, una familia de un área y la General
-- equivalente cuentan como una.
-- Los nombres se comparan sin mayúsculas, sin espacios a los lados y sin tildes (como el nombre de familia de la 0321).
-- Solo cuentan las etiquetas vivas: sin papelera ni archivo, de familia viva y de área viva (o General).
--
-- tasks.validate_label_names (tercer hook de validación, junto a tasks.validate_batch y tasks.validate_comments): mira el
-- estado final del lote y rechaza con DUPLICATE_LABEL (422) solo lo que **entra** en un choque: una etiqueta del lote (o
-- de una familia del lote) que ahora es visible con una clave (familia, madre, nombre, área) que antes no tenía, y que
-- coincide con otra viva. Es crear, renombrar, mover de madre o de familia, hacer General o desarchivar. Los datos viejos
-- que ya chocan no se rompen: un cambio que no toca la clave (otra posición, un renombrado que deja igual el nombre
-- normalizado, cualquier campo de otra tabla) sigue pasando.

-- Nombre normalizado de una etiqueta: sin mayúsculas, sin espacios a los lados y sin tildes. Lo mismo hace `labelNameKey`
-- en supabase/functions/_domain/tasks/labelnames.ts.
create or replace function tasks.label_name_key(p_name text)
returns text language sql immutable as $$
  select translate(lower(btrim(coalesce(p_name, ''))), 'áàâäéèêëíìîïóòôöúùûü', 'aaaaeeeeiiiioooouuuu');
$$;

-- Clave de familia: la de sistema o, sin ella, el nombre (como `familyKey` de la app).
create or replace function tasks.family_name_key(p_system_key text, p_name text)
returns text language sql immutable as $$
  select coalesce(p_system_key, 'name:' || lower(btrim(coalesce(p_name, ''))));
$$;

create or replace function tasks.validate_label_names(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_cursor bigint := (p->>'cursor')::bigint;
  r record;
begin
  select l.id, l.name, l.tab_id, l.family_id, l.parent_id, m.id as clash_id, m.name as clash_name, m.tab_id as clash_tab_id,
         fa.name as family_name, pa.name as parent_name, tb.name as tab_name, mt.name as clash_tab_name
    into r
    from (
      -- Lo que toca el lote: sus etiquetas y las de sus familias, con el estado de antes (el primer `before` del lote).
      with touched as (
        select ch.table_name, ch.row_id, ch.before, ch.seq
          from core.changes ch
         where ch.app = v_app and ch.cursor = v_cursor and ch.op <> 'call' and ch.schema_name = 'tasks' and ch.table_name in ('labels', 'families')
      ),
      first_before as (
        select distinct on (t.table_name, t.row_id) t.table_name, t.row_id, t.before from touched t order by t.table_name, t.row_id, t.seq
      ),
      fam_before as (
        select f.id, case when fb.row_id is null then f.system_key else fb.before->>'system_key' end as system_key,
               case when fb.row_id is null then f.name else fb.before->>'name' end as name,
               case when fb.row_id is null then f.deleted_at is null and not f.archived
                    else fb.before is not null and fb.before->>'deleted_at' is null and not coalesce((fb.before->>'archived')::boolean, false) end as alive
          from tasks.families f left join first_before fb on fb.table_name = 'families' and fb.row_id = f.id
      ),
      candidates as (
        select l.id from tasks.labels l where l.id in (select row_id from touched where table_name = 'labels')
        union
        select l.id from tasks.labels l where l.family_id in (select row_id from touched where table_name = 'families')
      )
      select l.id,
             -- Antes del lote: visible y con qué clave (nula si no era visible o no existía).
             (select case when b.before is null then null
                          when b.before->>'deleted_at' is null and not coalesce((b.before->>'archived')::boolean, false) and fb2.alive
                          then concat_ws('|', tasks.family_name_key(fb2.system_key, fb2.name), coalesce(b.before->>'parent_id', '-'),
                                         tasks.label_name_key(b.before->>'name'), coalesce(b.before->>'tab_id', '-')) end
                from (select coalesce((select fb.before from first_before fb where fb.table_name = 'labels' and fb.row_id = l.id),
                                      case when l.id in (select row_id from touched where table_name = 'labels') then null else to_jsonb(l) end) as before) b
                left join fam_before fb2 on fb2.id = (b.before->>'family_id')::uuid) as key_before
        from tasks.labels l where l.id in (select id from candidates)
    ) c
    join tasks.labels l on l.id = c.id
    join tasks.families fa on fa.id = l.family_id
    left join tasks.labels pa on pa.id = l.parent_id
    left join tasks.tabs tb on tb.id = l.tab_id
    join tasks.labels m on m.id <> l.id and m.deleted_at is null and not m.archived
                       and m.parent_id is not distinct from l.parent_id
                       and tasks.label_name_key(m.name) = tasks.label_name_key(l.name)
                       and (m.tab_id is null or l.tab_id is null or m.tab_id = l.tab_id)
    join tasks.families mf on mf.id = m.family_id and mf.deleted_at is null and not mf.archived
                          and tasks.family_name_key(mf.system_key, mf.name) = tasks.family_name_key(fa.system_key, fa.name)
    left join tasks.tabs mt on mt.id = m.tab_id
   where l.deleted_at is null and not l.archived and fa.deleted_at is null and not fa.archived
     and (l.tab_id is null or (tb.id is not null and tb.deleted_at is null))
     and (m.tab_id is null or (mt.id is not null and mt.deleted_at is null))
     -- Solo lo que entra en la clave: si ya la tenía antes del lote, un choque viejo no se rompe.
     and c.key_before is distinct from concat_ws('|', tasks.family_name_key(fa.system_key, fa.name), coalesce(l.parent_id::text, '-'),
                                                tasks.label_name_key(l.name), coalesce(l.tab_id::text, '-'))
   order by l.id, m.id
   limit 1;

  if r.id is not null then
    perform core.fail('DUPLICATE_LABEL', 422, jsonb_build_object(
      'labelId', r.id, 'name', r.name, 'tabId', r.tab_id, 'tabName', r.tab_name, 'familyId', r.family_id, 'familyName', r.family_name,
      'parentId', r.parent_id, 'parentName', r.parent_name,
      'conflictId', r.clash_id, 'conflictName', r.clash_name, 'conflictTabId', r.clash_tab_id, 'conflictTabName', r.clash_tab_name,
      'where', coalesce(r.parent_name, r.family_name)));
  end if;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_label_names');
