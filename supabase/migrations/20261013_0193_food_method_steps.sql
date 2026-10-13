-- Ikisai Food · elaboración en pasos y antelación con unidad (FB_2026_028, decisión del usuario del 13-10-2026;
-- docs/food/API.md §2.1). Toca solo el schema food.
--
-- - `recipes.method_steps`: pasos y subpasos `[{id, text, steps?}]`. Lo ya escrito en `method` pasa a pasos sin perder
--   nada: una línea no vacía, un paso (sin la numeración propia del texto, «1.» o «2)»). `method` se conserva tal cual.
-- - `recipes.prep_minutes`: hasta siete días (antes dos); 0 es «En el momento». Lo actual ya son minutos: no cambia.

alter table food.recipes add column method_steps jsonb
  check (method_steps is null or jsonb_typeof(method_steps) = 'array');

update food.recipes r set method_steps = (
  select coalesce(jsonb_agg(jsonb_build_object('id', gen_random_uuid()::text, 'text', left(t.line, 500)) order by t.n), '[]'::jsonb)
    from (select n, btrim(regexp_replace(btrim(l), '^\d+\s*[.)]\s+', '')) as line
            from regexp_split_to_table(r.method, E'\r?\n') with ordinality as x(l, n)) t
   where t.line <> '')
 where r.method is not null and btrim(r.method) <> '' and r.method_steps is null;

alter table food.recipes drop constraint if exists recipes_prep_minutes_check;
alter table food.recipes add constraint recipes_prep_minutes_check check (prep_minutes is null or prep_minutes between 0 and 10080);

select core.register_table('food', 'food', 'recipes', array[
  'name','public_name','public_description','category','base_servings','method','method_steps','conservation','freezable','regeneration',
  'service_notes','prep_minutes','status','diet_tags','allergens','allergens_checked','photo_file_id','photo_thumb_file_id']);
