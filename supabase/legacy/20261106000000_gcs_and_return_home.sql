-- GCS (ground control station) per lake, and the RETURN_HOME robot command.
-- Run after 20261105000000_mission_control.sql. Safe to run more than once.

-- 1. Where the robot is launched and returns to, shared by every device.
alter table public.lakes add column if not exists gcs_lat double precision;
alter table public.lakes add column if not exists gcs_lon double precision;

-- 2. Allow the "Return to GCS" command.
alter table public.robot_commands drop constraint if exists robot_commands_command_check;
alter table public.robot_commands add constraint robot_commands_command_check
  check (command in ('LOAD_WAYPOINTS', 'START', 'PAUSE', 'RESUME', 'STOP', 'RETURN_HOME', 'EMERGENCY_STOP'));
