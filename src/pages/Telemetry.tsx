import { useEffect, useState } from 'react';
import { Beaker, Compass, Cpu, Droplet, Droplets, FlaskConical, MapPin, Thermometer, Wifi, Zap } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { PageHeader } from '../components/PageHeader';
import { SensorCard } from '../components/SensorCard';
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

  const pill =
    connection.status === 'connected' && live
      ? { cls: 'live', label: 'Live' }
      : connection.status === 'stale'
        ? { cls: 'stale', label: 'Stale' }
        : { cls: '', label: 'Offline' };

  const ts = telemetry?.timestamp ?? null;

  // Alerts only make sense for fresh data: stale readings are not "current" problems.
  const alerts = connection.status === 'connected' && live ? alertsFor(telemetry) : [];
  const battery = telemetry?.batteryPercent ?? null;
  const batteryTone = batteryStatus(battery);
  const missionLabel = telemetry ? fmtMissionState(telemetry.missionState) : '-';

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
            <div className="k"><Wifi size={14} />Network</div>
            <div className="v">
              <span className={`dot ${connection.status === 'connected' ? 'live' : connection.status === 'connecting' ? 'working' : 'error'}`} aria-hidden="true" />
              {connection.status === 'connected' ? 'Connected' : connection.status === 'connecting' ? 'Connecting…' : connection.status === 'stale' ? 'Stale' : 'Offline'}
            </div>
          </div>
        </div>
        {DEMO && <p className="demo-note">Demo data — set VITE_DEMO=0 to use live sources.</p>}
      </main>
    </>
  );
}
