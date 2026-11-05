/**
 * Raspberry Pi backend (REST + WebSocket). When VITE_API_BASE_URL is set the dashboard
 * talks to the Pi directly; otherwise it uses the Supabase command table.
 * Protocol: docs/robot-protocol.md.
 */
const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** e.g. https://scrub-pi.example.com — no trailing slash. Empty when not configured. */
export const API_BASE_URL = trimSlash((import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '');

/** e.g. wss://scrub-pi.example.com — defaults to the API URL with ws(s):// when only that is set. */
export const WS_BASE_URL = trimSlash(
  (import.meta.env.VITE_WS_BASE_URL as string | undefined)?.trim() || API_BASE_URL.replace(/^http(s?):\/\//i, 'ws$1://'),
);

export const apiConfigured = API_BASE_URL !== '';
export const wsConfigured = WS_BASE_URL !== '';

/**
 * A reason the browser will refuse this backend URL, or null. A page served over
 * HTTPS (Vercel) may only call https:// and wss:// addresses.
 */
export function insecureUrlProblem(url: string, pageProtocol: string = typeof window !== 'undefined' ? window.location.protocol : 'https:'): string | null {
  if (pageProtocol !== 'https:') return null;
  if (/^(http|ws):\/\//i.test(url)) return `The dashboard is served over HTTPS, so ${url} must use https:// or wss://.`;
  return null;
}
