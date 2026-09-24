import type { Telemetry } from '../types';

/** ok = fine, warn = close to a limit, bad = outside the acceptable range, none = no data / no rule. */
export type ReadingStatus = 'ok' | 'warn' | 'bad' | 'none';

/** Acceptable ranges (also shown as the hint under each card). */
export const RANGES = {
  ph: { min: 6.5, max: 8.5, label: 'pH', unit: '' },
  turbidityNtu: { min: 0, max: 50, label: 'Turbidity', unit: 'NTU' },
  tdsPpm: { min: 0, max: 1000, label: 'TDS', unit: 'ppm' },
} as const;

/** A reading within this fraction of the range width from an edge is a "warn". */
const WARN_BAND = 0.1;

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function rangeStatus(value: number | null | undefined, min: number, max: number): ReadingStatus {
  if (!finite(value)) return 'none';
  if (value < min || value > max) return 'bad';
  const band = (max - min) * WARN_BAND;
  if (value < min + band && min > 0) return 'warn'; // a floor of 0 (turbidity, TDS) has no low warning
  if (value > max - band) return 'warn';
  return 'ok';
}

/** Same bands as `aqiBand`: <=50 good, <=100 moderate (warn), above that unhealthy (bad). */
export function aqiStatus(aqi: number | null | undefined): ReadingStatus {
  if (!finite(aqi)) return 'none';
  if (aqi <= 50) return 'ok';
  if (aqi <= 100) return 'warn';
  return 'bad';
}

export function batteryStatus(pct: number | null | undefined): ReadingStatus {
  if (!finite(pct)) return 'none';
  if (pct < 20) return 'bad';
  if (pct < 35) return 'warn';
  return 'ok';
}

export interface Alert {
  key: string;
  level: 'warn' | 'bad';
  text: string;
}

/** Everything currently outside (bad) or near the edge of (warn) its acceptable range. */
export function alertsFor(t: Telemetry | null): Alert[] {
  if (!t) return [];
  const out: Alert[] = [];
  const add = (key: string, level: ReadingStatus, text: string) => {
    if (level === 'warn' || level === 'bad') out.push({ key, level, text });
  };
  const { ph, turbidityNtu, tdsPpm } = t.water;
  add('ph', rangeStatus(ph, RANGES.ph.min, RANGES.ph.max), `pH ${finite(ph) ? ph.toFixed(1) : ''} (acceptable ${RANGES.ph.min}–${RANGES.ph.max})`);
  add('turbidity', rangeStatus(turbidityNtu, RANGES.turbidityNtu.min, RANGES.turbidityNtu.max), `Turbidity ${finite(turbidityNtu) ? Math.round(turbidityNtu) : ''} NTU (acceptable up to ${RANGES.turbidityNtu.max})`);
  add('tds', rangeStatus(tdsPpm, RANGES.tdsPpm.min, RANGES.tdsPpm.max), `TDS ${finite(tdsPpm) ? Math.round(tdsPpm) : ''} ppm (acceptable up to ${RANGES.tdsPpm.max})`);
  add('aqi', aqiStatus(t.air.aqi), `Air quality index ${finite(t.air.aqi) ? Math.round(t.air.aqi) : ''}`);
  add('battery', batteryStatus(t.batteryPercent), `Battery ${finite(t.batteryPercent) ? Math.round(t.batteryPercent) : ''}%`);
  return out.sort((a, b) => Number(b.level === 'bad') - Number(a.level === 'bad'));
}
