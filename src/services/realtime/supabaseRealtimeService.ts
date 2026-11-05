/**
 * Live telemetry from the robot over Supabase Realtime Broadcast:
 * channel `robot:{ROBOT_ID}`, event `telemetry`, about every 2 s. Nothing is stored.
 * Payload format: docs/robot-protocol.md, section 3.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { ConnectionState, MissionState, Telemetry } from '../../types';
import { supabase } from '../supabase/supabaseClient';
import { ROBOT_ID } from '../supabase/robotService';
import type { ConnectionListener, RealtimeService, TelemetryListener } from './realtimeService';

const MISSION_STATES: MissionState[] = ['idle', 'loaded', 'transit', 'sampling', 'returning', 'paused', 'completed', 'emergency_stop', 'error'];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Turn one broadcast payload into Telemetry; null when it is not an object. Unknown or bad fields become null. */
export function parseTelemetry(payload: unknown, robotId = ROBOT_ID): Telemetry | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const lat = num(p.lat);
  const lon = num(p.lon);
  const validFix = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const state = str(p.mission_state);
  return {
    robotId: str(p.device_id) ?? robotId,
    timestamp: str(p.ts),
    sequence: num(p.seq),
    water: { ph: num(p.ph), turbidityNtu: num(p.turbidity), tdsPpm: num(p.tds) },
    air: { aqi: num(p.aqi), temperatureC: num(p.temperature_c), humidityPct: num(p.humidity_percent) },
    gps: {
      latitude: validFix ? lat : null,
      longitude: validFix ? lon : null,
      speedMps: num(p.speed_mps),
      fix: validFix && p.fix !== false,
      satellites: num(p.satellites),
    },
    compass: { headingDeg: num(p.heading_deg) },
    batteryPercent: num(p.battery_percent),
    missionId: str(p.mission_id),
    missionState: state && (MISSION_STATES as string[]).includes(state) ? (state as MissionState) : 'unknown',
    currentWaypoint: num(p.waypoint_index),
    waypointTotal: num(p.waypoint_total),
  };
}

export class SupabaseRealtimeService implements RealtimeService {
  private channel: RealtimeChannel | null = null;
  private telemetryListeners = new Set<TelemetryListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private conn: ConnectionState = { status: 'disconnected', lastMessageAt: null, detail: null };

  private setConn(next: ConnectionState) {
    this.conn = next;
    this.connectionListeners.forEach((fn) => fn({ ...next }));
  }

  connect(): void {
    if (!supabase) {
      this.setConn({ status: 'disconnected', lastMessageAt: null, detail: 'Supabase is not configured.' });
      return;
    }
    if (this.channel) void supabase.removeChannel(this.channel);
    this.setConn({ status: 'connecting', lastMessageAt: this.conn.lastMessageAt, detail: null });
    this.channel = supabase
      .channel(`robot:${ROBOT_ID}`)
      .on('broadcast', { event: 'telemetry' }, ({ payload }) => {
        const t = parseTelemetry(payload);
        if (!t) return;
        // Freshness uses the time it arrived here, so a wrong robot clock cannot fake "live".
        this.setConn({ status: 'connected', lastMessageAt: new Date().toISOString(), detail: null });
        this.telemetryListeners.forEach((fn) => fn(t));
      })
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          this.setConn({ status: 'connected', lastMessageAt: this.conn.lastMessageAt, detail: 'Listening for the robot.' });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.setConn({ status: 'error', lastMessageAt: this.conn.lastMessageAt, detail: err?.message ?? 'Realtime connection failed.' });
        } else if (status === 'CLOSED') {
          this.setConn({ status: 'disconnected', lastMessageAt: this.conn.lastMessageAt, detail: null });
        }
      });
  }

  disconnect(): void {
    if (this.channel && supabase) void supabase.removeChannel(this.channel);
    this.channel = null;
    this.setConn({ status: 'disconnected', lastMessageAt: this.conn.lastMessageAt, detail: null });
  }

  onTelemetry(fn: TelemetryListener): () => void {
    this.telemetryListeners.add(fn);
    return () => this.telemetryListeners.delete(fn);
  }

  onConnection(fn: ConnectionListener): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }

  getConnection(): ConnectionState {
    return { ...this.conn };
  }
}
