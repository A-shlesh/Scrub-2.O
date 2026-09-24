import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { ObservatoryMap } from '../components/ObservatoryMap';
import { PageHeader } from '../components/PageHeader';
import { useLake } from '../stores/lake';
import { DEMO } from '../demo/demo';
import { computeGridAnalytics, fetchGridCells, fetchSensorSamples, fetchSessionStats, fetchVisitedGridIds, SENSORS } from '../services/supabase/supabaseService';
import type { GridAnalytics, GridCellAverage, SensorAverage, SensorKey } from '../types';

const RANGES = ['Last 24 Hours', 'Last 7 Days', 'Last 30 Days'] as const;

/** Interpolate between color stops based on value fraction (0–1). */
function heatmapColor(colors: [string, string, string, string, string], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const idx = clamped * (colors.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, colors.length - 1);
  const frac = idx - lo;
  return lerpColor(colors[lo], colors[hi], frac);
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function SensorCard({
  label,
  unit,
  avg,
  min,
  max,
  count,
  selected,
  onClick,
}: {
  label: string;
  unit: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`sensor-card${selected ? ' selected' : ''}`} onClick={onClick}>
      <div className="sensor-label">{label}</div>
      <div className="sensor-value">{avg !== null ? avg.toFixed(1) : '—'}</div>
      <div className="sensor-unit">{unit || 'avg'}</div>
      <div className="sensor-range">
        {min !== null && max !== null ? `${min.toFixed(1)} – ${max.toFixed(1)}` : 'no data'} · {count} readings
      </div>
    </button>
  );
}

export function AnalyticsPage() {
  const { lake, recent, cells, selectLake } = useLake();
  const [range, setRange] = useState<(typeof RANGES)[number]>('Last 7 Days');
  const [analytics, setAnalytics] = useState<GridAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSensor, setSelectedSensor] = useState<SensorKey>('ph');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [visitedGridIds, setVisitedGridIds] = useState<Set<string>>(new Set());

  const loadData = useCallback(async () => {
    if (!lake) { setAnalytics(null); setVisitedGridIds(new Set()); return; }
    setLoading(true);
    setError(null);
    try {
      if (DEMO) {
        // Demo: generate synthetic analytics from the current grid
        const demoAnalytics = generateDemoAnalytics(lake.id, cells.map((c) => ({ gridId: `demo-${c.id}`, gridCode: c.id, centerLat: c.center.lat, centerLon: c.center.lon })));
        setAnalytics(demoAnalytics);
        setVisitedGridIds(new Set());
      } else {
        const [grids, samples, visited] = await Promise.all([
          fetchGridCells(lake.id),
          fetchSensorSamples(lake.id),
          fetchVisitedGridIds(lake.id),
        ]);
        setAnalytics(computeGridAnalytics(lake.id, samples, grids));
        setVisitedGridIds(visited);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load analytics.');
    } finally {
      setLoading(false);
    }
  }, [lake?.id, cells, range]);

  // Initial load
  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh: poll every 8 seconds to detect newly completed sessions
  useEffect(() => {
    if (DEMO || !lake) return;
    const id = window.setInterval(() => {
      // Silently refresh visited + analytics in the background
      (async () => {
        const [grids, samples, visited] = await Promise.all([
          fetchGridCells(lake.id),
          fetchSensorSamples(lake.id),
          fetchVisitedGridIds(lake.id),
        ]);
        setAnalytics(computeGridAnalytics(lake.id, samples, grids));
        setVisitedGridIds(visited);
      })();
    }, 8000);
    return () => window.clearInterval(id);
  }, [lake?.id]);

  const meta = SENSORS.find((s) => s.key === selectedSensor) ?? SENSORS[0];

  /** Build a color map: gridCode → color for the heatmap. */
  const heatmapColors = useMemo(() => {
    if (!analytics) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const cell of analytics.cellAverages) {
      const val = cell.averages[selectedSensor];
      if (val === null) {
        map.set(cell.gridCode, 'rgba(128,128,128,0.15)');
      } else {
        const t = (val - meta.min) / (meta.max - meta.min);
        map.set(cell.gridCode, heatmapColor(meta.colors, t));
      }
    }
    return map;
  }, [analytics, selectedSensor, meta]);

  /** Cells formatted for the map's heatmap overlay. */
  const heatmapCells = useMemo(() => {
    if (!analytics) return [];
    return analytics.cellAverages.map((ca) => ({
      gridCode: ca.gridCode,
      color: heatmapColors.get(ca.gridCode) ?? 'rgba(128,128,128,0.15)',
      value: ca.averages[selectedSensor],
    }));
  }, [analytics, heatmapColors, selectedSensor]);

  const s = analytics?.sensorSummaries.find((ss) => ss.sensor.key === selectedSensor);

  return (
    <>
      <Navbar />
      <main className="page">
        <PageHeader
          title="Reclamation Analytics"
          sub="Water quality per grid cell from Supabase sensor readings."
          right={
            <label className="select-wrap">
              <span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Time range</span>
              <select value={range} onChange={(e) => setRange(e.target.value as (typeof RANGES)[number])}>
                {RANGES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <ChevronDown size={16} />
            </label>
          }
        />

        {/* Lake picker */}
        {recent.length > 1 && (
          <div className="analytics-picker">
            <button type="button" className="btn" onClick={() => setPickerOpen((v) => !v)}>
              {lake?.name ?? 'Select lake'} <ChevronDown size={14} />
            </button>
            {pickerOpen && (
              <ul className="lake-picker-dropdown">
                {recent.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      className={l.id === lake?.id ? 'active' : ''}
                      onClick={() => { selectLake(l); setPickerOpen(false); }}
                    >
                      {l.name ?? 'Unnamed'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <div className="notice error" role="alert">{error}</div>}
        {loading && <div className="notice">Loading sensor data…</div>}

        {/* Sensor summary cards */}
        {analytics && (
          <>
            <div className="section-label">Sensors</div>
            <div className="sensor-grid">
              {analytics.sensorSummaries.map((ss) => (
                <SensorCard
                  key={ss.sensor.key}
                  label={ss.sensor.label}
                  unit={ss.sensor.unit}
                  avg={ss.avg}
                  min={ss.min}
                  max={ss.max}
                  count={ss.count}
                  selected={selectedSensor === ss.sensor.key}
                  onClick={() => setSelectedSensor(ss.sensor.key)}
                />
              ))}
            </div>

            {/* Stats */}
            <div className="stat-grid" style={{ marginTop: 16 }}>
              <div className="stat-card">
                <div className="k">Total Samples</div>
                <div className="v">{analytics.totalSamples}</div>
              </div>
              <div className="stat-card">
                <div className="k">Sessions</div>
                <div className="v">{analytics.totalSessions}</div>
              </div>
              <div className="stat-card">
                <div className="k">Grid Cells</div>
                <div className="v">{analytics.cellAverages.length}</div>
              </div>
              <div className="stat-card">
                <div className="k">{meta.label} Average</div>
                <div className="v">
                  {s?.avg !== null && s?.avg !== undefined ? s.avg.toFixed(1) : '—'}
                  {s?.avg != null ? <span className="unit">{meta.unit}</span> : null}
                </div>
              </div>
            </div>

            {/* Heatmap legend */}
            <div className="section-label">Heatmap — {meta.label}</div>
            <div className="heatmap-legend">
              <span className="heatmap-lo">{meta.min} {meta.unit}</span>
              <div className="heatmap-bar" style={{
                background: `linear-gradient(to right, ${meta.colors.join(', ')})`,
              }} />
              <span className="heatmap-hi">{meta.max} {meta.unit}</span>
            </div>

            {/* Heatmap on the map */}
            <div className="analytics-map-wrap">
              <ObservatoryMap
                mode="browse"
                style="light"
                gridCells={cells}
                showGrid={true}
                heatmapCells={heatmapCells}
                visitedGridIds={visitedGridIds}
                showLegend
              />
            </div>
          </>
        )}

        {!lake && <p className="demo-note">Select a lake in the Observatory to view sensor analytics.</p>}
        {DEMO && <p className="demo-note">Demo data — set VITE_DEMO=0 to use live Supabase data.</p>}
      </main>
    </>
  );
}

// ── Demo data generator ────────────────────────────────────────────────────

function generateDemoAnalytics(
  lakeId: string,
  grids: { gridId: string; gridCode: string; centerLat: number; centerLon: number }[],
): GridAnalytics {
  const SENSOR_KEYS_D: SensorKey[] = ['ph', 'tds', 'turbidity', 'temperature_c', 'humidity_percent'];
  const DEMO_BASE: Record<SensorKey, number> = {
    ph: 7.2,
    tds: 320,
    turbidity: 18,
    temperature_c: 28,
    humidity_percent: 72,
  };
  const DEMO_RANGE: Record<SensorKey, number> = {
    ph: 0.8,
    tds: 120,
    turbidity: 15,
    temperature_c: 4,
    humidity_percent: 10,
  };

  const cellAverages: GridCellAverage[] = grids.map((g) => {
    const avgs = {} as Record<SensorKey, number | null>;
    for (const key of SENSOR_KEYS_D) {
      // deterministic "random" based on grid code hash
      const h = gridHash(g.gridCode);
      avgs[key] = DEMO_BASE[key] + (h[key] ?? 0) * DEMO_RANGE[key];
    }
    return { gridId: g.gridId, gridCode: g.gridCode, centerLat: g.centerLat, centerLon: g.centerLon, averages: avgs };
  });

  const sensorSummaries: SensorAverage[] = SENSORS.map((meta) => {
    const vals = cellAverages.map((ca) => ca.averages[meta.key]).filter((v): v is number => v !== null);
    return {
      sensor: meta,
      avg: vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      min: vals.length > 0 ? Math.min(...vals) : null,
      max: vals.length > 0 ? Math.max(...vals) : null,
      count: vals.length * 5,
    };
  });

  return { lakeId, cellAverages, sensorSummaries, totalSamples: grids.length * 5, totalSessions: 3 };
}

function gridHash(code: string): Record<SensorKey, number> {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = ((h << 5) - h + code.charCodeAt(i)) | 0;
  const norm = (n: number) => (Math.abs(((h >> (n * 3)) & 0x7) / 7) - 0.5);
  return {
    ph: norm(0),
    tds: norm(1),
    turbidity: norm(2),
    temperature_c: norm(3),
    humidity_percent: norm(4),
  };
}
