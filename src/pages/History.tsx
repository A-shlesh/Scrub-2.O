import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ChartCard } from '../components/ChartCard';
import { Navbar } from '../components/Navbar';
import { ObservatoryMap } from '../components/ObservatoryMap';
import type { MapPoint } from '../components/ObservatoryMap';
import { PageHeader } from '../components/PageHeader';
import { DEMO } from '../demo/demo';
import { ROBOT_ID, SENSOR_RECORD_SECONDS } from '../config/robot';
import { useLake } from '../stores/lake';
import { heatmapForSensor } from '../utils/gridAnalysis';
import { supabaseConfigured } from '../services/supabase/supabaseClient';
import { fetchMissions, fetchSensorHistory, HISTORY_MAX_ROWS, SENSORS } from '../services/supabase/supabaseService';
import type { MissionListItem } from '../services/supabase/supabaseService';
import type { SensorKey, SensorSample, SeriesPoint } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_POINTS: MapPoint[] = [];

/** Date -> value for <input type="datetime-local"> in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fmt = (v: number | null | undefined, digits = 1) => (finite(v) ? v.toFixed(digits) : '—');

/** Colour for a value on a sensor's 5-step scale. */
function colourFor(key: SensorKey, v: number | null | undefined): string {
  const meta = SENSORS.find((m) => m.key === key);
  if (!meta || !finite(v)) return '#9ca3af';
  const t = (v - meta.min) / (meta.max - meta.min);
  return meta.colors[Math.max(0, Math.min(4, Math.floor(t * 5)))];
}

export function HistoryPage() {
  const enabled = supabaseConfigured && !DEMO;
  const [missions, setMissions] = useState<MissionListItem[]>([]);
  const [missionId, setMissionId] = useState('');
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - DAY_MS));
  const [to, setTo] = useState(() => toLocalInput(Date.now()));
  const [samples, setSamples] = useState<SensorSample[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colourBy, setColourBy] = useState<SensorKey>('ph');
  const [view, setView] = useState<'points' | 'heatmap'>('points');
  const { lake, cells, cellSizeM } = useLake();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    fetchMissions(ROBOT_ID).then(setMissions, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [enabled]);

  const load = useCallback(async () => {
    if (!enabled) return;
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      setError('Choose a start time before the end time.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetchSensorHistory({ deviceId: ROBOT_ID, missionId: missionId || null, fromMs, toMs });
      setSamples(r.samples);
      setTruncated(r.truncated);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sensor history.');
    } finally {
      setLoading(false);
    }
  }, [enabled, from, to, missionId]);

  // Load once on open, and whenever the mission filter changes.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId, enabled]);

  /** Picking a mission sets the time window to that mission. */
  const pickMission = (id: string) => {
    setMissionId(id);
    const m = missions.find((x) => x.missionId === id);
    if (m) {
      const start = Date.parse(m.startedAt ?? m.createdAt);
      const end = m.completedAt ? Date.parse(m.completedAt) : Date.now();
      setFrom(toLocalInput(start - 60_000));
      setTo(toLocalInput(Math.max(end, start) + 60_000));
    }
  };

  const series = useMemo(() => {
    const out = {} as Record<SensorKey, SeriesPoint[]>;
    for (const m of SENSORS) {
      out[m.key] = samples.filter((s) => finite(s[m.key])).map((s) => ({ t: s.recorded_at, v: s[m.key] as number }));
    }
    return out;
  }, [samples]);

  const points: MapPoint[] = useMemo(
    () =>
      samples
        .filter((s) => finite(s.latitude) && finite(s.longitude) && !(s.latitude === 0 && s.longitude === 0))
        .map((s) => ({
          id: s.sample_id,
          p: { lat: s.latitude, lon: s.longitude },
          color: colourFor(colourBy, s[colourBy]),
          label: `${new Date(s.recorded_at).toLocaleString()} · ${SENSORS.find((m) => m.key === colourBy)?.label} ${fmt(s[colourBy])}`,
        })),
    [samples, colourBy],
  );

  const record = samples.find((s) => s.sample_id === selected) ?? null;

  /** Water-quality heatmap: the loaded readings averaged per grid cell of the selected lake. */
  const heat = useMemo(() => (view === 'heatmap' ? heatmapForSensor(samples, cells, colourBy) : null), [view, samples, cells, colourBy]);

  return (
    <>
      <Navbar />
      <main className="page">
        <PageHeader title="Sensor History" sub={`GPS-tagged readings stored by ${ROBOT_ID} every ${SENSOR_RECORD_SECONDS} s.`} />

        {!enabled ? (
          <div className="notice" role="status">
            {DEMO ? 'Sensor history is read from Supabase; it is not available in demo mode.' : 'Supabase is not configured, so no sensor history can be loaded.'}
          </div>
        ) : (
          <>
            <form
              className="history-filters panel"
              onSubmit={(e) => {
                e.preventDefault();
                void load();
              }}
            >
              <label>
                Mission
                <select value={missionId} onChange={(e) => pickMission(e.target.value)}>
                  <option value="">All missions</option>
                  {missions.map((m) => (
                    <option key={m.missionId} value={m.missionId}>
                      {new Date(m.createdAt).toLocaleString()} · {m.lakeName ?? 'Lake'} · {m.status} · {m.missionId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                From
                <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <button type="submit" className="btn-primary" disabled={loading}>
                <RefreshCw size={15} /> {loading ? 'Loading…' : 'Load'}
              </button>
            </form>

            {error && <div className="notice error" role="alert">{error}</div>}
            <div className="section-label">
              {samples.length} records{truncated ? ` (first ${HISTORY_MAX_ROWS}; narrow the time range to see the rest)` : ''}
            </div>

            <div className="history-map-row">
              <div className="map-wrap">
                <ObservatoryMap
                  mode="browse"
                  style="light"
                  showGrid={view === 'heatmap'}
                  gridCells={view === 'heatmap' ? cells : undefined}
                  heatmapCells={heat?.cells ?? []}
                  points={view === 'points' ? points : NO_POINTS}
                  selectedPointId={selected}
                  onPointClick={setSelected}
                />
                <div className="map-hint history-colour">
                  <div className="seg" role="group" aria-label="Map view">
                    <button type="button" aria-pressed={view === 'points'} onClick={() => setView('points')}>Points</button>
                    <button type="button" aria-pressed={view === 'heatmap'} onClick={() => setView('heatmap')}>Heatmap</button>
                  </div>
                  <label>
                    {view === 'heatmap' ? 'Average' : 'Colour by'}{' '}
                    <select value={colourBy} onChange={(e) => setColourBy(e.target.value as SensorKey)}>
                      {SENSORS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                  </label>
                  {view === 'heatmap' && (
                    <span className="heat-note">
                      {!lake
                        ? 'Select a lake in the Observatory to see its grid.'
                        : cells.length === 0
                          ? 'This lake has no grid yet (Observatory → grid size).'
                          : heat && heat.cellsWithData > 0
                            ? `${heat.cellsWithData} of ${cells.length} cells with readings · ${cellSizeM} m grid${heat.min !== null ? ` · ${fmt(heat.min)}–${fmt(heat.max)}` : ''}`
                            : 'No readings inside this lake\'s grid for this filter.'}
                    </span>
                  )}
                </div>
              </div>
              <section className="panel record-panel" aria-label="Selected record">
                <h3>Record</h3>
                {record ? (
                  <dl className="kv-rows">
                    <div><dt>Time</dt><dd>{new Date(record.recorded_at).toLocaleString()}</dd></div>
                    <div><dt>Position</dt><dd>{fmt(record.latitude, 6)}, {fmt(record.longitude, 6)}</dd></div>
                    <div><dt>Heading</dt><dd>{finite(record.heading_deg) ? `${Math.round(record.heading_deg)}°` : '—'}</dd></div>
                    {SENSORS.map((m) => (
                      <div key={m.key}><dt>{m.label}</dt><dd>{fmt(record[m.key], m.key === 'ph' ? 2 : 1)} {m.unit}</dd></div>
                    ))}
                    <div><dt>Mission</dt><dd>{record.mission_id ? record.mission_id.slice(0, 8) : '—'}</dd></div>
                    <div><dt>Device</dt><dd>{record.device_id ?? '—'}</dd></div>
                  </dl>
                ) : (
                  <p className="panel-sub">Click a point on the map or a row below to see a record.</p>
                )}
              </section>
            </div>

            <div className="history-grid">
              {SENSORS.map((m) => (
                <ChartCard key={m.key} title={m.label} unit={m.unit} points={series[m.key]} emptyHint={`No ${m.label} records in this range.`} />
              ))}
            </div>

            {samples.length > 0 && (
              <div className="table-wrap">
                <table className="records">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Latitude</th>
                      <th>Longitude</th>
                      <th>Heading</th>
                      {SENSORS.map((m) => <th key={m.key}>{m.label}{m.unit ? ` (${m.unit})` : ''}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {[...samples].reverse().slice(0, 500).map((s) => (
                      <tr key={s.sample_id} className={s.sample_id === selected ? 'selected' : undefined} onClick={() => setSelected(s.sample_id)}>
                        <td>{new Date(s.recorded_at).toLocaleString()}</td>
                        <td>{fmt(s.latitude, 6)}</td>
                        <td>{fmt(s.longitude, 6)}</td>
                        <td>{finite(s.heading_deg) ? Math.round(s.heading_deg) : '—'}</td>
                        {SENSORS.map((m) => <td key={m.key}>{fmt(s[m.key], m.key === 'ph' ? 2 : 1)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {samples.length > 500 && <p className="panel-sub">Showing the latest 500 of {samples.length} records. The charts and map show all of them.</p>}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
