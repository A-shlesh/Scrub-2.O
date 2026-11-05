/**
 * Global polygon coverage: a boustrophedon (zigzag / lawnmower) route over the
 * selected lake polygon, built directly from GPS coordinates. No grid is used.
 *
 * - Sweep lines run along the polygon's long axis, `spacingM` apart (the robot's
 *   effective cleaning width). Each sweep alternates direction.
 * - Concave shores and islands split a sweep line into several in-water stretches.
 *   Stretches that continue each other form one zigzag "block"; blocks are visited
 *   one after another, nearest first.
 * - Every leg that is not along a sweep (turns, block-to-block and return legs) is
 *   checked against the shore and islands. A leg that would cross land is replaced
 *   by the shortest in-water route around it (visibility graph over the shore's
 *   corners). Legs that cannot be routed are reported, never silently kept.
 * - The result is deterministic: the same polygon and settings give the same route.
 */
import type { LatLon } from '../types';
import { openRing, simplifyRing } from './geo';

export type WaypointKind = 'GCS' | 'COVERAGE' | 'TRANSIT';

export interface CoverageInput {
  boundary: LatLon[] | null;
  /** islands: the robot never enters them */
  holes?: LatLon[][];
  /** distance between sweep lines, metres (effective cleaning width) */
  spacingM: number;
  /** keep sweep ends at least this far (m) from the shore and islands */
  marginM?: number;
  /** ground control station: the route starts and ends here */
  gcs?: LatLon | null;
}

export interface MissionRoute {
  /** every waypoint in visiting order, GCS first and last when a GCS is set */
  path: LatLon[];
  /** parallel to `path` */
  kinds: WaypointKind[];
  /** coverage part (first to last sweep waypoint), for drawing */
  coverage: LatLon[];
  /** connections rerouted through the water (from, via..., to), for drawing */
  transits: LatLon[][];
  /** legs that cross land and could not be routed around */
  blocked: Array<[LatLon, LatLon]>;
  /** last coverage waypoint -> (in-water points) -> GCS, or null without a GCS */
  returnLeg: LatLon[] | null;
  sweeps: number;
  coverageWaypoints: number;
  /** problems the operator should fix (route still drawn) */
  warnings: string[];
  /** why no route could be made (route empty) */
  error: string | null;
}

export const MIN_SPACING_M = 0.5;
export const MAX_SWEEPS = 4000;
export const MAX_WAYPOINTS = 20000;
/** Sweep ends stay at least this far from the shore, even with no shore margin. */
export const MIN_END_CLEARANCE_M = 1;

const M_PER_DEG_LAT = 111_320;

type XY = [number, number];
interface Interval {
  v: number;
  u0: number;
  u1: number;
}

const EMPTY = (error: string | null, warnings: string[] = []): MissionRoute => ({
  path: [],
  kinds: [],
  coverage: [],
  transits: [],
  blocked: [],
  returnLeg: null,
  sweeps: 0,
  coverageWaypoints: 0,
  warnings,
  error,
});

// ── Local projection (metres), rotated so sweeps run along the long axis ──────

function makeProjection(ring: LatLon[]) {
  const ref = {
    lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length,
    lon: ring.reduce((s, p) => s + p.lon, 0) / ring.length,
  };
  const kx = M_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180);
  const xy = ring.map((p) => [(p.lon - ref.lon) * kx, (p.lat - ref.lat) * M_PER_DEG_LAT]);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of xy) {
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  let angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  // Near-axis-aligned lakes get exact east-west / north-south sweeps.
  const SNAP = Math.PI / 18;
  for (const s of [0, Math.PI / 2, -Math.PI / 2]) if (Math.abs(angle - s) < SNAP) angle = s;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    toUV(p: LatLon): XY {
      const x = (p.lon - ref.lon) * kx;
      const y = (p.lat - ref.lat) * M_PER_DEG_LAT;
      return [x * cos + y * sin, -x * sin + y * cos];
    },
    fromUV([u, v]: XY): LatLon {
      const x = u * cos - v * sin;
      const y = u * sin + v * cos;
      return { lat: ref.lat + y / M_PER_DEG_LAT, lon: ref.lon + x / kx };
    },
  };
}

// ── Planar geometry in UV ─────────────────────────────────────────────────────

function inRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const orient = (a: XY, b: XY, c: XY) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Proper crossing of segments a-b and c-d (touching at an end does not count). */
function crosses(a: XY, b: XY, c: XY, d: XY): boolean {
  if (Math.max(c[0], d[0]) < Math.min(a[0], b[0]) || Math.min(c[0], d[0]) > Math.max(a[0], b[0])) return false;
  if (Math.max(c[1], d[1]) < Math.min(a[1], b[1]) || Math.min(c[1], d[1]) > Math.max(a[1], b[1])) return false;
  const d1 = orient(a, b, c);
  const d2 = orient(a, b, d);
  const d3 = orient(c, d, a);
  const d4 = orient(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ringEdges(ring: XY[]): Array<[XY, XY]> {
  return ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as [XY, XY]);
}

/** True when the ring's edges cross each other (a figure-eight outline). */
function selfIntersects(ring: XY[]): boolean {
  const e = ringEdges(ring);
  for (let i = 0; i < e.length; i++) {
    for (let j = i + 2; j < e.length; j++) {
      if (i === 0 && j === e.length - 1) continue; // neighbours through the closing vertex
      if (crosses(e[i][0], e[i][1], e[j][0], e[j][1])) return true;
    }
  }
  return false;
}

function areaOf(ring: XY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

class Water {
  readonly edges: Array<[XY, XY]>;
  readonly shoreEdges: Array<[XY, XY]>;
  readonly islandEdges: Array<[XY, XY]>;

  constructor(
    readonly outer: XY[],
    readonly holes: XY[][],
  ) {
    this.shoreEdges = ringEdges(outer);
    this.islandEdges = holes.flatMap(ringEdges);
    this.edges = [...this.shoreEdges, ...this.islandEdges];
  }

  contains(p: XY): boolean {
    return inRing(p, this.outer) && !this.holes.some((h) => inRing(p, h));
  }

  /** The straight leg a-b stays in the water (both ends assumed in water). */
  clear(a: XY, b: XY): boolean {
    for (const [c, d] of this.edges) if (crosses(a, b, c, d)) return false;
    for (const t of [0.25, 0.5, 0.75]) {
      if (!this.contains([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
    }
    return true;
  }

  /** How often a-b crosses the shore and the islands. */
  crossings(a: XY, b: XY): { shore: number; islands: number } {
    let shore = 0;
    let islands = 0;
    for (const [c, d] of this.shoreEdges) if (crosses(a, b, c, d)) shore++;
    for (const [c, d] of this.islandEdges) if (crosses(a, b, c, d)) islands++;
    return { shore, islands };
  }

  /** In-water stretches of the line v = const, sorted by u. */
  intervalsAt(v: number): Array<[number, number]> {
    const us: number[] = [];
    for (const [a, b] of this.edges) {
      if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) {
        us.push(a[0] + ((v - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    us.sort((x, y) => x - y);
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < us.length; i += 2) out.push([us[i], us[i + 1]]);
    return out;
  }
}

/**
 * Shortest in-water routes between two points, through corners of the shore and the
 * islands moved slightly into the water. Leg checks always use the full outlines.
 */
class WaterRouter {
  private nodes: XY[] = [];
  private memo = new Map<number, boolean>();

  constructor(
    private water: Water,
    inset: number,
    outerXY: XY[],
    holesXY: XY[][],
  ) {
    const rings = [outerXY, ...holesXY];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const a = ring[(i - 1 + ring.length) % ring.length];
        const c = ring[(i + 1) % ring.length];
        const na = norm([a[0] - p[0], a[1] - p[1]]);
        const nc = norm([c[0] - p[0], c[1] - p[1]]);
        let bis: XY = [na[0] + nc[0], na[1] + nc[1]];
        if (Math.hypot(bis[0], bis[1]) < 1e-9) bis = [-na[1], na[0]];
        bis = norm(bis);
        for (const sgn of [1, -1]) {
          const q: XY = [p[0] + sgn * bis[0] * inset, p[1] + sgn * bis[1] * inset];
          if (water.contains(q)) {
            this.nodes.push(q);
            break;
          }
        }
      }
    }
  }

  private nodeClear(i: number, j: number): boolean {
    const key = i < j ? i * 100_000 + j : j * 100_000 + i;
    let v = this.memo.get(key);
    if (v === undefined) {
      v = this.water.clear(this.nodes[i], this.nodes[j]);
      this.memo.set(key, v);
    }
    return v;
  }

  /** Points to pass through between a and b ([] when the straight leg is clear), or null. */
  route(a: XY, b: XY): XY[] | null {
    if (this.water.clear(a, b)) return [];
    const n = this.nodes.length;
    const A = n;
    const B = n + 1;
    const pos = (k: number): XY => (k === A ? a : k === B ? b : this.nodes[k]);
    const dist = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const clearTo = (k: number, m: number): boolean => {
      if (k < n && m < n) return this.nodeClear(k, m);
      return this.water.clear(pos(k), pos(m));
    };
    const g = new Map<number, number>([[A, 0]]);
    const prev = new Map<number, number>();
    const open = new Set<number>([A]);
    const closed = new Set<number>();
    while (open.size > 0) {
      let cur = -1;
      let best = Infinity;
      for (const k of open) {
        const f = (g.get(k) ?? Infinity) + dist(pos(k), b);
        if (f < best || (f === best && k < cur)) {
          best = f;
          cur = k;
        }
      }
      if (cur === B) break;
      open.delete(cur);
      closed.add(cur);
      const gc = g.get(cur) ?? Infinity;
      for (let m = 0; m <= B; m++) {
        if (m === cur || m === A || closed.has(m)) continue;
        const nd = gc + dist(pos(cur), pos(m));
        if (nd >= (g.get(m) ?? Infinity)) continue;
        if (!clearTo(cur, m)) continue;
        g.set(m, nd);
        prev.set(m, cur);
        open.add(m);
      }
    }
    if (!prev.has(B)) return null;
    const chain: number[] = [];
    for (let k = prev.get(B) as number; k !== A; k = prev.get(k) as number) chain.push(k);
    return chain.reverse().map((k) => this.nodes[k]);
  }
}

function norm(p: XY): XY {
  const l = Math.hypot(p[0], p[1]);
  return l === 0 ? [0, 0] : [p[0] / l, p[1] / l];
}

// ── Planner ───────────────────────────────────────────────────────────────────

/** Split sweep stretches into zigzag blocks: a stretch continues a block when it overlaps exactly one stretch of the row before, and that one overlaps only it. */
function decompose(rows: Interval[][]): Interval[][] {
  const blocks: Interval[][] = [];
  let prev: Array<{ iv: Interval; block: number }> = [];
  const overlap = (a: Interval, b: Interval) => a.u0 <= b.u1 && b.u0 <= a.u1;
  for (const row of rows) {
    const cur: Array<{ iv: Interval; block: number }> = [];
    for (const iv of row) {
      const over = prev.filter((p) => overlap(p.iv, iv));
      let block = -1;
      if (over.length === 1 && row.filter((o) => overlap(o, over[0].iv)).length === 1) block = over[0].block;
      if (block < 0) {
        blocks.push([]);
        block = blocks.length - 1;
      }
      blocks[block].push(iv);
      cur.push({ iv, block });
    }
    prev = cur;
  }
  return blocks;
}

/** Waypoints of one block, starting from the first or last row and in either direction. */
function blockPoints(block: Interval[], fromLast: boolean, leftFirst: boolean): XY[] {
  const rows = fromLast ? [...block].reverse() : block;
  const out: XY[] = [];
  rows.forEach((iv, j) => {
    const ltr = leftFirst === (j % 2 === 0);
    const a: XY = [ltr ? iv.u0 : iv.u1, iv.v];
    const b: XY = [ltr ? iv.u1 : iv.u0, iv.v];
    out.push(a);
    if (Math.abs(iv.u1 - iv.u0) > 1e-6) out.push(b);
  });
  return out;
}

/**
 * Plan the full mission route: GCS -> zigzag coverage of the polygon -> GCS.
 * Without a GCS only the coverage part is returned.
 */
export function planMissionRoute(input: CoverageInput): MissionRoute {
  const raw = input.boundary ? openRing(input.boundary) : [];
  if (raw.length < 3) return EMPTY('Draw a lake polygon with at least 3 points.');
  if (raw.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180)) {
    return EMPTY('The lake polygon has an invalid coordinate.');
  }
  const spacing = input.spacingM;
  if (!(spacing >= MIN_SPACING_M)) return EMPTY(`Sweep spacing must be at least ${MIN_SPACING_M} m.`);
  const margin = Math.max(0, input.marginM ?? 0);

  const proj = makeProjection(raw);
  const outer = raw.map(proj.toUV);
  if (selfIntersects(outer)) return EMPTY('The lake polygon crosses itself. Fix the outline in the Observatory.');
  if (areaOf(outer) < 1) return EMPTY('The lake polygon has no area.');
  const holes = (input.holes ?? []).map(openRing).filter((h) => h.length >= 3).map((h) => h.map(proj.toUV));
  const water = new Water(outer, holes);

  // Sweep lines.
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [, v] of outer) {
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const off = Math.max(spacing / 2, margin);
  const lines: number[] = [];
  if (vMax - vMin <= 2 * off) {
    lines.push((vMin + vMax) / 2);
  } else {
    const count = Math.floor((vMax - off - (vMin + off)) / spacing + 1e-9) + 1;
    if (count > MAX_SWEEPS) {
      return EMPTY(`This needs ${count} sweeps, more than ${MAX_SWEEPS}. Increase the sweep spacing.`);
    }
    for (let k = 0; k < count; k++) lines.push(vMin + off + k * spacing);
  }

  // Sweep ends never sit exactly on the shore.
  const trim = Math.max(margin, MIN_END_CLEARANCE_M);
  const rows: Interval[][] = lines.map((v) =>
    water
      .intervalsAt(v)
      .map(([u0, u1]) => ({ v, u0: u0 + trim, u1: u1 - trim }))
      .filter((iv) => iv.u1 >= iv.u0),
  );
  // Empty rows stay in, so blocks never join across a strip of land.
  const blocks = decompose(rows);
  if (blocks.length === 0) {
    return EMPTY('No water is left to cover. Reduce the shore margin or the sweep spacing.');
  }

  const inset = Math.max(1.5, Math.min(margin, spacing / 2));
  const simplified = simplifyRing(raw, 150).map(proj.toUV);
  const simplifiedHoles = (input.holes ?? []).map((h) => simplifyRing(h, 40)).filter((h) => h.length >= 3).map((h) => h.map(proj.toUV));
  const router = new WaterRouter(water, inset, simplified, simplifiedHoles);

  const gcsUV = input.gcs ? proj.toUV(input.gcs) : null;
  const pathUV: XY[] = [];
  const kinds: WaypointKind[] = [];
  const transits: XY[][] = [];
  const blocked: Array<[XY, XY]> = [];

  /** Append `to`, routing through the water when the leg from the last point would cross land. */
  const connect = (to: XY, kind: WaypointKind) => {
    const from = pathUV[pathUV.length - 1];
    if (from) {
      const via = router.route(from, to);
      if (via === null) blocked.push([from, to]);
      else if (via.length > 0) {
        for (const p of via) {
          pathUV.push(p);
          kinds.push('TRANSIT');
        }
        transits.push([from, ...via, to]);
      }
    }
    pathUV.push(to);
    kinds.push(kind);
  };

  // Visit blocks nearest-first from the GCS (or from the first block).
  const left = new Set(blocks.map((_, i) => i));
  let here: XY | null = gcsUV;
  while (left.size > 0) {
    let pick = { i: -1, fromLast: false, leftFirst: true, d: Infinity };
    for (const i of left) {
      for (const fromLast of [false, true]) {
        for (const leftFirst of [true, false]) {
          const first = blockPoints(blocks[i], fromLast, leftFirst)[0];
          const d = here ? Math.hypot(first[0] - here[0], first[1] - here[1]) : i;
          if (d < pick.d) pick = { i, fromLast, leftFirst, d };
        }
      }
    }
    left.delete(pick.i);
    for (const p of blockPoints(blocks[pick.i], pick.fromLast, pick.leftFirst)) connect(p, 'COVERAGE');
    here = pathUV[pathUV.length - 1];
    if (pathUV.length > MAX_WAYPOINTS) {
      return EMPTY(`The route has more than ${MAX_WAYPOINTS} waypoints. Increase the sweep spacing.`);
    }
  }

  const coverageWaypoints = kinds.filter((k) => k === 'COVERAGE').length;
  const coverageUV = [...pathUV];
  const warnings: string[] = [];
  let returnLegUV: XY[] | null = null;

  if (gcsUV) {
    const entry = pathUV[0];
    const last = pathUV[pathUV.length - 1];
    const out = water.crossings(gcsUV, entry);
    if (out.shore > 1 || out.islands > 0) {
      warnings.push('The straight line from the GCS to the first waypoint crosses land. Move the GCS so the robot can reach the water directly.');
    }
    const back = water.crossings(last, gcsUV);
    returnLegUV = [last, gcsUV];
    if (pathUV.length > 1 && (back.shore > 1 || back.islands > 0)) {
      // Go back through the water to where the robot entered, then leave the way it came in.
      const via = router.route(last, entry);
      if (via === null) {
        warnings.push('The trip back to the GCS crosses land and no route through the water was found.');
      } else {
        for (const p of [...via, entry]) {
          pathUV.push(p);
          kinds.push('TRANSIT');
        }
        returnLegUV = [last, ...via, entry, gcsUV];
      }
    }
    pathUV.unshift(gcsUV);
    kinds.unshift('GCS');
    pathUV.push(gcsUV);
    kinds.push('GCS');
  }

  if (blocked.length > 0) {
    warnings.push(`${blocked.length} leg${blocked.length === 1 ? ' crosses' : 's cross'} land and could not be routed through the water.`);
  }

  const toLL = (pts: XY[]) => pts.map(proj.fromUV);
  // The GCS itself is returned exactly as given (no projection round-off).
  const path = pathUV.map((p, i) => (kinds[i] === 'GCS' && input.gcs ? { lat: input.gcs.lat, lon: input.gcs.lon } : proj.fromUV(p)));
  return {
    path,
    kinds,
    coverage: toLL(coverageUV),
    transits: transits.map(toLL),
    blocked: blocked.map(([a, b]) => [proj.fromUV(a), proj.fromUV(b)] as [LatLon, LatLon]),
    returnLeg: returnLegUV ? returnLegUV.map((p, i, all) => (i === all.length - 1 && input.gcs ? { ...input.gcs } : proj.fromUV(p))) : null,
    sweeps: rows.filter((r) => r.length > 0).length,
    coverageWaypoints,
    warnings,
    error: null,
  };
}
