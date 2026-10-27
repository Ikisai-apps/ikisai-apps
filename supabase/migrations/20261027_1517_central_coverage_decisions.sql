-- Central · Revisión › Uso y cobertura (visión V0.2 aprobada por VG, 27-10): la decisión de una persona sobre cada función o
-- campo (mantener, simplificar, integrar o retirar), con su nota. Nunca la pone el sistema: el estado de cobertura solo
-- informa. Una decisión viva por función. Escribe solo el owner de Central (administra la revisión); lee también solo él.
-- Referencia: docs/central/API.md §2.17. Toca solo central.
create table central.coverage_decisions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  -- App y función o campo (el id de uso o, si no está instrumentado, el del inventario de UI-kit).
  app text not null check (app ~ '^[a-z][a-z0-9_]{0,39}$'),
  feature_id text not null check (length(feature_id) between 1 and 200),
  decision text not null check (decision in ('mantener','simplificar','integrar','retirar')),
  note text check (note is null or length(note) <= 500)
);
create unique index coverage_decisions_feature_idx on central.coverage_decisions (feature_id) where deleted_at is null;

select core.register_table('central', 'central', 'coverage_decisions', array['app','feature_id','decision','note'], '{owner}', '{owner}');
