import { describe, expect, it } from 'vitest';
import { generateGrid, planCoverage } from './geo';
import { buildWaypointsFile, canonicalWaypointText, cellIdsForPath, planWaypoints, waypointChecksum } from './waypoints';
import type { Waypoint } from './waypoints';

const sample: Waypoint[] = [
  { seq: 1, lat: 12.9145123, lon: 77.4820456, type: 'lane', grid_id: 'g-1' },
  { seq: 2, lat: 13, lon: 77.5, type: 'detour', grid_id: null },
  { seq: 3, lat: -0.0000001, lon: -77.1234567, type: 'lane', grid_id: 'g-3' },
];

describe('waypoint checksum', () => {
  it('uses the line format documented for the robot', () => {
    expect(canonicalWaypointText(sample)).toBe(
      '1,12.9145123,77.4820456,lane,g-1\n2,13.0000000,77.5000000,detour,\n3,-0.0000001,-77.1234567,lane,g-3\n',
    );
  });

  it('matches the Python reference in docs/robot-protocol.md', async () => {
    // Computed with the documented Python waypoint_checksum() on the same three waypoints.
    expect(await waypointChecksum(sample)).toBe('f1f4431fcccd8f98f19d07b632736fd7d12ef139945526b025429742ffae1eb8');
  });
});

describe('planWaypoints', () => {
  const square = [
    { lat: 12.97, lon: 77.59 },
    { lat: 12.97, lon: 77.592 },
    { lat: 12.972, lon: 77.592 },
    { lat: 12.972, lon: 77.59 },
  ];
  const cells = generateGrid(square, 40, { lakePrefix: 'TST' });
  const plan = planCoverage(cells, square);

  it('ties every path point to its cell and grid row, in visiting order', () => {
    const gridIds = new Map(cells.map((c) => [c.id, `grid-${c.id}`]));
    const wps = planWaypoints(plan, cells, gridIds);
    expect(wps).toHaveLength(plan.path.length);
    expect(wps.map((w) => w.seq)).toEqual(plan.path.map((_, i) => i + 1));
    expect(wps.every((w) => w.grid_id !== null)).toBe(true);
    expect(cellIdsForPath(plan.path, cells).every((id) => id !== null)).toBe(true);
  });

  it('builds a file whose count and checksum describe its waypoints', async () => {
    const wps = planWaypoints(plan, cells, new Map());
    const file = await buildWaypointsFile({ missionId: 'm', deviceId: 'BOT001', supabaseLakeId: 'l', lakeName: 'Test', cellSizeM: 40, waypoints: wps });
    expect(file.count).toBe(wps.length);
    expect(file.sha256).toBe(await waypointChecksum(wps));
    expect(file.waypoints.every((w) => w.grid_id === null)).toBe(true);
  });
});
