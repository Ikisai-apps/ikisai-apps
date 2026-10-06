-- Ikisai Core · limpieza del historial de pg_cron: cron.job_run_details guarda cada ejecución (≈ 300 al día) y no se
-- purga solo. Se conservan 7 días. pg_net ya borra sus respuestas a las 6 horas por defecto.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then return; end if;
  execute $q$select cron.schedule('ikisai-cron-history-cleanup', '40 3 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$)$q$;
end $$;
