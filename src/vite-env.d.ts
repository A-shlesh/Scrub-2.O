/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" = synthetic telemetry, lakes and analytics for design review only. */
  readonly VITE_DEMO?: string;
  readonly VITE_ANALYTICS_API_BASE?: string;
  readonly VITE_TELEMETRY_STALE_AFTER_MS?: string;
  /** "lat,lon" the map opens on when no lake is selected (default Bengaluru) */
  readonly VITE_MAP_CENTER?: string;
  readonly VITE_MAP_ZOOM?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** robot this dashboard controls (default BOT001) */
  readonly VITE_ROBOT_ID?: string;
  /** robot cruise speed in m/s, for mission estimates (default 0.8) */
  readonly VITE_ROBOT_SPEED_MPS?: string;
  /** seconds the robot stops at each sampling cell (default 10) */
  readonly VITE_SAMPLE_SECONDS?: string;
  /** minutes of driving on a full battery (default 120) */
  readonly VITE_BATTERY_MINUTES?: string;
  /** "1" = operators must sign in (Supabase Auth) before using the dashboard */
  readonly VITE_REQUIRE_LOGIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
