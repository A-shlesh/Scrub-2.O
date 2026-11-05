-- Operator sign-in and row level security. NOT part of schema.sql: run it by hand, only
-- when everything below is ready, or the dashboard loses access.
--
-- Before running:
--   1. Supabase -> Authentication -> Users: create an account for every operator.
--   2. Give the Raspberry Pi the service_role key (it bypasses RLS). Keep that key on
--      the Pi only; never put it in the website or in a repository.
--   3. Set VITE_REQUIRE_LOGIN=1 for the website (Vercel env vars) and redeploy.
--
-- After this, only signed-in operators can read or write through the website's key.

do $$
declare t text;
begin
  foreach t in array array['lakes', 'missions', 'mission_waypoints', 'sensor_readings']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists operators_all on public.%I', t);
      execute format('create policy operators_all on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- To undo (back to open access):
--   alter table public.<table> disable row level security;   -- for each table above
