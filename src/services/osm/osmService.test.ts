import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LatLon } from '../../types';
import {
  elementOutline,
  elementRing,
  identifyWaterAt,
  lakeFromSearchResult,
  polygonFromGeoJson,
  resolveBoundary,
  ringFromGeoJson,
  searchLakes,
  stitchRings,
} from './osmService';
import { polygonAreaSqM } from '../../utils/geo';

const sq = (lat: number, lon: number, d: number) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];
const P = (lat: number, lon: number): LatLon => ({ lat, lon });
const geom = (ring: number[][]) => ring.map(([lo, la]) => ({ lat: la, lon: lo }));

afterEach(() => vi.unstubAllGlobals());

describe('GeoJSON -> outline', () => {
  it('Polygon: outer ring, lat/lon order swapped from [lon,lat]', () => {
    const r = ringFromGeoJson({ type: 'Polygon', coordinates: [sq(12.9, 77.4, 0.004)] });
    expect(r).toHaveLength(5);
    expect(r?.[0]).toEqual({ lat: 12.9, lon: 77.4 });
  });
  it('MultiPolygon: the LARGEST polygon wins, not the first', () => {
    const r = ringFromGeoJson({ type: 'MultiPolygon', coordinates: [[sq(12.9, 77.4, 0.001)], [sq(12.95, 77.45, 0.01)], [sq(12.8, 77.3, 0.002)]] });
    expect(r?.[0].lat).toBeCloseTo(12.95, 9);
  });
  it('points, lines and missing geometry are not outlines', () => {
    expect(ringFromGeoJson({ type: 'Point', coordinates: [77.4, 12.9] })).toBeNull();
    expect(ringFromGeoJson({ type: 'LineString', coordinates: [[77.4, 12.9], [77.5, 12.9]] })).toBeNull();
    expect(ringFromGeoJson(undefined)).toBeNull();
  });
  it('keeps the islands (inner rings) of a Polygon', () => {
    const o = polygonFromGeoJson({ type: 'Polygon', coordinates: [sq(12.9, 77.4, 0.01), sq(12.904, 77.404, 0.002)] });
    expect(o?.holes).toHaveLength(1);
    expect(o?.holes[0]).toHaveLength(5);
  });
  it('MultiPolygon: islands come from the same polygon as the chosen outer ring', () => {
    const o = polygonFromGeoJson({ type: 'MultiPolygon', coordinates: [[sq(12.9, 77.4, 0.001), sq(12.9003, 77.4003, 0.0002)], [sq(12.95, 77.45, 0.01), sq(12.954, 77.454, 0.002)]] });
    expect(o?.outer[0].lat).toBeCloseTo(12.95, 9);
    expect(o?.holes).toHaveLength(1);
    expect(o?.holes[0][0].lat).toBeCloseTo(12.954, 9);
  });
});

describe('multipolygon relations', () => {
  const a = P(12.9, 77.4), b = P(12.9, 77.41), c = P(12.91, 77.41), d = P(12.91, 77.4);
  it('stitches split, reversed, out-of-order ways into one closed ring', () => {
    const rings = stitchRings([[c, b], [a, b], [c, d, a]]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(5);
    expect(Math.round(polygonAreaSqM(rings[0]) as number)).toBeGreaterThan(1_000_000);
  });
  it('unclosed pieces yield no ring', () => {
    expect(stitchRings([[a, b], [c, d]])).toHaveLength(0);
  });
  it('a relation gives its outer ring AND its island, stitched from several inner ways', () => {
    const inner1 = [P(12.902, 77.402), P(12.902, 77.406), P(12.906, 77.406)];
    const inner2 = [P(12.906, 77.406), P(12.906, 77.402), P(12.902, 77.402)];
    const outsideInner = [P(12.95, 77.5), P(12.95, 77.51), P(12.96, 77.51), P(12.95, 77.5)]; // not inside the lake
    const rel = {
      type: 'relation' as const, id: 9, tags: { natural: 'water' },
      members: [
        { type: 'way', role: 'outer', geometry: [a, b] }, { type: 'way', role: 'outer', geometry: [c, b] }, { type: 'way', role: 'outer', geometry: [c, d, a] },
        { type: 'way', role: 'inner', geometry: inner1 }, { type: 'way', role: 'inner', geometry: inner2 },
        { type: 'way', role: 'inner', geometry: outsideInner },
      ],
    };
    const o = elementOutline(rel);
    expect(o?.outer).toHaveLength(5);
    expect(o?.holes).toHaveLength(1);           // the stray inner ring outside the lake is dropped
    expect(elementRing(rel)).toHaveLength(5);
  });
  it('an unclosed way is not a lake outline', () => {
    expect(elementRing({ type: 'way', id: 1, geometry: [a, b, c, d] })).toBeNull();
  });
});

describe('search / lookup', () => {
  const bigLake = { type: 'way', id: 111, tags: { natural: 'water', name: 'Big' }, geometry: geom(sq(12.9, 77.4, 0.02)) };
  const pond = { type: 'way', id: 222, tags: { natural: 'water', name: 'Pond' }, geometry: geom(sq(12.95, 77.45, 0.001)) };
  const overpassGeom = (l: typeof bigLake) => l;

  it('searchLakes: water first, outline + islands attached, points get none', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ([
      { place_id: 1, osm_type: 'node', osm_id: 5, display_name: 'Kengeri, Bengaluru', lat: '12.91', lon: '77.48', category: 'place', type: 'suburb', geojson: { type: 'Point', coordinates: [77.48, 12.91] } },
      { place_id: 2, osm_type: 'way', osm_id: 111, display_name: 'Big Lake, Bengaluru', lat: '12.91', lon: '77.41', category: 'natural', type: 'water', geojson: { type: 'Polygon', coordinates: [sq(12.9, 77.4, 0.02), sq(12.905, 77.405, 0.002)] } },
    ]) }));
    const res = await searchLakes('kengeri');
    expect(res[0].id).toBe('osm:way/111');
    expect(res[0].isWater).toBe(true);
    expect(res[0].boundary).toHaveLength(5);
    expect(res[0].holes).toHaveLength(1);
    expect(res[1].boundary).toBeNull();
    const lake = lakeFromSearchResult(res[0]);
    expect(lake.osmBoundary?.holes).toHaveLength(1);
  });

  it('identifyWaterAt asks Overpass which polygons CONTAIN the point and dedupes results', async () => {
    let q = '';
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => { q = decodeURIComponent(init.body); return { ok: true, json: async () => ({ elements: [pond, overpassGeom(bigLake), bigLake] }) }; });
    const mid = await identifyWaterAt({ lat: 12.91, lon: 77.41 }, 40);
    expect(q).toContain('is_in(12.91,77.41)');
    expect(q).toContain('pivot.a');
    expect(q).toContain('around:40,');
    expect(mid?.id).toBe('osm:way/111');
    expect((await identifyWaterAt({ lat: 12.9505, lon: 77.4505 }, 40))?.id).toBe('osm:way/222'); // smallest containing polygon
  });

  it('identifyWaterAt returns the islands of a relation lake', async () => {
    const a = P(12.9, 77.4), b = P(12.9, 77.41), c = P(12.91, 77.41), d = P(12.91, 77.4);
    const rel = { type: 'relation', id: 9, tags: { natural: 'water', name: 'Islet Lake' }, members: [
      { type: 'way', role: 'outer', geometry: [a, b, c, d, a] },
      { type: 'way', role: 'inner', geometry: [P(12.904, 77.404), P(12.904, 77.406), P(12.906, 77.406), P(12.904, 77.404)] } ] };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ elements: [rel] }) }));
    const lake = await identifyWaterAt({ lat: 12.902, lon: 77.402 }, 40);
    expect(lake?.osmBoundary?.holes).toHaveLength(1);
  });

  it('no polygon -> null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ elements: [] }) }));
    expect(await identifyWaterAt({ lat: 12.5, lon: 77 }, 40)).toBeNull();
  });

  it('resolveBoundary: fetches by OSM id, keeps islands', async () => {
    const withIsland = { ...bigLake };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ elements: [withIsland] }) }));
    const lake = await resolveBoundary({ id: 'osm:way/111', name: 'x', waterType: null, center: P(12.9, 77.4), osmBoundary: null, scrubBoundary: null, updatedAt: '' });
    expect(lake.osmBoundary?.points).toHaveLength(5);
    expect(lake.osmBoundary?.holes).toEqual([]);
  });

  it('resolveBoundary: OSM unreachable throws (also for node ids); reachable-but-empty resolves point-only', async () => {
    const base = { id: 'osm:node/88', name: 'x', waterType: null, center: P(12.9, 77.4), osmBoundary: null, scrubBoundary: null, updatedAt: '' };
    vi.stubGlobal('fetch', async () => { throw new Error('network down'); });
    await expect(resolveBoundary(base)).rejects.toThrow();
    await expect(resolveBoundary({ ...base, id: 'osm:way/999' })).rejects.toThrow();
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ elements: [] }) }));
    expect((await resolveBoundary(base)).osmBoundary).toBeNull();
  });
});
