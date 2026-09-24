/**
 * SCRUB frontend data model.
 *
 * These interfaces are the single source of truth for the UI.
 * Raw transport payloads (MQTT JSON, OSM responses, InfluxDB rows)
 * are converted into these normalized shapes by adapters in `services/`.
 * UI components must only depend on these types — never on raw JSON.
 */

// ---------------------------------------------------------------------------
// Telemetry (live path: Pi -> MQTT -> AWS IoT Core -> realtime channel)
// ---------------------------------------------------------------------------

export interface GpsFix {
  latitude: number | null;
  longitude: number | null;
  /** speed over ground, metres per second */
  speedMps: number | null;
  /** true when the receiver reports a usable fix */
  fix: boolean;
  satellites: number | null;
}

export interface CompassReading {
  /** degrees, 0–360 */
  headingDeg: number | null;
}

export interface WaterReading {
  ph: number | null;
  /** nephelometric turbidity units */
  turbidityNtu: number | null;
  /** parts per million */
  tdsPpm: number | null;
}

/**
 * Optional air/environment sensors (e.g. MQ135, DHT22).
 * Only present when the robot's backend schema actually provides them —
 * the adapter leaves them null otherwise and the UI renders "-".
 */
export interface AirReading {
  /** MQ135-derived air quality index */
  aqi: number | null;
  temperatureC: number | null;
  humidityPct: number | null;
}

export type MissionState =
  | 'idle'
  | 'transit'
  | 'sampling'
  | 'returning'
  | 'paused'
  | 'error'
  | 'unknown';

export interface Telemetry {
  robotId: string;
  /** ISO-8601 timestamp produced by the robot */
  timestamp: string | null;
  sequence: number | null;
  water: WaterReading;
  air: AirReading;
  gps: GpsFix;
  compass: CompassReading;
  batteryPercent: number | null;
  missionId: string | null;
  missionState: MissionState;
  currentWaypoint: string | number | null;
}

// ---------------------------------------------------------------------------
// Realtime connection
// ---------------------------------------------------------------------------

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'stale'
  | 'disconnected'
  | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  /** ISO timestamp of the last accepted telemetry packet, null if none yet */
  lastMessageAt: string | null;
  /** human-readable reason for error/disconnected states */
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Lakes (map path: OpenStreetMap -> adapter -> Lake)
// ---------------------------------------------------------------------------

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * The OSM-derived boundary as retrieved from external data.
 * Never mutated by editing — editing produces `scrubBoundary`.
 */
export interface OsmBoundary {
  points: LatLon[];
  /** islands (inner rings of a multipolygon): water only exists OUTSIDE these */
  holes?: LatLon[][];
  /** e.g. OSM way/relation id, when available */
  sourceId: string | null;
  source: 'openstreetmap';
}

/**
 * SCRUB's own saved configuration. This is what the grid is built from.
 */
export interface LakeBoundary {
  points: LatLon[];
  /** islands inside the outline; the grid and the robot path avoid them */
  holes?: LatLon[][];
}

export interface Lake {
  id: string;
  /** Display name from OSM (`name` tag) or null when unnamed */
  name: string | null;
  /** water type from OSM tags, e.g. "lake", "pond", "reservoir" */
  waterType: string | null;
  center: LatLon;
  /** initial external boundary; null when OSM has no usable geometry */
  osmBoundary: OsmBoundary | null;
  /** SCRUB's saved (possibly edited or hand-drawn) boundary */
  scrubBoundary: LakeBoundary | null;
  updatedAt: string;
}

export interface GridConfiguration {
  /** physical cell size in metres */
  cellSizeM: number;
  /** keep sampling points at least this far from the shore / islands (metres, default 0) */
  shoreMarginM?: number;
  lakeId: string;
  updatedAt: string;
}

export interface GridCell {
  /** stable identifier, e.g. "R3C7" */
  id: string;
  row: number;
  col: number;
  polygon: LatLon[];
  center: LatLon;
}

// ---------------------------------------------------------------------------
// Analytics (historical path: InfluxDB via secure backend/API layer)
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  /** ISO-8601 timestamp */
  t: string;
  v: number;
}

export interface LakeAnalytics {
  lakeId: string;
  ph: SeriesPoint[];
  turbidityNtu: SeriesPoint[];
  tdsPpm: SeriesPoint[];
  temperatureC: SeriesPoint[];
  humidityPct: SeriesPoint[];
  speedMps: SeriesPoint[];
  headingDeg: SeriesPoint[];
  /** GPS track samples for the selected lake */
  track: LatLon[];
  missions: MissionSummary[];
  waterLevelM: SeriesPoint[];
  dissolvedOxygenMgL: SeriesPoint[];
  bodMgL: SeriesPoint[];
  /** headline numbers for the Analytics stat cards; null until a backend supplies them */
  summary: AnalyticsSummary | null;
}

export interface AnalyticsSummary {
  areaCoveredPct: number | null;
  wasteCollectedKg: number | null;
  waterQualityIndex: number | null;
  activeMissions: number | null;
}

export interface MissionSummary {
  id: string;
  state: MissionState;
  startedAt: string | null;
  endedAt: string | null;
  samples: number | null;
}

// ---------------------------------------------------------------------------
// Supabase measurement data (Part 3)
// ---------------------------------------------------------------------------

export interface GridSession {
  session_id: string;
  grid_id: string;
  device_id: string;
  started_at: string;
  completed_at: string | null;
  latitude: number;
  longitude: number;
  sample_count: number;
  created_at: string;
}

export interface SensorSample {
  sample_id: string;
  session_id: string;
  grid_id: string;
  sample_number: number;
  recorded_at: string;
  latitude: number;
  longitude: number;
  ph: number | null;
  tds: number | null;
  turbidity: number | null;
  temperature_c: number | null;
  humidity_percent: number | null;
  created_at: string;
}

export type SensorKey = 'ph' | 'tds' | 'turbidity' | 'temperature_c' | 'humidity_percent';

export interface SensorMeta {
  key: SensorKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** Tailwind-like color stops for the heatmap: index 0 = lowest, last = highest */
  colors: [string, string, string, string, string];
}

export interface SensorAverage {
  sensor: SensorMeta;
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export interface GridCellAverage {
  gridId: string;
  gridCode: string;
  centerLat: number;
  centerLon: number;
  averages: Record<SensorKey, number | null>;
}

export interface GridAnalytics {
  lakeId: string;
  cellAverages: GridCellAverage[];
  sensorSummaries: SensorAverage[];
  totalSamples: number;
  totalSessions: number;
}

export interface RobotStatus {
  online: boolean;
  lastSeenAt: string | null;
}
