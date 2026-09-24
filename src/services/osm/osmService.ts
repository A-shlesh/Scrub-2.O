/**
 * OpenStreetMap lake discovery + boundary layer.
 *
 * - Search: Nominatim, asking for the real polygon (`polygon_geojson`) so a
 *   selected lake arrives with its OSM outline already attached.
 * - Boundary by id / by point: Overpass API (`natural=water`, `landuse=reservoir`),
 *   including multipolygon *relations* (outer ways are stitched into rings).
 * - Tiles: OpenStreetMap standard tiles by default (see `mapProviders`).
 *
 * Raw OSM responses are converted into normalized `Lake` objects here;
 * the map UI never parses OSM JSON directly.
 */

import type { Lake, LatLon } from '../../types';
import { pointInPolygon, polygonAreaSqM } from '../../utils/geo';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// ── Nominatim usage policy: max 1 request / second ───────────────────────

let nominatimChain: Promise<unknown> = Promise.resolve();
let lastNominatimAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nominatimFetch(url: string): Promise<Response> {
  const run = async () => {
    const wait = Math.max(0, lastNominatimAt + 1100 - Date.now());
    if (wait > 0) await sleep(wait);
    lastNominatimAt = Date.now();
    return fetch(url, { headers: { Accept: 'application/json' } });
  };
  const next = nominatimChain.then(run, run);
  nominatimChain = next.catch(() => undefined);
  return next;
}

// ── Geometry helpers (exported for tests) ────────────────────────────────

type GeoJsonGeometry = { type: string; coordinates?: unknown } | null | undefined;

const toRing = (coords: unknown): LatLon[] | null => {
  if (!Array.isArray(coords)) return null;
  const ring: LatLon[] = [];
  for (const c of coords) {
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
    ring.push({ lat: c[1], lon: c[0] });
  }
  return ring.length >= 4 ? ring : null;
};

const areaOf = (ring: LatLon[]) => polygonAreaSqM(ring) ?? 0;

export interface Outline {
  outer: LatLon[];
  /** islands: inner rings that lie inside `outer` */
  holes: LatLon[][];
}

/** Largest polygon of a GeoJSON Polygon / MultiPolygon: its outer ring plus its inner rings (islands). */
export function polygonFromGeoJson(geom: GeoJsonGeometry): Outline | null {
  if (!geom || !Array.isArray(geom.coordinates)) return null;
  const fromPoly = (poly: unknown): Outline | null => {
    if (!Array.isArray(poly)) return null;
    const outer = toRing(poly[0]);
    if (!outer) return null;
    const holes = poly
      .slice(1)
      .map(toRing)
      .filter((r): r is LatLon[] => r !== null);
    return { outer, holes };
  };
  if (geom.type === 'Polygon') return fromPoly(geom.coordinates);
  if (geom.type === 'MultiPolygon') {
    let best: Outline | null = null;
    for (const poly of geom.coordinates as unknown[]) {
      const o = fromPoly(poly);
      if (o && (!best || areaOf(o.outer) > areaOf(best.outer))) best = o;
    }
    return best;
  }
  return null;
}

/** Largest outer ring of a GeoJSON Polygon / MultiPolygon, or null (points, lines, junk). */
export function ringFromGeoJson(geom: GeoJsonGeometry): LatLon[] | null {
  return polygonFromGeoJson(geom)?.outer ?? null;
}

const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;

/**
 * Join open way segments end-to-end into closed rings. OSM multipolygon
 * relations describe a lake as several outer ways sharing end nodes.
 */
export function stitchRings(segments: LatLon[][]): LatLon[][] {
  const pool = segments.filter((s) => s.length > 1).map((s) => [...s]);
  const rings: LatLon[][] = [];
  while (pool.length > 0) {
    let cur = pool.pop() as LatLon[];
    let progressed = true;
    while (!same(cur[0], cur[cur.length - 1]) && progressed) {
      progressed = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const rev = [...s].reverse();
        if (same(cur[cur.length - 1], s[0])) cur = cur.concat(s.slice(1));
        else if (same(cur[cur.length - 1], s[s.length - 1])) cur = cur.concat(rev.slice(1));
        else if (same(cur[0], s[s.length - 1])) cur = s.concat(cur.slice(1));
        else if (same(cur[0], s[0])) cur = rev.concat(cur.slice(1));
        else continue;
        pool.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (cur.length >= 4 && same(cur[0], cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

// ── Overpass ─────────────────────────────────────────────────────────────

interface OverpassMember {
  type: string;
  role?: string;
  geometry?: Array<{ lat: number; lon: number }>;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: OverpassMember[];
}

interface OverpassResponse {
  elements: OverpassElement[];
}

async function overpass(query: string): Promise<OverpassResponse> {
  let lastError: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
      return (await res.json()) as OverpassResponse;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Overpass request failed');
}

/** Outer ring of a way, or of a multipolygon relation (largest stitched outer ring). */
export function elementRing(el: OverpassElement): LatLon[] | null {
  return elementOutline(el)?.outer ?? null;
}

/** Outline of a way (no islands) or a multipolygon relation (outer ring + inner rings inside it). */
export function elementOutline(el: OverpassElement): Outline | null {
  if (el.type === 'way') {
    const g = el.geometry?.map((p) => ({ lat: p.lat, lon: p.lon })) ?? [];
    return g.length >= 4 && same(g[0], g[g.length - 1]) ? { outer: g, holes: [] } : null;
  }
  if (el.type === 'relation') {
    const members = (el.members ?? []).filter((m) => m.type === 'way' && m.geometry && m.geometry.length > 1);
    const geom = (m: OverpassMember) => (m.geometry as Array<{ lat: number; lon: number }>).map((p) => ({ lat: p.lat, lon: p.lon }));
    const outers = stitchRings(members.filter((m) => m.role !== 'inner').map(geom));
    if (outers.length === 0) return null;
    const outer = outers.reduce((best, r) => (areaOf(r) > areaOf(best) ? r : best));
    const holes = stitchRings(members.filter((m) => m.role === 'inner').map(geom)).filter((r) =>
      pointInPolygon(r[0], outer),
    );
    return { outer, holes };
  }
  return null;
}

const centroid = (ring: LatLon[]): LatLon => ({
  lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length,
  lon: ring.reduce((s, p) => s + p.lon, 0) / ring.length,
});

const distM = (a: LatLon, b: LatLon) => {
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
};

function lakeFromElement(el: OverpassElement, ring: LatLon[], holes: LatLon[][] = []): Lake {
  const tags = el.tags ?? {};
  const sourceId = `osm:${el.type}/${el.id}`;
  return {
    id: sourceId,
    name: tags.name?.trim() || null,
    waterType: tags.water ?? tags.landuse ?? tags.wetland ?? 'water',
    center: centroid(ring),
    osmBoundary: { points: ring, holes, sourceId, source: 'openstreetmap' },
    scrubBoundary: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Identify the water body at a location.
 *
 * Uses Overpass `is_in` (every water polygon that CONTAINS the point, so a click
 * in the middle of a big lake works) plus a small `around` tolerance for clicks
 * right at the shoreline. Prefers the smallest containing polygon; otherwise the
 * nearest one within `radiusM`. Returns null when OSM has no water polygon there.
 */
export async function identifyWaterAt(point: LatLon, radiusM = 600): Promise<Lake | null> {
  const { lat, lon } = point;
  const around = `(around:${radiusM},${lat},${lon})`;
  const query =
    `[out:json][timeout:25];is_in(${lat},${lon})->.a;(` +
    `way(pivot.a)["natural"="water"];relation(pivot.a)["natural"="water"];` +
    `way(pivot.a)["landuse"="reservoir"];relation(pivot.a)["landuse"="reservoir"];` +
    `way["natural"="water"]${around};relation["natural"="water"]${around};` +
    `way["landuse"="reservoir"]${around};relation["landuse"="reservoir"]${around};` +
    `);out geom;`;
  const data = await overpass(query);

  const seen = new Set<string>();
  const candidates = (data.elements ?? [])
    .filter((el) => {
      const k = `${el.type}/${el.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((el) => ({ el, outline: elementOutline(el) }))
    .filter((c): c is { el: OverpassElement; outline: Outline } => c.outline !== null)
    .map((c) => ({ el: c.el, ring: c.outline.outer, holes: c.outline.holes }));
  if (candidates.length === 0) return null;

  const containing = candidates
    .filter((c) => pointInPolygon(point, c.ring))
    .sort((a, b) => areaOf(a.ring) - areaOf(b.ring));
  const pick =
    containing[0] ??
    [...candidates].sort((a, b) => distM(point, centroid(a.ring)) - distM(point, centroid(b.ring)))[0];
  return lakeFromElement(pick.el, pick.ring, pick.holes);
}

/**
 * Fetch the outline of one specific OSM way/relation by id.
 * Returns `undefined` (no request made) when the id is not a way/relation.
 */
async function boundaryByOsmId(id: string): Promise<{ points: LatLon[]; holes: LatLon[][]; sourceId: string } | null | undefined> {
  const m = /^osm:(way|relation)\/(\d+)$/.exec(id);
  if (!m) return undefined;
  const data = await overpass(`[out:json][timeout:25];${m[1]}(${m[2]});out geom;`);
  const el = data.elements?.[0];
  const outline = el ? elementOutline(el) : null;
  return outline ? { points: outline.outer, holes: outline.holes, sourceId: id } : null;
}

// ── Search (Nominatim) ───────────────────────────────────────────────────

export interface LakeSearchResult {
  /** `osm:way/123`, `osm:relation/456` or `osm:node/789` (stable OSM identity) */
  id: string;
  displayName: string;
  lat: number;
  lon: number;
  type: string | null;
  /** true for water bodies / reservoirs, so they can be listed first */
  isWater: boolean;
  /** outer ring straight from Nominatim's polygon, when the feature is an area */
  boundary: LatLon[] | null;
  /** islands from the same polygon */
  holes: LatLon[][];
}

interface NominatimItem {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  category?: string;
  class?: string;
  geojson?: GeoJsonGeometry;
}

const WATER_TYPES = new Set(['water', 'lake', 'pond', 'reservoir', 'basin', 'wetland', 'bay', 'lagoon']);

/** Search real OSM data for a water body by name; water features sort first. */
export async function searchLakes(query: string): Promise<LakeSearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = `${NOMINATIM}/search?${new URLSearchParams({
    q,
    format: 'jsonv2',
    limit: '8',
    polygon_geojson: '1',
    polygon_threshold: '0.00001',
  })}`;
  const res = await nominatimFetch(url);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const items = (await res.json()) as NominatimItem[];
  const out: LakeSearchResult[] = [];
  for (const it of items) {
    const lat = Number(it.lat);
    const lon = Number(it.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const category = it.category ?? it.class ?? '';
    const type = it.type ?? null;
    const isWater =
      category === 'waterway' ||
      category === 'water' ||
      (category === 'natural' && type !== null && WATER_TYPES.has(type)) ||
      (category === 'landuse' && (type === 'reservoir' || type === 'basin')) ||
      (type !== null && WATER_TYPES.has(type));
    out.push({
      id: it.osm_type && it.osm_id ? `osm:${it.osm_type}/${it.osm_id}` : `nominatim:${it.place_id}`,
      displayName: it.display_name,
      lat,
      lon,
      type,
      isWater,
      boundary: polygonFromGeoJson(it.geojson)?.outer ?? null,
      holes: polygonFromGeoJson(it.geojson)?.holes ?? [],
    });
  }
  return out.sort((a, b) => Number(b.isWater) - Number(a.isWater));
}

/** Build a Lake from a search result; the OSM outline is attached when Nominatim supplied one. */
export function lakeFromSearchResult(r: LakeSearchResult): Lake {
  return {
    id: r.id,
    name: r.displayName.split(',')[0]?.trim() || r.displayName,
    waterType: r.type,
    center: { lat: r.lat, lon: r.lon },
    osmBoundary: r.boundary ? { points: r.boundary, holes: r.holes, sourceId: r.id, source: 'openstreetmap' } : null,
    scrubBoundary: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Make sure a lake has its OSM outline. Order: already attached -> by OSM id ->
 * water polygon containing the lake's centre. Throws only when *every* lookup
 * failed because OSM could not be reached (not when OSM simply has no outline).
 */
export async function resolveBoundary(lake: Lake): Promise<Lake> {
  if (lake.osmBoundary) return lake;
  let reached = false;
  let lastError: unknown = null;

  try {
    const byId = await boundaryByOsmId(lake.id);
    if (byId !== undefined) reached = true; // only counts when a request really completed
    if (byId) {
      return {
        ...lake,
        osmBoundary: { points: byId.points, holes: byId.holes, sourceId: byId.sourceId, source: 'openstreetmap' },
        updatedAt: new Date().toISOString(),
      };
    }
  } catch (e) {
    lastError = e;
  }

  try {
    const found = await identifyWaterAt(lake.center);
    reached = true;
    if (found?.osmBoundary) {
      return { ...lake, osmBoundary: found.osmBoundary, updatedAt: new Date().toISOString() };
    }
  } catch (e) {
    lastError = e;
  }

  if (!reached) throw lastError instanceof Error ? lastError : new Error('Could not reach OpenStreetMap');
  return lake;
}

// ── Map tiles ────────────────────────────────────────────────────────────

export const mapProviders = {
  /** OpenStreetMap standard tiles (default). */
  light: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  /** OpenStreetMap data, dark styling by CARTO. */
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  /** Aerial imagery from Esri (not OpenStreetMap). */
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
  },
} as const;

export type MapStyle = keyof typeof mapProviders;

// ── Locality label ───────────────────────────────────────────────────────

interface ReverseResult {
  address?: {
    city?: string;
    town?: string;
    village?: string;
    suburb?: string;
    county?: string;
    state?: string;
  };
}

const localityCache = new Map<string, Promise<string | null>>();

/**
 * Real locality label ("City, State") from Nominatim reverse geocoding.
 * Cached and rate-limited; returns null when unavailable — callers render "-".
 */
export function reverseLocality(point: LatLon): Promise<string | null> {
  const key = `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`;
  const hit = localityCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const url = `${NOMINATIM}/reverse?${new URLSearchParams({
        lat: String(point.lat),
        lon: String(point.lon),
        format: 'jsonv2',
      })}`;
      const res = await nominatimFetch(url);
      if (!res.ok) return null;
      const a = ((await res.json()) as ReverseResult).address;
      if (!a) return null;
      const city = a.city ?? a.town ?? a.village ?? a.suburb ?? a.county ?? null;
      if (city && a.state) return `${city}, ${a.state}`;
      return city ?? a.state ?? null;
    } catch {
      return null;
    }
  })();
  localityCache.set(key, p);
  void p.then((v) => {
    if (v === null) localityCache.delete(key);
  });
  return p;
}
