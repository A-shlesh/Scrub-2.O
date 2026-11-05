import { describe, expect, it } from 'vitest';
import type { LatLon } from '../types';
import { generateGrid, pathLengthM, polygonAreaSqM, scaleRing, ringCenter } from './geo';

// local metre box -> lat/lon around Bengaluru so the tests read in metres
const LAT0 = 12.9;
const LON0 = 77.5;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const m = (x: number, y: number): LatLon => ({ lat: LAT0 + y / 111_320, lon: LON0 + x / KX });
const poly = (pts: Array<[number, number]>) => pts.map(([x, y]) => m(x, y));
const distToRingM = (p: LatLon, ring: LatLon[]) => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const [ax, ay, bx, by, px, py] = [a.lon * KX, a.lat * 111_320, b.lon * KX, b.lat * 111_320, p.lon * KX, p.lat * 111_320];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
};

const SQUARE = poly([[0, 0], [1000, 0], [1000, 1000], [0, 1000]]);
const ISLAND = poly([[400, 400], [600, 400], [600, 600], [400, 600]]);

describe('generateGrid', () => {
  it('keeps every cell centre inside a plain square', () => {
    const cells = generateGrid(SQUARE, 100);
    expect(cells.length).toBe(100); // 10 x 10
  });

  it('drops cells whose centre is on an island', () => {
    const plain = generateGrid(SQUARE, 100);
    const withIsland = generateGrid(SQUARE, 100, { holes: [ISLAND] });
    expect(withIsland.length).toBeLessThan(plain.length);
    // corner-touch check drops the 4 centre-in-island cells plus neighbours that overlap the island edge
    expect(plain.length - withIsland.length).toBe(11);
    for (const c of withIsland) {
      const x = (c.center.lon - LON0) * KX, y = (c.center.lat - LAT0) * 111_320;
      expect(x > 400 && x < 600 && y > 400 && y < 600).toBe(false);
    }
  });

  it('shore margin removes cells too close to the shore and keeps the rest', () => {
    const plain = generateGrid(SQUARE, 100);
    const margin = generateGrid(SQUARE, 100, { shoreMarginM: 60 });
    expect(margin.length).toBeLessThan(plain.length);
    for (const c of margin) expect(distToRingM(c.center, SQUARE)).toBeGreaterThanOrEqual(60 - 0.5);
    // 100 m cells: centres sit 50 m from the shore, so a 60 m margin drops the outer ring (36 of 100 kept)
    expect(margin.length).toBe(64);
  });

  it('shore margin also keeps away from island edges', () => {
    const cells = generateGrid(SQUARE, 100, { holes: [ISLAND], shoreMarginM: 60 });
    for (const c of cells) expect(distToRingM(c.center, ISLAND)).toBeGreaterThanOrEqual(60 - 0.5);
  });

  it('margin 0 / undefined behaves exactly like before', () => {
    expect(generateGrid(SQUARE, 100, { shoreMarginM: 0 }).length).toBe(generateGrid(SQUARE, 100).length);
  });
});

describe('scaleRing', () => {
  it('scales area by factor squared about the ring centre', () => {
    const a = polygonAreaSqM(SQUARE) as number;
    expect((polygonAreaSqM(scaleRing(SQUARE, 1.1)) as number) / a).toBeCloseTo(1.21, 3);
  });
  it('can scale an island about the LAKE centre so it stays where it belongs', () => {
    const centre = ringCenter(SQUARE);
    const grown = scaleRing(ISLAND, 1.5, centre);
    // island centre (500,500) is the lake centre, so it stays; its size grows
    expect((polygonAreaSqM(grown) as number) / (polygonAreaSqM(ISLAND) as number)).toBeCloseTo(2.25, 2);
    const c = ringCenter(grown);
    expect(Math.abs(c.lat - ringCenter(ISLAND).lat)).toBeLessThan(1e-9);
  });
});
