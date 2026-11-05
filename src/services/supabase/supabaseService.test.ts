import { describe, expect, it } from 'vitest';
import type { GridCell, SensorSample } from '../../types';
import { generateGrid } from '../../utils/geo';
import { computeGridAnalytics, readingToSample } from './supabaseService';

const square = [
  { lat: 12.97, lon: 77.59 },
  { lat: 12.97, lon: 77.592 },
  { lat: 12.972, lon: 77.592 },
  { lat: 12.972, lon: 77.59 },
];

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

describe('readingToSample', () => {
  it('maps a sensor_readings row (heading, reading_id) to the page shape', () => {
    const r = readingToSample({
      reading_id: 'r1', mission_id: 'm1', device_id: 'BOT001', recorded_at: '2026-11-05T10:00:00Z', created_at: null,
      latitude: 12.97, longitude: 77.59, heading: 142.5, ph: 7.2, tds: null, turbidity: 11, temperature_c: 27.9, humidity_percent: 64,
    });
    expect(r).toMatchObject({
      sample_id: 'r1', mission_id: 'm1', device_id: 'BOT001', heading_deg: 142.5, grid_id: null, session_id: null,
      latitude: 12.97, longitude: 77.59, ph: 7.2, tds: null, turbidity: 11, temperature_c: 27.9, humidity_percent: 64,
      created_at: '2026-11-05T10:00:00Z',
    });
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
