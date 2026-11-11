import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConnectionState, LatLon, Telemetry } from '../types';
import { NullRealtimeService, staleAfterMs } from '../services/realtime/realtimeService';
import type { RealtimeService } from '../services/realtime/realtimeService';
import { DEMO, DemoRealtimeService } from '../demo/demo';
import { SupabaseRealtimeService } from '../services/realtime/supabaseRealtimeService';
import { supabaseConfigured } from '../services/supabase/supabaseClient';
import { WebSocketRealtimeService } from '../services/realtime/wsRealtimeService';
import { wsConfigured } from '../config/backend';

interface TelemetryCtx {
  telemetry: Telemetry | null;
  connection: ConnectionState;
  /** true when connected AND a fresh packet arrived within the stale window */
  live: boolean;
  /** recent GPS positions of the robot (this session, oldest first) */
  trail: LatLon[];
  /** where live telemetry comes from */
  source: 'pi' | 'supabase' | 'demo' | 'none';
  reconnect: () => void;
}

const Ctx = createContext<TelemetryCtx>({
  telemetry: null,
  connection: { status: 'disconnected', lastMessageAt: null, detail: null },
  live: false,
  trail: [],
  source: 'none',
  reconnect: () => undefined,
});

/** Positions kept for the live track on the maps. */
const TRAIL_MAX = 600;

// Single shared instance. Default: the Pi's WebSocket (VITE_WS_BASE_URL, or VITE_API_BASE_URL
// with ws/wss). Supabase Realtime Broadcast only with VITE_TELEMETRY_SOURCE=supabase (the Pi
// does not broadcast there by default). VITE_DEMO=1 swaps in synthetic telemetry for design review.
const wantSupabase = (import.meta.env.VITE_TELEMETRY_SOURCE as string | undefined)?.trim().toLowerCase() === 'supabase';
const source: TelemetryCtx['source'] = DEMO
  ? 'demo'
  : wantSupabase
    ? supabaseConfigured
      ? 'supabase'
      : 'none'
    : wsConfigured
      ? 'pi'
      : 'none';
const service: RealtimeService =
  source === 'demo'
    ? new DemoRealtimeService()
    : source === 'pi'
      ? new WebSocketRealtimeService()
      : source === 'supabase'
        ? new SupabaseRealtimeService()
        : new NullRealtimeService();

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [trail, setTrail] = useState<LatLon[]>([]);
  const [connection, setConnection] = useState<ConnectionState>(() => service.getConnection());
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const offT = service.onTelemetry((t) => {
      setTelemetry(t);
      const { latitude: lat, longitude: lon } = t.gps;
      if (lat === null || lon === null) return;
      setTrail((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.lat === lat && last.lon === lon) return prev;
        const next = [...prev, { lat, lon }];
        return next.length > TRAIL_MAX ? next.slice(next.length - TRAIL_MAX) : next;
      });
    });
    const offC = service.onConnection(setConnection);
    service.connect();
    // Tick so the stale transition happens without new packets.
    timer.current = window.setInterval(() => setNow(Date.now()), 5000);
    return () => {
      offT();
      offC();
      if (timer.current !== null) window.clearInterval(timer.current);
      service.disconnect();
    };
  }, []);

  const live = useMemo(() => {
    if (connection.status !== 'connected' || !connection.lastMessageAt) return false;
    const age = now - new Date(connection.lastMessageAt).getTime();
    return Number.isFinite(age) && age <= staleAfterMs();
  }, [connection, now]);

  const effective: ConnectionState = useMemo(() => {
    if (connection.status === 'connected' && !live && connection.lastMessageAt) {
      return { ...connection, status: 'stale', detail: 'No recent telemetry — data may be outdated.' };
    }
    return connection;
  }, [connection, live]);

  const value = useMemo<TelemetryCtx>(
    () => ({
      telemetry,
      connection: effective,
      live,
      trail,
      source,
      reconnect: () => service.connect(),
    }),
    [telemetry, effective, live, trail],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTelemetry(): TelemetryCtx {
  return useContext(Ctx);
}
