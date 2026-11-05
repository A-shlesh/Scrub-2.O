import type { GridCell, GridCellAverage, GridAnalytics, Lake, LatLon, SensorAverage, SensorKey, SensorMeta, SensorSample } from '../../types';
import { openRing } from '../../utils/geo';
import {
  getOrCreateSupabaseLakeId,
  getSupabaseLakeId,
  loadMissionId,
  maxLocalSampleNumber,
  rememberMissionId,
  supabaseLakeKey,
} from '../storage/lakeStorage';
import { supabase, supabaseConfigured } from './supabaseClient';

const NOT_CONFIGURED = 'Supabase is not configured — missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.';
/** Rows per request when reading; PostgREST caps responses at 1000 rows by default. */
const PAGE = 1000;
/** Rows per insert/upsert request. */
const WRITE_CHUNK = 500;
/** Ids per `.in()` filter, so the request URL stays well under server limits. */
const IN_CHUNK = 150;

/** A time as an ISO-8601 string in UTC (the database stores instants; the screen shows local time). */
export function utcIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

function polygonEwkt(points: LatLon[]): string {
  const ring = openRing(points);
  const closed = [...ring, ring[0]];
  return `SRID=4326;POLYGON((${closed.map((p) => `${p.lon} ${p.lat}`).join(', ')}))`;
}

function pointEwkt(p: LatLon): string {
  return `SRID=4326;POINT(${p.lon} ${p.lat})`;
}

function client() {
  if (!supabaseConfigured || !supabase) throw new Error(NOT_CONFIGURED);
  return supabase;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Read every row of a query, one page at a time. `page(from, to)` must apply `.range(from, to)` after a stable order. */
async function selectAll<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * Identity of a grid cell on the water: its size and its centre (to ~0.1 m).
 * Grid codes (KNG001, ...) are renumbered whenever the size, shore margin or boundary
 * changes, so they cannot identify a cell. Matching on geometry means a row — and the
 * sensor samples recorded against it — always refers to the same patch of water.
 */
export function gridGeometryKey(sizeM: number, lat: number, lon: number): string {
  return `${Number(sizeM)}|${Number(lat).toFixed(6)}|${Number(lon).toFixed(6)}`;
}

export interface SupabaseGrid {
  gridId: string;
  gridCode: string;
  gridSizeM: number;
  centerLat: number;
  centerLon: number;
}

async function fetchGridsBySupabaseLakeId(supaLakeId: string): Promise<SupabaseGrid[]> {
  const sb = client();
  const rows = await selectAll<{ grid_id: string; grid_code: string; grid_size_m: number; center_lat: number; center_lon: number }>(
    (from, to) =>
      sb
        .from('grids')
        .select('grid_id, grid_code, grid_size_m, center_lat, center_lon')
        .eq('lake_id', supaLakeId)
        .order('grid_id')
        .range(from, to),
  );
  return rows.map((r) => ({
    gridId: r.grid_id,
    gridCode: r.grid_code,
    gridSizeM: Number(r.grid_size_m),
    centerLat: Number(r.center_lat),
    centerLon: Number(r.center_lon),
  }));
}

/**
 * Push a lake/polygon and its full grid to Supabase (`lakes` + `grids` tables).
 * A cell whose size and centre already exist for this lake keeps its existing grid_id;
 * every other cell gets a new row. Rows from earlier grid layouts are left untouched,
 * so the samples recorded against them keep their true location.
 * Returns the Supabase lake_id and a map of local cell id → grid_id.
 */
export async function pushLakeAndGrids(lake: Lake, cells: GridCell[], cellSizeM: number): Promise<{ lakeId: string; gridIds: Map<string, string> }> {
  const sb = client();
  const boundary = lake.scrubBoundary?.points ?? lake.osmBoundary?.points ?? null;
  if (!boundary || boundary.length < 3) throw new Error('This lake has no boundary to send.');
  if (cells.length === 0) throw new Error('This lake has no grid points to send.');

  // A sample polygon inside a real lake stores its grids under the parent lake,
  // and must not overwrite the parent's name/boundary.
  const isChildPolygon = !!lake.parentLakeId;
  const lakeId = getOrCreateSupabaseLakeId(supabaseLakeKey(lake));
  const now = utcIso();

  if (!isChildPolygon) {
    const { error: lakeError } = await sb.from('lakes').upsert({
      lake_id: lakeId,
      name: lake.name ?? 'Unnamed',
      boundary: polygonEwkt(boundary),
      created_at: now,
    });
    if (lakeError) throw new Error(`Could not save lake: ${lakeError.message}`);
  }

  let existing: SupabaseGrid[];
  try {
    existing = await fetchGridsBySupabaseLakeId(lakeId);
  } catch (e) {
    throw new Error(`Could not read existing grid points: ${e instanceof Error ? e.message : String(e)}`);
  }
  const byGeometry = new Map(existing.map((g) => [gridGeometryKey(g.gridSizeM, g.centerLat, g.centerLon), g.gridId]));

  const gridIds = new Map<string, string>();
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  for (const c of cells) {
    const known = byGeometry.get(gridGeometryKey(cellSizeM, c.center.lat, c.center.lon));
    const row = {
      grid_id: known ?? crypto.randomUUID(),
      lake_id: lakeId,
      grid_code: c.id,
      grid_size_m: cellSizeM,
      center_lat: c.center.lat,
      center_lon: c.center.lon,
      center_geom: pointEwkt(c.center),
    };
    gridIds.set(c.id, row.grid_id);
    if (known) updates.push(row); // keeps its original created_at
    else inserts.push({ ...row, created_at: now });
  }

  for (const [i, batch] of chunks(updates, WRITE_CHUNK).entries()) {
    const { error } = await sb.from('grids').upsert(batch);
    if (error) throw new Error(`Could not update grid points (batch ${i + 1}): ${error.message}`);
  }
  for (const [i, batch] of chunks(inserts, WRITE_CHUNK).entries()) {
    const { error } = await sb.from('grids').insert(batch);
    if (error) throw new Error(`Could not save grid points (batch ${i + 1}): ${error.message}`);
  }

  return { lakeId, gridIds };
}

/**
 * Create a mission with one mission_grids row per cell, in `orderedCellIds` order
 * (cells missing from it are appended). Call AFTER pushLakeAndGrids.
 * If any mission_grids batch fails, the mission and its rows are removed again.
 * `localLakeId` is the SCRUB lake id (lake or sample polygon) the mission is remembered under.
 */
export async function createMission(
  localLakeId: string,
  supabaseLakeId: string,
  cellToGridId: Map<string, string>,
  orderedCellIds: string[],
  deviceId = 'BOT001',
): Promise<string> {
  const sb = client();
  const missionId = crypto.randomUUID();

  const { error: mErr } = await sb.from('missions').insert({
    mission_id: missionId,
    device_id: deviceId,
    lake_id: supabaseLakeId,
    status: 'PENDING',
    created_at: utcIso(),
    notes: null,
  });
  if (mErr) throw new Error(`Could not create mission: ${mErr.message}`);

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of [...orderedCellIds, ...cellToGridId.keys()]) {
    const gid = cellToGridId.get(id);
    if (gid && !seen.has(id)) {
      seen.add(id);
      ordered.push(gid);
    }
  }
  const rows = ordered.map((gridId, i) => ({
    mission_grid_id: crypto.randomUUID(),
    mission_id: missionId,
    grid_id: gridId,
    sequence_order: i + 1,
    status: 'PENDING',
    session_id: null,
  }));

  for (const [i, batch] of chunks(rows, WRITE_CHUNK).entries()) {
    const { error } = await sb.from('mission_grids').insert(batch);
    if (error) {
      // Best-effort rollback so a half-built mission is never left PENDING.
      await sb.from('mission_grids').delete().eq('mission_id', missionId);
      await sb.from('missions').delete().eq('mission_id', missionId);
      throw new Error(`Could not create mission grid rows (batch ${i + 1}): ${error.message}`);
    }
  }
  rememberMissionId(localLakeId, missionId);
  return missionId;
}

/** Mark a mission ABORTED (e.g. the robot never loaded its waypoints). Best effort: errors are ignored. */
export async function abandonMission(missionId: string, reason: string): Promise<void> {
  if (!supabaseConfigured || !supabase) return;
  await supabase.from('missions').update({ status: 'ABORTED', notes: reason }).eq('mission_id', missionId).eq('status', 'PENDING');
}

export interface MissionProgress {
  missionId: string | null;
  done: number;
  total: number;
  status: string | null;
}

/**
 * Progress of the mission created for this lake from this browser or, for a real lake
 * with none remembered, the lake's latest mission. A sample polygon only ever shows its
 * own mission, never one from its parent lake or a sibling polygon.
 */
export async function fetchMissionProgress(lake: Lake): Promise<MissionProgress> {
  const EMPTY: MissionProgress = { missionId: null, done: 0, total: 0, status: null };
  if (!supabaseConfigured || !supabase) return EMPTY;
  const sb = supabase;

  let missionId = loadMissionId(lake.id);
  let status: string | null = null;
  if (missionId) {
    const { data, error } = await sb.from('missions').select('status').eq('mission_id', missionId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return EMPTY; // deleted on the server
    status = (data as { status: string }).status;
  } else {
    if (lake.parentLakeId) return EMPTY;
    const supaLakeId = getSupabaseLakeId(lake.id);
    if (!supaLakeId) return EMPTY;
    const { data, error } = await sb
      .from('missions')
      .select('mission_id, status')
      .eq('lake_id', supaLakeId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return EMPTY;
    const m = data[0] as { mission_id: string; status: string };
    missionId = m.mission_id;
    status = m.status;
  }

  const [all, completed] = await Promise.all([
    sb.from('mission_grids').select('mission_grid_id', { count: 'exact', head: true }).eq('mission_id', missionId),
    sb.from('mission_grids').select('mission_grid_id', { count: 'exact', head: true }).eq('mission_id', missionId).eq('status', 'COMPLETED'),
  ]);
  if (all.error) throw new Error(all.error.message);
  if (completed.error) throw new Error(completed.error.message);
  return { missionId, done: completed.count ?? 0, total: all.count ?? 0, status };
}

/**
 * Next free sample polygon number: one past the highest used either in this browser
 * (deleted polygons included) or in a Supabase `lakes` row named "Sample Polygon N".
 */
export async function fetchNextPolygonNumber(): Promise<number> {
  let max = maxLocalSampleNumber();
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.from('lakes').select('name').like('name', 'Sample Polygon %');
    if (!error && data) {
      for (const row of data as { name: string }[]) {
        const m = row.name.match(/Sample Polygon (\d+)/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
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

/** Every grid row stored for this lake (for a sample polygon: its parent lake), across all grid layouts. */
export async function fetchLakeGrids(lake: Lake): Promise<SupabaseGrid[]> {
  if (!supabaseConfigured || !supabase) return [];
  const supaLakeId = getSupabaseLakeId(supabaseLakeKey(lake));
  if (!supaLakeId) return [];
  return fetchGridsBySupabaseLakeId(supaLakeId);
}

/**
 * Map Supabase grid rows onto the grid currently shown (same size and centre).
 * Returns grid_id → local cell id; rows from other layouts or sibling polygons are left out.
 */
export function matchGridsToCells(grids: SupabaseGrid[], cells: GridCell[], cellSizeM: number): Map<string, string> {
  const cellByGeometry = new Map(cells.map((c) => [gridGeometryKey(cellSizeM, c.center.lat, c.center.lon), c.id]));
  const out = new Map<string, string>();
  for (const g of grids) {
    const cellId = cellByGeometry.get(gridGeometryKey(g.gridSizeM, g.centerLat, g.centerLon));
    if (cellId) out.set(g.gridId, cellId);
  }
  return out;
}

/** All sensor samples recorded against these grid ids, oldest first; `sinceMs` keeps only newer ones. */
export async function fetchSensorSamples(gridIds: string[], sinceMs: number | null = null): Promise<SensorSample[]> {
  if (!supabaseConfigured || !supabase || gridIds.length === 0) return [];
  const sb = supabase;
  const out: SensorSample[] = [];
  for (const ids of chunks(gridIds, IN_CHUNK)) {
    const rows = await selectAll<SensorSample>((from, to) => {
      let q = sb.from('sensor_samples').select('*').in('grid_id', ids);
      if (sinceMs !== null) q = q.gte('recorded_at', utcIso(sinceMs));
      return q.order('recorded_at', { ascending: true }).order('sample_id').range(from, to);
    });
    out.push(...rows);
  }
  if (gridIds.length > IN_CHUNK) out.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  return out;
}

/**
 * Cloud sensor records uploaded by one robot since `sinceMs`, oldest first
 * (the Pi uploads one every 10 s; needs the `device_id` column from the mission-control migration).
 */
export async function fetchDeviceSamples(deviceId: string, sinceMs: number): Promise<SensorSample[]> {
  if (!supabaseConfigured || !supabase) return [];
  const sb = supabase;
  return selectAll<SensorSample>((from, to) =>
    sb
      .from('sensor_samples')
      .select('*')
      .eq('device_id', deviceId)
      .gte('recorded_at', utcIso(sinceMs))
      .order('recorded_at', { ascending: true })
      .order('sample_id')
      .range(from, to),
  );
}

/**
 * Of these grid ids, the ones with a completed session (completed_at not null)
 * or a COMPLETED mission_grids row. Used to mark visited cells on the heatmap.
 */
export async function fetchVisitedGridIds(gridIds: string[]): Promise<Set<string>> {
  const visited = new Set<string>();
  if (!supabaseConfigured || !supabase || gridIds.length === 0) return visited;
  const sb = supabase;
  for (const ids of chunks(gridIds, IN_CHUNK)) {
    const [sessions, missionGrids] = await Promise.all([
      selectAll<{ grid_id: string }>((from, to) =>
        sb.from('grid_sessions').select('grid_id').in('grid_id', ids).not('completed_at', 'is', null).order('grid_id').range(from, to),
      ),
      selectAll<{ grid_id: string }>((from, to) =>
        sb.from('mission_grids').select('grid_id').in('grid_id', ids).eq('status', 'COMPLETED').order('grid_id').range(from, to),
      ),
    ]);
    for (const r of sessions) visited.add(r.grid_id);
    for (const r of missionGrids) visited.add(r.grid_id);
  }
  return visited;
}

function stats(vals: number[]): { avg: number | null; min: number | null; max: number | null } {
  if (vals.length === 0) return { avg: null, min: null, max: null };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { avg: sum / vals.length, min, max };
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/**
 * Per-cell averages for `cells` (grid_id plus the code to show) and per-sensor
 * summaries over `samples`. Ready for the sensor cards and the heatmap.
 */
export function computeGridAnalytics(
  lakeId: string,
  samples: SensorSample[],
  cells: { gridId: string; gridCode: string; centerLat: number; centerLon: number }[],
): GridAnalytics {
  const byGrid = new Map<string, SensorSample[]>();
  for (const s of samples) {
    const arr = byGrid.get(s.grid_id) ?? [];
    arr.push(s);
    byGrid.set(s.grid_id, arr);
  }

  const cellAverages: GridCellAverage[] = cells.map((g) => {
    const cellSamples = byGrid.get(g.gridId) ?? [];
    const averages = {} as Record<SensorKey, number | null>;
    for (const meta of SENSORS) averages[meta.key] = stats(cellSamples.map((s) => s[meta.key]).filter(finite)).avg;
    return { gridId: g.gridId, gridCode: g.gridCode, centerLat: g.centerLat, centerLon: g.centerLon, averages };
  });

  const sensorSummaries: SensorAverage[] = SENSORS.map((meta) => {
    const vals = samples.map((s) => s[meta.key]).filter(finite);
    return { sensor: meta, ...stats(vals), count: vals.length };
  });

  return { lakeId, cellAverages, sensorSummaries, totalSamples: samples.length, totalSessions: new Set(samples.map((s) => s.session_id)).size };
}

// ── Ground control station ─────────────────────────────────────────────

/**
 * The lake's GCS stored in Supabase (`lakes.gcs_lat` / `gcs_lon`). Returns undefined when
 * it cannot be read (not configured, lake not uploaded yet, columns not added yet),
 * null when the lake has no GCS.
 */
export async function fetchGcs(lake: Lake): Promise<LatLon | null | undefined> {
  if (!supabaseConfigured || !supabase) return undefined;
  const lakeId = getSupabaseLakeId(supabaseLakeKey(lake));
  if (!lakeId) return undefined;
  const { data, error } = await supabase.from('lakes').select('gcs_lat, gcs_lon').eq('lake_id', lakeId).maybeSingle();
  if (error || !data) return undefined;
  const row = data as { gcs_lat: number | null; gcs_lon: number | null };
  return typeof row.gcs_lat === 'number' && typeof row.gcs_lon === 'number' ? { lat: row.gcs_lat, lon: row.gcs_lon } : null;
}

/** Store the lake's GCS in Supabase. Returns false when it could not be stored. */
export async function saveGcsRemote(lake: Lake, gcs: LatLon | null): Promise<boolean> {
  if (!supabaseConfigured || !supabase) return false;
  const lakeId = getSupabaseLakeId(supabaseLakeKey(lake));
  if (!lakeId) return false;
  const { data, error } = await supabase
    .from('lakes')
    .update({ gcs_lat: gcs?.lat ?? null, gcs_lon: gcs?.lon ?? null })
    .eq('lake_id', lakeId)
    .select('lake_id');
  return !error && Array.isArray(data) && data.length > 0;
}

/** grid_ids of the mission's cells the robot has finished sampling. */
export async function fetchCompletedMissionGrids(missionId: string): Promise<Set<string>> {
  const sb = client();
  const rows = await selectAll<{ grid_id: string }>((from, to) =>
    sb.from('mission_grids').select('grid_id').eq('mission_id', missionId).eq('status', 'COMPLETED').order('grid_id').range(from, to),
  );
  return new Set(rows.map((r) => r.grid_id));
}

