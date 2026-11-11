/**
 * Live telemetry straight from the Raspberry Pi backend: WebSocket `{VITE_WS_BASE_URL}/ws/telemetry`.
 * One JSON frame about every 2 s (format: docs/robot-protocol.md, section 3).
 * Reconnects by itself with a growing delay (1 s up to 15 s) after a disconnect.
 *
 * Browsers cannot send headers on a WebSocket, so a signed-in operator's Supabase access
 * token goes in the query string: /ws/telemetry?token=<access token>. The URL is rebuilt
 * on every (re)connect, and the socket reconnects when the token is refreshed or the
 * operator signs in or out. Without a session it connects without a token.
 */
import type { ConnectionState } from '../../types';
import { insecureUrlProblem, WS_BASE_URL } from '../../config/backend';
import { ROBOT_ID } from '../../config/robot';
import type { ConnectionListener, RealtimeService, TelemetryListener } from './realtimeService';
import { parseTelemetry } from './telemetryParser';
import { supabase } from '../supabase/supabaseClient';

/** `base` with `?token=` (or `&token=`) appended when there is a token. */
export function withToken(base: string, token: string | null | undefined): string {
  if (!token) return base;
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** The signed-in operator's Supabase access token, or null. */
async function sessionToken(): Promise<string | null> {
  try {
    return (await supabase?.auth.getSession())?.data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

const MAX_RETRY_MS = 15_000;
const PING_MS = 20_000;

export class WebSocketRealtimeService implements RealtimeService {
  private ws: WebSocket | null = null;
  private telemetryListeners = new Set<TelemetryListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private conn: ConnectionState = { status: 'disconnected', lastMessageAt: null, detail: null };
  private retryMs = 1000;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private wanted = false;
  /** bumped on every connect/disconnect so a slow token lookup never opens a stale socket */
  private generation = 0;
  private authSub: { unsubscribe: () => void } | null = null;
  private lastToken: string | null = null;

  constructor(
    private readonly url: string = `${WS_BASE_URL}/ws/telemetry`,
    private readonly getToken: () => Promise<string | null> = sessionToken,
  ) {}

  /** Reconnect with a fresh URL whenever the operator's token changes. */
  private watchAuth() {
    if (this.authSub || !supabase) return;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? null;
      if (token !== this.lastToken && this.wanted) this.connect();
    });
    this.authSub = data.subscription;
  }

  private setConn(next: ConnectionState) {
    this.conn = next;
    this.connectionListeners.forEach((fn) => fn({ ...next }));
  }

  private clearTimers() {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  connect(): void {
    this.wanted = true;
    this.clearTimers();
    this.watchAuth();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    const problem = insecureUrlProblem(this.url);
    if (problem) {
      this.setConn({ status: 'error', lastMessageAt: this.conn.lastMessageAt, detail: problem });
      return;
    }
    this.setConn({ status: 'connecting', lastMessageAt: this.conn.lastMessageAt, detail: null });
    const gen = ++this.generation;
    void this.getToken().then((token) => {
      if (gen !== this.generation || !this.wanted) return;
      this.lastToken = token;
      this.open(withToken(this.url, token));
    });
  }

  private open(url: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.setConn({ status: 'error', lastMessageAt: this.conn.lastMessageAt, detail: e instanceof Error ? e.message : 'Bad WebSocket URL.' });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.setConn({ status: 'connected', lastMessageAt: this.conn.lastMessageAt, detail: 'Connected to the robot backend.' });
      // Keeps proxies from closing an idle connection.
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return; // not JSON (e.g. "pong")
      }
      const t = parseTelemetry(payload, ROBOT_ID);
      if (!t) return;
      // Freshness uses the arrival time, so a wrong robot clock cannot fake "live".
      this.setConn({ status: 'connected', lastMessageAt: new Date().toISOString(), detail: null });
      this.telemetryListeners.forEach((fn) => fn(t));
    };
    ws.onerror = () => {
      this.setConn({ status: 'error', lastMessageAt: this.conn.lastMessageAt, detail: 'Cannot reach the robot backend.' });
    };
    ws.onclose = () => {
      this.ws = null;
      this.clearTimers();
      if (!this.wanted) return;
      if (this.conn.status !== 'error') this.setConn({ status: 'disconnected', lastMessageAt: this.conn.lastMessageAt, detail: 'Reconnecting…' });
      this.retryTimer = window.setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
    };
  }

  disconnect(): void {
    this.wanted = false;
    this.generation++;
    this.clearTimers();
    this.authSub?.unsubscribe();
    this.authSub = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
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
