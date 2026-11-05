import type { GridCell, GridCellAverage, GridAnalytics, Lake, LatLon, SensorAverage, SensorKey, SensorMeta, SensorSample } from '../../types';
import type { MissionPayload } from '../../utils/missionPayload';
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

// ── Shared schema: supabase/schema.sql, rules in docs/supabase-schema.md ─────
//   lakes(lake_id, name, boundary_geom, created_at)
//   missions(mission_id, device_id, lake_id, polygon_geom, status, waypoint_load_ack, total_waypoints,
//            current_waypoint_index, progress_percent, started_at, completed_at, created_at, notes)
//   mission_waypoints(waypoint_id, mission_id, sequence_order, latitude, longitude, waypoint_geom, status, created_at)
//   sensor_readings(reading_id, local_record_id, mission_id, device_id, recorded_at, latitude, longitude,
//                   position_geom, heading, ph, tds, turbidity, temperature_c, humidity_percent, created_at)

/** EWKT polygon (closed ring, longitude first), as PostGIS reads it. */
export function polygonEwkt(points: LatLon[]): string {
  const ring = openRing(points);
  const closed = [...ring, ring[0]];
  return `SRID=4326;POLYGON((${closed.map((p) => `${p.lon} ${p.lat}`).join(', ')}))`;
}

/** EWKT point (longitude first). */
export function pointEwkt(lat: number, lon: number): string {
  return `SRID=4326;POINT(${lon} ${lat})`;
}

/** Mission status values (missions.status). */
export type MissionRowStatus = 'PENDING' | 'LOADING_WAYPOINTS' | 'READY' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABORTED' | 'FAILED';

const READING_COLUMNS =
  'reading_id, local_record_id, mission_id, device_id, recorded_at, created_at, latitude, longitude, heading, ph, tds, turbidity, temperature_c, humidity_percent';

interface ReadingRow {
  reading_id: string;
  local_record_id?: string | null;
  mission_id: string | null;
  device_id: string | null;
  recorded_at: string;
  created_at: string | null;
  latitude: number;
  longitude: number;
  heading: number | null;
  ph: number | null;
  tds: number | null;
  turbidity: number | null;
  temperature_c: number | null;
  humidity_percent: number | null;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** One `sensor_readings` row in the shape the pages use. */
export function readingToSample(r: ReadingRow): SensorSample {
  return {
    sample_id: r.reading_id,
    session_id: null,
    grid_id: null,
    device_id: r.device_id,
    mission_id: r.mission_id,
    heading_deg: numOrNull(r.heading),
    sample_number: 0,
    recorded_at: r.recorded_at,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    ph: numOrNull(r.ph),
    tds: numOrNull(r.tds),
    turbidity: numOrNull(r.turbidity),
    temperature_c: numOrNull(r.temperature_c),
    humidity_percent: numOrNull(r.humidity_percent),
    created_at: r.created_at ?? r.recorded_at,
  };
}

/**
 * Make sure the lake (or, for a sample polygon, its parent lake) has a `lakes` row and
 * return its Supabase lake_id. A sample polygon never overwrites its parent's name.
 */
export async function pushLake(lake: Lake): Promise<string> {
  const sb = client();
  const boundary = lake.scrubBoundary?.points ?? lake.osmBoundary?.points ?? null;
  if (!boundary || boundary.length < 3) throw new Error('This lake has no boundary to send.');
  const lakeId = getOrCreateSupabaseLakeId(supabaseLakeKey(lake));
  const row = { lake_id: lakeId, name: lake.name ?? 'Unnamed', boundary_geom: polygonEwkt(boundary), created_at: utcIso() };
  const { error } = lake.parentLakeId
    ? await sb.from('lakes').upsert(row, { onConflict: 'lake_id', ignoreDuplicates: true })
    : await sb.from('lakes').upsert(row);
  if (error) throw new Error(`Could not save lake: ${error.message}`);
  return lakeId;
}

/**
 * Record the mission before the plan is sent to the robot: a `missions` row (status PENDING,
 * polygon_geom, total_waypoints, waypoint_load_ack false, progress 0) and one
 * `mission_waypoints` row per waypoint in visiting order (sequence_order 0 = GCS).
 * If the waypoints cannot be stored, the mission is removed again.
 * `localLakeId` is the SCRUB lake the mission is remembered under.
 */
export async function createMission(localLakeId: string, supabaseLakeId: string, payload: MissionPayload): Promise<void> {
  const sb = client();
  const { error } = await sb.from('missions').insert({
    mission_id: payload.mission_id,
    device_id: payload.device_id,
    lake_id: supabaseLakeId,
    polygon_geom: polygonEwkt(payload.polygon.map((p) => ({ lat: p.latitude, lon: p.longitude }))),
    status: 'PENDING' satisfies MissionRowStatus,
    waypoint_load_ack: false,
    total_waypoints: payload.waypoint_count,
    current_waypoint_index: null,
    progress_percent: 0,
    created_at: payload.created_at,
    notes: null,
  });
  if (error) throw new Error(`Could not create mission: ${error.message}`);

  const rows = payload.waypoints.map((w) => ({
    waypoint_id: crypto.randomUUID(),
    mission_id: payload.mission_id,
    sequence_order: w.sequence_order,
    latitude: w.latitude,
    longitude: w.longitude,
    waypoint_geom: pointEwkt(w.latitude, w.longitude),
    status: 'PENDING',
    created_at: payload.created_at,
  }));
  for (const [i, batch] of chunks(rows, WRITE_CHUNK).entries()) {
    const { error: wErr } = await sb.from('mission_waypoints').insert(batch);
    if (wErr) {
      // Best-effort rollback so a half-stored mission is never left PENDING.
      await sb.from('mission_waypoints').delete().eq('mission_id', payload.mission_id);
      await sb.from('missions').delete().eq('mission_id', payload.mission_id);
      throw new Error(`Could not store the mission waypoints (batch ${i + 1}): ${wErr.message}`);
    }
  }
  rememberMissionId(localLakeId, payload.mission_id);
}

/** The plan is on its way to the robot: status LOADING_WAYPOINTS. Best effort. */
export async function markMissionLoading(missionId: string): Promise<void> {
  if (!supabaseConfigured || !supabase) return;
  await supabase.from('missions').update({ status: 'LOADING_WAYPOINTS' }).eq('mission_id', missionId).eq('status', 'PENDING');
}

/**
 * Mark a mission FAILED when the robot did not store its waypoints (refused, no answer,
 * wrong checksum). Only while it is still being loaded. Best effort: errors are ignored.
 */
export async function abandonMission(missionId: string, reason: string): Promise<void> {
  if (!supabaseConfigured || !supabase) return;
  await supabase
    .from('missions')
    .update({ status: 'FAILED', notes: reason })
    .eq('mission_id', missionId)
    .in('status', ['PENDING', 'LOADING_WAYPOINTS']);
}

export interface LatestMission {
  missionId: string | null;
  /** missions.status as kept by the robot: PENDING, ACTIVE, PAUSED, COMPLETED, ABORTED */
  status: string | null;
  /** missions.current_waypoint_index / total_waypoints / progress_percent, as kept by the robot */
  currentWaypoint: number | null;
  totalWaypoints: number | null;
  progressPercent: number | null;
  /** missions.waypoint_load_ack: the Pi confirmed it stored the waypoints */
  loadAck: boolean;
}

type MissionRow = {
  mission_id: string;
  status: string;
  current_waypoint_index: number | null;
  total_waypoints: number | null;
  progress_percent: number | string | null;
  waypoint_load_ack: boolean | null;
};
const toLatest = (m: MissionRow): LatestMission => ({
  missionId: m.mission_id,
  status: m.status,
  currentWaypoint: numOrNull(m.current_waypoint_index),
  totalWaypoints: numOrNull(m.total_waypoints),
  progressPercent: numOrNull(m.progress_percent),
  loadAck: m.waypoint_load_ack === true,
});

/**
 * The mission created for this lake from this browser or, for a real lake with none
 * remembered, the lake's latest mission. A sample polygon only ever shows its own mission.
 */
export async function fetchLatestMission(lake: Lake): Promise<LatestMission> {
  const EMPTY: LatestMission = { missionId: null, status: null, currentWaypoint: null, totalWaypoints: null, progressPercent: null, loadAck: false };
  if (!supabaseConfigured || !supabase) return EMPTY;
  const sb = supabase;
  const cols = 'mission_id, status, current_waypoint_index, total_waypoints, progress_percent, waypoint_load_ack';
  const remembered = loadMissionId(lake.id);
  if (remembered) {
    const { data, error } = await sb.from('missions').select(cols).eq('mission_id', remembered).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toLatest(data as MissionRow) : EMPTY;
  }
  if (lake.parentLakeId) return EMPTY;
  const supaLakeId = getSupabaseLakeId(lake.id);
  if (!supaLakeId) return EMPTY;
  const { data, error } = await sb.from('missions').select(cols).eq('lake_id', supaLakeId).order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return data && data.length > 0 ? toLatest(data[0] as MissionRow) : EMPTY;
}

export interface MissionListItem {
  missionId: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lakeName: string | null;
}

/** The robot's most recent missions, newest first (for the sensor history filter). */
export async function fetchMissions(deviceId: string, limit = 100): Promise<MissionListItem[]> {
  const sb = client();
  const { data, error } = await sb
    .from('missions')
    .select('mission_id, status, created_at, started_at, completed_at, lake_id')
    .eq('device_id', deviceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    mission_id: string;
    status: string;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    lake_id: string | null;
  }>;
  const lakeIds = [...new Set(rows.map((r) => r.lake_id).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (lakeIds.length > 0) {
    const { data: lakes } = await sb.from('lakes').select('lake_id, name').in('lake_id', lakeIds);
    for (const l of (lakes ?? []) as Array<{ lake_id: string; name: string | null }>) if (l.name) names.set(l.lake_id, l.name);
  }
  return rows.map((r) => ({
    missionId: r.mission_id,
    status: r.status,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    lakeName: r.lake_id ? names.get(r.lake_id) ?? null : null,
  }));
}

/** Most sensor records one history query returns. */
export const HISTORY_MAX_ROWS = 5000;

/**
 * GPS-tagged sensor readings (`sensor_readings`, one every 10 s) for a robot, optionally for one mission,
 * within [fromMs, toMs], oldest first. `truncated` is true when more rows exist.
 */
export async function fetchSensorHistory(q: {
  deviceId: string;
  missionId?: string | null;
  fromMs: number;
  toMs: number;
}): Promise<{ samples: SensorSample[]; truncated: boolean }> {
  const sb = client();
  const out: SensorSample[] = [];
  for (let from = 0; from < HISTORY_MAX_ROWS; from += PAGE) {
    let query = sb
      .from('sensor_readings')
      .select(READING_COLUMNS)
      .eq('device_id', q.deviceId)
      .gte('recorded_at', utcIso(q.fromMs))
      .lte('recorded_at', utcIso(q.toMs));
    if (q.missionId) query = query.eq('mission_id', q.missionId);
    const { data, error } = await query
      .order('recorded_at', { ascending: true })
      .order('reading_id')
      .range(from, Math.min(from + PAGE, HISTORY_MAX_ROWS) - 1);
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as unknown as ReadingRow[]).map(readingToSample);
    out.push(...rows);
    if (rows.length < PAGE) return { samples: out, truncated: false };
  }
  return { samples: out, truncated: true };
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

/** Cloud sensor readings for one robot since `sinceMs`, oldest first (the Pi uploads one every 10 s). */
export async function fetchDeviceSamples(deviceId: string, sinceMs: number): Promise<SensorSample[]> {
  if (!supabaseConfigured || !supabase) return [];
  const sb = supabase;
  const rows = await selectAll<ReadingRow>((from, to) =>
    sb
      .from('sensor_readings')
      .select(READING_COLUMNS)
      .eq('device_id', deviceId)
      .gte('recorded_at', utcIso(sinceMs))
      .order('recorded_at', { ascending: true })
      .order('reading_id')
      .range(from, to) as unknown as PageResult<ReadingRow>,
  );
  return rows.map(readingToSample);
}

/**
 * Every sensor reading taken during this lake's missions (for a sample polygon: its parent
 * lake's), since `sinceMs` when given, oldest first. Grids play no part: the Analytics page
 * places each reading in a cell by its GPS position.
 */
export async function fetchLakeReadings(lake: Lake, sinceMs: number | null = null): Promise<SensorSample[]> {
  if (!supabaseConfigured || !supabase) return [];
  const sb = supabase;
  const supaLakeId = getSupabaseLakeId(supabaseLakeKey(lake));
  if (!supaLakeId) return [];
  const missions = await selectAll<{ mission_id: string }>((from, to) =>
    sb.from('missions').select('mission_id').eq('lake_id', supaLakeId).order('mission_id').range(from, to),
  );
  const out: SensorSample[] = [];
  for (const ids of chunks(missions.map((m) => m.mission_id), IN_CHUNK)) {
    const rows = await selectAll<ReadingRow>((from, to) => {
      let q = sb.from('sensor_readings').select(READING_COLUMNS).in('mission_id', ids);
      if (sinceMs !== null) q = q.gte('recorded_at', utcIso(sinceMs));
      return q.order('recorded_at', { ascending: true }).order('reading_id').range(from, to) as unknown as PageResult<ReadingRow>;
    });
    out.push(...rows.map(readingToSample));
  }
  out.sort((x, y) => Date.parse(x.recorded_at) - Date.parse(y.recorded_at));
  return out;
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
    if (!s.grid_id) continue; // records taken along the polygon route carry no grid
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

  return { lakeId, cellAverages, sensorSummaries, totalSamples: samples.length, totalSessions: new Set(samples.map((s) => s.mission_id ?? s.session_id).filter((id) => id)).size };
}
