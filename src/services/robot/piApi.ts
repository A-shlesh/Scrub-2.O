/**
 * REST client for the Raspberry Pi backend (VITE_API_BASE_URL). Contract: docs/robot-protocol.md.
 *
 *   POST /api/missions                       mission payload -> load acknowledgement
 *   POST /api/missions/{id}/start|pause|resume|abort|return-home
 *   POST /api/emergency-stop
 *   GET  /api/missions/{id}                  robot-side mission state
 *   GET  /api/health
 *
 * The Pi answers a POST only after it has acted (for /api/missions: after the waypoints
 * are validated and committed to SQLite). An HTTP 2xx therefore means "done", a 4xx/5xx
 * means "refused" with a reason in `detail` (or `errors`, a list of strings).
 * Every request carries `Authorization: Bearer <Supabase access token>` when signed in.
 */
import { API_BASE_URL, insecureUrlProblem } from '../../config/backend';
import { supabase } from '../supabase/supabaseClient';
import type { RobotAnswer } from './robotLink';

export interface PiMissionStatus {
  missionId: string;
  state: string | null;
  currentWaypoint: number | null;
  totalWaypoints: number | null;
  completedWaypoints: number | null;
  detail: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function headers(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // Signed-in operators (VITE_REQUIRE_LOGIN=1) prove who they are to the Pi with their Supabase token.
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function url(path: string): string {
  if (!API_BASE_URL) throw new Error('The robot backend is not configured (VITE_API_BASE_URL).');
  const problem = insecureUrlProblem(API_BASE_URL);
  if (problem) throw new Error(problem);
  return `${API_BASE_URL}${path}`;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The backend's reason: `detail` first, then `errors` (list of strings), `message`, `error`. */
export function reason(body: Record<string, unknown> | null, fallback: string): string {
  const d = body?.detail;
  if (typeof d === 'string' && d.trim()) return d;
  // FastAPI validation errors: {"detail": [{"msg": "..."}]}
  if (Array.isArray(d) && d.length > 0 && typeof d[0]?.msg === 'string') return d.map((x: { msg: string }) => x.msg).join('; ');
  const errors = body?.errors;
  if (Array.isArray(errors)) {
    const list = errors.filter((e): e is string => typeof e === 'string' && e.trim() !== '');
    if (list.length > 0) return list.join('; ');
  }
  for (const k of ['message', 'error'] as const) {
    const v = body?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return fallback;
}

/** Refusal text for an HTTP error, with the special cases the operator needs to act on. */
export function refusal(status: number, path: string, body: Record<string, unknown> | null): string {
  if (status === 401 || status === 403) return 'Not signed in / not authorised for the robot.';
  if (status === 404 && path.endsWith('/return-home')) return 'Robot backend is too old (no return-home endpoint).';
  return reason(body, `HTTP ${status}`);
}

/** POST and turn the response into an answer. Network failures throw; a timeout is EXPIRED. */
export async function post(path: string, body: unknown, timeoutMs: number): Promise<RobotAnswer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url(path), { method: 'POST', headers: await headers(), body: JSON.stringify(body ?? {}), signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) {
      return { status: 'EXPIRED', detail: 'The robot backend did not answer in time. It may still carry out the command: check its state before retrying.', ack: null };
    }
    throw new Error(`Cannot reach the robot backend at ${API_BASE_URL}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  const json = await readJson(res);
  if (!res.ok) return { status: 'REJECTED', detail: refusal(res.status, path, json), ack: json, httpStatus: res.status };
  if (json?.ok === false || json?.status === 'REJECTED') {
    return { status: 'REJECTED', detail: reason(json, 'Refused by the robot.'), ack: json, httpStatus: res.status };
  }
  return { status: 'ACKED', detail: null, ack: json, httpStatus: res.status };
}

export async function getMissionStatus(missionId: string, timeoutMs = 8000): Promise<PiMissionStatus | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url(`/api/missions/${encodeURIComponent(missionId)}`), { headers: await headers(), signal: ctrl.signal });
    if (res.status === 404) return null;
    const json = await readJson(res);
    if (!res.ok || !json) throw new Error(refusal(res.status, '', json));
    return {
      missionId,
      state: typeof json.state === 'string' ? json.state : typeof json.status === 'string' ? json.status : null,
      currentWaypoint: num(json.current_waypoint) ?? num(json.current_waypoint_index),
      totalWaypoints: num(json.total_waypoints) ?? num(json.waypoint_count),
      completedWaypoints: num(json.completed_waypoints),
      detail: typeof json.detail === 'string' ? json.detail : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** True when the backend answers GET /api/health with 2xx. */
export async function health(timeoutMs = 5000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url('/api/health'), { headers: await headers(), signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
