-- SCRUB mission control over Supabase.
-- See docs/robot-protocol.md for how the dashboard and the Raspberry Pi use these.
-- Safe to run more than once.

-- 1. Commands from the dashboard to the robot, acknowledged by the robot.
create table if not exists public.robot_commands (
  command_id  uuid primary key default gen_random_uuid(),
  device_id   text        not null,
  mission_id  uuid,
  command     text        not null check (command in ('LOAD_WAYPOINTS', 'START', 'PAUSE', 'RESUME', 'STOP', 'EMERGENCY_STOP')),
  payload     jsonb,
  status      text        not null default 'PENDING' check (status in ('PENDING', 'ACKED', 'REJECTED', 'EXPIRED')),
  detail      text,
  ack         jsonb,
  created_at  timestamptz not null default now(),
  acked_at    timestamptz
);

create index if not exists robot_commands_device_pending
  on public.robot_commands (device_id, created_at)
  where status = 'PENDING';

-- The dashboard waits for acknowledgements, and the Pi waits for new commands,
-- through Realtime "postgres_changes", which only covers tables in this publication.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'robot_commands'
  ) then
    alter publication supabase_realtime add table public.robot_commands;
  end if;
end $$;

-- 2. Which robot and mission each cloud sensor record belongs to.
-- Records uploaded every 10 s are often taken between grid cells, so grid_id
-- (and the session it belongs to) may be empty for them.
alter table public.sensor_samples add column if not exists device_id  text;
alter table public.sensor_samples add column if not exists mission_id uuid;
alter table public.sensor_samples alter column grid_id    drop not null;
alter table public.sensor_samples alter column session_id drop not null;

create index if not exists sensor_samples_device_time
  on public.sensor_samples (device_id, recorded_at desc);

-- 3. Security: READ BEFORE GOING LIVE.
-- The dashboard uses the public anon key. Unless row level security restricts
-- robot_commands, anyone who has that key (it ships in the website) can send
-- START or STOP to the robot. Before using this on a real robot:
--   * enable RLS on robot_commands,
--   * allow INSERT only for signed-in operators (Supabase Auth),
--   * allow UPDATE of status/ack/detail/acked_at only for the robot's own account.
-- Example, once operators sign in:
--   alter table public.robot_commands enable row level security;
--   create policy operators_insert on public.robot_commands for insert to authenticated with check (true);
--   create policy operators_read   on public.robot_commands for select to authenticated using (true);
