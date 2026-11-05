import type { GridCell, LatLon } from '../types';
import { shoreCrossings, waterRoute } from './geo';

/** waypoints.json, as sent to the robot. Format described in docs/robot-protocol.md. */
export interface WaypointsFile {
  format: 'scrub-waypoints/1';
  mission_id: string;
  device_id: string;
  lake_id: string;
  lake_name: string | null;
  generated_at: string;
  cell_size_m: number;
  /** Ground control station: where the robot starts and returns to. Also the first and last waypoint. */
  gcs: LatLon | null;
  count: number;
  sha256: string;
  waypoints: Waypoint[];
}

export interface Waypoint {
  seq: number;
  lat: number;
  lon: number;
  type: WaypointType;
  grid_id: string | null;
}

/** `gcs` = ground control station (start and return point), `lane` = sampling cell, `detour` = extra point to stay in water. */
export type WaypointType = 'gcs' | 'lane' | 'detour';

/** A route in visiting order; `kinds` is parallel to `path`. */
export interface Route {
  path: LatLon[];
  kinds: WaypointType[];
  /** in-water stretch added so the trip back to the GCS avoids land (for drawing), or null */
  returnDetour: LatLon[] | null;
  /** problems with the legs to and from the GCS, for the operator */
  gcsWarnings: string[];
}

/** Lake geometry, so the legs to and from the GCS can be checked against land. */
export interface Water {
  cells: GridCell[];
  boundary: LatLon[] | null;
  holes: LatLon[][];
}

const distSq = (a: LatLon, b: LatLon) => {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return (a.lat - b.lat) ** 2 + ((a.lon - b.lon) * k) ** 2;
};

/** A leg to or from the GCS is fine when it crosses the shore at most once and no island. */
function gcsLegOk(a: LatLon, b: LatLon, water: Water | undefined): boolean {
  if (!water?.boundary || water.boundary.length < 3) return true;
  const c = shoreCrossings(a, b, water.boundary, water.holes);
  return c.shore <= 1 && c.islands === 0;
}

/**
 * The full mission route: GCS -> coverage path -> back to GCS. The coverage path is
 * reversed when its far end is nearer the GCS, so the robot enters at the closest cell.
 * When the straight trip home would cross land, the robot first goes back through the
 * water to the entry cell and leaves the lake the way it came in.
 * Without a GCS the coverage path is returned unchanged.
 */
export function routeWithGcs(
  plan: { path: LatLon[]; kinds: Array<'lane' | 'detour'> },
  gcs: LatLon | null,
  water?: Water,
): Route {
  if (!gcs || plan.path.length === 0) return { path: plan.path, kinds: plan.kinds, returnDetour: null, gcsWarnings: [] };
  const reverse = distSq(gcs, plan.path[plan.path.length - 1]) < distSq(gcs, plan.path[0]);
  const path = reverse ? [...plan.path].reverse() : plan.path;
  const kinds = reverse ? [...plan.kinds].reverse() : plan.kinds;
  const entry = path[0];
  const last = path[path.length - 1];
  const warnings: string[] = [];
  if (!gcsLegOk(gcs, entry, water)) {
    warnings.push('The straight line from the GCS to the first waypoint crosses land. Move the GCS so the robot can reach the water directly.');
  }

  let home: LatLon[] = [];
  if (path.length > 1 && !gcsLegOk(last, gcs, water)) {
    const via = water ? waterRoute(water.cells, water.boundary, water.holes, last, entry) : null;
    if (via) home = [...via, entry];
    else warnings.push('The trip back to the GCS crosses land and no route through the water was found.');
  }
  return {
    path: [gcs, ...path, ...home, gcs],
    kinds: ['gcs', ...kinds, ...home.map((): WaypointType => 'detour'), 'gcs'],
    returnDetour: home.length > 0 ? [last, ...home] : null,
    gcsWarnings: warnings,
  };
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
export function planWaypoints(plan: { path: LatLon[]; kinds: WaypointType[] }, cells: GridCell[], cellToGridId: Map<string, string>): Waypoint[] {
  const cellIds = cellIdsForPath(plan.path, cells);
  return plan.path.map((p, i) => {
    const cellId = plan.kinds[i] === 'gcs' ? null : cellIds[i];
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
  gcs?: LatLon | null;
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
    gcs: input.gcs ? { lat: round7(input.gcs.lat), lon: round7(input.gcs.lon) } : null,
    count: input.waypoints.length,
    sha256: await waypointChecksum(input.waypoints),
    waypoints: input.waypoints,
  };
}
