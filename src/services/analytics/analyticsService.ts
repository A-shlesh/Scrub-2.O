/**
 * Historical analytics integration layer (InfluxDB via secure backend/API).
 *
 * InfluxDB is NOT implemented yet and must never be contacted directly from
 * the browser (no credentials in frontend code, no direct DB connections).
 * The future backend exposes an HTTP API such as
 * `GET /api/lakes/:lakeId/analytics`; this service is the single place
 * that call will live.
 *
 * Until then `getLakeAnalytics` resolves to an empty `LakeAnalytics`
 * object so every chart renders its honest empty state.
 */

import type { LakeAnalytics } from '../../types';
import { DEMO, demoAnalytics } from '../../demo/demo';

export interface AnalyticsService {
  getLakeAnalytics(lakeId: string): Promise<LakeAnalytics>;
}

function emptyAnalytics(lakeId: string): LakeAnalytics {
  return {
    lakeId,
    ph: [],
    turbidityNtu: [],
    tdsPpm: [],
    temperatureC: [],
    humidityPct: [],
    speedMps: [],
    headingDeg: [],
    track: [],
    missions: [],
    waterLevelM: [],
    dissolvedOxygenMgL: [],
    bodMgL: [],
    summary: null,
  };
}

class HttpAnalyticsService implements AnalyticsService {
  async getLakeAnalytics(lakeId: string): Promise<LakeAnalytics> {
    if (DEMO) return { ...emptyAnalytics(lakeId), ...demoAnalytics() };
    const base = (import.meta.env.VITE_ANALYTICS_API_BASE as string | undefined)?.trim();
    if (!base) {
      // No backend configured yet — honest empty state, no fake series.
      return emptyAnalytics(lakeId);
    }
    const res = await fetch(`${base.replace(/\/$/, '')}/lakes/${encodeURIComponent(lakeId)}/analytics`);
    if (!res.ok) throw new Error(`Analytics request failed (${res.status})`);
    const data = (await res.json()) as Partial<LakeAnalytics>;
    return { ...emptyAnalytics(lakeId), ...data, lakeId };
  }
}

export const analyticsService: AnalyticsService = new HttpAnalyticsService();
