-- Ikisai Flow · documentos e imágenes del flujo subidos desde la app (orden de VG del 27-10, paso 1; bucket `flow-media`,
-- alta de Core). Los usan las versiones nuevas; la v1 congelada sigue con lo que tenía (portada y guías del código) mientras
-- no tenga documentos propios. Las guías del Inicio y la portada dejan de vivir en el código: son archivos del proyecto (core.files) que el owner
-- sube, ordena y quita. Las imágenes de producto siguen como están (apps/flow/public/assets, por image_key).

-- Portada del proyecto (sustituye a cover_image, que queda para lo ya publicado).
alter table flow.projects add column cover_file_id uuid;
select core.register_table('flow', 'flow', 'projects', array['name','status','notes','booking_event_id','starts_on','ends_on','cover_image','test_mode','food_menu_id','tasks_project_id','template_key','template_version','frozen','serves_public','cover_file_id'], '{reader,editor,owner,outsider}', '{owner}', false);
select core.register_file_field('flow', 'flow', 'projects', 'cover_file_id', 'permanent');

-- Documentos del flujo (guías del Inicio), en su orden.
create table flow.project_documents (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  file_id uuid not null,
  title text not null check (length(title) between 1 and 120),
  mime text check (mime is null or mime in ('image/webp','image/jpeg','image/png','application/pdf')),
  position integer not null default 0
);
create index project_documents_project_idx on flow.project_documents (project_id, position) where deleted_at is null;
select core.register_table('flow', 'flow', 'project_documents', array['project_id','file_id','title','mime','position'], '{reader,editor,owner,outsider}', '{owner}', false);
select core.register_file_field('flow', 'flow', 'project_documents', 'file_id', 'permanent');
create trigger flow_scope before insert or update on flow.project_documents for each row execute function flow.guard_scope();

-- Para Central (accesos por proyecto, ámbitos de la 0902): los proyectos vivos de Flow. Solo el owner de Central.
create view flow.projects_projection as
  select id, name, status, starts_on, ends_on, test_mode, booking_event_id
    from flow.projects where deleted_at is null;
select core.allow_read('central', 'flow.projects_projection', 'view', '{owner}');

-- «Nueva versión del flujo» copia también la portada subida y los documentos (los mismos archivos, sin duplicarlos).
alter function flow.new_version(jsonb) rename to new_version_base;
create or replace function flow.new_version(p jsonb) returns jsonb language plpgsql as $$
declare v_out jsonb; v_src flow.projects; v_new flow.projects; v_doc flow.project_documents;
begin
  v_out := flow.new_version_base(p);
  perform flow.proc_begin();
  select * into v_src from flow.projects where id = flow.arg_uuid(p, 'source_project_id');
  select * into v_new from flow.projects where id = (v_out->>'project_id')::uuid;
  if v_src.cover_file_id is not null then
    perform flow.upd(p, 'flow.projects', v_new.id, v_new.revision, jsonb_build_object('cover_file_id', v_src.cover_file_id));
  end if;
  for v_doc in select * from flow.project_documents where project_id = v_src.id and deleted_at is null order by position loop
    perform flow.ins(p, 'flow.project_documents', jsonb_build_object('project_id', v_new.id, 'file_id', v_doc.file_id, 'title', v_doc.title, 'mime', v_doc.mime, 'position', v_doc.position));
  end loop;
  perform flow.proc_end();
  return v_out;
end $$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
