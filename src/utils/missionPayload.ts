/**
 * Mission payload sent to the Raspberry Pi (REST `POST /api/missions`, or the
 * `LOAD_WAYPOINTS` command over Supabase). This is the mission API contract, not the
 * STM32 UART packet. Documented in docs/robot-protocol.md.
 */
import type { LatLon } from '../types';
import type { WaypointKind } from './coverage';

export const MISSION_FORMAT = 'scrub-mission/2';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface MissionWaypoint {
  /** 0 = GCS; the last waypoint is the GCS again */
  sequence_order: number;
  latitude: number;
  longitude: number;
  type: WaypointKind;
}

export interface MissionPayload {
  format: typeof MISSION_FORMAT;
  mission_id: string;
  device_id: string;
  created_at: string;
  /** Supabase lakes.lake_id, when the lake is stored there */
  lake_id: string | null;
  lake_name: string | null;
  ground_control: GeoPoint;
  /** lake outline, open ring */
  polygon: GeoPoint[];
  /** islands inside the outline: the robot never enters them */
  islands: GeoPoint[][];
  sweep_spacing_m: number;
  shore_margin_m: number;
  /** a waypoint counts as reached within this distance */
  acceptance_radius_m: number;
  waypoint_count: number;
  /** SHA-256 of the waypoint list, see canonicalWaypointText */
  checksum: string;
  waypoints: MissionWaypoint[];
  /** "demo" = drawn path, open-loop motor control (no polygon, no GCS-return rule) */
  mode?: 'demo';
  demo?: DemoBlock;
}

/** Demo mission block (docs/robot-protocol.md, section 9). x = east, y = north, metres. */
export interface DemoBlock {
  path_m: Array<{ x_m: number; y_m: number }>;
  start_heading_deg: number;
  calibration: { drive_mps_per_power: number; turn_dps_per_power: number };
  max_power: number;
}

const round7 = (v: number) => Number(v.toFixed(7));
const geo = (p: LatLon): GeoPoint => ({ latitude: round7(p.lat), longitude: round7(p.lon) });

/** Waypoints in visiting order, numbered from 0 (the GCS). */
export function toMissionWaypoints(path: LatLon[], kinds: WaypointKind[]): MissionWaypoint[] {
  return path.map((p, i) => ({ sequence_order: i, latitude: round7(p.lat), longitude: round7(p.lon), type: kinds[i] ?? 'COVERAGE' }));
}

/** One line per waypoint: `{sequence_order},{latitude:.7f},{longitude:.7f},{type}\n`. The Pi recomputes this exactly. */
export function canonicalWaypointText(waypoints: MissionWaypoint[]): string {
  return waypoints.map((w) => `${w.sequence_order},${w.latitude.toFixed(7)},${w.longitude.toFixed(7)},${w.type}\n`).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildMissionPayload(input: {
  missionId: string;
  deviceId: string;
  lakeId: string | null;
  lakeName: string | null;
  gcs: LatLon;
  polygon: LatLon[];
  islands: LatLon[][];
  sweepSpacingM: number;
  shoreMarginM: number;
  acceptanceRadiusM: number;
  path: LatLon[];
  kinds: WaypointKind[];
  createdAt?: string;
  /** demo missions: polygon and islands are empty */
  demo?: DemoBlock;
}): Promise<MissionPayload> {
  const waypoints = toMissionWaypoints(input.path, input.kinds);
  return {
    format: MISSION_FORMAT,
    mission_id: input.missionId,
    device_id: input.deviceId,
    created_at: input.createdAt ?? new Date().toISOString(),
    lake_id: input.lakeId,
    lake_name: input.lakeName,
    ground_control: geo(input.gcs),
    polygon: input.polygon.map(geo),
    islands: input.islands.filter((h) => h.length >= 3).map((h) => h.map(geo)),
    sweep_spacing_m: input.sweepSpacingM,
    shore_margin_m: input.shoreMarginM,
    acceptance_radius_m: input.acceptanceRadiusM,
    waypoint_count: waypoints.length,
    checksum: await sha256Hex(canonicalWaypointText(waypoints)),
    waypoints,
    ...(input.demo
      ? {
          mode: 'demo' as const,
          demo: {
            path_m: input.demo.path_m.map((q) => ({ x_m: Number(q.x_m.toFixed(3)), y_m: Number(q.y_m.toFixed(3)) })),
            start_heading_deg: input.demo.start_heading_deg,
            calibration: { ...input.demo.calibration },
            max_power: input.demo.max_power,
          },
        }
      : {}),
  };
}

/**
 * Check the Pi's load acknowledgement: it must report the same waypoint count and
 * checksum it recomputed from what it stored. Returns a reason when it does not match.
 */
export function ackMismatch(payload: Pick<MissionPayload, 'waypoint_count' | 'checksum'>, ack: Record<string, unknown> | null): string | null {
  const count = Number(ack?.waypoint_count);
  const checksum = typeof ack?.checksum === 'string' ? ack.checksum.toLowerCase() : '';
  if (count === payload.waypoint_count && checksum === payload.checksum) return null;
  if (ack?.waypoint_count === undefined && ack?.checksum === undefined) {
    return 'The robot answered without a waypoint count or checksum: the backend is on an old version, update the Pi. Not safe to start.';
  }
  const parts: string[] = [];
  if (count !== payload.waypoint_count) parts.push(`${Number.isFinite(count) ? count : 'no'} waypoints (sent ${payload.waypoint_count})`);
  if (checksum !== payload.checksum) parts.push(checksum ? 'a different checksum' : 'no checksum');
  return `The robot answered, but reported ${parts.join(' and ')}. Not safe to start: send the plan again.`;
}
