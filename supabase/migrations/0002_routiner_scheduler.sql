-- Hands-off scheduling for the Claude Routine Planner.
-- pg_cron + pg_net are pre-installed on Supabase. This schedules a
-- once-a-minute call to the `routiner-scheduler` edge function, which
-- finds due routines and fires them.
--
-- The Authorization bearer below is the project's PUBLIC anon key (safe to
-- commit) — it only satisfies the function's verify_jwt check; the function
-- itself uses the service role from its own env to read/write the tables.

select cron.schedule(
  'routiner-scheduler',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://vonfdzttupyemtomsojy.functions.supabase.co/routiner-scheduler',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer <PROJECT_ANON_KEY>'
       )
     ); $$
);

-- To inspect / manage:
--   select * from cron.job where jobname = 'routiner-scheduler';
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select cron.unschedule('routiner-scheduler');
