import type { GridCell, LatLon } from '../types';

/** metres per degree of latitude (approx, sufficient for small lakes) */
const M_PER_DEG_LAT = 111_320;

function mPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Ray-cast point-in-polygon. Points on the edge count as inside. */
export function pointInPolygon(p: LatLon, polygon: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;
    const intersect =
      yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonBounds(points: LatLon[]): {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
} | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/** Above this many cells the grid is refused (keeps the map and planner responsive). */
export const MAX_GRID_CELLS = 50000;

/** Number of bounding-box rows x cols a boundary would need at this cell size. */
function gridDimensions(boundary: LatLon[], cellSizeM: number): { rows: number; cols: number } | null {
  const bounds = polygonBounds(boundary);
  if (!bounds || !(cellSizeM > 0)) return null;
  const lonScale = mPerDegLon((bounds.minLat + bounds.maxLat) / 2);
  if (lonScale <= 0) return null;
  return {
    cols: Math.max(1, Math.ceil(((bounds.maxLon - bounds.minLon) * lonScale) / cellSizeM)),
    rows: Math.max(1, Math.ceil(((bounds.maxLat - bounds.minLat) * M_PER_DEG_LAT) / cellSizeM)),
  };
}

/** True when this cell size would produce more than MAX_GRID_CELLS candidate cells. */
export function gridExceedsLimit(boundary: LatLon[], cellSizeM: number): boolean {
  const d = gridDimensions(boundary, cellSizeM);
  return d ? d.rows * d.cols > MAX_GRID_CELLS : false;
}

export interface GridOptions {
  /** islands: cells whose centre falls inside one are dropped */
  holes?: LatLon[][];
  /** drop cells whose centre is closer than this (metres) to the shore or an island */
  shoreMarginM?: number;
  /** 3-letter prefix for cell IDs, e.g. "SUN" → SUN1, SUN2, ... */
  lakePrefix?: string;
}

/** Closed ring -> metre-space segments [x1,y1,x2,y2] using the grid's own projection. */
function ringSegmentsM(ring: LatLon[], lonScale: number): number[][] {
  const pts = openRing(ring);
  const segs: number[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    segs.push([a.lon * lonScale, a.lat * M_PER_DEG_LAT, b.lon * lonScale, b.lat * M_PER_DEG_LAT]);
  }
  return segs;
}

/** Round up to one of a small set of "nice" cell sizes so the UI shows tidy numbers. */
const NICE_CELL_SIZES_M = [2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000];

function niceCellSize(raw: number): number {
  for (const s of NICE_CELL_SIZES_M) if (s >= raw) return s;
  return NICE_CELL_SIZES_M[NICE_CELL_SIZES_M.length - 1];
}

/**
 * Suggest a starting grid cell size (metres) for a newly added lake, so a
 * small pond doesn't default to 20 m cells (2-3 total, useless) and a large
 * reservoir doesn't default to a grid so fine it exceeds MAX_GRID_CELLS.
 * Aims for roughly `targetCells` sampling points, then nudges up if the
 * boundary's bounding box would still exceed the grid cap at that size
 * (e.g. a long thin inlet where area is small but the bbox is huge).
 */
export function suggestCellSizeM(boundary: LatLon[], targetCells = 250): number {
  const area = polygonAreaSqM(boundary);
  if (!area || area <= 0) return 20;
  const raw = Math.sqrt(area / targetCells);
  let size = niceCellSize(Math.max(2, raw));
  let i = NICE_CELL_SIZES_M.indexOf(size);
  while (gridExceedsLimit(boundary, size) && i < NICE_CELL_SIZES_M.length - 1) {
    i += 1;
    size = NICE_CELL_SIZES_M[i];
  }
  return size;
}

function distToSegSq(px: number, py: number, s: number[]): number {
  const dx = s[2] - s[0];
  const dy = s[3] - s[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - s[0]) * dx + (py - s[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = s[0] + t * dx;
  const cy = s[1] + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** Compute the rotation angle (radians) that aligns the grid with the boundary's principal axis. */
function principalAngle(boundary: LatLon[], lonScale: number): number {
  const pts = openRing(boundary);
  if (pts.length < 2) return 0;
  const cx = pts.reduce((s, p) => s + p.lon * lonScale, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.lat * M_PER_DEG_LAT, 0) / pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.lon * lonScale - cx;
    const dy = p.lat * M_PER_DEG_LAT - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Angle of the eigenvector for the largest eigenvalue of the 2x2 covariance matrix.
  let angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  // Snap to the nearest axis (0 or π/2) when the shape is nearly axis-aligned.
  // This avoids spurious ~π/2 rotations from floating-point noise on near-square polygons.
  const SNAP = Math.PI / 12; // 15°
  const snaps = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  for (const s of snaps) {
    if (Math.abs(angle - s) < SNAP || Math.abs(angle - s + 2 * Math.PI) < SNAP || Math.abs(angle - s - 2 * Math.PI) < SNAP) {
      return s;
    }
  }
  return angle;
}

function rotX(x: number, y: number, cos: number, sin: number): number {
  return x * cos + y * sin;
}
function rotY(x: number, y: number, cos: number, sin: number): number {
  return -x * sin + y * cos;
}

/**
 * Generate a sampling grid over a lake boundary.
 *
 * - The grid is auto-rotated to align with the boundary's longest axis, giving
 *   much better coverage for elongated or diagonally-oriented lakes.
 * - `cellSizeM` is a physical dimension in metres (user-configurable).
 * - Cells are kept when their centre is inside the boundary, outside every island,
 *   and at least `shoreMarginM` from any shore/island edge.
 * - Cell ids are stable row/col identifiers ("R{row}C{col}").
 */
export function generateGrid(boundary: LatLon[], cellSizeM: number, opts: GridOptions = {}): GridCell[] {
  const bounds = polygonBounds(boundary);
  if (!bounds || cellSizeM <= 0) return [];
  const refLat = (bounds.minLat + bounds.maxLat) / 2;
  const lonScale = mPerDegLon(refLat);
  if (lonScale <= 0) return [];

  // Rotation to align grid with the lake's principal axis.
  const rawAngle = principalAngle(boundary, lonScale);
  // Snap cos/sin to exact axis-aligned values to avoid floating-point drift on near-square polygons.
  let cos = Math.cos(rawAngle);
  let sin = Math.sin(rawAngle);
  const SNAP = 0.02;
  if (Math.abs(cos) < SNAP) cos = 0;
  if (Math.abs(sin) < SNAP) sin = 0;
  if (Math.abs(cos - 1) < SNAP) cos = 1;
  if (Math.abs(cos + 1) < SNAP) cos = -1;
  if (Math.abs(sin - 1) < SNAP) sin = 1;
  if (Math.abs(sin + 1) < SNAP) sin = -1;

  // Project boundary into rotated metre-space to find the bounding box.
  const openPts = openRing(boundary);
  let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
  for (const p of openPts) {
    const rx = rotX(p.lon * lonScale, p.lat * M_PER_DEG_LAT, cos, sin);
    const ry = rotY(p.lon * lonScale, p.lat * M_PER_DEG_LAT, cos, sin);
    if (rx < rMinX) rMinX = rx;
    if (rx > rMaxX) rMaxX = rx;
    if (ry < rMinY) rMinY = ry;
    if (ry > rMaxY) rMaxY = ry;
  }

  const cols = Math.max(1, Math.ceil((rMaxX - rMinX) / cellSizeM));
  const rows = Math.max(1, Math.ceil((rMaxY - rMinY) / cellSizeM));

  // Guard against pathological boundaries producing enormous grids.
  if (rows * cols > MAX_GRID_CELLS) return [];

  const holes = (opts.holes ?? []).filter((h) => h.length >= 3);
  const margin = Math.max(0, opts.shoreMarginM ?? 0);
  const marginSq = margin * margin;
  const segs = margin > 0 ? [boundary, ...holes].flatMap((r) => ringSegmentsM(r, lonScale)) : [];

  const toLatLon = (rx: number, ry: number): LatLon => {
    const x = rotX(rx, ry, cos, -sin);
    const y = rotY(rx, ry, cos, -sin);
    return { lat: y / M_PER_DEG_LAT, lon: x / lonScale };
  };

  const prefix = opts.lakePrefix ?? '';
  const cells: GridCell[] = [];
  let seq = 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const rx0 = rMinX + col * cellSizeM;
      const rx1 = Math.min(rx0 + cellSizeM, rMaxX);
      const ry0 = rMinY + row * cellSizeM;
      const ry1 = Math.min(ry0 + cellSizeM, rMaxY);
      const cx = (rx0 + rx1) / 2;
      const cy = (ry0 + ry1) / 2;
      const center = toLatLon(cx, cy);
      if (!pointInPolygon(center, boundary)) continue;
      if (holes.some((h) => pointInPolygon(center, h))) continue;
      if (margin > 0) {
        const ux = rotX(cx, cy, cos, -sin);
        const uy = rotY(cx, cy, cos, -sin);
        if (segs.some((sg) => distToSegSq(ux, uy, sg) < marginSq)) continue;
      }
      const corners = [toLatLon(rx0, ry0), toLatLon(rx1, ry0), toLatLon(rx1, ry1), toLatLon(rx0, ry1)];

      // A cell that touches an island at all is dropped rather than clipped: unlike the shoreline
      // below, there's no convex clip window to cut a hole-shaped bite out of a cell with
      // Sutherland-Hodgman. Checking only the cell's centre (as before) let a cell whose CORNERS
      // overlapped an island still render as a full, un-clipped rectangle over it.
      const touchesHole = holes.some(
        (h) => corners.some((c) => pointInPolygon(c, h)) || h.some((hv) => pointInPolygon(hv, corners)),
      );
      if (touchesHole) continue;

      const allCornersIn = corners.every((c) => pointInPolygon(c, boundary));
      // A cell fully inside the boundary and clear of every island keeps its plain
      // rectangle (cheap, and correct). A cell straddling the shore is clipped to the
      // boundary with real polygon clipping (Sutherland-Hodgman) instead of pulling each
      // corner independently toward the centre — the old per-corner approach let
      // neighbouring edge cells disagree about where the shore actually was, producing
      // overlapping slivers and stray triangles right at the waterline.
      let polygon = corners;
      if (!allCornersIn) {
                // The lake boundary can be concave, so it must be the SUBJECT here, not the
        // clip window — Sutherland-Hodgman only clips correctly against a CONVEX clip
        // polygon. The cell itself is always convex (rectangle, or a parallelogram
        // once the grid is rotated), so clip the boundary against the cell instead
        // of the other way around.
        const clipped = clipPolygonToBoundary(boundary, corners);
        polygon = clipped.length >= 3 ? clipped : corners;
      }
            // Zero-padded to 3 digits to match the schema's grid_code style (KNG001, SAM1001, ...).
      const id = prefix ? `${prefix}${String(seq).padStart(3, '0')}` : `R${row}C${col}`;
      cells.push({ id, row, col, polygon, center });
      seq++;
    }
  }
  return cells;
}

/** Drop the duplicated closing vertex OSM rings carry (first === last). */
export function openRing(points: LatLon[]): LatLon[] {
  if (points.length > 1) {
    const a = points[0];
    const b = points[points.length - 1];
    if (a.lat === b.lat && a.lon === b.lon) return points.slice(0, -1);
  }
  return points;
}

/** Signed area of a ring (positive = counter-clockwise in lat/lon). */
function signedArea(ring: LatLon[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p.lon * q.lat - q.lon * p.lat;
  }
  return a / 2;
}

/** Is point p on the inside side of the directed edge a→b? */
function isInsideEdge(p: LatLon, a: LatLon, b: LatLon, ccw: boolean): boolean {
  const cross = (b.lon - a.lon) * (p.lat - a.lat) - (b.lat - a.lat) * (p.lon - a.lon);
  return ccw ? cross >= 0 : cross <= 0;
}

/** Intersection of segment p1→p2 with the line through edge a→b. */
function intersectEdges(p1: LatLon, p2: LatLon, a: LatLon, b: LatLon): LatLon {
  const d1x = p2.lon - p1.lon, d1y = p2.lat - p1.lat;
  const d2x = b.lon - a.lon, d2y = b.lat - a.lat;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-14) return { lat: (p1.lat + p2.lat) / 2, lon: (p1.lon + p2.lon) / 2 };
  const t = ((a.lon - p1.lon) * d2y - (a.lat - p1.lat) * d2x) / denom;
  return { lat: p1.lat + t * d1y, lon: p1.lon + t * d1x };
}

/**
 * Sutherland-Hodgman polygon clipping: clip `subject` polygon to the inside of
 * every edge of `clip` polygon. Works for concave clip polygons too.
 * Returns the clipped polygon (may be empty if the subject is entirely outside).
 */
export function clipPolygonToBoundary(subject: LatLon[], clip: LatLon[]): LatLon[] {
  if (subject.length < 3 || clip.length < 3) return subject;
  const ccw = signedArea(clip) >= 0;
  let output = subject;
  for (let i = 0; i < clip.length; i++) {
    if (output.length < 3) return output;
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const p1 = input[j];
      const p2 = input[(j + 1) % input.length];
      const inside1 = isInsideEdge(p1, a, b, ccw);
      const inside2 = isInsideEdge(p2, a, b, ccw);
      if (inside1 && inside2) {
        output.push(p2);
      } else if (inside1 && !inside2) {
        output.push(intersectEdges(p1, p2, a, b));
      } else if (!inside1 && inside2) {
        output.push(intersectEdges(p1, p2, a, b));
        output.push(p2);
      }
    }
  }
  return output;
}

function dpSimplify(pts: Array<{ x: number; y: number; i: number }>, tol: number): number[] {
  if (pts.length < 3) return pts.map((p) => p.i);
  const a = pts[0];
  const b = pts[pts.length - 1];
  let maxD = 0;
  let idx = 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k];
    const d = len === 0 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
    if (d > maxD) {
      maxD = d;
      idx = k;
    }
  }
  if (maxD <= tol) return [a.i, b.i];
  const left = dpSimplify(pts.slice(0, idx + 1), tol);
  const right = dpSimplify(pts.slice(idx), tol);
  return [...left.slice(0, -1), ...right];
}

/**
 * Reduce a ring to at most `maxPoints` vertices (Douglas-Peucker, tolerance
 * grown until it fits). Used so a 600-vertex OSM outline stays editable by hand.
 */
export function simplifyRing(points: LatLon[], maxPoints = 60): LatLon[] {
  const ring = openRing(points);
  if (ring.length <= maxPoints) return ring;
  const refLat = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const kx = mPerDegLon(refLat);
  const xy = ring.map((p, i) => ({ x: p.lon * kx, y: p.lat * M_PER_DEG_LAT, i }));
  let tol = 0.5;
  let keep: number[] = xy.map((p) => p.i);
  for (let n = 0; n < 24 && keep.length > maxPoints; n++) {
    keep = dpSimplify([...xy, { ...xy[0], i: ring.length }], tol).filter((i) => i < ring.length);
    tol *= 1.6;
  }
  return keep.map((i) => ring[i]);
}

/**
 * Scale a ring about its centre by `factor` (1.1 = 10% larger). Latitude and
 * longitude are scaled by the same factor, which is a uniform metric scale at lake size.
 */
export function scaleRing(points: LatLon[], factor: number, about?: LatLon): LatLon[] {
  if (points.length === 0 || !(factor > 0)) return points;
  const cLat = about ? about.lat : points.reduce((s, p) => s + p.lat, 0) / points.length;
  const cLon = about ? about.lon : points.reduce((s, p) => s + p.lon, 0) / points.length;
  return points.map((p) => ({
    lat: cLat + (p.lat - cLat) * factor,
    lon: cLon + (p.lon - cLon) * factor,
  }));
}

/** Mean of a ring's vertices: the centre `scaleRing` scales about by default. */
export function ringCenter(points: LatLon[]): LatLon {
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / Math.max(1, points.length),
    lon: points.reduce((s, p) => s + p.lon, 0) / Math.max(1, points.length),
  };
}

/** Approximate planar area of a polygon in square metres. */
export function polygonAreaSqM(points: LatLon[]): number | null {
  if (points.length < 3) return null;
  const refLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const kx = mPerDegLon(refLat);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.lon * kx * (b.lat * M_PER_DEG_LAT) - b.lon * kx * (a.lat * M_PER_DEG_LAT);
  }
  return Math.abs(area / 2);
}

/**
 * Boustrophedon (serpentine) order over real grid cells:
 * north-south lanes traversed in alternating directions.
 */
export function orderedCells(cells: GridCell[]): GridCell[] {
  if (cells.length === 0) return [];
  const cols = new Map<number, GridCell[]>();
  for (const c of cells) {
    const list = cols.get(c.col) ?? [];
    list.push(c);
    cols.set(c.col, list);
  }
  const ordered = [...cols.keys()].sort((a, b) => a - b);
  const out: GridCell[] = [];
  ordered.forEach((col, i) => {
    const list = [...(cols.get(col) ?? [])].sort((a, b) => a.row - b.row);
    if (i % 2 === 1) list.reverse();
    out.push(...list);
  });
  return out;
}

/** Serpentine coverage path through real grid cell centres (straight legs, not yet checked against land). */
export function coveragePath(cells: GridCell[]): LatLon[] {
  return orderedCells(cells).map((c) => c.center);
}

/** True when the straight leg a->b crosses no shore or island edge (endpoints are assumed to be in water). */
function legClear(a: number[], b: number[], segs: number[][]): boolean {
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxY = Math.max(a[1], b[1]);
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (const s of segs) {
    if (Math.max(s[0], s[2]) < minX || Math.min(s[0], s[2]) > maxX) continue;
    if (Math.max(s[1], s[3]) < minY || Math.min(s[1], s[3]) > maxY) continue;
    const d1 = orient(a[0], a[1], b[0], b[1], s[0], s[1]);
    const d2 = orient(a[0], a[1], b[0], b[1], s[2], s[3]);
    const d3 = orient(s[0], s[1], s[2], s[3], a[0], a[1]);
    const d4 = orient(s[0], s[1], s[2], s[3], b[0], b[1]);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return false;
  }
  return true;
}

export interface CoveragePlan {
  /** waypoints in visiting order, including any detour waypoints */
  path: LatLon[];
  /** 'lane' = planned sampling cell, 'detour' = extra cell inserted to stay in water; parallel to `path` */
  kinds: Array<'lane' | 'detour'>;
  /** each rerouted stretch, from the last good waypoint to the next (for drawing) */
  detours: LatLon[][];
  /** straight legs that would cross land and could not be routed around */
  blocked: Array<[LatLon, LatLon]>;
}

/**
 * Coverage path that stays in the water. Every leg of the serpentine is checked
 * against the shore and islands; a leg that would cross land is replaced by the
 * shortest chain of neighbouring grid cells (Dijkstra). Legs that cannot be
 * routed are reported in `blocked` instead of silently left crossing land.
 */
export function planCoverage(cells: GridCell[], boundary: LatLon[] | null, holes: LatLon[][] = []): CoveragePlan {
  const order = orderedCells(cells);
  const plain: CoveragePlan = { path: order.map((c) => c.center), kinds: order.map(() => 'lane'), detours: [], blocked: [] };
  if (order.length < 2 || !boundary || boundary.length < 3) return plain;

  const refLat = boundary.reduce((s, p) => s + p.lat, 0) / boundary.length;
  const lonScale = mPerDegLon(refLat);
  const segs = [boundary, ...holes.filter((h) => h.length >= 3)].flatMap((r) => ringSegmentsM(r, lonScale));
  const xy = (p: LatLon) => [p.lon * lonScale, p.lat * M_PER_DEG_LAT];

  const index = new Map<string, number>();
  order.forEach((c, i) => index.set(`${c.row},${c.col}`, i));
  const adjMemo = new Map<number, boolean>();
  const adjacentClear = (i: number, j: number): boolean => {
    const key = i < j ? i * 100_000 + j : j * 100_000 + i;
    let v = adjMemo.get(key);
    if (v === undefined) {
      v = legClear(xy(order[i].center), xy(order[j].center), segs);
      adjMemo.set(key, v);
    }
    return v;
  };

  // Shortest chain of 8-connected cells whose consecutive legs are all in water.
  const route = (from: number, to: number): number[] | null => {
    const dist = new Map<number, number>([[from, 0]]);
    const prev = new Map<number, number>();
    const heap: Array<[number, number]> = [[0, from]];
    const push = (item: [number, number]) => {
      heap.push(item);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop() as [number, number];
      if (heap.length > 0) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    while (heap.length > 0) {
      const [d, u] = pop();
      if (u === to) break;
      if (d > (dist.get(u) ?? Infinity)) continue;
      const cu = order[u];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const v = index.get(`${cu.row + dr},${cu.col + dc}`);
          if (v === undefined || !adjacentClear(u, v)) continue;
          const pv = xy(order[v].center);
          const pu = xy(cu.center);
          const nd = d + Math.hypot(pv[0] - pu[0], pv[1] - pu[1]);
          if (nd < (dist.get(v) ?? Infinity)) {
            dist.set(v, nd);
            prev.set(v, u);
            push([nd, v]);
          }
        }
      }
    }
    if (!prev.has(to)) return null;
    const chain = [to];
    while (chain[chain.length - 1] !== from) chain.push(prev.get(chain[chain.length - 1]) as number);
    return chain.reverse();
  };

  const path: LatLon[] = [order[0].center];
  const kinds: Array<'lane' | 'detour'> = ['lane'];
  const detours: LatLon[][] = [];
  const blocked: Array<[LatLon, LatLon]> = [];
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i];
    const b = order[i + 1];
    if (legClear(xy(a.center), xy(b.center), segs)) {
      path.push(b.center);
      kinds.push('lane');
      continue;
    }
    const chain = route(i, i + 1);
    if (!chain) {
      blocked.push([a.center, b.center]);
      path.push(b.center);
      kinds.push('lane');
      continue;
    }
    for (const k of chain.slice(1, -1)) {
      path.push(order[k].center);
      kinds.push('detour');
    }
    path.push(b.center);
    kinds.push('lane');
    detours.push(chain.map((k) => order[k].center));
  }
  return { path, kinds, detours, blocked };
}

/** Great-circle-free planar length of a path in metres (fine at lake scale). */
export function pathLengthM(path: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    const dx = (b.lon - a.lon) * mPerDegLon((a.lat + b.lat) / 2);
    total += Math.hypot(dx, dy);
  }
  return total;
}

/**
 * Build a CSV matching Supabase's `grids` table exactly: grid_id, lake_id,
 * grid_code, grid_size_m, center_lat, center_lon, center_geom, created_at.
 * `center_geom` is EWKT (`SRID=4326;POINT(lon lat)`) — the standard PostGIS
 * text form. If a direct CSV import into a `geometry` column doesn't accept
 * it as-is, a one-line SQL backfill fixes it:
 *   UPDATE grids SET center_geom = ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326);
 */
export function cellsToCsv(cells: GridCell[], opts: { lakeId: string; cellSizeM: number }): string {
  const header = 'grid_id,lake_id,grid_code,grid_size_m,center_lat,center_lon,center_geom,created_at';
  const IST_MS = 5.5 * 60 * 60 * 1000;
  const createdAt = new Date(Date.now() + IST_MS).toISOString().replace('Z', '+05:30');
  const rows = cells.map((c) => {
    const geom = `SRID=4326;POINT(${c.center.lon} ${c.center.lat})`;
    return [
      crypto.randomUUID(),
      opts.lakeId,
      c.id,
      opts.cellSizeM,
      c.center.lat.toFixed(7),
      c.center.lon.toFixed(7),
      geom,
      createdAt,
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

/** Trigger a browser download of a text file. */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
