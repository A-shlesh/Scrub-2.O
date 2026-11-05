import { describe, expect, it } from 'vitest';
import type { GridCell, SensorSample } from '../types';
import { averageByCell, classifyByPosition } from './gridAnalysis';

const cell = (id: string, lat0: number, lon0: number): GridCell => ({
  id,
  row: 0,
  col: 0,
  center: { lat: lat0 + 0.0005, lon: lon0 + 0.0005 },
  polygon: [
    { lat: lat0, lon: lon0 },
    { lat: lat0, lon: lon0 + 0.001 },
    { lat: lat0 + 0.001, lon: lon0 + 0.001 },
    { lat: lat0 + 0.001, lon: lon0 },
  ],
});
const sample = (id: string, lat: number, lon: number, ph: number | null): SensorSample => ({
  sample_id: id, session_id: null, grid_id: null, sample_number: 0, recorded_at: '2026-11-05T10:00:00Z',
  latitude: lat, longitude: lon, ph, tds: null, turbidity: null, temperature_c: null, humidity_percent: null, created_at: '',
});

describe('GPS-to-grid analysis (future heatmap)', () => {
  const A = cell('A', 12.97, 77.59);
  const B = cell('B', 12.97, 77.591);
  const samples = [
    sample('1', 12.9702, 77.5902, 7.1),
    sample('2', 12.9705, 77.5905, 7.3),
    sample('3', 12.9708, 77.5908, 7.2),
    sample('4', 12.9702, 77.5912, 6.8),
    sample('5', 12.9705, 77.5915, 7.0),
    sample('6', 12.99, 77.6, 9.9), // outside the lake grid
  ];

  it('assigns each record to the cell containing its GPS position', () => {
    const m = classifyByPosition(samples, [A, B]);
    expect([...m.values()]).toEqual(['A', 'A', 'A', 'B', 'B', null]);
  });

  it('averages each sensor per cell (Grid A pH 7.2, Grid B pH 6.9)', () => {
    const out = averageByCell(samples, [A, B]);
    expect(out.find((c) => c.cellId === 'A')).toMatchObject({ count: 3 });
    expect(out.find((c) => c.cellId === 'A')!.averages.ph).toBeCloseTo(7.2, 6);
    expect(out.find((c) => c.cellId === 'B')!.averages.ph).toBeCloseTo(6.9, 6);
    expect(out.find((c) => c.cellId === 'B')!.averages.tds).toBeNull();
  });
});
