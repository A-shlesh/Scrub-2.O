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
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
