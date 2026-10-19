-- Food · tanda 27 (rediseño de La Muela, MUELA-068 §3, «Votar deslizando, decide quien administra»; aprobado por VG el
-- 19-10-2026): votos a las sugerencias de plato del menú de casa. Toca solo el schema food.
--
-- Votan todas las personas de la cocina, también quien solo lee; decide editor u owner, como hoy, en el núcleo
-- (`core.suggestion_decide`). Los votos orientan y no deciden nada.
-- - Un voto vivo por persona y sugerencia: `keep` (aprobar) o `drop` (descartar). Cambiar de voto es actualizar la
--   fila; quitarlo, borrarla.
-- - Quién vota no se escribe: es quien manda el lote. Nadie vota por otra persona ni cambia su voto.
-- - `suggestion_id` apunta a `core.suggestions` (app `food`), en otro schema: sin clave foránea. Que la sugerencia exista,
--   sea de Food y esté pendiente lo comprueba el cliente con la lista del núcleo; un voto a otra cosa no cambia nada.
-- - Es una tabla del espejo: el recuento y «Tu voto» salen de ella, también sin red (votar sí pide red, como decidir).
--   No lleva datos de fuera: solo personas de la cocina, que ya se ven entre sí en los menús.
-- - Se vota con `POST /api/v1/suggestion-votes` de la Edge de Food, que llama a `food.vote_suggestion` como quien vota:
--   la Edge del núcleo no deja escribir nada a quien solo lee, y esta ruta solo escribe su voto.

create table food.suggestion_votes (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  suggestion_id uuid not null,
  voter_id uuid not null references auth.users(id),
  vote text not null check (vote in ('keep', 'drop'))
);
create unique index suggestion_votes_voter_key on food.suggestion_votes (suggestion_id, voter_id) where deleted_at is null;
create index suggestion_votes_suggestion_idx on food.suggestion_votes (suggestion_id) where deleted_at is null;

-- Quien vota es quien escribe (`updated_by`, que pone el núcleo: al insertar, `core.apply_row_op`; al actualizar,
-- `core_touch_revision`, que corre antes por orden de nombre). La sugerencia y la persona no cambian.
create or replace function food.guard_suggestion_vote()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.updated_by is null then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'food.suggestion_votes')); end if;
    new.voter_id := new.updated_by;
  else
    if new.suggestion_id <> old.suggestion_id then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'suggestion_id'));
    end if;
    if new.voter_id <> old.voter_id or new.updated_by is distinct from old.voter_id then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'food.suggestion_votes', 'reason', 'not_your_vote'));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_suggestion_vote before insert or update on food.suggestion_votes
  for each row execute function food.guard_suggestion_vote();

-- `voter_id` no es escribible: lo pone el trigger. Escriben lector, editor y owner (el outsider ni lee ni escribe).
select core.register_table('food', 'food', 'suggestion_votes', array['suggestion_id', 'vote'], '{reader,editor,owner}', '{reader,editor,owner}');

-- Votar, cambiar el voto o quitarlo (`vote` null), siempre el propio. Lo llama la ruta de votos de la Edge de Food.
create or replace function food.vote_suggestion(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb); v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_suggestion uuid; v_vote text := nullif(a->>'vote', ''); v_mine food.suggestion_votes;
begin
  if coalesce(a->>'suggestion_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.vote_suggestion', 'argument', 'suggestion_id'));
  end if;
  if v_vote is not null and v_vote not in ('keep', 'drop') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.vote_suggestion', 'argument', 'vote'));
  end if;
  v_suggestion := (a->>'suggestion_id')::uuid;
  select * into v_mine from food.suggestion_votes where suggestion_id = v_suggestion and voter_id = v_actor and deleted_at is null for update;
  if v_mine.id is null and v_vote is not null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'insert', 'table', 'food.suggestion_votes', 'id', gen_random_uuid(), 'fields', jsonb_build_object('suggestion_id', v_suggestion, 'vote', v_vote)));
  elsif v_mine.id is not null and v_vote is null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'delete', 'table', 'food.suggestion_votes', 'id', v_mine.id, 'expectedRevision', v_mine.revision));
  elsif v_mine.id is not null and v_mine.vote <> v_vote then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'update', 'table', 'food.suggestion_votes', 'id', v_mine.id, 'expectedRevision', v_mine.revision, 'fields', jsonb_build_object('vote', v_vote)));
  end if;
  return jsonb_build_object('suggestion_id', v_suggestion, 'vote', v_vote);
end $$;
select core.allow_procedure('food', 'food.vote_suggestion');
