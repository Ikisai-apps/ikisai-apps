-- Food · P17: el núcleo ya tiene el servicio `food` (0096) y el worker crea su cuenta la primera vez con
-- `ensureServiceActor`, como Feedback (respuesta de Core del 18-10-2026). El tick se despierta solo con que haya trabajo.
-- Toca solo el schema food.
create or replace function food.consumption_has_work()
returns boolean language plpgsql stable as $$
begin
  return jsonb_array_length(food.consumption_due('{}'::jsonb)->'items') > 0;
end $$;
