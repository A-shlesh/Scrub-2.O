/**
 * Demo missions: the operator draws a path on a blank canvas (metres, x = east, y = north),
 * the Pi drives the motors along it open loop (no GPS / compass). Pure functions only:
 * path editing, limits, metres <-> lat/lon, and the motor model + step planner that
 * mirrors the Pi's DemoRunner (docs/robot-protocol.md, section 9).
 *
 * Heading: degrees, 0 = north = up on the canvas, clockwise positive.
 * Motor model: v = drive_mps_per_power * (L + R) / 2 [m/s];
 *              turn rate = turn_dps_per_power * (L - R) / 2 [deg/s] (left faster turns right).
 * One motor packet every 2 s, so every step lasts a whole number of packets.
 */
import type { LatLon } from '../types';

export interface DemoPoint {
  x_m: number;
  y_m: number;
}

export interface DemoCalibration {
  drive_mps_per_power: number;
  turn_dps_per_power: number;
}

/** What GET /api/demo/defaults returns (and the fallback when the Pi cannot be reached). */
export interface DemoDefaults extends DemoCalibration {
  max_power: number;
  max_path_m: number;
  max_points: number;
  min_segment_m: number;
  origin: LatLon;
}

export interface DemoSettings extends DemoCalibration {
  max_power: number;
  start_heading_deg: number;
}

export const PACKET_S = 2;
export const SETTLE_PACKETS = 1;
/** Hardware motor range (Pi -> STM32 packet "left"/"right": "-999".."+999"). */
export const MAX_MOTOR_POWER = 999;
const M_PER_DEG_LAT = 111_320;

function originFromEnv(): LatLon {
  const raw = (import.meta.env.VITE_DEMO_ORIGIN as string | undefined)?.trim();
  if (raw) {
    const [a, b] = raw.split(',').map((v) => Number(v.trim()));
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  }
  return { lat: 12.9716, lon: 77.5946 };
}

/** Used when the Pi's /api/demo/defaults cannot be reached. Same defaults as the Pi. */
export const FALLBACK_DEMO_DEFAULTS: DemoDefaults = {
  drive_mps_per_power: 0.004,
  turn_dps_per_power: 0.5,
  max_power: 200,
  max_path_m: 300,
  max_points: 50,
  min_segment_m: 0.5,
  origin: originFromEnv(),
};

export const START: DemoPoint = { x_m: 0, y_m: 0 };

// ── Editing (the start point, index 0, is fixed at 0,0) ─────────────────────

export const snap = (p: DemoPoint, step: number): DemoPoint =>
  step > 0 ? { x_m: Math.round(p.x_m / step) * step, y_m: Math.round(p.y_m / step) * step } : p;

export function addPoint(path: DemoPoint[], p: DemoPoint): DemoPoint[] {
  return [...(path.length === 0 ? [START] : path), p];
}

export function movePoint(path: DemoPoint[], index: number, p: DemoPoint): DemoPoint[] {
  if (index <= 0 || index >= path.length) return path;
  return path.map((q, i) => (i === index ? p : q));
}

export function removePoint(path: DemoPoint[], index: number): DemoPoint[] {
  if (index <= 0 || index >= path.length) return path;
  return path.filter((_, i) => i !== index);
}

/** Undo / redo history of paths. */
export interface PathHistory {
  past: DemoPoint[][];
  present: DemoPoint[];
  future: DemoPoint[][];
}

export const newHistory = (present: DemoPoint[] = [START]): PathHistory => ({ past: [], present, future: [] });

export function commit(h: PathHistory, next: DemoPoint[]): PathHistory {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-200), present: next, future: [] };
}

export const undo = (h: PathHistory): PathHistory =>
  h.past.length === 0 ? h : { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };

export const redo = (h: PathHistory): PathHistory =>
  h.future.length === 0 ? h : { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };

// ── Geometry and limits ─────────────────────────────────────────────────────

const dist = (a: DemoPoint, b: DemoPoint) => Math.hypot(b.x_m - a.x_m, b.y_m - a.y_m);

export function segmentLengths(path: DemoPoint[]): number[] {
  return path.slice(1).map((p, i) => dist(path[i], p));
}

export const totalLength = (path: DemoPoint[]) => segmentLengths(path).reduce((a, b) => a + b, 0);

/** Compass bearing from a to b: 0 = north (up), clockwise. */
export function bearing(a: DemoPoint, b: DemoPoint): number {
  const deg = (Math.atan2(b.x_m - a.x_m, b.y_m - a.y_m) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Shortest signed turn from heading `from` to `to`, in (-180, 180]. */
export function turnDelta(from: number, to: number): number {
  let d = (((to - from) % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Problems that stop the path from being sent (the Pi checks the same limits). */
export function validatePath(path: DemoPoint[], d: DemoDefaults): string[] {
  const out: string[] = [];
  if (path.length < 2) out.push('Add at least one point after the start.');
  if (path.length > d.max_points) out.push(`At most ${d.max_points} points (this path has ${path.length}).`);
  if (path.some((p) => !Number.isFinite(p.x_m) || !Number.isFinite(p.y_m))) out.push('A point has an invalid position.');
  const lens = segmentLengths(path);
  const short = lens.map((l, i) => (l < d.min_segment_m ? i + 1 : 0)).filter((i) => i > 0);
  if (short.length > 0) out.push(`Segment${short.length > 1 ? 's' : ''} ${short.join(', ')} shorter than ${d.min_segment_m} m.`);
  const total = lens.reduce((a, b) => a + b, 0);
  if (total > d.max_path_m) out.push(`The path is ${total.toFixed(1)} m long; the limit is ${d.max_path_m} m.`);
  if (path.some((p) => Math.hypot(p.x_m, p.y_m) > 500)) out.push('Keep every point within 500 m of the start.');
  return out;
}

// ── Metres <-> lat/lon around the virtual origin (exact inverses) ───────────

export function toLatLon(p: DemoPoint, origin: LatLon): LatLon {
  const kx = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return { lat: origin.lat + p.y_m / M_PER_DEG_LAT, lon: origin.lon + p.x_m / kx };
}

export function toMetres(ll: LatLon, origin: LatLon): DemoPoint {
  const kx = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return { x_m: (ll.lon - origin.lon) * kx, y_m: (ll.lat - origin.lat) * M_PER_DEG_LAT };
}

// ── Motor model and step planner (mirrors the Pi's DemoRunner) ──────────────

export type DemoStepKind = 'TURN' | 'DRIVE' | 'SETTLE';

export interface DemoStep {
  kind: DemoStepKind;
  /** index of the path segment (1 = start -> point 1) */
  segment: number;
  packets: number;
  left: number;
  right: number;
}

/**
 * Whole-packet duration and power for moving `amount` (m or deg) at `k` units per power
 * per second: n = max(1, round(t / 2 s)) at max power, then the power that covers
 * exactly `amount` in n packets; more packets if that power is above max power.
 */
export function planAmount(amount: number, k: number, maxPower: number): { packets: number; power: number } {
  const cap = Math.max(1, Math.min(maxPower, MAX_MOTOR_POWER));
  if (!(amount > 0) || !(k > 0)) return { packets: 0, power: 0 };
  let n = Math.max(1, Math.round(amount / (k * cap) / PACKET_S));
  let power = amount / (k * n * PACKET_S);
  while (power > cap) {
    n += 1;
    power = amount / (k * n * PACKET_S);
  }
  return { packets: n, power };
}

/** TURN (in place, shortest way) then DRIVE for each segment, with SETTLE packets between steps. */
export function planSteps(path: DemoPoint[], s: DemoSettings): DemoStep[] {
  const steps: DemoStep[] = [];
  let heading = s.start_heading_deg;
  const settle = (segment: number) => {
    if (SETTLE_PACKETS > 0) steps.push({ kind: 'SETTLE', segment, packets: SETTLE_PACKETS, left: 0, right: 0 });
  };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = dist(a, b);
    if (len < 1e-9) continue;
    const want = bearing(a, b);
    const delta = turnDelta(heading, want);
    if (Math.abs(delta) >= 0.5) {
      const t = planAmount(Math.abs(delta), s.turn_dps_per_power, s.max_power);
      const p = Math.sign(delta) * t.power;
      steps.push({ kind: 'TURN', segment: i, packets: t.packets, left: p, right: -p });
      settle(i);
    }
    heading = want;
    const d = planAmount(len, s.drive_mps_per_power, s.max_power);
    steps.push({ kind: 'DRIVE', segment: i, packets: d.packets, left: d.power, right: d.power });
    if (i < path.length - 1) settle(i);
  }
  return steps;
}

export interface DemoPose {
  x_m: number;
  y_m: number;
  heading_deg: number;
}

/** Pose after holding (left, right) for `seconds`, with the motor model. */
export function advancePose(p: DemoPose, left: number, right: number, seconds: number, c: DemoCalibration): DemoPose {
  const v = (c.drive_mps_per_power * (left + right)) / 2;
  const w = (c.turn_dps_per_power * (left - right)) / 2;
  const heading = p.heading_deg + w * seconds;
  // Turns are in place (v = 0) and drives straight (w = 0) by construction; integrate with the mid heading otherwise.
  const mid = ((p.heading_deg + heading) / 2) * (Math.PI / 180);
  return {
    x_m: p.x_m + v * seconds * Math.sin(mid),
    y_m: p.y_m + v * seconds * Math.cos(mid),
    heading_deg: ((heading % 360) + 360) % 360,
  };
}

export interface SimFrame extends DemoPose {
  /** seconds since the start */
  t: number;
  segment: number;
  step: DemoStepKind;
}

/** Pose after every packet (plus the start), as the Pi dead-reckons it. */
export function simulate(steps: DemoStep[], s: DemoSettings): SimFrame[] {
  let pose: DemoPose = { x_m: 0, y_m: 0, heading_deg: s.start_heading_deg };
  const frames: SimFrame[] = [{ ...pose, t: 0, segment: steps[0]?.segment ?? 1, step: steps[0]?.kind ?? 'SETTLE' }];
  let t = 0;
  for (const st of steps) {
    for (let k = 0; k < st.packets; k++) {
      pose = advancePose(pose, st.left, st.right, PACKET_S, s);
      t += PACKET_S;
      frames.push({ ...pose, t, segment: st.segment, step: st.kind });
    }
  }
  return frames;
}

export const totalSeconds = (steps: DemoStep[]) => steps.reduce((a, s) => a + s.packets * PACKET_S, 0);

/** Pose at time t (seconds) by linear interpolation between simulated frames. */
export function poseAt(frames: SimFrame[], t: number): SimFrame {
  if (frames.length === 0) return { x_m: 0, y_m: 0, heading_deg: 0, t: 0, segment: 1, step: 'SETTLE' };
  if (t <= frames[0].t) return frames[0];
  const last = frames[frames.length - 1];
  if (t >= last.t) return last;
  let i = 1;
  while (frames[i].t < t) i++;
  const a = frames[i - 1];
  const b = frames[i];
  const f = (t - a.t) / (b.t - a.t);
  const dh = turnDelta(a.heading_deg, b.heading_deg);
  return {
    x_m: a.x_m + (b.x_m - a.x_m) * f,
    y_m: a.y_m + (b.y_m - a.y_m) * f,
    heading_deg: (((a.heading_deg + dh * f) % 360) + 360) % 360,
    t,
    segment: b.segment,
    step: b.step,
  };
}

/**
 * Smooth live motion between the Pi's 2-second frames: move the last reported pose on
 * with the commanded (left, right) for `seconds` (at most one packet), but never past the
 * segment's target point (DRIVE) or the bearing to it (TURN).
 */
export function extrapolate(
  pose: DemoPose,
  left: number,
  right: number,
  seconds: number,
  c: DemoCalibration,
  target: DemoPoint | null,
  step: DemoStepKind | null,
): DemoPose {
  const dt = Math.max(0, Math.min(seconds, PACKET_S));
  if (dt === 0 || step === 'SETTLE' || (left === 0 && right === 0)) return pose;
  const next = advancePose(pose, left, right, dt, c);
  if (!target) return next;
  if (step === 'DRIVE') {
    const remaining = Math.hypot(target.x_m - pose.x_m, target.y_m - pose.y_m);
    const moved = Math.hypot(next.x_m - pose.x_m, next.y_m - pose.y_m);
    if (moved > remaining) return { x_m: target.x_m, y_m: target.y_m, heading_deg: pose.heading_deg };
    return next;
  }
  if (step === 'TURN') {
    const want = bearing(pose, target);
    const need = turnDelta(pose.heading_deg, want);
    const did = ((c.turn_dps_per_power * (left - right)) / 2) * dt; // raw rotation, not wrapped
    if (Math.sign(need) === Math.sign(did) && Math.abs(did) >= Math.abs(need)) return { ...pose, heading_deg: want };
    return { ...pose, heading_deg: next.heading_deg };
  }
  return next;
}

/** Next demo number: one past the highest "Demo N" name (N = 1 when there is none). */
export function nextDemoNumber(names: string[]): number {
  let max = 0;
  for (const n of names) {
    const m = /^Demo (\d+)$/.exec(n.trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export const isDemoName = (name: string | null | undefined) => !!name && /^Demo( \d+|\b)/.test(name);
