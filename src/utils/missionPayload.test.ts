import { describe, expect, it } from 'vitest';
import { ackMismatch, buildMissionPayload, canonicalWaypointText, sha256Hex, toMissionWaypoints } from './missionPayload';
import { planMissionRoute } from './coverage';
import { toLatLon } from './demoPath';

const square = [
  { lat: 12.97, lon: 77.59 },
  { lat: 12.97, lon: 77.5915 },
  { lat: 12.9709, lon: 77.5915 },
  { lat: 12.9709, lon: 77.59 },
];
const gcs = { lat: 12.96985, lon: 77.58985 };

describe('mission payload', () => {
  const route = planMissionRoute({ boundary: square, spacingM: 20, gcs });

  it('has the GCS as the first and last waypoint, numbered from 0', async () => {
    const p = await buildMissionPayload({
      missionId: 'm-1',
      deviceId: 'BOT001',
      lakeId: null,
      lakeName: 'Test',
      gcs,
      polygon: square,
      islands: [],
      sweepSpacingM: 20,
      shoreMarginM: 0,
      acceptanceRadiusM: 3,
      path: route.path,
      kinds: route.kinds,
      createdAt: '2026-11-05T10:00:00.000Z',
    });
    expect(p.ground_control).toEqual({ latitude: 12.96985, longitude: 77.58985 });
    expect(p.polygon).toHaveLength(4);
    expect(p.waypoint_count).toBe(route.path.length);
    expect(p.waypoints[0]).toMatchObject({ sequence_order: 0, type: 'GCS', latitude: 12.96985, longitude: 77.58985 });
    const last = p.waypoints[p.waypoints.length - 1];
    expect(last).toMatchObject({ sequence_order: p.waypoint_count - 1, type: 'GCS', latitude: 12.96985 });
    expect(p.waypoints.slice(1, -1).every((w) => w.type === 'COVERAGE')).toBe(true);
    expect(p.waypoints.map((w) => w.sequence_order)).toEqual(p.waypoints.map((_, i) => i));
  });

  it('checksum is SHA-256 of the documented canonical text (same as the Python reference)', async () => {
    const wps = toMissionWaypoints(
      [gcs, { lat: 12.9700898, lon: 77.5900092 }, { lat: 12.9701, lon: 77.5914 }, gcs],
      ['GCS', 'COVERAGE', 'TRANSIT', 'GCS'],
    );
    const text = canonicalWaypointText(wps);
    expect(text).toBe(
      ['0,12.9698500,77.5898500,GCS', '1,12.9700898,77.5900092,COVERAGE', '2,12.9701000,77.5914000,TRANSIT', '3,12.9698500,77.5898500,GCS', ''].join('\n'),
    );
    // hashlib.sha256(text.encode()).hexdigest() in Python:
    expect(await sha256Hex(text)).toBe('62ee77eb9a3f7377de882178178795e881b1d5c67997a56a154a38bc15789f47');
  });

  it('accepts only an acknowledgement with the same count and checksum', () => {
    const sent = { waypoint_count: 12, checksum: 'abc' };
    expect(ackMismatch(sent, { waypoint_count: 12, checksum: 'ABC' })).toBeNull();
    expect(ackMismatch(sent, { waypoint_count: 11, checksum: 'abc' })).toMatch(/11 waypoints \(sent 12\)/);
    expect(ackMismatch(sent, { waypoint_count: 12, checksum: 'zzz' })).toMatch(/different checksum/);
    expect(ackMismatch(sent, null)).toMatch(/old version, update the Pi/);
    expect(ackMismatch(sent, { status: 'LOADED' })).toMatch(/old version, update the Pi/);
    expect(ackMismatch(sent, { waypoint_count: 12 })).toMatch(/no checksum/);
  });

  it('builds a demo payload: drawn path in metres plus the same waypoints as lat/lon and checksum', async () => {
    const origin = { lat: 12.9716, lon: 77.5946 };
    const pathM = [{ x_m: 0, y_m: 0 }, { x_m: 5, y_m: 0 }, { x_m: 5, y_m: 3 }];
    const ll = pathM.map((q) => toLatLon(q, origin));
    const p = await buildMissionPayload({
      missionId: 'd1', deviceId: 'BOT001', lakeId: 'lake-1', lakeName: 'Demo 3', gcs: ll[0], polygon: [], islands: [],
      sweepSpacingM: 0, shoreMarginM: 0, acceptanceRadiusM: 1, path: ll, kinds: ['GCS', 'COVERAGE', 'COVERAGE'],
      demo: { path_m: pathM, start_heading_deg: 0, calibration: { drive_mps_per_power: 0.004, turn_dps_per_power: 0.5 }, max_power: 200 },
    });
    expect(p.mode).toBe('demo');
    expect(p.format).toBe('scrub-mission/2');
    expect(p.polygon).toEqual([]);
    expect(p.demo).toEqual({ path_m: pathM, start_heading_deg: 0, calibration: { drive_mps_per_power: 0.004, turn_dps_per_power: 0.5 }, max_power: 200 });
    expect(p.waypoints.map((w) => w.type)).toEqual(['GCS', 'COVERAGE', 'COVERAGE']);
    expect(p.checksum).toBe(await sha256Hex(canonicalWaypointText(p.waypoints)));
  });
});
