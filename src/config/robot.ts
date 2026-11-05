/**
 * Robot figures used for mission estimates. Set the real values in the environment
 * (see .env.example); the defaults are placeholders, not measured values.
 */
function num(raw: string | undefined, fallback: number): number {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Cruise speed on the water, metres per second. */
export const ROBOT_SPEED_MPS = num(import.meta.env.VITE_ROBOT_SPEED_MPS, 0.8);
/** Time the robot stops at each sampling cell, seconds. */
export const SAMPLE_SECONDS = num(import.meta.env.VITE_SAMPLE_SECONDS, 10);
/** Minutes of driving on a full battery. */
export const BATTERY_MINUTES = num(import.meta.env.VITE_BATTERY_MINUTES, 120);
/** Battery percentage to keep in reserve when the mission ends. */
export const BATTERY_RESERVE_PCT = 20;
/** Below this battery percentage a mission is not started. */
export const MIN_START_BATTERY_PCT = 30;
