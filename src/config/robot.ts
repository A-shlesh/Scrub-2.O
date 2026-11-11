/**
 * Robot figures used for planning and estimates. Set the real values in the environment
 * (see .env.example); the defaults are placeholders, not measured values.
 */
function num(raw: string | undefined, fallback: number): number {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Cruise speed on the water, metres per second. */
export const ROBOT_SPEED_MPS = num(import.meta.env.VITE_ROBOT_SPEED_MPS, 0.8);
/** Minutes of driving on a full battery. */
export const BATTERY_MINUTES = num(import.meta.env.VITE_BATTERY_MINUTES, 120);
/** Default distance between sweep lines (effective cleaning width), metres. Changeable per lake on the Mission page. */
export const SWEEP_SPACING_M = num(import.meta.env.VITE_SWEEP_SPACING_M, 10);
/** A waypoint counts as reached within this distance, metres (sent to the robot with the mission). */
export const ACCEPTANCE_RADIUS_M = num(import.meta.env.VITE_ACCEPTANCE_RADIUS_M, 3);
/** Battery percentage to keep in reserve when the mission ends. */
export const BATTERY_RESERVE_PCT = 20;
/** Below this battery percentage a mission is not started. */
export const MIN_START_BATTERY_PCT = 30;
/** The robot stores one sensor record every this many seconds (locally and in the cloud). */
export const SENSOR_RECORD_SECONDS = 10;
/** The robot this dashboard controls (missions.device_id, sensor_readings.device_id). */
export const ROBOT_ID = (import.meta.env.VITE_ROBOT_ID as string | undefined)?.trim() || 'BOT001';
