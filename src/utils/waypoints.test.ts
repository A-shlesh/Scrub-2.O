import { describe, expect, it } from 'vitest';
import { generateGrid, planCoverage, shoreCrossings } from './geo';
import { buildWaypointsFile, canonicalWaypointText, cellIdsForPath, planWaypoints, routeWithGcs, waypointChecksum } from './waypoints';
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

  it('starts at the GCS, returns to it, and enters at the cell nearest the GCS', async () => {
    const last = plan.path[plan.path.length - 1];
    const gcs = { lat: last.lat + 0.0003, lon: last.lon }; // just outside, beside the far end of the path
    const route = routeWithGcs(plan, gcs);
    expect(route.path).toHaveLength(plan.path.length + 2);
    expect(route.path[0]).toEqual(gcs);
    expect(route.path[route.path.length - 1]).toEqual(gcs);
    expect(route.kinds[0]).toBe('gcs');
    expect(route.kinds[route.kinds.length - 1]).toBe('gcs');
    expect(route.path[1]).toEqual(last); // reversed so the robot enters nearest the GCS

    const gridIds = new Map(cells.map((c) => [c.id, `grid-${c.id}`]));
    const wps = planWaypoints(route, cells, gridIds);
    expect(wps[0]).toMatchObject({ seq: 1, type: 'gcs', grid_id: null });
    expect(wps[wps.length - 1]).toMatchObject({ seq: wps.length, type: 'gcs', grid_id: null });
    const file = await buildWaypointsFile({ missionId: 'm', deviceId: 'BOT001', supabaseLakeId: 'l', lakeName: 'Test', cellSizeM: 40, gcs, waypoints: wps });
    expect(file.gcs).toEqual({ lat: wps[0].lat, lon: wps[0].lon }); // header GCS is exactly the first waypoint
    expect(file.count).toBe(plan.path.length + 2);
  });

  it('leaves the path unchanged when no GCS is set', () => {
    expect(routeWithGcs(plan, null)).toMatchObject({ path: plan.path, kinds: plan.kinds, returnDetour: null, gcsWarnings: [] });
  });
});

describe('trip back to the GCS', () => {
  const lake = [
    { lat: 12.97, lon: 77.59 },
    { lat: 12.97, lon: 77.594 },
    { lat: 12.974, lon: 77.594 },
    { lat: 12.974, lon: 77.59 },
  ];
  const island = [
    { lat: 12.9712, lon: 77.5912 },
    { lat: 12.9712, lon: 77.5928 },
    { lat: 12.9728, lon: 77.5928 },
    { lat: 12.9728, lon: 77.5912 },
  ];
  const cells = generateGrid(lake, 40, { holes: [island], lakePrefix: 'ISL' });
  const plan = planCoverage(cells, lake, [island]);
  const route0 = (gcs: { lat: number; lon: number }) => routeWithGcs(plan, gcs, { cells, boundary: lake, holes: [island] });

  it('goes back through the water when the straight line home would cross an island', () => {
    const entry = plan.path[0];
    const last = plan.path[plan.path.length - 1];
    // GCS on the south-west bank: nearest the path start, but the island lies between it and the path end.
    const gcs = { lat: 12.9698, lon: 77.5905 };
    expect(route0(gcs).path[1]).toEqual(entry);
    expect(shoreCrossings(last, gcs, lake, [island]).islands).toBeGreaterThan(0);

    const route = routeWithGcs(plan, gcs, { cells, boundary: lake, holes: [island] });
    expect(route.gcsWarnings).toEqual([]);
    expect(route.returnDetour).not.toBeNull();
    // Every leg of the trip home stays off the island, and it leaves the lake at the entry cell.
    const home = route.path.slice(plan.path.length);
    const legs = [last, ...home];
    for (let i = 1; i < legs.length; i++) expect(shoreCrossings(legs[i - 1], legs[i], lake, [island]).islands).toBe(0);
    expect(route.path[route.path.length - 2]).toEqual(entry);
    expect(route.kinds[route.kinds.length - 2]).toBe('detour');
  });

  it('warns when the GCS cannot reach the first waypoint without crossing land', () => {
    const entry = plan.path[0];
    const gcs = { lat: 12.972, lon: 77.592 }; // in the middle of the island
    const route = routeWithGcs({ path: [entry], kinds: ['lane'] }, gcs, { cells, boundary: lake, holes: [island] });
    expect(route.gcsWarnings.length).toBeGreaterThan(0);
  });
});

