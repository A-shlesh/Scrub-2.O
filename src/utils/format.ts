/**
 * Display helpers. Missing data always renders as "-" — never 0,
 * never a placeholder value.
 */

export const DASH = '-';

export function fmt(value: number | string | null | undefined, digits?: number): string {
  if (value === null || value === undefined) return DASH;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return DASH;
    return digits !== undefined ? value.toFixed(digits) : String(value);
  }
  const s = String(value).trim();
  return s.length > 0 ? s : DASH;
}

export function fmtWithUnit(
  value: number | null | undefined,
  unit: string,
  digits?: number,
): { value: string; unit: string } {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { value: DASH, unit };
  }
  return { value: digits !== undefined ? value.toFixed(digits) : String(value), unit };
}

export function fmtGps(lat: number | null, lon: number | null, fix: boolean): string {
  if (!fix || lat === null || lon === null) return DASH;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return DASH;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString();
}

export function fmtMissionState(s: string): string {
  if (!s || s === 'unknown') return DASH;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const COMPASS_POINTS = [
  'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW',
];

/** 8-point compass label derived from a real heading, e.g. 142 -> "SE". */
export function compassPoint(headingDeg: number | null | undefined): string | null {
  if (headingDeg === null || headingDeg === undefined || !Number.isFinite(headingDeg)) return null;
  const idx = Math.round((((headingDeg % 360) + 360) % 360) / 45) % 8;
  return COMPASS_POINTS[idx];
}

/** e.g. 12.9145, 77.482 -> "12.9145° N, 77.4820° E". Null-safe. */
export function fmtGpsDetailed(lat: number | null, lon: number | null, fix: boolean): string {
  if (!fix || lat === null || lon === null) return DASH;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return DASH;
  const la = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
  return `${la}, ${lo}`;
}

/** Qualitative AQI band derived from a real value. */
export function aqiBand(aqi: number | null | undefined): string {
  if (aqi === null || aqi === undefined || !Number.isFinite(aqi)) return DASH;
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy (sensitive)';
  return 'Unhealthy';
}

/** "5 seconds ago", "2 min ago", "3 h ago". DASH when unknown. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return DASH;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return DASH;
  const s = Math.max(1, Math.round((now - t) / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** 1_800_000 -> "1.8 km\u00b2", 42_000 -> "4.2 ha", 800 -> "800 m\u00b2". */
export function fmtArea(sqm: number | null | undefined): string {
  if (sqm === null || sqm === undefined || !Number.isFinite(sqm)) return DASH;
  if (sqm >= 1_000_000) return `${(sqm / 1_000_000).toFixed(1)} km\u00b2`;
  if (sqm >= 10_000) return `${(sqm / 10_000).toFixed(1)} ha`;
  return `${Math.round(sqm)} m\u00b2`;
}

/** seconds -> "2.5 hours" / "40 min". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}
