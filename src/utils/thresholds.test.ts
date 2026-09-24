import { describe, expect, it } from 'vitest';
import type { Telemetry } from '../types';
import { alertsFor, aqiStatus, batteryStatus, rangeStatus } from './thresholds';

const tele = (over: Partial<{ ph: number | null; ntu: number | null; tds: number | null; aqi: number | null; bat: number | null }> = {}): Telemetry => ({
  robotId: 'r', timestamp: null, sequence: null,
  water: { ph: over.ph === undefined ? 7.2 : over.ph, turbidityNtu: over.ntu === undefined ? 12 : over.ntu, tdsPpm: over.tds === undefined ? 310 : over.tds },
  air: { aqi: over.aqi === undefined ? 42 : over.aqi, temperatureC: 28, humidityPct: 60 },
  gps: { latitude: null, longitude: null, speedMps: null, fix: false, satellites: null },
  compass: { headingDeg: null }, batteryPercent: over.bat === undefined ? 82 : over.bat, missionId: null, missionState: 'idle', currentWaypoint: null,
});

describe('rangeStatus', () => {
  it('pH 6.5-8.5: inside is ok, edges warn, outside is bad', () => {
    expect(rangeStatus(7.2, 6.5, 8.5)).toBe('ok');
    expect(rangeStatus(6.6, 6.5, 8.5)).toBe('warn');
    expect(rangeStatus(8.4, 6.5, 8.5)).toBe('warn');
    expect(rangeStatus(6.4, 6.5, 8.5)).toBe('bad');
    expect(rangeStatus(9.1, 6.5, 8.5)).toBe('bad');
  });
  it('the limits themselves are acceptable (warn, not bad)', () => {
    expect(rangeStatus(6.5, 6.5, 8.5)).toBe('warn');
    expect(rangeStatus(8.5, 6.5, 8.5)).toBe('warn');
  });
  it('a floor of 0 never warns on the low side (0 NTU is perfect water)', () => {
    expect(rangeStatus(0, 0, 50)).toBe('ok');
    expect(rangeStatus(1, 0, 50)).toBe('ok');
    expect(rangeStatus(48, 0, 50)).toBe('warn');
    expect(rangeStatus(51, 0, 50)).toBe('bad');
  });
  it('missing / non-finite data is "none", never bad', () => {
    expect(rangeStatus(null, 6.5, 8.5)).toBe('none');
    expect(rangeStatus(NaN, 6.5, 8.5)).toBe('none');
    expect(rangeStatus(undefined, 6.5, 8.5)).toBe('none');
  });
});

describe('aqi / battery', () => {
  it('follows the same bands as the "Good / Moderate / Unhealthy" label', () => {
    expect([aqiStatus(42), aqiStatus(50), aqiStatus(51), aqiStatus(100), aqiStatus(101), aqiStatus(null)]).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', 'none']);
  });
  it('battery: <20 bad, <35 warn', () => {
    expect([batteryStatus(82), batteryStatus(34), batteryStatus(19), batteryStatus(0), batteryStatus(null)]).toEqual(['ok', 'warn', 'bad', 'bad', 'none']);
  });
});

describe('alertsFor', () => {
  it('healthy demo readings raise nothing', () => expect(alertsFor(tele())).toEqual([]));
  it('no telemetry raises nothing (offline is not an alert here)', () => expect(alertsFor(null)).toEqual([]));
  it('lists bad readings before warnings, with the value in the text', () => {
    const a = alertsFor(tele({ ph: 9.1, ntu: 48, bat: 15 }));
    expect(a.map((x) => [x.key, x.level])).toEqual([['ph', 'bad'], ['battery', 'bad'], ['turbidity', 'warn']]);
    expect(a[0].text).toContain('pH 9.1');
    expect(a[0].text).toContain('6.5–8.5');
  });
});
