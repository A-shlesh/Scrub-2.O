/**
 * Groundwork for the future lake-quality heatmap (analysis only, never navigation).
 *
 * Sensor records keep their own GPS position, time and mission. Later the lake polygon
 * can be divided into grid cells (utils/geo.ts generateGrid) and every record assigned
 * to the cell that contains it, then averaged per cell. Nothing here changes the route.
 */
import type { GridCell, SensorKey, SensorSample } from '../types';
import { pointInPolygon } from './geo';
import { SENSORS } from '../services/supabase/supabaseService';

const KEYS: SensorKey[] = ['ph', 'tds', 'turbidity', 'temperature_c', 'humidity_percent'];

export interface CellSummary {
  cellId: string;
  count: number;
  averages: Record<SensorKey, number | null>;
}

/** Cell id for each record from its GPS position (null when outside every cell). */
export function classifyByPosition(samples: SensorSample[], cells: GridCell[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const s of samples) {
    const p = { lat: s.latitude, lon: s.longitude };
    const cell = Number.isFinite(p.lat) && Number.isFinite(p.lon) ? cells.find((c) => pointInPolygon(p, c.polygon)) : undefined;
    out.set(s.sample_id, cell?.id ?? null);
  }
  return out;
}

/** Per-cell averages of every sensor, for cells that have at least one record. */
export function averageByCell(samples: SensorSample[], cells: GridCell[]): CellSummary[] {
  const byCell = classifyByPosition(samples, cells);
  const groups = new Map<string, SensorSample[]>();
  for (const s of samples) {
    const id = byCell.get(s.sample_id);
    if (!id) continue;
    const list = groups.get(id) ?? [];
    list.push(s);
    groups.set(id, list);
  }
  return [...groups.entries()].map(([cellId, list]) => {
    const averages = {} as Record<SensorKey, number | null>;
    for (const k of KEYS) {
      const vals = list.map((s) => s[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      averages[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return { cellId, count: list.length, averages };
  });
}

export interface SensorHeatmap {
  /** one entry per cell with readings, coloured on the sensor's scale */
  cells: Array<{ gridCode: string; color: string; value: number | null }>;
  cellsWithData: number;
  min: number | null;
  max: number | null;
}

/**
 * Heatmap of one sensor: readings averaged per cell, each cell coloured on that sensor's
 * 5-step scale (SENSORS in supabaseService). Cells without readings are left out.
 */
export function heatmapForSensor(samples: SensorSample[], cells: GridCell[], key: SensorKey): SensorHeatmap {
  const meta = SENSORS.find((m) => m.key === key);
  const values = averageByCell(samples, cells)
    .map((c) => ({ cellId: c.cellId, value: c.averages[key] }))
    .filter((c): c is { cellId: string; value: number } => c.value !== null);
  const colour = (v: number): string => {
    if (!meta) return '#9ca3af';
    const t = (v - meta.min) / (meta.max - meta.min);
    return meta.colors[Math.max(0, Math.min(4, Math.floor(t * 5)))];
  };
  const vs = values.map((c) => c.value);
  return {
    cells: values.map((c) => ({ gridCode: c.cellId, color: colour(c.value), value: c.value })),
    cellsWithData: values.length,
    min: vs.length ? Math.min(...vs) : null,
    max: vs.length ? Math.max(...vs) : null,
  };
}
