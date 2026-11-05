-- Polygon (boustrophedon) navigation and GPS-tagged sensor history.
-- Run after 20261106000000_gcs_and_return_home.sql. Safe to run more than once.
-- Needs PostGIS (already used by grids.center_geom and lakes.boundary).

-- 1. Missions keep the plan they were started with.
alter table public.missions add column if not exists gcs_lat            double precision;
alter table public.missions add column if not exists gcs_lon            double precision;
alter table public.missions add column if not exists polygon            geometry(Polygon, 4326);
alter table public.missions add column if not exists sweep_spacing_m    double precision;
alter table public.missions add column if not exists waypoint_count     integer;
alter table public.missions add column if not exists waypoint_checksum  text;
-- full mission payload as sent to the robot (docs/robot-protocol.md, section 2)
alter table public.missions add column if not exists plan               jsonb;
-- progress kept by the robot while it runs the mission
alter table public.missions add column if not exists current_waypoint   integer;

create index if not exists missions_device_created on public.missions (device_id, created_at desc);

-- 2. Sensor records (one every 10 s) keep where and how the robot was pointing.
alter table public.sensor_samples add column if not exists heading_deg double precision;
alter table public.sensor_samples add column if not exists position geometry(Point, 4326)
  generated always as (st_setsrid(st_makepoint(longitude, latitude), 4326)) stored;

create index if not exists sensor_samples_position on public.sensor_samples using gist (position);
create index if not exists sensor_samples_mission_time on public.sensor_samples (mission_id, recorded_at);
