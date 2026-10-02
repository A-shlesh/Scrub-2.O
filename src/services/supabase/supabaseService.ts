import type { GridCell, GridCellAverage, GridSession, GridAnalytics, Lake, LatLon, Mission, MissionGrid, SensorAverage, SensorKey, SensorMeta, SensorSample } from '../../types';
import { openRing } from '../../utils/geo';
import { getOrCreateSupabaseGridId, getOrCreateSupabaseLakeId } from '../storage/lakeStorage';
import { supabase, supabaseConfigured } from './supabaseClient';

/** Current time in IST (Asia/Kolkata, UTC+5:30) as an ISO string. */
function nowIst(): string {
  const now = Date.now();
  const IST_MS = 5.5 * 60 * 60 * 1000;
  return new Date(now + IST_MS).toISOString().replace('Z', '+05:30');
}

function polygonEwkt(points: LatLon[]): string {
  const ring = openRing(points);
  const closed = [...ring, ring[0]];
  return `SRID=4326;POLYGON((${closed.map((p) => `${p.lon} ${p.lat}`).join(', ')}))`;
}

function pointEwkt(p: LatLon): string {
  return `SRID=4326;POINT(${p.lon} ${p.lat})`;
}

/**
 * Push a lake/polygon and its full grid to Supabase (`lakes` + `grids` tables),
 * so the robot's edge logic has the point list to check GPS against before a
 * mission run. Upserts, so re-sending an unchanged lake updates rows in place
 * rather than duplicating them.
 */
export async function pushLakeAndGrids(lake: Lake, cells: GridCell[], cellSizeM: number): Promise<{ lakeId: string; gridIds: Map<string, string> }> {
  if (!supabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured — missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.');
  }
  const boundary = lake.scrubBoundary?.points ?? lake.osmBoundary?.points ?? null;
  if (!boundary || boundary.length < 3) throw new Error('This lake has no boundary to send.');
  if (cells.length === 0) throw new Error('This lake has no grid points to send.');

  // If this is a sample polygon inside a real lake, push grids under the parent lake.
  // Skip the lakes upsert in that case — don't overwrite the parent's name/boundary.
  const isChildPolygon = !!lake.parentLakeId;
  const targetLakeId = lake.parentLakeId ?? lake.id;
  const lakeId = getOrCreateSupabaseLakeId(targetLakeId);
  const now = nowIst();

  if (!isChildPolygon) {
    const { error: lakeError } = await supabase.from('lakes').upsert({
      lake_id: lakeId,
      name: lake.name ?? 'Unnamed',
      boundary: polygonEwkt(boundary),
      created_at: now,
    });
    if (lakeError) throw new Error(`Could not save lake: ${lakeError.message}`);
  }

  const gridRows = cells.map((c) => ({
    grid_id: getOrCreateSupabaseGridId(lakeId, c.id),
    lake_id: lakeId,
    grid_code: c.id,
    grid_size_m: cellSizeM,
    center_lat: c.center.lat,
    center_lon: c.center.lon,
    center_geom: pointEwkt(c.center),
    created_at: now,
  }));

  // Chunked so a large lake's grid doesn't hit request-size limits in one call.
  const CHUNK = 500;
  for (let i = 0; i < gridRows.length; i += CHUNK) {
    const { error: gridError } = await supabase.from('grids').upsert(gridRows.slice(i, i + CHUNK));
    if (gridError) throw new Error(`Could not save grid points (batch starting at row ${i + 1}): ${gridError.message}`);
  }

  return { lakeId, gridIds: new Map(gridRows.map((r) => [r.grid_code, r.grid_id])) };
}

/**
 * Create a mission with one mission_grids row per cell.
 * Call AFTER pushLakeAndGrids — needs the grids to exist.
 * sequence_order follows the coverage path order (cells in `orderedGridCodes`
 * first, in that order, then any remaining cells).
 * Returns the new mission_id.
 */
export async function createMission(
  supabaseLakeId: string,
  gridCodeToId: Map<string, string>,
  orderedGridCodes: string[],
  deviceId = 'BOT001',
): Promise<string> {
  if (!supabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured — missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.');
  }
  const now = nowIst();
  const missionId = crypto.randomUUID();

  const { error: mErr } = await supabase.from('missions').insert({
    mission_id: missionId,
    device_id: deviceId,
    lake_id: supabaseLakeId,
    status: 'PENDING',
    created_at: now,
    notes: null,
  });
  if (mErr) throw new Error(`Could not create mission: ${mErr.message}`);

  // Build the visit order: path cells first, then leftovers.
  const seen = new Set<string>();
  const ordered: { gridCode: string; gridId: string }[] = [];
  for (const code of orderedGridCodes) {
    const gid = gridCodeToId.get(code);
    if (gid && !seen.has(code)) {
      seen.add(code);
      ordered.push({ gridCode: code, gridId: gid });
    }
  }
  for (const [code, gid] of gridCodeToId) {
    if (!seen.has(code)) ordered.push({ gridCode: code, gridId: gid });
  }

  const rows = ordered.map((o, i) => ({
    mission_grid_id: crypto.randomUUID(),
    mission_id: missionId,
    grid_id: o.gridId,
    sequence_order: i + 1,
    status: 'PENDING',
    session_id: null,
  }));

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: gErr } = await supabase.from('mission_grids').insert(rows.slice(i, i + CHUNK));
    if (gErr) throw new Error(`Could not create mission grid rows (batch at ${i + 1}): ${gErr.message}`);
  }
  return missionId;
}

/**
 * Fetch mission progress: completed vs total cells for the latest mission of a lake.
 */
export async function fetchMissionProgress(lakeId: string): Promise<{ missionId: string | null; done: number; total: number; status: string | null }> {
  const EMPTY = { missionId: null, done: 0, total: 0, status: null };
  if (!supabaseConfigured || !supabase) return EMPTY;
  const supaLakeId = getOrCreateSupabaseLakeId(lakeId);
  const { data: missions, error: mErr } = await supabase
    .from('missions')
    .select('mission_id, status')
    .eq('lake_id', supaLakeId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (mErr || !missions || missions.length === 0) return EMPTY;
  const m = missions[0] as { mission_id: string; status: string };
  const { data: grids, error: gErr } = await supabase
    .from('mission_grids')
    .select('status')
    .eq('mission_id', m.mission_id);
  if (gErr) return { missionId: m.mission_id, done: 0, total: 0, status: m.status };
  const total = grids?.length ?? 0;
  const done = grids?.filter((g: { status: string }) => g.status === 'COMPLETED').length ?? 0;
  return { missionId: m.mission_id, done, total, status: m.status };
}

/**
 * Query Supabase for existing "Sample Polygon N" names and return N+1.
 * Falls back to 1 if Supabase is unreachable or has no sample polygons.
 */
export async function fetchNextPolygonNumber(): Promise<number> {
  if (!supabaseConfigured || !supabase) return 1;
  const { data, error } = await supabase
    .from('lakes')
    .select('name')
    .like('name', 'Sample Polygon %');
  if (error || !data) return 1;
  let max = 0;
  for (const row of data as { name: string }[]) {
    const m = row.name.match(/Sample Polygon (\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

// ── Sensor metadata ────────────────────────────────────────────────────────

export const SENSORS: SensorMeta[] = [
  { key: 'ph', label: 'pH', unit: '', min: 0, max: 14, colors: ['#ef4444', '#f59e0b', '#22c55e', '#22c55e', '#ef4444'] },
  { key: 'tds', label: 'TDS', unit: 'ppm', min: 0, max: 1500, colors: ['#22c55e', '#22c55e', '#f59e0b', '#f59e0b', '#ef4444'] },
  { key: 'turbidity', label: 'Turbidity', unit: 'NTU', min: 0, max: 100, colors: ['#22c55e', '#22c55e', '#f59e0b', '#f59e0b', '#ef4444'] },
  { key: 'temperature_c', label: 'Temp', unit: '°C', min: 0, max: 50, colors: ['#3b82f6', '#22c55e', '#22c55e', '#f59e0b', '#ef4444'] },
  { key: 'humidity_percent', label: 'Humidity', unit: '%', min: 0, max: 100, colors: ['#ef4444', '#f59e0b', '#22c55e', '#22c55e', '#3b82f6'] },
];

// ── Read functions ─────────────────────────────────────────────────────────

/**
 * Fetch all grid cells for a lake from Supabase.
 */
export async function fetchGridCells(lakeId: string): Promise<{ gridId: string; gridCode: string; centerLat: number; centerLon: number }[]> {
  if (!supabaseConfigured || !supabase) return [];
  const supaLakeId = getOrCreateSupabaseLakeId(lakeId);
  const { data, error } = await supabase
    .from('grids')
    .select('grid_id, grid_code, center_lat, center_lon')
    .eq('lake_id', supaLakeId);
  if (error || !data) return [];
  return data.map((r: { grid_id: string; grid_code: string; center_lat: number; center_lon: number }) => ({
    gridId: r.grid_id,
    gridCode: r.grid_code,
    centerLat: r.center_lat,
    centerLon: r.center_lon,
  }));
}

/**
 * Fetch all sensor samples for a lake's grid cells.
 * Joins grids → sensor_samples to get every reading for the given lake.
 */
export async function fetchSensorSamples(lakeId: string): Promise<SensorSample[]> {
  if (!supabaseConfigured || !supabase) return [];
  const supaLakeId = getOrCreateSupabaseLakeId(lakeId);
  // First get all grid_ids for this lake
  const { data: grids, error: gErr } = await supabase
    .from('grids')
    .select('grid_id')
    .eq('lake_id', supaLakeId);
  if (gErr || !grids || grids.length === 0) return [];
  const gridIds = grids.map((g: { grid_id: string }) => g.grid_id);
  // Then fetch samples for those grids
  const { data: samples, error: sErr } = await supabase
    .from('sensor_samples')
    .select('*')
    .in('grid_id', gridIds)
    .order('recorded_at', { ascending: true });
  if (sErr || !samples) return [];
  return samples as SensorSample[];
}

/**
 * Fetch session count and sample count for a lake.
 */
export async function fetchSessionStats(lakeId: string): Promise<{ sessions: number; samples: number }> {
  if (!supabaseConfigured || !supabase) return { sessions: 0, samples: 0 };
  const supaLakeId = getOrCreateSupabaseLakeId(lakeId);
  const { data: grids } = await supabase
    .from('grids')
    .select('grid_id')
    .eq('lake_id', supaLakeId);
  if (!grids || grids.length === 0) return { sessions: 0, samples: 0 };
  const gridIds = grids.map((g: { grid_id: string }) => g.grid_id);
  const { count: sessions } = await supabase
    .from('grid_sessions')
    .select('session_id', { count: 'exact', head: true })
    .in('grid_id', gridIds);
  const { count: samples } = await supabase
    .from('sensor_samples')
    .select('sample_id', { count: 'exact', head: true })
    .in('grid_id', gridIds);
  return { sessions: sessions ?? 0, samples: samples ?? 0 };
}

/**
 * Fetch the set of grid_id values that have at least one completed session
 * (completed_at IS NOT NULL) OR a COMPLETED mission_grids row.
 * Used to mark "visited" cells on the heatmap.
 */
export async function fetchVisitedGridIds(lakeId: string): Promise<Set<string>> {
  if (!supabaseConfigured || !supabase) return new Set();
  const supaLakeId = getOrCreateSupabaseLakeId(lakeId);
  const { data: grids } = await supabase
    .from('grids')
    .select('grid_id')
    .eq('lake_id', supaLakeId);
  if (!grids || grids.length === 0) return new Set();
  const gridIds = grids.map((g: { grid_id: string }) => g.grid_id);
  const visited = new Set<string>();

  // 1. Completed sessions
  const { data: sessions } = await supabase
    .from('grid_sessions')
    .select('grid_id')
    .in('grid_id', gridIds)
    .not('completed_at', 'is', null);
  if (sessions) {
    for (const s of sessions as { grid_id: string }[]) visited.add(s.grid_id);
  }

  // 2. COMPLETED mission_grids rows
  const { data: mGrids } = await supabase
    .from('mission_grids')
    .select('grid_id')
    .in('grid_id', gridIds)
    .eq('status', 'COMPLETED');
  if (mGrids) {
    for (const mg of mGrids as { grid_id: string }[]) visited.add(mg.grid_id);
  }
  return visited;
}

/**
 * Compute per-cell and per-sensor averages from raw samples.
 * Returns a GridAnalytics ready for rendering cards + heatmap.
 */
export function computeGridAnalytics(
  lakeId: string,
  samples: SensorSample[],
  grids: { gridId: string; gridCode: string; centerLat: number; centerLon: number }[],
): GridAnalytics {
  const SENSOR_KEYS: SensorKey[] = ['ph', 'tds', 'turbidity', 'temperature_c', 'humidity_percent'];

  // Group samples by grid_id
  const byGrid = new Map<string, SensorSample[]>();
  for (const s of samples) {
    const arr = byGrid.get(s.grid_id) ?? [];
    arr.push(s);
    byGrid.set(s.grid_id, arr);
  }

  // Per-cell averages
  const cellAverages: GridCellAverage[] = grids.map((g) => {
    const cellSamples = byGrid.get(g.gridId) ?? [];
    const avgs = {} as Record<SensorKey, number | null>;
    for (const key of SENSOR_KEYS) {
      const vals = cellSamples.map((s) => s[key]).filter((v): v is number => v !== null && Number.isFinite(v));
      avgs[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return { gridId: g.gridId, gridCode: g.gridCode, centerLat: g.centerLat, centerLon: g.centerLon, averages: avgs };
  });

  // Per-sensor summaries across all cells
  const sensorSummaries: SensorAverage[] = SENSORS.map((meta) => {
    const allVals = samples.map((s) => s[meta.key]).filter((v): v is number => v !== null && Number.isFinite(v));
    return {
      sensor: meta,
      avg: allVals.length > 0 ? allVals.reduce((a, b) => a + b, 0) / allVals.length : null,
      min: allVals.length > 0 ? Math.min(...allVals) : null,
      max: allVals.length > 0 ? Math.max(...allVals) : null,
      count: allVals.length,
    };
  });

  return { lakeId, cellAverages, sensorSummaries, totalSamples: samples.length, totalSessions: new Set(samples.map((s) => s.session_id)).size };
}
