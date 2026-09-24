/**
 * Demo data for design review. Enabled ONLY when VITE_DEMO=1.
 *
 * Nothing in here runs in a normal build: production keeps its honest
 * "-" / empty states. Demo lakes use ids prefixed with "demo:" so they can
 * never be confused with (or persist as) real OSM lakes.
 */

import type { ConnectionState, Lake, LakeAnalytics, LatLon, SeriesPoint, Telemetry } from '../types';
import type {
  ConnectionListener,
  RealtimeService,
  TelemetryListener,
} from '../services/realtime/realtimeService';

export const DEMO = import.meta.env.VITE_DEMO === '1';

export const isDemoId = (id: string) => id.startsWith('demo:');

// ── Lakes ────────────────────────────────────────────────────────────────

/** Irregular lake-shaped polygon: ellipse (metres) with harmonic wobble. */
function blob(center: LatLon, rx: number, ry: number, seed: number, n = 56): LatLon[] {
  const pts: LatLon[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r =
      1 +
      0.16 * Math.sin(2 * a + seed) +
      0.09 * Math.sin(3 * a + seed * 1.7) +
      0.05 * Math.sin(5 * a + seed * 2.3);
    const dy = ry * r * Math.sin(a);
    const dx = rx * r * Math.cos(a);
    const lat = center.lat + dy / 111_320;
    pts.push({ lat, lon: center.lon + dx / (111_320 * Math.cos((lat * Math.PI) / 180)) });
  }
  pts.push(pts[0]);
  return pts;
}

function demoLake(id: string, name: string, center: LatLon, rx: number, ry: number, seed: number, ageMin: number): Lake {
  const points = blob(center, rx, ry, seed);
  return {
    id: `demo:${id}`,
    name,
    waterType: 'lake',
    center,
    osmBoundary: { points, sourceId: null, source: 'openstreetmap' },
    scrubBoundary: { points },
    updatedAt: new Date(Date.now() - ageMin * 60_000).toISOString(),
  };
}

export const demoLakes: Lake[] = [
  demoLake('kengeri', 'Kengeri Lake', { lat: 12.9145, lon: 77.482 }, 300, 340, 0.6, 2),
  demoLake('ulsoor', 'Ulsoor Lake', { lat: 12.9825, lon: 77.62 }, 340, 220, 2.1, 65),
  demoLake('sarakki', 'Sarakki Lake', { lat: 12.8995, lon: 77.585 }, 260, 240, 4.0, 190),
];

export const demoLocality: Record<string, string> = {
  'demo:kengeri': 'Bangalore, KA',
  'demo:ulsoor': 'Bangalore, KA',
  'demo:sarakki': 'Bangalore, KA',
};

// ── Live telemetry ───────────────────────────────────────────────────────

const wobble = (base: number, amp: number) => base + (Math.random() - 0.5) * amp;

/**
 * Demo only: force readings to test alerts, e.g. in the browser console
 *   localStorage.setItem('scrub:demoOverride', JSON.stringify({ ph: 9.1, batteryPercent: 15 }))
 * and remove the key to go back to normal. Keys: ph, turbidityNtu, tdsPpm, aqi, batteryPercent.
 */
function demoOverride(): Record<string, number> {
  try {
    const raw = localStorage.getItem('scrub:demoOverride');
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export class DemoRealtimeService implements RealtimeService {
  private tl = new Set<TelemetryListener>();
  private cl = new Set<ConnectionListener>();
  private timer: number | null = null;
  private seq = 0;
  private last: Telemetry | null = null;
  private conn: ConnectionState = { status: 'disconnected', lastMessageAt: null, detail: 'Demo mode' };

  private tick = () => {
    const now = new Date().toISOString();
    const c = demoLakes[0].center;
    const o = demoOverride();
    this.last = {
      robotId: 'scrub-demo-01',
      timestamp: now,
      sequence: ++this.seq,
      water: { ph: o.ph ?? wobble(7.2, 0.06), turbidityNtu: o.turbidityNtu ?? wobble(12, 0.6), tdsPpm: o.tdsPpm ?? wobble(310, 4) },
      air: { aqi: o.aqi ?? Math.round(wobble(42, 1.5)), temperatureC: wobble(28.4, 0.2), humidityPct: wobble(62, 0.8) },
      gps: {
        latitude: c.lat + (Math.random() - 0.5) * 0.0002,
        longitude: c.lon + (Math.random() - 0.5) * 0.0002,
        speedMps: wobble(0.8, 0.05),
        fix: true,
        satellites: 9,
      },
      compass: { headingDeg: wobble(142, 2) },
      batteryPercent: o.batteryPercent ?? 82,
      missionId: null,
      missionState: 'sampling',
      currentWaypoint: null,
    };
    this.conn = { status: 'connected', lastMessageAt: now, detail: 'Demo mode' };
    this.tl.forEach((fn) => fn(this.last as Telemetry));
    this.cl.forEach((fn) => fn({ ...this.conn }));
  };

  connect(): void {
    if (this.timer !== null) return;
    this.tick();
    this.timer = window.setInterval(this.tick, 2000);
  }

  disconnect(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.conn = { status: 'disconnected', lastMessageAt: null, detail: 'Demo mode' };
    this.cl.forEach((fn) => fn({ ...this.conn }));
  }

  onTelemetry(fn: TelemetryListener): () => void {
    this.tl.add(fn);
    if (this.last) queueMicrotask(() => this.last && fn(this.last));
    return () => {
      this.tl.delete(fn);
    };
  }

  onConnection(fn: ConnectionListener): () => void {
    this.cl.add(fn);
    queueMicrotask(() => fn({ ...this.conn }));
    return () => {
      this.cl.delete(fn);
    };
  }

  getConnection(): ConnectionState {
    return { ...this.conn };
  }
}

// ── Analytics ────────────────────────────────────────────────────────────

function series(base: number, amp: number, days = 7, perDay = 4): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  const total = days * perDay;
  for (let i = 0; i < total; i++) {
    const t = new Date(Date.now() - (total - 1 - i) * (86_400_000 / perDay)).toISOString();
    out.push({ t, v: base + Math.sin(i / 2.3) * amp + Math.cos(i / 5.1) * amp * 0.6 });
  }
  return out;
}

export function demoAnalytics(): Partial<LakeAnalytics> {
  return {
    waterLevelM: series(2.4, 0.15),
    dissolvedOxygenMgL: series(6.8, 0.5),
    bodMgL: series(3.2, 0.4),
    summary: { areaCoveredPct: 68, wasteCollectedKg: 12.4, waterQualityIndex: 78, activeMissions: 6 },
  };
}
