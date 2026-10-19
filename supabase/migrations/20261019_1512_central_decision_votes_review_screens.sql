-- Central · tanda 27 (rediseño de La Muela, aprobado por el usuario el 19-10-2026): datos de Decisiones y de Revisión.
-- 1. Votos de Decisiones (MUELA-014 r2): todo el equipo vota, también quien solo lee, si una decisión vigente se mantiene o
--    se retira. Los votos orientan; quien administra (owner) decide en la ficha, y queda quién, cuándo y con qué votación.
-- 2. Pantallas de Revisión (MUELA-027): el avance de cada pantalla en los diez pasos del cuadro, para la sección Revisión.
--    El feedback se une a su pantalla por el prefijo de sus ids de feedback o por su ruta (sin dato nuevo en el kit).
-- Referencia: docs/central/API.md §2.10 y §2.14. Toca solo el schema central.

-- ---------------------------------------------------------------------------
-- 1. Votos
-- ---------------------------------------------------------------------------
create table central.decision_votes (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  decision_id uuid not null references central.decisions(id),
  -- Quien vota: lo pone el disparador con el actor del lote; no se escribe.
  voter_id uuid not null references auth.users(id),
  vote text not null check (vote in ('mantener','retirar'))
);
-- Un voto vivo por persona y decisión: cambiar de opinión es cambiar el voto, no añadir otro.
create unique index decision_votes_one_idx on central.decision_votes (decision_id, voter_id) where deleted_at is null;
create index decision_votes_decision_idx on central.decision_votes (decision_id) where deleted_at is null;

-- Cada uno escribe solo su voto, y solo en decisiones vivas y vigentes. Borrar es retirar el voto (papelera del núcleo).
create or replace function central.decision_vote_row()
returns trigger language plpgsql as $$
declare v_status text;
begin
  if tg_op = 'INSERT' then
    if new.updated_by is null then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.decision_votes', 'reason', 'a vote needs a voter')); end if;
    new.voter_id := new.updated_by;
  else
    if new.updated_by is distinct from old.voter_id then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.decision_votes', 'reason', 'only the voter changes a vote'));
    end if;
    new.voter_id := old.voter_id;
    if new.decision_id is distinct from old.decision_id then perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'decision_id')); end if;
  end if;
  if new.deleted_at is null then
    select status into v_status from central.decisions where id = new.decision_id and deleted_at is null;
    if v_status is distinct from 'vigente' then
      perform core.fail('DECISION_NOT_VOTABLE', 422, jsonb_build_object('table', 'central.decision_votes', 'decision_id', new.decision_id));
    end if;
  end if;
  return new;
end $$;
create trigger decision_votes_row before insert or update on central.decision_votes
  for each row execute function central.decision_vote_row();

-- Leen todos los miembros de Central; escriben también los lectores (su propio voto).
select core.register_table('central', 'central', 'decision_votes', array['decision_id','vote'],
  '{reader,editor,owner}', '{reader,editor,owner}');

-- ---------------------------------------------------------------------------
-- Decisión final de quien administra
-- ---------------------------------------------------------------------------
-- Lo escribe el owner: `review_outcome` y, para volver a decidir lo mismo más tarde, `reviewed_at` (cualquier valor: la
-- hora la pone el servidor). El disparador pone quién, cuándo y el recuento de votos vivos en ese momento. «Retirar» deja
-- la decisión revocada. Si alguien la vuelve a poner vigente, deja de constar como retirada (lo último decidido se queda en
-- `reviewed_*`). Una decisión nueva nace sin decidir.
alter table central.decisions
  add column review_outcome text check (review_outcome is null or review_outcome in ('mantener','retirar')),
  add column reviewed_by uuid references auth.users(id),
  add column reviewed_at timestamptz,
  add column review_tally jsonb check (review_tally is null or jsonb_typeof(review_tally) = 'object');

create or replace function central.decision_review_row()
returns trigger language plpgsql as $$
declare v_role text;
begin
  if tg_op = 'INSERT' then
    new.review_outcome := null; new.reviewed_by := null; new.reviewed_at := null; new.review_tally := null;
    return new;
  end if;
  if old.review_outcome = 'retirar' and old.status = 'revocada' and new.status = 'vigente' and new.review_outcome = 'retirar' then
    new.review_outcome := null;
    new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at; new.review_tally := old.review_tally;
    return new;
  end if;
  if new.review_outcome is not distinct from old.review_outcome and new.reviewed_at is not distinct from old.reviewed_at then
    new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at; new.review_tally := old.review_tally;
    return new;
  end if;
  select role into v_role from core.memberships where app = 'central' and user_id = new.updated_by;
  if v_role is distinct from 'owner' then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.decisions', 'field', 'review_outcome', 'reason', 'only the owner decides'));
  end if;
  if new.review_outcome is null then
    new.reviewed_by := null; new.reviewed_at := null; new.review_tally := null;
    return new;
  end if;
  if new.review_outcome = 'retirar' then
    if new.status = 'sustituida' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'review_outcome', 'reason', 'superseded')); end if;
    new.status := 'revocada';
  end if;
  new.reviewed_by := new.updated_by;
  new.reviewed_at := now();
  new.review_tally := jsonb_build_object(
    'mantener', (select count(*) from central.decision_votes v where v.decision_id = new.id and v.deleted_at is null and v.vote = 'mantener'),
    'retirar', (select count(*) from central.decision_votes v where v.decision_id = new.id and v.deleted_at is null and v.vote = 'retirar'));
  return new;
end $$;
create trigger decisions_review before insert or update on central.decisions
  for each row execute function central.decision_review_row();

select core.register_table('central', 'central', 'decisions', array['decided_on','name','summary','technical','responsible_person_id',
  'status','superseded_by','scopes','link_url','link_label','review_outcome','reviewed_at']);

-- ---------------------------------------------------------------------------
-- 2. Pantallas de Revisión
-- ---------------------------------------------------------------------------
create table central.review_screens (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  -- App de la pantalla (`transversal`: piezas comunes del kit o el menú).
  app text not null check (app in ('central','tasks','invoices','booking','food','guests','organizers','resources','transversal')),
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Uno de los diez pasos del cuadro de avance (claves en _domain/central/review.ts).
  step text not null default 'sin' check (step in ('cal','fuera','sin','hoy','alt','demo','listo','cons','aprob','hecha')),
  -- «Ir al sitio» (prototipo o pantalla real) y lo que une el feedback a la pantalla.
  url text check (url is null or (length(url) <= 500 and url ~ '^https://')),
  route text check (route is null or (length(route) <= 120 and route ~ '^#/')),
  feedback_prefix text check (feedback_prefix is null or (length(feedback_prefix) <= 120 and feedback_prefix ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)*$')),
  handoff text check (handoff is null or length(btrim(handoff)) between 1 and 40),
  note text check (note is null or length(note) <= 1000),
  position integer not null default 0
);
create unique index review_screens_name_idx on central.review_screens (app, lower(name)) where deleted_at is null;
create index review_screens_app_idx on central.review_screens (app, position) where deleted_at is null;

-- Leen todos los miembros (ven el avance); escribe solo el owner (decidir, revisar y comprobar son suyos).
select core.register_table('central', 'central', 'review_screens', array['app','name','step','url','route','feedback_prefix','handoff','note','position'],
  '{reader,editor,owner}', '{owner}');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
