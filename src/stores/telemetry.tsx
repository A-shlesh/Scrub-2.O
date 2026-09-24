import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConnectionState, Telemetry } from '../types';
import { NullRealtimeService, staleAfterMs } from '../services/realtime/realtimeService';
import type { RealtimeService } from '../services/realtime/realtimeService';
import { DEMO, DemoRealtimeService } from '../demo/demo';

interface TelemetryCtx {
  telemetry: Telemetry | null;
  connection: ConnectionState;
  /** true when connected AND a fresh packet arrived within the stale window */
  live: boolean;
  reconnect: () => void;
}

const Ctx = createContext<TelemetryCtx>({
  telemetry: null,
  connection: { status: 'disconnected', lastMessageAt: null, detail: null },
  live: false,
  reconnect: () => undefined,
});

// Single shared instance while AWS IoT Core is unimplemented.
// VITE_DEMO=1 swaps in synthetic telemetry for design review only.
const service: RealtimeService = DEMO ? new DemoRealtimeService() : new NullRealtimeService();

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(() => service.getConnection());
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const offT = service.onTelemetry(setTelemetry);
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
      reconnect: () => service.connect(),
    }),
    [telemetry, effective, live],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTelemetry(): TelemetryCtx {
  return useContext(Ctx);
}
