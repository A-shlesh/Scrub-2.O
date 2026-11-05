import { describe, expect, it } from 'vitest';
import { planMissionRoute } from './coverage';
import { pathLengthM, pointInPolygon, shoreCrossings } from './geo';
import type { LatLon } from '../types';

const M = 111_320;
/** Point `dx` m east and `dy` m north of (12.97, 77.59). */
const at = (dx: number, dy: number): LatLon => ({ lat: 12.97 + dy / M, lon: 77.59 + dx / (M * Math.cos((12.97 * Math.PI) / 180)) });
const rect = (x0: number, y0: number, x1: number, y1: number): LatLon[] => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];

const inWater = (p: LatLon, outer: LatLon[], holes: LatLon[][] = []) => pointInPolygon(p, outer) && !holes.some((h) => pointInPolygon(p, h));

/** Every leg (except legs touching the GCS) stays in the water. */
function legsInWater(path: LatLon[], kinds: string[], outer: LatLon[], holes: LatLon[][] = []) {
  for (let i = 1; i < path.length; i++) {
    if (kinds[i] === 'GCS' || kinds[i - 1] === 'GCS') continue;
    const c = shoreCrossings(path[i - 1], path[i], outer, holes);
    expect(c.shore + c.islands, `leg ${i}`).toBe(0);
  }
}

describe('planMissionRoute', () => {
  const lake = rect(0, 0, 400, 100); // long east-west lake

  it('zigzags along the long axis, alternating direction, inside the polygon', () => {
    const r = planMissionRoute({ boundary: lake, spacingM: 20 });
    expect(r.error).toBeNull();
    expect(r.sweeps).toBe(5); // lines at 10, 30, 50, 70, 90 m
    expect(r.path).toHaveLength(10);
    expect(r.kinds.every((k) => k === 'COVERAGE')).toBe(true);
    for (const p of r.path) expect(inWater(p, lake)).toBe(true);
    // Sweeps alternate: west->east, then east->west.
    expect(r.path[1].lon).toBeGreaterThan(r.path[0].lon);
    expect(r.path[3].lon).toBeLessThan(r.path[2].lon);
    // Sweep lines are `spacing` apart.
    expect(Math.abs(r.path[2].lat - r.path[0].lat) * M).toBeCloseTo(20, 3);
  });

  it('is deterministic', () => {
    const a = planMissionRoute({ boundary: lake, spacingM: 15, gcs: at(-30, 50) });
    const b = planMissionRoute({ boundary: lake, spacingM: 15, gcs: at(-30, 50) });
    expect(a).toEqual(b);
  });

  it('keeps the shore margin at sweep ends', () => {
    const r = planMissionRoute({ boundary: lake, spacingM: 20, marginM: 10 });
    const westmost = Math.min(...r.path.map((p) => p.lon));
    expect((westmost - lake[0].lon) * M * Math.cos((12.97 * Math.PI) / 180)).toBeCloseTo(10, 3);
  });

  it('starts and ends at the GCS and enters at the nearest end', () => {
    const gcs = at(420, 95); // east bank, north end
    const r = planMissionRoute({ boundary: lake, spacingM: 20, gcs });
    expect(r.kinds[0]).toBe('GCS');
    expect(r.kinds[r.kinds.length - 1]).toBe('GCS');
    expect(r.path[0]).toEqual(gcs);
    expect(r.path[r.path.length - 1]).toEqual(gcs);
    const first = r.path[1];
    expect(first.lon).toBeGreaterThan(at(300, 0).lon);
    expect(first.lat).toBeGreaterThan(at(0, 80).lat);
    expect(r.returnLeg?.[r.returnLeg.length - 1]).toEqual(gcs);
    expect(r.warnings).toEqual([]);
  });

  it('covers a concave (U-shaped) lake without crossing land', () => {
    // U shape: two arms joined at the south, land in between.
    const u = [at(0, 0), at(300, 0), at(300, 300), at(200, 300), at(200, 100), at(100, 100), at(100, 300), at(0, 300)];
    const r = planMissionRoute({ boundary: u, spacingM: 20 });
    expect(r.error).toBeNull();
    expect(r.blocked).toEqual([]);
    for (const p of r.path) expect(inWater(p, u)).toBe(true);
    legsInWater(r.path, r.kinds, u);
    // Both arms are covered.
    expect(r.path.some((p) => p.lat > at(0, 250).lat && p.lon < at(100, 0).lon)).toBe(true);
    expect(r.path.some((p) => p.lat > at(0, 250).lat && p.lon > at(200, 0).lon)).toBe(true);
  });

  it('goes around an island', () => {
    const big = rect(0, 0, 300, 300);
    const island = rect(120, 120, 180, 180);
    const r = planMissionRoute({ boundary: big, holes: [island], spacingM: 20 });
    expect(r.error).toBeNull();
    expect(r.blocked).toEqual([]);
    for (const p of r.path) expect(inWater(p, big, [island])).toBe(true);
    legsInWater(r.path, r.kinds, big, [island]);
  });

  it('routes the trip home through the water when the straight line would cross an island', () => {
    // Three sweeps (y = 10, 30, 50) end on the east side; a small island between the
    // sweeps sits on the straight line from there back to the GCS in the south-west.
    const big = rect(0, 0, 300, 60);
    const island = rect(140, 12, 160, 28);
    const gcs = at(-20, 0);
    const r = planMissionRoute({ boundary: big, holes: [island], spacingM: 20, gcs });
    expect(r.error).toBeNull();
    expect(r.blocked).toEqual([]);
    // The coverage ends east of the island, so the robot needs a detour home.
    expect(r.kinds.filter((k) => k === 'TRANSIT').length).toBeGreaterThan(0);
    expect(r.returnLeg!.length).toBeGreaterThan(2);
    legsInWater(r.path, r.kinds, big, [island]);
    const last = r.path[r.path.length - 2];
    const c = shoreCrossings(last, gcs, big, [island]);
    expect(c.islands).toBe(0);
    expect(c.shore).toBeLessThanOrEqual(1);
  });

  it('warns when the GCS cannot reach the water directly', () => {
    const big = rect(0, 0, 300, 300);
    const island = rect(100, 100, 200, 200);
    const gcs = at(150, 150); // on the island
    const r = planMissionRoute({ boundary: big, holes: [island], spacingM: 25, gcs });
    expect(r.warnings.join(' ')).toMatch(/GCS/);
  });

  it('rejects invalid polygons and settings', () => {
    expect(planMissionRoute({ boundary: null, spacingM: 10 }).error).toMatch(/at least 3/);
    expect(planMissionRoute({ boundary: [at(0, 0), at(10, 0)], spacingM: 10 }).error).toMatch(/at least 3/);
    const bowtie = [at(0, 0), at(100, 100), at(100, 0), at(0, 100)];
    expect(planMissionRoute({ boundary: bowtie, spacingM: 10 }).error).toMatch(/crosses itself/);
    expect(planMissionRoute({ boundary: lake, spacingM: 0 }).error).toMatch(/spacing/);
    expect(planMissionRoute({ boundary: rect(0, 0, 100000, 100000), spacingM: 1 }).error).toMatch(/sweeps/);
    expect(planMissionRoute({ boundary: rect(0, 0, 20, 20), spacingM: 5, marginM: 15 }).error).toMatch(/No water/);
    expect(planMissionRoute({ boundary: [at(0, 0), at(10, 0), at(20, 0)], spacingM: 5 }).error).toMatch(/no area/);
  });

  it('total route length is sweeps x length plus turns', () => {
    const r = planMissionRoute({ boundary: lake, spacingM: 20 });
    expect(pathLengthM(r.path)).toBeCloseTo(5 * (400 - 2) + 4 * 20, 0);
  });
});
