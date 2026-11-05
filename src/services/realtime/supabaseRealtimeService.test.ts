import { describe, expect, it } from 'vitest';
import { parseTelemetry } from './supabaseRealtimeService';

describe('parseTelemetry', () => {
  it('maps the documented broadcast payload', () => {
    const t = parseTelemetry({
      ts: '2026-11-05T09:12:04Z', seq: 7,
      ph: 7.1, tds: 310, turbidity: 12.4, temperature_c: 28.2, humidity_percent: 61, aqi: 42,
      lat: 12.9145, lon: 77.482, fix: true, satellites: 9, speed_mps: 0.8, heading_deg: 142,
      battery_percent: 82, mission_id: 'm1', mission_state: 'transit', waypoint_index: 12, waypoint_total: 240,
    }, 'BOT001');
    expect(t).toMatchObject({
      robotId: 'BOT001',
      timestamp: '2026-11-05T09:12:04Z',
      sequence: 7,
      water: { ph: 7.1, tdsPpm: 310, turbidityNtu: 12.4 },
      air: { aqi: 42, temperatureC: 28.2, humidityPct: 61 },
      gps: { latitude: 12.9145, longitude: 77.482, fix: true, satellites: 9, speedMps: 0.8 },
      compass: { headingDeg: 142 },
      batteryPercent: 82,
      missionId: 'm1',
      missionState: 'transit',
      currentWaypoint: 12,
      waypointTotal: 240,
    });
  });

  it('turns missing, wrong-typed or impossible values into null instead of trusting them', () => {
    const t = parseTelemetry({ ph: '7', lat: 123, lon: 77, mission_state: 'flying', heading_deg: Number.NaN });
    expect(t?.water.ph).toBeNull();
    expect(t?.gps).toMatchObject({ latitude: null, longitude: null, fix: false });
    expect(t?.missionState).toBe('unknown');
    expect(t?.compass.headingDeg).toBeNull();
    expect(t?.currentWaypoint).toBeNull();
  });

  it('ignores payloads that are not objects', () => {
    expect(parseTelemetry(null)).toBeNull();
    expect(parseTelemetry('hello')).toBeNull();
    expect(parseTelemetry([1, 2])).toBeNull();
  });
});
