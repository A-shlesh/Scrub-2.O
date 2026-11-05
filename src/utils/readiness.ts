import type { Telemetry } from '../types';
import { BATTERY_MINUTES, BATTERY_RESERVE_PCT, MIN_START_BATTERY_PCT, ROBOT_SPEED_MPS, SAMPLE_SECONDS } from '../config/robot';

export interface MissionEstimate {
  distanceM: number;
  minutes: number;
  /** battery percentage the mission uses, plus the reserve */
  batteryNeededPct: number;
}

/** Rough time and battery for a route of `distanceM` metres with `sampleStops` sampling cells. */
export function estimateMission(distanceM: number, sampleStops: number): MissionEstimate {
  const minutes = (distanceM / ROBOT_SPEED_MPS + sampleStops * SAMPLE_SECONDS) / 60;
  return {
    distanceM,
    minutes,
    batteryNeededPct: Math.min(100, Math.ceil((minutes / BATTERY_MINUTES) * 100 + BATTERY_RESERVE_PCT)),
  };
}

/** Reasons the robot should not be started now; empty when it is ready. */
export function startProblems(telemetry: Telemetry | null, live: boolean, estimate: MissionEstimate | null): string[] {
  if (!telemetry || !live) return ['No live data from the robot (it may be off or out of range).'];
  const out: string[] = [];
  if (!telemetry.gps.fix || telemetry.gps.latitude === null || telemetry.gps.longitude === null) out.push('The robot has no GPS fix.');
  const battery = telemetry.batteryPercent;
  if (typeof battery !== 'number' || !Number.isFinite(battery)) {
    out.push('The robot is not reporting its battery level.');
  } else if (battery < MIN_START_BATTERY_PCT) {
    out.push(`Battery is at ${Math.round(battery)}% (needs at least ${MIN_START_BATTERY_PCT}% to start).`);
  } else if (estimate && battery < estimate.batteryNeededPct) {
    out.push(`Battery is at ${Math.round(battery)}%, but this mission needs about ${estimate.batteryNeededPct}% (including a ${BATTERY_RESERVE_PCT}% reserve).`);
  }
  return out;
}

/** e.g. 95 -> "1 h 35 min", 12.4 -> "13 min" */
export function fmtMinutes(minutes: number): string {
  const m = Math.max(1, Math.ceil(minutes));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
