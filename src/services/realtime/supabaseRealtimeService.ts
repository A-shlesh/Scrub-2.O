/**
 * Live telemetry from the robot over Supabase Realtime Broadcast:
 * channel `robot:{ROBOT_ID}`, event `telemetry`, about every 2 s. Nothing is stored.
 * Payload format (flat or nested): docs/robot-protocol.md, section 3.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { ConnectionState } from '../../types';
import { supabase } from '../supabase/supabaseClient';
import { ROBOT_ID } from '../../config/robot';
import type { ConnectionListener, RealtimeService, TelemetryListener } from './realtimeService';
import { parseTelemetry } from './telemetryParser';

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
        const t = parseTelemetry(payload, ROBOT_ID);
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
