import { describe, expect, it } from 'vitest';
import type { LatLon } from '../types';
import type { CoveragePlan } from './geo';
import { planFileName, planToCsv, planToGeoJson } from './exportPlan';

const P = (lat: number, lon: number): LatLon => ({ lat, lon });
const boundary = [P(12.9, 77.4), P(12.9, 77.41), P(12.91, 77.41), P(12.91, 77.4)];
const island = [P(12.904, 77.404), P(12.904, 77.406), P(12.906, 77.406), P(12.906, 77.404)];
const plan: CoveragePlan = {
  path: [P(12.901, 77.401), P(12.902, 77.402), P(12.903, 77.403)],
  kinds: ['lane', 'detour', 'lane'],
  detours: [[P(12.901, 77.401), P(12.902, 77.402), P(12.903, 77.403)]],
  blocked: [[P(12.9, 77.4), P(12.91, 77.41)]],
};
const input = { lake: { id: 'osm:way/1', name: 'Kengeri Lake', waterType: null, center: P(12.905, 77.405), osmBoundary: null, scrubBoundary: null, updatedAt: '' }, boundary, holes: [island], plan, cellSizeM: 100, shoreMarginM: 10, speedMps: 0.8, seconds: 1234.6, generatedAt: '2026-01-01T00:00:00Z' };

describe('planToGeoJson', () => {
  const gj = planToGeoJson(input) as { type: string; properties: Record<string, unknown>; features: Array<{ properties: Record<string, unknown>; geometry: { type: string; coordinates: any } }> };
  it('is a FeatureCollection with [lon, lat] coordinates (RFC 7946)', () => {
    expect(gj.type).toBe('FeatureCollection');
    const wp = gj.features.find((f) => f.properties.role === 'waypoint' && f.properties.seq === 1)!;
    expect(wp.geometry.coordinates).toEqual([77.401, 12.901]);
  });
  it('boundary polygon: closed outer ring plus a closed island ring', () => {
    const poly = gj.features.find((f) => f.properties.role === 'boundary')!;
    expect(poly.geometry.type).toBe('Polygon');
    expect(poly.geometry.coordinates).toHaveLength(2);
    for (const ring of poly.geometry.coordinates) expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
  it('one waypoint per path point, in order, tagged lane/detour; blocked legs exported', () => {
    const wps = gj.features.filter((f) => f.properties.role === 'waypoint');
    expect(wps.map((w) => w.properties.seq)).toEqual([1, 2, 3]);
    expect(wps.map((w) => w.properties.leg)).toEqual(['lane', 'detour', 'lane']);
    expect(gj.features.filter((f) => f.properties.role === 'blocked-leg')).toHaveLength(1);
    expect(gj.features.find((f) => f.properties.role === 'path')?.geometry.coordinates).toHaveLength(3);
  });
  it('carries the planning parameters', () => {
    expect(gj.properties).toMatchObject({ cellSizeM: 100, shoreMarginM: 10, waypoints: 3, detourWaypoints: 1, blockedLegs: 1, estimatedSeconds: 1235 });
  });
  it('is valid JSON', () => {
    expect(() => JSON.parse(JSON.stringify(gj))).not.toThrow();
  });
});

describe('planToCsv / planFileName', () => {
  it('header + one row per waypoint with 7-decimal coordinates', () => {
    const lines = planToCsv(input).trim().split('\n');
    expect(lines[0]).toBe('seq,latitude,longitude,type');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe('2,12.9020000,77.4020000,detour');
  });
  it('safe file names', () => {
    expect(planFileName(input.lake, 'geojson')).toBe('kengeri-lake-mission-plan.geojson');
    expect(planFileName(null, 'csv')).toBe('lake-mission-plan.csv');
    expect(planFileName({ ...input.lake, name: 'Ulsoor / Halasuru Kere!' }, 'csv')).toBe('ulsoor-halasuru-kere-mission-plan.csv');
  });
});
