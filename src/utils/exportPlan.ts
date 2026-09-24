import type { Lake, LatLon } from '../types';
import type { CoveragePlan } from './geo';

export interface PlanExportInput {
  lake: Lake | null;
  boundary: LatLon[] | null;
  holes: LatLon[][];
  plan: CoveragePlan;
  cellSizeM: number;
  shoreMarginM: number;
  /** cruise speed used for the time estimate, m/s */
  speedMps: number;
  /** estimated mission time in seconds (null when there is no path) */
  seconds: number | null;
  generatedAt?: string;
}

const closed = (ring: LatLon[]): number[][] => {
  const pts = ring.map((p) => [p.lon, p.lat]);
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (a && b && (a[0] !== b[0] || a[1] !== b[1])) pts.push([a[0], a[1]]);
  return pts;
};

/** RFC 7946 GeoJSON: coordinates are [longitude, latitude]. */
export function planToGeoJson(i: PlanExportInput) {
  const features: unknown[] = [];
  if (i.boundary && i.boundary.length >= 3) {
    features.push({
      type: 'Feature',
      properties: { role: 'boundary', name: i.lake?.name ?? null, islands: i.holes.length },
      geometry: { type: 'Polygon', coordinates: [closed(i.boundary), ...i.holes.filter((h) => h.length >= 3).map(closed)] },
    });
  }
  if (i.plan.path.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { role: 'path' },
      geometry: { type: 'LineString', coordinates: i.plan.path.map((p) => [p.lon, p.lat]) },
    });
  }
  i.plan.path.forEach((p, k) => {
    features.push({
      type: 'Feature',
      properties: { role: 'waypoint', seq: k + 1, leg: i.plan.kinds[k] ?? 'lane' },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    });
  });
  for (const [a, b] of i.plan.blocked) {
    features.push({
      type: 'Feature',
      properties: { role: 'blocked-leg', note: 'straight leg crosses land and could not be routed around' },
      geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
    });
  }
  return {
    type: 'FeatureCollection',
    properties: {
      generator: 'SCRUB dashboard',
      lakeId: i.lake?.id ?? null,
      lakeName: i.lake?.name ?? null,
      generatedAt: i.generatedAt ?? new Date().toISOString(),
      cellSizeM: i.cellSizeM,
      shoreMarginM: i.shoreMarginM,
      waypoints: i.plan.path.length,
      detourWaypoints: i.plan.kinds.filter((k) => k === 'detour').length,
      blockedLegs: i.plan.blocked.length,
      planningSpeedMps: i.speedMps,
      estimatedSeconds: i.seconds === null ? null : Math.round(i.seconds),
    },
    features,
  };
}

/** One waypoint per row, in visiting order. */
export function planToCsv(i: PlanExportInput): string {
  const rows = ['seq,latitude,longitude,type'];
  i.plan.path.forEach((p, k) => rows.push(`${k + 1},${p.lat.toFixed(7)},${p.lon.toFixed(7)},${i.plan.kinds[k] ?? 'lane'}`));
  return rows.join('\n') + '\n';
}

export function planFileName(lake: Lake | null, ext: string): string {
  const base = (lake?.name ?? 'lake').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lake';
  return `${base}-mission-plan.${ext}`;
}

/** Trigger a browser download of `text` as a file. */
export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
