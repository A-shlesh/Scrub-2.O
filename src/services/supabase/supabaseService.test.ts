import { describe, expect, it } from 'vitest';
import type { GridCell, SensorSample } from '../../types';
import { generateGrid } from '../../utils/geo';
import { computeGridAnalytics, gridGeometryKey, matchGridsToCells } from './supabaseService';
import type { SupabaseGrid } from './supabaseService';

const square = [
  { lat: 12.97, lon: 77.59 },
  { lat: 12.97, lon: 77.592 },
  { lat: 12.972, lon: 77.592 },
  { lat: 12.972, lon: 77.59 },
];

function rowsFor(cells: GridCell[], sizeM: number, idPrefix: string): SupabaseGrid[] {
  return cells.map((c, i) => ({ gridId: `${idPrefix}-${i}`, gridCode: c.id, gridSizeM: sizeM, centerLat: c.center.lat, centerLon: c.center.lon }));
}

function sample(gridId: string, ph: number | null, session = 's1'): SensorSample {
  return {
    sample_id: `${gridId}-${ph}`,
    session_id: session,
    grid_id: gridId,
    sample_number: 1,
    recorded_at: '2026-01-01T00:00:00+05:30',
    latitude: 0,
    longitude: 0,
    ph,
    tds: null,
    turbidity: null,
    temperature_c: null,
    humidity_percent: null,
    created_at: '2026-01-01T00:00:00+05:30',
  };
}

describe('gridGeometryKey', () => {
  it('ignores sub-decimetre float noise but separates sizes and positions', () => {
    expect(gridGeometryKey(20, 12.9700001, 77.59)).toBe(gridGeometryKey(20, 12.97000014, 77.59));
    expect(gridGeometryKey(20, 12.97, 77.59)).not.toBe(gridGeometryKey(25, 12.97, 77.59));
    expect(gridGeometryKey(20, 12.97, 77.59)).not.toBe(gridGeometryKey(20, 12.9701, 77.59));
  });
});

describe('matchGridsToCells', () => {
  it('matches rows of the current layout only, even when codes repeat across layouts', () => {
    const cells20 = generateGrid(square, 20, { lakePrefix: 'KNG' });
    const cells40 = generateGrid(square, 40, { lakePrefix: 'KNG' });
    // Both layouts number their cells KNG001..., so codes collide.
    expect(cells40[0].id).toBe(cells20[0].id);

    const rows = [...rowsFor(cells20, 20, 'old'), ...rowsFor(cells40, 40, 'new')];
    const matched = matchGridsToCells(rows, cells40, 40);

    expect(matched.size).toBe(cells40.length);
    for (const [gridId, cellId] of matched) {
      expect(gridId.startsWith('new-')).toBe(true);
      expect(cells40.some((c) => c.id === cellId)).toBe(true);
    }
  });

  it('returns nothing when the lake has no stored rows', () => {
    expect(matchGridsToCells([], generateGrid(square, 20), 20).size).toBe(0);
  });
});

describe('computeGridAnalytics', () => {
  it('averages per cell and summarises across all samples, skipping missing values', () => {
    const cells = [
      { gridId: 'a', gridCode: 'C1', centerLat: 0, centerLon: 0 },
      { gridId: 'b', gridCode: 'C2', centerLat: 0, centerLon: 0 },
    ];
    const samples = [sample('a', 7), sample('a', 8), sample('a', null), sample('c', 6, 's2')];
    const r = computeGridAnalytics('lake', samples, cells);

    expect(r.cellAverages.find((c) => c.gridCode === 'C1')?.averages.ph).toBe(7.5);
    expect(r.cellAverages.find((c) => c.gridCode === 'C2')?.averages.ph).toBeNull();
    const ph = r.sensorSummaries.find((s) => s.sensor.key === 'ph');
    expect(ph).toMatchObject({ avg: 7, min: 6, max: 8, count: 3 });
    expect(r.totalSamples).toBe(4);
    expect(r.totalSessions).toBe(2);
  });

  it('handles very large sample sets without overflowing the stack', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => sample('a', i % 14));
    const ph = computeGridAnalytics('lake', many, []).sensorSummaries.find((s) => s.sensor.key === 'ph');
    expect(ph?.min).toBe(0);
    expect(ph?.max).toBe(13);
  });
});
