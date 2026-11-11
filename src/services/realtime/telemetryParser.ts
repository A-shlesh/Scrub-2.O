/**
 * Turns one live telemetry message from the robot into `Telemetry`.
 *
 * Two shapes are accepted (docs/robot-protocol.md, section 3):
 * - nested, as forwarded by the Raspberry Pi from the STM32 packet
 *   (`gps.latitude`, `compass.heading`, `sensors.ph`, `motors.left`, ...) plus a
 *   `navigation` object with the Pi's mission state;
 * - flat (`lat`, `heading_deg`, `ph`, `mission_state`, ...), the original broadcast format.
 * Older backend names are accepted as a fallback so the page degrades gracefully:
 * `position.{latitude,longitude,gps_valid}`, top-level `heading`, `navigation.nav_state`,
 * `navigation.current_waypoint_index`, `navigation.progress_percent` (0-100),
 * `mission_status`, and a numeric epoch-milliseconds `timestamp`.
 *
 * Unknown, missing, wrong-typed or impossible values become null rather than being trusted.
 */
import type { LatLon, MissionState, Telemetry } from '../../types';

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return null;
};
/** Motor values may arrive as "+100" strings (the Pi -> STM32 packet uses strings). */
const motor = (v: unknown): number | null => {
  if (typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return num(v);
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Robot state names (any case) -> the dashboard's mission states. */
const STATE_ALIASES: Record<string, MissionState> = {
  idle: 'idle',
  loaded: 'loaded',
  mission_received: 'loaded',
  ready: 'loaded',
  transit: 'transit',
  navigating: 'transit',
  coverage: 'transit',
  waypoint_reached: 'transit',
  active: 'transit',
  running: 'transit',
  sampling: 'sampling',
  returning: 'returning',
  return_home: 'returning',
  returning_home: 'returning',
  paused: 'paused',
  completed: 'completed',
  complete: 'completed',
  aborted: 'aborted',
  stopped: 'aborted',
  emergency_stop: 'emergency_stop',
  estop: 'emergency_stop',
  error: 'error',
  fault: 'error',
};

export function normaliseMissionState(v: unknown): MissionState {
  const s = str(v)?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (s && STATE_ALIASES[s]) || 'unknown';
}

function point(latV: unknown, lonV: unknown): LatLon | null {
  const lat = num(latV);
  const lon = num(lonV);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // 0,0 is what most GPS modules report before they have a fix.
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** ISO string, or epoch milliseconds (seconds when small) converted to ISO; else null. */
function isoTime(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v < 1e11 ? v * 1000 : v; // 1e11 ms is 1973; smaller values are seconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function parseTelemetry(payload: unknown, robotId = 'BOT001'): Telemetry | null {
  let p = obj(payload);
  if (!p) return null;
  // Some backends wrap the frame: {"type": "telemetry", "data": {...}}.
  const wrapped = obj(p.data);
  if (wrapped && (p.type === 'telemetry' || p.type === undefined)) p = wrapped;

  const gps = obj(p.gps);
  const position = obj(p.position); // older backend
  const compass = obj(p.compass);
  const sensors = obj(p.sensors);
  const motors = obj(p.motors);
  const nav = obj(p.navigation);
  const target = obj(nav?.target);

  const pos = gps
    ? point(gps.latitude, gps.longitude)
    : position
      ? point(position.latitude, position.longitude)
      : point(p.lat, p.lon);
  const fixFlag = gps?.fix ?? position?.gps_valid ?? p.fix;
  const pick = (nested: unknown, flat: unknown) => (nested !== undefined ? nested : flat);
  const sensor = (key: string, flatKey = key) => num(pick(sensors?.[key], p[flatKey]));

  const pctOld = num(nav?.progress_percent);
  const progress = num(nav?.progress) ?? (pctOld !== null ? pctOld / 100 : null);
  return {
    robotId: str(p.device_id) ?? str(p.robot_id) ?? robotId,
    timestamp: isoTime(p.timestamp) ?? isoTime(p.ts),
    sequence: num(p.sequence) ?? num(p.seq),
    water: { ph: sensor('ph'), turbidityNtu: sensor('turbidity'), tdsPpm: sensor('tds') },
    air: { aqi: num(p.aqi), temperatureC: sensor('temperature_c'), humidityPct: sensor('humidity_percent') },
    gps: {
      latitude: pos?.lat ?? null,
      longitude: pos?.lon ?? null,
      speedMps: num(pick(gps?.speed_mps, p.speed_mps)),
      fix: pos !== null && fixFlag !== false,
      satellites: num(pick(gps?.satellites, p.satellites)),
    },
    compass: { headingDeg: num(compass?.heading) ?? num(p.heading_deg) ?? num(p.heading) },
    batteryPercent: num(p.battery_percent),
    missionId: str(nav?.mission_id) ?? str(p.mission_id),
    missionState: normaliseMissionState(nav?.state ?? nav?.nav_state ?? p.mission_state ?? p.mission_status),
    currentWaypoint: num(nav?.current_waypoint) ?? num(nav?.current_waypoint_index) ?? num(p.waypoint_index),
    waypointTotal: num(nav?.total_waypoints) ?? num(p.waypoint_total),
    motors: { left: motor(motors?.left), right: motor(motors?.right) },
    navigation: {
      target: target ? point(target.latitude, target.longitude) : point(p.target_lat, p.target_lon),
      distanceToTargetM: num(nav?.distance_to_target_m) ?? num(p.distance_to_target_m),
      completedWaypoints: num(nav?.completed_waypoints) ?? num(p.completed_waypoints),
      progress: progress !== null && progress >= 0 && progress <= 1 ? progress : null,
    },
  };
}
