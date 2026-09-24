import type { GridConfiguration, Lake, LatLon } from '../../types';

export interface GridSnapshot {
  lakeId: string;
  cellSizeM: number;
  cellCount: number;
  updatedAt: string;
}

const POLYGON_COUNTER_KEY = 'scrub:polygonCounter';
const LAKES_KEY = 'scrub:lakes';
const RECENT_KEY = 'scrub:recent';
const SAVED_LAKE_KEY = 'scrub:savedLake';
const GRID_CONFIG_KEY = 'scrub:gridConfig'; // legacy: one config for one lake
const GRID_CONFIGS_KEY = 'scrub:gridConfigs'; // per-lake
const GRID_SNAPSHOTS_KEY = 'scrub:gridSnapshots';
const DELETED_DEMOS_KEY = 'scrub:deletedDemos';
const DELETED_IDS_KEY = 'scrub:deletedIds';
const SUPABASE_LAKE_IDS_KEY = 'scrub:supabaseLakeIds';
const SUPABASE_GRID_IDS_KEY = 'scrub:supabaseGridIds';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Supabase's `lakes.lake_id` is a UUID, but SCRUB's own lake ids are strings
 * like "osm:way/123" or "sam:3". This maps each SCRUB lake id to one stable
 * UUID, generated the first time it's needed and reused after — so a CSV
 * exported today and a `lakes` row inserted later (Part 2) reference the
 * exact same lake_id.
 */
export function getOrCreateSupabaseLakeId(lakeId: string): string {
  const all = readJson<Record<string, string>>(SUPABASE_LAKE_IDS_KEY, {});
  if (all[lakeId]) return all[lakeId];
  const uuid = crypto.randomUUID();
  all[lakeId] = uuid;
  writeJson(SUPABASE_LAKE_IDS_KEY, all);
  return uuid;
}

/** One stable UUID per (Supabase lake_id, grid_code), so re-syncing a lake updates the same grid rows instead of duplicating them. */
export function getOrCreateSupabaseGridId(supabaseLakeId: string, gridCode: string): string {
  const key = `${supabaseLakeId}:${gridCode}`;
  const all = readJson<Record<string, string>>(SUPABASE_GRID_IDS_KEY, {});
  if (all[key]) return all[key];
  const uuid = crypto.randomUUID();
  all[key] = uuid;
  writeJson(SUPABASE_GRID_IDS_KEY, all);
  return uuid;
}

/** Next sample-polygon number (1, 2, 3, ...), persisted so numbers never repeat or collide. */
export function nextPolygonNumber(): number {
  const cur = readJson<number>(POLYGON_COUNTER_KEY, 0);
  const next = cur + 1;
  writeJson(POLYGON_COUNTER_KEY, next);
  return next;
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

// ── Saved lake ──────────────────────────────────────────────────────────

export function loadSavedLake(): Lake | null {
  return readJson<Lake | null>(SAVED_LAKE_KEY, null);
}

export function saveLake(lake: Lake): void {
  writeJson(SAVED_LAKE_KEY, lake);
  // Also persist in the lakes map
  const map = readJson<Record<string, Lake>>(LAKES_KEY, {});
  map[lake.id] = lake;
  writeJson(LAKES_KEY, map);
}

export function clearSavedLake(): void {
  localStorage.removeItem(SAVED_LAKE_KEY);
}

export function removeLake(lakeId: string): Lake[] {
  // Mark as deleted so it never reappears on refresh
  markDeletedId(lakeId);
  if (lakeId.startsWith('demo:')) markDemoDeleted(lakeId);
  // Remove from the lakes map
  const map = readJson<Record<string, Lake>>(LAKES_KEY, {});
  delete map[lakeId];
  writeJson(LAKES_KEY, map);
  // Remove from recent
  const recent = loadRecentLakes().filter((l) => l.id !== lakeId);
  writeJson(RECENT_KEY, recent);
  // Clear saved lake if it was the active one
  const saved = loadSavedLake();
  if (saved && saved.id === lakeId) clearSavedLake();
  return recent;
}

// ── Recent lakes ────────────────────────────────────────────────────────

export function loadRecentLakes(): Lake[] {
  return readJson<Lake[]>(RECENT_KEY, []);
}

export function rememberLake(lake: Lake): Lake[] {
  const recent = loadRecentLakes().filter((l) => l.id !== lake.id);
  recent.unshift(lake);
  const trimmed = recent.slice(0, 10);
  writeJson(RECENT_KEY, trimmed);
  return trimmed;
}

// ── Grid config ─────────────────────────────────────────────────────────

/** Grid configuration per lake id, so each lake remembers its own cell size. */
export function loadGridConfigs(): Record<string, GridConfiguration> {
  const all = readJson<Record<string, GridConfiguration>>(GRID_CONFIGS_KEY, {});
  const legacy = readJson<GridConfiguration | null>(GRID_CONFIG_KEY, null);
  if (legacy && !all[legacy.lakeId]) all[legacy.lakeId] = legacy;
  return all;
}

export function saveGridConfig(cfg: GridConfiguration): Record<string, GridConfiguration> {
  const all = loadGridConfigs();
  all[cfg.lakeId] = cfg;
  writeJson(GRID_CONFIGS_KEY, all);
  return all;
}

// ── Grid snapshots ──────────────────────────────────────────────────────

export function loadGridSnapshots(): Record<string, GridSnapshot> {
  return readJson<Record<string, GridSnapshot>>(GRID_SNAPSHOTS_KEY, {});
}

export function saveGridSnapshot(snap: GridSnapshot): Record<string, GridSnapshot> {
  const all = loadGridSnapshots();
  all[snap.lakeId] = snap;
  writeJson(GRID_SNAPSHOTS_KEY, all);
  return all;
}

// ── Deleted lakes (all) ───────────────────────────────────────────────

export function loadDeletedIds(): Set<string> {
  return new Set(readJson<string[]>(DELETED_IDS_KEY, []));
}

function markDeletedId(lakeId: string): void {
  const ids = readJson<string[]>(DELETED_IDS_KEY, []);
  if (!ids.includes(lakeId)) {
    ids.push(lakeId);
    writeJson(DELETED_IDS_KEY, ids);
  }
}

// ── Deleted demos ──────────────────────────────────────────────────────

export function loadDeletedDemoIds(): Set<string> {
  return new Set(readJson<string[]>(DELETED_DEMOS_KEY, []));
}

export function markDemoDeleted(lakeId: string): void {
  const ids = readJson<string[]>(DELETED_DEMOS_KEY, []);
  if (!ids.includes(lakeId)) {
    ids.push(lakeId);
    writeJson(DELETED_DEMOS_KEY, ids);
  }
}

export function unmarkDemoDeleted(lakeId: string): void {
  const ids = readJson<string[]>(DELETED_DEMOS_KEY, []).filter((id) => id !== lakeId);
  writeJson(DELETED_DEMOS_KEY, ids);
}
