import { describe, expect, it } from 'vitest';
import { normaliseMissionState, parseTelemetry } from './telemetryParser';

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

  it('maps the nested packet forwarded by the Pi (STM32 fields plus navigation)', () => {
    const t = parseTelemetry({
      device_id: 'BOT001',
      timestamp: '2026-11-05T10:41:00.000Z',
      motors: { left: '+100', right: -40 },
      gps: { latitude: 12.91686, longitude: 77.48698 },
      compass: { heading: 87.5 },
      sensors: { ph: 7.2, tds: 305, turbidity: 11, temperature_c: 27.9, humidity_percent: 64 },
      battery_percent: 76,
      navigation: {
        mission_id: 'm2', state: 'NAVIGATING', current_waypoint: 5, total_waypoints: 40, completed_waypoints: 4,
        target: { latitude: 12.9169, longitude: 77.48705 }, distance_to_target_m: 6.4, progress: 0.1,
      },
    });
    expect(t).toMatchObject({
      robotId: 'BOT001',
      timestamp: '2026-11-05T10:41:00.000Z',
      water: { ph: 7.2, tdsPpm: 305, turbidityNtu: 11 },
      air: { temperatureC: 27.9, humidityPct: 64 },
      gps: { latitude: 12.91686, longitude: 77.48698, fix: true },
      compass: { headingDeg: 87.5 },
      motors: { left: 100, right: -40 },
      missionId: 'm2',
      missionState: 'transit',
      currentWaypoint: 5,
      waypointTotal: 40,
      navigation: { target: { lat: 12.9169, lon: 77.48705 }, distanceToTargetM: 6.4, completedWaypoints: 4, progress: 0.1 },
    });
  });

  it('treats 0,0 as no GPS fix and unwraps {type, data} frames', () => {
    expect(parseTelemetry({ gps: { latitude: 0, longitude: 0 } })?.gps.fix).toBe(false);
    expect(parseTelemetry({ type: 'telemetry', data: { sensors: { ph: 6.9 } } })?.water.ph).toBe(6.9);
  });

  it('understands the robot state names in any case', () => {
    expect(normaliseMissionState('RETURNING')).toBe('returning');
    expect(normaliseMissionState('Mission received')).toBe('loaded');
    expect(normaliseMissionState('ABORTED')).toBe('aborted');
    expect(normaliseMissionState('FAULT')).toBe('error');
    expect(normaliseMissionState('flying')).toBe('unknown');
  });
});
