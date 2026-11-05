import { describe, expect, it } from 'vitest';
import type { Telemetry } from '../types';
import { estimateMission, fmtMinutes, startProblems } from './readiness';

const robot = (over: Partial<Telemetry> = {}): Telemetry => ({
  robotId: 'BOT001', timestamp: null, sequence: null,
  water: { ph: null, tdsPpm: null, turbidityNtu: null },
  air: { aqi: null, temperatureC: null, humidityPct: null },
  gps: { latitude: 12.9, longitude: 77.5, speedMps: 0, fix: true, satellites: 8 },
  compass: { headingDeg: null },
  batteryPercent: 90, missionId: null, missionState: 'idle', currentWaypoint: null,
  ...over,
} as Telemetry);

describe('mission estimate', () => {
  it('counts driving time (defaults: 0.8 m/s, 120 min battery, 20% reserve)', () => {
    const e = estimateMission(4800); // 6000 s driving = 100 min
    expect(Math.round(e.minutes)).toBe(100);
    expect(e.batteryNeededPct).toBe(100); // 84% of the battery + 20% reserve, capped at 100
    expect(fmtMinutes(e.minutes)).toBe('1 h 40 min');
    expect(estimateMission(2400).batteryNeededPct).toBe(62); // 42% + 20%
  });
});

describe('start checks', () => {
  const small = estimateMission(480);
  it('is ready with live data, a GPS fix and enough battery', () => {
    expect(startProblems(robot(), true, small)).toEqual([]);
  });
  it('refuses without live data', () => {
    expect(startProblems(robot(), false, small)[0]).toMatch(/No live data/);
    expect(startProblems(null, true, small)[0]).toMatch(/No live data/);
  });
  it('flags no GPS fix and a low or insufficient battery', () => {
    expect(startProblems(robot({ gps: { latitude: null, longitude: null, speedMps: null, fix: false, satellites: 0 } }), true, small).join()).toMatch(/GPS/);
    expect(startProblems(robot({ batteryPercent: 25 }), true, small).join()).toMatch(/at least 30%/);
    expect(startProblems(robot({ batteryPercent: 40 }), true, estimateMission(4800)).join()).toMatch(/needs about/);
    expect(startProblems(robot({ batteryPercent: null }), true, small).join()).toMatch(/battery level/);
  });
});
