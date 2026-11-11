import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Beaker, Compass, Cpu, Crosshair, Droplet, Droplets, FlaskConical, Gauge, House, MapPin, Navigation, Ruler, Thermometer, Waypoints, Wifi, Zap } from 'lucide-react';
import { ChartCard } from '../components/ChartCard';
import { Navbar } from '../components/Navbar';
import { PageHeader } from '../components/PageHeader';
import { SensorCard } from '../components/SensorCard';
import { fetchDeviceSamples } from '../services/supabase/supabaseService';
import { ROBOT_ID } from '../config/robot';
import { supabaseConfigured } from '../services/supabase/supabaseClient';
import type { SensorKey, SensorSample, SeriesPoint } from '../types';
import { useTelemetry } from '../stores/telemetry';
import { DEMO } from '../demo/demo';
import { aqiBand, compassPoint, fmtGpsDetailed, fmtMissionState, timeAgo } from '../utils/format';
import { RANGES, alertsFor, aqiStatus, batteryStatus, rangeStatus } from '../utils/thresholds';
import { reverseLocality } from '../services/osm/osmService';

/** Re-render every second so "Last updated" keeps counting. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const round = (v: number | null | undefined, digits = 0): string | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v.toFixed(digits);

/** The robot uploads one record every 10 s; the dashboard reads them at the same pace. */
const HISTORY_REFRESH_MS = 10_000;
const HISTORY_WINDOW_MS = 30 * 60 * 1000;
const HISTORY_CHARTS: Array<{ key: SensorKey; title: string; unit: string }> = [
  { key: 'ph', title: 'pH', unit: '' },
  { key: 'tds', title: 'TDS', unit: 'ppm' },
  { key: 'turbidity', title: 'Turbidity', unit: 'NTU' },
  { key: 'temperature_c', title: 'Temperature', unit: '°C' },
  { key: 'humidity_percent', title: 'Humidity', unit: '%' },
];

/** e.g. 100 -> "+100", -40 -> "-40", null -> "—" */
const fmtMotor = (v: number | null | undefined) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${Math.round(v)}` : '—');

/** Cloud sensor records for this robot over the last 30 minutes, refreshed every 10 s. */
function useCloudHistory(enabled: boolean): { samples: SensorSample[]; error: string | null; loadedAt: number | null } {
  const [samples, setSamples] = useState<SensorSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const rows = await fetchDeviceSamples(ROBOT_ID, Date.now() - HISTORY_WINDOW_MS);
        if (cancelled) return;
        setSamples(rows);
        setError(null);
        setLoadedAt(Date.now());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load sensor history.');
      } finally {
        inFlight = false;
      }
    };
    load();
    const id = window.setInterval(load, HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);
  return { samples, error, loadedAt };
}

export function TelemetryPage() {
  const { telemetry, connection, live } = useTelemetry();
  const now = useNow();
  const [locality, setLocality] = useState<string | null>(null);

  const lat = telemetry?.gps.latitude ?? null;
  const lng = telemetry?.gps.longitude ?? null;

  useEffect(() => {
    if (lat == null || lng == null || DEMO) return;
    let alive = true;
    void reverseLocality({ lat, lon: lng }).then((label) => {
      if (alive) setLocality(label);
    });
    return () => {
      alive = false;
    };
  }, [lat, lng]);

  const heading = telemetry?.compass.headingDeg;
  const headingLabel = typeof heading === 'number' && Number.isFinite(heading)
    ? `${Math.round(heading)}° ${compassPoint(heading)}`
    : '—';
  const speed = telemetry?.gps.speedMps;
  const speedLabel = typeof speed === 'number' && Number.isFinite(speed) ? `${speed.toFixed(1)} m/s` : '—';
  const aqi = telemetry?.air.aqi ?? null;

  const ts = telemetry?.timestamp ?? null;

  const pill =
    connection.status === 'connected' && live
      ? { cls: 'live', label: 'Live' }
      : connection.status === 'stale'
        ? { cls: 'stale', label: 'Stale' }
        : { cls: '', label: 'Offline' };


  // Alerts only make sense for fresh data: stale readings are not "current" problems.
  const alerts = connection.status === 'connected' && live ? alertsFor(telemetry) : [];
  const battery = telemetry?.batteryPercent ?? null;
  const batteryTone = batteryStatus(battery);
  const missionLabel = telemetry ? fmtMissionState(telemetry.missionState) : '-';
  const wp = typeof telemetry?.currentWaypoint === 'number' ? telemetry.currentWaypoint : null;
  const wpTotal = telemetry?.waypointTotal ?? null;
  const nav = telemetry?.navigation;
  const done = nav?.completedWaypoints ?? null;
  const progressPct = nav?.progress !== null && nav?.progress !== undefined
    ? Math.round(nav.progress * 100)
    : wpTotal ? Math.min(100, Math.round(((done ?? wp ?? 0) / wpTotal) * 100)) : null;
  const progressLabel = wpTotal ? `${done ?? '—'} of ${wpTotal} reached${progressPct !== null ? ` (${progressPct}%)` : ''}` : '—';
  const targetLabel = nav?.target ? `${nav.target.lat.toFixed(6)}, ${nav.target.lon.toFixed(6)}` : '—';
  const distLabel = typeof nav?.distanceToTargetM === 'number' ? `${nav.distanceToTargetM.toFixed(1)} m` : '—';
  const motors = telemetry?.motors;
  const motorLabel = motors && (motors.left !== null || motors.right !== null) ? `L ${fmtMotor(motors.left)} · R ${fmtMotor(motors.right)}` : '—';
  const gcsReturn =
    telemetry?.missionState === 'returning' ? 'Returning to GCS' : telemetry?.missionState === 'completed' ? 'Back at GCS' : telemetry?.missionId ? 'Not returning' : '—';
  const readingAt = ts ? new Date(ts).toLocaleTimeString() : null;

  const history = useCloudHistory(supabaseConfigured && !DEMO);
  const series = useMemo(() => {
    const out = {} as Record<SensorKey, SeriesPoint[]>;
    for (const c of HISTORY_CHARTS) {
      out[c.key] = history.samples
        .filter((s) => typeof s[c.key] === 'number' && Number.isFinite(s[c.key]))
        .map((s) => ({ t: s.recorded_at, v: s[c.key] as number }));
    }
    return out;
  }, [history.samples]);

  return (
    <>
      <Navbar />
      <main className="page">
        <PageHeader
          title="Live Telemetry"
          sub="Real-time sensor data from the robot."
          right={
            <>
              <span className={`pill ${pill.cls}`} role="status">
                <span className={`dot ${pill.cls || ''}`} aria-hidden="true" />
                {pill.label}
              </span>
              {battery !== null && Number.isFinite(battery) && (
                <span className={`stat-chip ${batteryTone}`} title="Robot battery">Battery {Math.round(battery)}%</span>
              )}
              {missionLabel !== '-' && <span className="stat-chip" title="Mission state">{missionLabel}</span>}
              {ts && <span className="updated-at">Last updated: {timeAgo(ts, now)}</span>}
            </>
          }
        />

        {alerts.length > 0 && (
          <div className={`alert-banner ${alerts.some((a) => a.level === 'bad') ? 'bad' : 'warn'}`} role="alert">
            <strong>{alerts.some((a) => a.level === 'bad') ? 'Readings outside the acceptable range' : 'Readings close to their limit'}</strong>
            <ul>
              {alerts.map((a) => (
                <li key={a.key} className={a.level}>{a.text}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="tele-layout">
          <div className="robot-photo" role="img" aria-label="SCRUB robot on the water" />

          <div className="sensor-grid">
            <SensorCard icon={<Droplet size={16} />} tone="blue" label="pH" value={round(telemetry?.water.ph, 1)} hint={`${RANGES.ph.min} - ${RANGES.ph.max}`} status={rangeStatus(telemetry?.water.ph, RANGES.ph.min, RANGES.ph.max)} />
            <SensorCard icon={<Beaker size={16} />} tone="slate" label="Turbidity" value={round(telemetry?.water.turbidityNtu)} unit="NTU" hint={`${RANGES.turbidityNtu.min} - ${RANGES.turbidityNtu.max}`} status={rangeStatus(telemetry?.water.turbidityNtu, RANGES.turbidityNtu.min, RANGES.turbidityNtu.max)} />
            <SensorCard icon={<FlaskConical size={16} />} tone="amber" label="TDS" value={round(telemetry?.water.tdsPpm)} unit="ppm" hint={`${RANGES.tdsPpm.min} - ${RANGES.tdsPpm.max}`} status={rangeStatus(telemetry?.water.tdsPpm, RANGES.tdsPpm.min, RANGES.tdsPpm.max)} />
            <SensorCard icon={<Cpu size={16} />} tone="teal" label="MQ135" value={round(aqi)} unit="AQI" hint={aqi !== null ? aqiBand(aqi) : ''} status={aqiStatus(aqi)} />
            <SensorCard icon={<Thermometer size={16} />} tone="rose" label="Temperature" value={round(telemetry?.air.temperatureC, 1)} unit="°C" />
            <SensorCard icon={<Droplets size={16} />} tone="blue" label="Humidity" value={round(telemetry?.air.humidityPct)} unit="%" />
          </div>
        </div>
        {readingAt && (
          <p className="reading-meta">
            Latest readings taken at {readingAt}
            {lat !== null && lng !== null ? ` at ${lat.toFixed(6)}, ${lng.toFixed(6)}` : ' (no GPS fix)'}
          </p>
        )}

        <div className="strip">
          <div className="strip-item" title={locality ?? undefined}>
            <div className="k"><MapPin size={14} />GPS Location</div>
            <div className="v">{fmtGpsDetailed(lat, lng, telemetry?.gps.fix ?? false).replace('-', '—')}</div>
          </div>
          <div className="strip-item">
            <div className="k"><Compass size={14} />Heading</div>
            <div className="v">{headingLabel}</div>
          </div>
          <div className="strip-item">
            <div className="k"><Zap size={14} />Speed</div>
            <div className="v">{speedLabel}</div>
          </div>
          <div className="strip-item">
            <div className="k"><Navigation size={14} />Navigation</div>
            <div className="v">{missionLabel}</div>
          </div>
          <div className="strip-item">
            <div className="k"><Wifi size={14} />Network</div>
            <div className="v">
              <span className={`dot ${connection.status === 'connected' ? 'live' : connection.status === 'connecting' ? 'working' : 'error'}`} aria-hidden="true" />
              {connection.status === 'connected' ? 'Connected' : connection.status === 'connecting' ? 'Connecting…' : connection.status === 'stale' ? 'Stale' : 'Offline'}
            </div>
          </div>
        </div>

        <div className="section-label">Navigation{telemetry?.missionId ? ` · mission ${telemetry.missionId.slice(0, 8)}` : ''}</div>
        <div className="strip nav-strip">
          <div className="strip-item">
            <div className="k"><Waypoints size={14} />Current waypoint</div>
            <div className="v">{wp !== null ? `${wp}${wpTotal ? ` of ${wpTotal}` : ''}` : '—'}</div>
          </div>
          <div className="strip-item">
            <div className="k"><Crosshair size={14} />Target</div>
            <div className="v">{targetLabel}</div>
          </div>
          <div className="strip-item">
            <div className="k"><Ruler size={14} />Distance to target</div>
            <div className="v">{distLabel}</div>
          </div>
          <div className="strip-item">
            <div className="k"><Gauge size={14} />Progress</div>
            <div className="v">{progressLabel}</div>
          </div>
          <div className="strip-item">
            <div className="k"><Zap size={14} />Motors</div>
            <div className="v">{motorLabel}</div>
          </div>
          <div className="strip-item">
            <div className="k"><House size={14} />GCS return</div>
            <div className="v">{gcsReturn}</div>
          </div>
        </div>

        {supabaseConfigured && !DEMO && (
          <>
            <div className="section-label">
              Sensor history · last 30 min from the cloud · updates every 10 s
              {history.loadedAt ? ` · ${history.samples.length} records` : ''} · <Link to="/history">Full history</Link>
            </div>
            {history.error && (
              <div className="notice error" role="alert">
                Could not load sensor history: {history.error}. Check that the mission-control migration (device_id column) has been applied.
              </div>
            )}
            <div className="history-grid">
              {HISTORY_CHARTS.map((c) => (
                <ChartCard
                  key={c.key}
                  title={c.title}
                  unit={c.unit}
                  points={series[c.key]}
                  emptyHint={`No ${c.title} records from ${ROBOT_ID} in the last 30 minutes.`}
                />
              ))}
            </div>
          </>
        )}
        {DEMO && <p className="demo-note">Demo data — set VITE_DEMO=0 to use live sources.</p>}
      </main>
    </>
  );
}
