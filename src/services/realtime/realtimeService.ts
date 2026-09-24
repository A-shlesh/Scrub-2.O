import type { ConnectionState, Telemetry } from '../../types';

export type TelemetryListener = (t: Telemetry) => void;
export type ConnectionListener = (s: ConnectionState) => void;

export const STALE_AFTER_MS = Number(import.meta.env.VITE_TELEMETRY_STALE_AFTER_MS ?? 30_000);
export const staleAfterMs = () => STALE_AFTER_MS;

export interface RealtimeService {
  connect(): void;
  disconnect(): void;
  onTelemetry(fn: TelemetryListener): () => void;
  onConnection(fn: ConnectionListener): () => void;
  getConnection(): ConnectionState;
}

export class NullRealtimeService implements RealtimeService {
  private conn: ConnectionState = { status: 'disconnected', lastMessageAt: null, detail: null };

  connect(): void {
    this.conn = { status: 'disconnected', lastMessageAt: null, detail: 'No realtime backend configured.' };
  }

  disconnect(): void {
    this.conn = { status: 'disconnected', lastMessageAt: null, detail: null };
  }

  onTelemetry(_fn: TelemetryListener): () => void {
    return () => {};
  }

  onConnection(_fn: ConnectionListener): () => void {
    return () => {};
  }

  getConnection(): ConnectionState {
    return { ...this.conn };
  }
}
