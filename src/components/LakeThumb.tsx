import type { LatLon } from '../types';

/**
 * Small map-style thumbnail drawn from the lake's own outline (OpenStreetMap
 * colours), so cards need no third-party imagery and work offline.
 */
export function LakeThumb({ points, holes = [] }: { points: LatLon[] | null; holes?: LatLon[][] }) {
  const W = 78;
  const H = 66;
  const PAD = 9;
  if (!points || points.length < 3) {
    return (
      <span className="lake-thumb lake-thumb-fallback" aria-hidden="true">≋</span>
    );
  }
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const w = Math.max((maxLon - minLon) * kx, 1e-9);
  const h = Math.max(maxLat - minLat, 1e-9);
  const scale = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h);
  const ox = (W - w * scale) / 2;
  const oy = (H - h * scale) / 2;
  const ringPath = (ring: LatLon[]) =>
    ring
      .map((p, i) => {
        const x = ox + (p.lon - minLon) * kx * scale;
        const y = oy + (maxLat - p.lat) * scale;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ') + ' Z';
  // Islands are extra sub-paths; fill-rule evenodd cuts them out of the water.
  const d = [points, ...holes.filter((h) => h.length >= 3)].map(ringPath).join(' ');
  return (
    <svg className="lake-thumb" viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
      <rect width={W} height={H} fill="#f2efe9" />
      <path d={d} fill="#aad3df" fillRule="evenodd" stroke="#6ea9bf" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
