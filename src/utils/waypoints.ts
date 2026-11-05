import type { GridCell, LatLon } from '../types';
import type { CoveragePlan } from './geo';

/** waypoints.json, as sent to the robot. Format described in docs/robot-protocol.md. */
export interface WaypointsFile {
  format: 'scrub-waypoints/1';
  mission_id: string;
  device_id: string;
  lake_id: string;
  lake_name: string | null;
  generated_at: string;
  cell_size_m: number;
  count: number;
  sha256: string;
  waypoints: Waypoint[];
}

export interface Waypoint {
  seq: number;
  lat: number;
  lon: number;
  type: 'lane' | 'detour';
  grid_id: string | null;
}

const pointKey = (p: LatLon) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
const round7 = (v: number) => Number(v.toFixed(7));

/** The grid cell each path point sits on (path points are cell centres), or null. */
export function cellIdsForPath(path: LatLon[], cells: GridCell[]): Array<string | null> {
  const byCentre = new Map(cells.map((c) => [pointKey(c.center), c.id]));
  return path.map((p) => byCentre.get(pointKey(p)) ?? null);
}

/** One line per waypoint: `{seq},{lat:.7f},{lon:.7f},{type},{grid_id or ''}\n`. The robot recomputes this exactly. */
export function canonicalWaypointText(waypoints: Waypoint[]): string {
  return waypoints.map((w) => `${w.seq},${w.lat.toFixed(7)},${w.lon.toFixed(7)},${w.type},${w.grid_id ?? ''}\n`).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function waypointChecksum(waypoints: Waypoint[]): Promise<string> {
  return sha256Hex(canonicalWaypointText(waypoints));
}

/** Waypoints in visiting order, each tied to its Supabase grid row when known. */
export function planWaypoints(plan: CoveragePlan, cells: GridCell[], cellToGridId: Map<string, string>): Waypoint[] {
  const cellIds = cellIdsForPath(plan.path, cells);
  return plan.path.map((p, i) => {
    const cellId = cellIds[i];
    return {
      seq: i + 1,
      lat: round7(p.lat),
      lon: round7(p.lon),
      type: plan.kinds[i] ?? 'lane',
      grid_id: cellId ? cellToGridId.get(cellId) ?? null : null,
    };
  });
}

export async function buildWaypointsFile(input: {
  missionId: string;
  deviceId: string;
  supabaseLakeId: string;
  lakeName: string | null;
  cellSizeM: number;
  waypoints: Waypoint[];
  generatedAt?: string;
}): Promise<WaypointsFile> {
  return {
    format: 'scrub-waypoints/1',
    mission_id: input.missionId,
    device_id: input.deviceId,
    lake_id: input.supabaseLakeId,
    lake_name: input.lakeName,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    cell_size_m: input.cellSizeM,
    count: input.waypoints.length,
    sha256: await waypointChecksum(input.waypoints),
    waypoints: input.waypoints,
  };
}
