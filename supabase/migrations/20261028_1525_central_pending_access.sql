-- Ikisai Central · accesos pendientes de una persona sin cuenta (VG, 28-10: decide hoy qué proyectos de Flow verán Anabel,
-- José Luis y Tati, pero no tendrán cuenta hasta que vengan y se la dé en persona). Lo que tendrá en cada app (hoy, sus
-- proyectos de Flow: `scopes.projects`) se guarda aquí, y Central lo aplica a su pertenencia al darle la cuenta.
-- Una fila viva por persona y app. Solo el owner de Central (también en la base). Toca solo el schema central.

create table central.pending_access (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  person_id uuid not null references central.people(id),
  app text not null check (app ~ '^[a-z][a-z0-9_]*$' and app <> 'central'),
  scopes jsonb not null check (jsonb_typeof(scopes) = 'object'),
  note text check (note is null or length(note) <= 300)
);
create unique index pending_access_person_app_idx on central.pending_access (person_id, app) where deleted_at is null;
create trigger pending_access_reparent before update on central.pending_access for each row execute function central.forbid_reparent('person_id');

select core.register_table('central', 'central', 'pending_access', array['person_id','app','scopes','note'], '{editor,owner}', '{owner}');
