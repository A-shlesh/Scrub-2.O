import { describe, expect, it } from 'vitest';
import {
  addPoint,
  bearing,
  extrapolate,
  commit,
  FALLBACK_DEMO_DEFAULTS,
  isDemoName,
  movePoint,
  newHistory,
  nextDemoNumber,
  PACKET_S,
  planAmount,
  planSteps,
  poseAt,
  redo,
  removePoint,
  segmentLengths,
  simulate,
  snap,
  START,
  toLatLon,
  toMetres,
  totalLength,
  totalSeconds,
  turnDelta,
  undo,
  validatePath,
} from './demoPath';
import type { DemoPoint, DemoSettings } from './demoPath';

const S: DemoSettings = { drive_mps_per_power: 0.004, turn_dps_per_power: 0.5, max_power: 200, start_heading_deg: 0 };
const P = (x_m: number, y_m: number): DemoPoint => ({ x_m, y_m });

describe('path editing', () => {
  it('adds, moves and removes points; the start stays fixed at 0,0', () => {
    let path = addPoint([], P(5, 0));
    expect(path).toEqual([START, P(5, 0)]);
    path = addPoint(path, P(5, 3));
    expect(movePoint(path, 2, P(6, 3))[2]).toEqual(P(6, 3));
    expect(movePoint(path, 0, P(1, 1))).toBe(path); // start cannot move
    expect(removePoint(path, 1)).toEqual([START, P(5, 3)]);
    expect(removePoint(path, 0)).toBe(path); // start cannot be removed
    expect(snap(P(1.26, -0.74), 0.5)).toEqual(P(1.5, -0.5));
  });

  it('undo / redo', () => {
    let h = newHistory();
    h = commit(h, addPoint(h.present, P(5, 0)));
    h = commit(h, addPoint(h.present, P(5, 3)));
    expect(h.present).toHaveLength(3);
    h = undo(h);
    expect(h.present).toHaveLength(2);
    h = redo(h);
    expect(h.present).toHaveLength(3);
    h = undo(undo(undo(h)));
    expect(h.present).toEqual([START]);
    expect(undo(h)).toBe(h);
  });

  it('lengths and limits', () => {
    const L = [START, P(5, 0), P(5, 3)];
    expect(segmentLengths(L)).toEqual([5, 3]);
    expect(totalLength(L)).toBe(8);
    expect(validatePath(L, FALLBACK_DEMO_DEFAULTS)).toEqual([]);
    expect(validatePath([START], FALLBACK_DEMO_DEFAULTS).join()).toMatch(/at least one point/);
    expect(validatePath([START, P(0.2, 0)], FALLBACK_DEMO_DEFAULTS).join()).toMatch(/shorter than 0.5 m/);
    expect(validatePath([START, P(200, 0), P(200, 200)], FALLBACK_DEMO_DEFAULTS).join()).toMatch(/limit is 300 m/);
    const many = [START, ...Array.from({ length: 60 }, (_, i) => P(i + 1, 0))];
    expect(validatePath(many, FALLBACK_DEMO_DEFAULTS).join()).toMatch(/At most 50 points/);
  });
});

describe('metres <-> lat/lon', () => {
  it('round-trips exactly around the virtual origin', () => {
    const o = { lat: 12.9716, lon: 77.5946 };
    for (const p of [P(0, 0), P(5, 0), P(-12.25, 33.5), P(250, -120)]) {
      const back = toMetres(toLatLon(p, o), o);
      expect(back.x_m).toBeCloseTo(p.x_m, 6);
      expect(back.y_m).toBeCloseTo(p.y_m, 6);
    }
    // 7-decimal rounding (as sent in the payload) stays within 1 cm.
    const ll = toLatLon(P(5, 3), o);
    const r = toMetres({ lat: Number(ll.lat.toFixed(7)), lon: Number(ll.lon.toFixed(7)) }, o);
    expect(Math.hypot(r.x_m - 5, r.y_m - 3)).toBeLessThan(0.01);
  });
});

describe('motor model and steps (same as the Pi)', () => {
  it('bearings and shortest turns', () => {
    expect(bearing(START, P(0, 1))).toBe(0);
    expect(bearing(START, P(1, 0))).toBe(90);
    expect(bearing(START, P(-1, 0))).toBe(270);
    expect(turnDelta(0, 90)).toBe(90);
    expect(turnDelta(0, 270)).toBe(-90);
    expect(turnDelta(350, 10)).toBe(20);
    expect(turnDelta(0, 180)).toBe(180);
  });

  it('plans whole packets and re-solves the power, never above max power', () => {
    // 5 m at 0.004 m/s per power, max 200: 6.25 s -> 3 packets, power 5 / (0.004 * 6) = 208 > 200 -> 4 packets
    const d = planAmount(5, 0.004, 200);
    expect(d.packets).toBe(4);
    expect(d.power).toBeCloseTo(156.25, 6);
    expect(0.004 * d.power * d.packets * PACKET_S).toBeCloseTo(5, 9);
    const t = planAmount(90, 0.5, 200); // 0.9 s -> 1 packet at 90 power
    expect(t).toEqual({ packets: 1, power: 90 });
    expect(planAmount(0, 0.004, 200)).toEqual({ packets: 0, power: 0 });
  });

  it('turns in place (equal and opposite power) then drives straight', () => {
    const steps = planSteps([START, P(5, 0), P(5, 3)], S);
    expect(steps.map((s) => s.kind)).toEqual(['TURN', 'SETTLE', 'DRIVE', 'SETTLE', 'TURN', 'SETTLE', 'DRIVE']);
    const firstTurn = steps[0];
    expect(firstTurn.left).toBeGreaterThan(0); // clockwise (right) turn to face east
    expect(firstTurn.right).toBe(-firstTurn.left);
    const secondTurn = steps[4];
    expect(secondTurn.left).toBeLessThan(0); // east -> north is a left turn
    expect(steps[2].left).toBe(steps[2].right);
    expect(totalSeconds(steps) % PACKET_S).toBe(0);
  });

  it('the simulated pose reaches the last point of a square and an L path', () => {
    for (const path of [
      [START, P(0, 6), P(6, 6), P(6, 0), P(0, 0)],
      [START, P(5, 0), P(5, 3)],
    ]) {
      const frames = simulate(planSteps(path, S), S);
      const end = frames[frames.length - 1];
      const target = path[path.length - 1];
      expect(Math.hypot(end.x_m - target.x_m, end.y_m - target.y_m)).toBeLessThan(0.05);
    }
  });

  it('interpolates the pose between packets', () => {
    const frames = simulate(planSteps([START, P(0, 8)], S), S);
    const mid = poseAt(frames, frames[frames.length - 1].t / 2);
    expect(mid.x_m).toBeCloseTo(0, 6);
    expect(mid.y_m).toBeGreaterThan(0);
    expect(mid.y_m).toBeLessThan(8);
  });
});

describe('demo names', () => {
  it('next number is one past the highest "Demo N"', () => {
    expect(nextDemoNumber([])).toBe(1);
    expect(nextDemoNumber(['Demo 1', 'Demo 7', 'Kengeri Lake', 'Demo x', 'Demo 3'])).toBe(8);
    expect(isDemoName('Demo 4')).toBe(true);
    expect(isDemoName('Demo (not saved)')).toBe(true);
    expect(isDemoName('Demolition Pond')).toBe(false);
  });
});

describe('live motion between frames', () => {
  it('moves on with the commanded power but never past the target point or bearing', () => {
    const c = { drive_mps_per_power: 0.004, turn_dps_per_power: 0.5 };
    const p0 = { x_m: 0, y_m: 0, heading_deg: 0 };
    const half = extrapolate(p0, 100, 100, 1, c, P(0, 5), 'DRIVE');
    expect(half.y_m).toBeCloseTo(0.4, 6); // 0.004 * 100 m/s for 1 s
    const capped = extrapolate({ x_m: 0, y_m: 4.9, heading_deg: 0 }, 100, 100, 2, c, P(0, 5), 'DRIVE');
    expect(capped).toEqual({ x_m: 0, y_m: 5, heading_deg: 0 });
    const turn = extrapolate(p0, 200, -200, 2, c, P(5, 0), 'TURN'); // 200 deg/s would overshoot 90
    expect(turn.heading_deg).toBe(90);
    expect(turn.x_m).toBe(0);
    expect(extrapolate(p0, 0, 0, 2, c, P(0, 5), 'SETTLE')).toBe(p0);
    expect(extrapolate(p0, 100, 100, 10, c, P(0, 50), 'DRIVE').y_m).toBeCloseTo(0.8, 6); // at most one packet
  });
});
