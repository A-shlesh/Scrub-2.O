-- ============================================================================
-- SCRUB — shared Supabase schema (single source of truth)
--
-- Used by BOTH the dashboard (this repo) and the Raspberry Pi backend.
-- Diagram: docs/images/supabase-schema.webp   Rules: docs/supabase-schema.md
-- Change it only by agreement, in both repositories, in the same release.
--
-- Safe to run more than once on a new project (create ... if not exists).
-- Needs PostGIS for the *_geom columns.
-- ============================================================================

create extension if not exists postgis;

-- ─── lakes: lake info and its boundary ──────────────────────────────────────
create table if not exists public.lakes (
  lake_id        uuid primary key default gen_random_uuid(),
  name           text not null,
  boundary_geom  geometry(Polygon, 4326),
  created_at     timestamptz not null default now()
);

-- ─── missions: one autonomous trash-collection mission ──────────────────────
create table if not exists public.missions (
  mission_id              uuid primary key default gen_random_uuid(),
  device_id               text not null,
  lake_id                 uuid references public.lakes (lake_id),
  polygon_geom            geometry(Polygon, 4326),
  status                  text not null default 'PENDING'
    check (status in ('PENDING', 'LOADING_WAYPOINTS', 'READY', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ABORTED', 'FAILED')),
  waypoint_load_ack       boolean not null default false,
  total_waypoints         integer,
  current_waypoint_index  integer,
  progress_percent        numeric(5, 2),
  started_at              timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz not null default now(),
  notes                   text
);
create index if not exists missions_device_created on public.missions (device_id, created_at desc);
create index if not exists missions_lake on public.missions (lake_id);

-- ─── mission_waypoints: the generated boustrophedon route ───────────────────
create table if not exists public.mission_waypoints (
  waypoint_id     uuid primary key default gen_random_uuid(),
  mission_id      uuid not null references public.missions (mission_id) on delete cascade,
  sequence_order  integer not null,
  latitude        double precision not null,
  longitude       double precision not null,
  waypoint_geom   geometry(Point, 4326),
  status          text not null default 'PENDING'
    check (status in ('PENDING', 'ACTIVE', 'COMPLETED', 'SKIPPED')),
  created_at      timestamptz not null default now(),
  unique (mission_id, sequence_order)
);

-- ─── sensor_readings: sensor data uploaded every 10 seconds ─────────────────
create table if not exists public.sensor_readings (
  reading_id        uuid primary key default gen_random_uuid(),
  local_record_id   uuid not null unique,
  mission_id        uuid references public.missions (mission_id),
  device_id         text not null,
  recorded_at       timestamptz not null,
  latitude          double precision,
  longitude         double precision,
  position_geom     geometry(Point, 4326),
  heading           double precision,
  ph                numeric,
  tds               numeric,
  turbidity         numeric,
  temperature_c     numeric,
  humidity_percent  numeric,
  created_at        timestamptz not null default now()
);
create index if not exists sensor_readings_device_time on public.sensor_readings (device_id, recorded_at);
create index if not exists sensor_readings_mission_time on public.sensor_readings (mission_id, recorded_at);
create index if not exists sensor_readings_position on public.sensor_readings using gist (position_geom);
