import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import L from 'leaflet';
import type { GridCell, Lake, LatLon } from '../types';
import { mapProviders } from '../services/osm/osmService';
import type { MapStyle } from '../services/osm/osmService';
import { useLake } from '../stores/lake';
import { useTheme } from '../stores/theme';

export type MapMode = 'browse' | 'edit' | 'draw';

/** Where the map opens when no lake is selected. Override with VITE_MAP_CENTER="lat,lon" and VITE_MAP_ZOOM. */
function startView(): { center: [number, number]; zoom: number } {
  const raw = import.meta.env.VITE_MAP_CENTER;
  const zoom = Number(import.meta.env.VITE_MAP_ZOOM) || 12;
  if (raw) {
    const [a, b] = raw.split(',').map((v) => Number(v.trim()));
    if (Number.isFinite(a) && Number.isFinite(b)) return { center: [a, b], zoom };
  }
  return { center: [12.9716, 77.5946], zoom }; // Bengaluru
}

const ICON = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const MYLOC_SVG = ICON('<polygon points="3 11 22 2 13 21 11 13 3 11"/>');
const EXPAND_SVG = ICON('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>');
const COLLAPSE_SVG = ICON('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>');

// Stable defaults: a fresh `[]` per render would make the overlay redraw on every render.
const NO_POINTS: LatLon[] = [];
const NO_RINGS: LatLon[][] = [];
const NO_CELLS: GridCell[] = [];
const NO_LAKES: Array<{ id: string; points: LatLon[] }> = [];
const NO_LEGS: Array<[LatLon, LatLon]> = [];

function toLeaflet(p: LatLon): [number, number] {
  return [p.lat, p.lon];
}

const ringsToLeaflet = (outer: LatLon[], holes: LatLon[][] = []): [number, number][][] => [
  outer.map(toLeaflet),
  ...holes.filter((h) => h.length >= 3).map((h) => h.map(toLeaflet)),
];

function boundaryPoints(lake: Lake | null): LatLon[] | null {
  return lake?.scrubBoundary?.points ?? lake?.osmBoundary?.points ?? null;
}

function fitLake(map: L.Map, lake: Lake | null, animate: boolean) {
  if (!lake) return;
  const pts = boundaryPoints(lake);
  if (pts && pts.length >= 3) {
    map.fitBounds(L.latLngBounds(pts.map(toLeaflet)), { padding: [56, 56], maxZoom: 18, animate });
  } else {
    map.setView(toLeaflet(lake.center), Math.max(map.getZoom(), 14), { animate });
  }
}

export function ObservatoryMap({
  mode = 'browse',
  style,
  workingPoints = NO_POINTS,
  onWorkingChange,
  onPickPoint,
  robot = null,
  gridCells = NO_CELLS,
  showGrid = true,
  focus = 0,
  plannedPath = NO_POINTS,
  showLegend = false,
  backTo = null,
  previewPoints = null,
  previewHoles = NO_RINGS,
  workingHoles = NO_RINGS,
  otherLakes = NO_LAKES,
  detours = NO_RINGS,
  blockedLegs = NO_LEGS,
  referencePoints,
  flyTo = null,
  expanded = false,
  onToggleExpand,
  onNotice,
  addLakeMode = false,
  heatmapCells = [],
  visitedGridIds = new Set(),
}: {
  mode?: MapMode;
  style: MapStyle;
  workingPoints?: LatLon[];
  onWorkingChange?: (pts: LatLon[]) => void;
  /** browse-mode click on the map (with the current zoom level) */
  onPickPoint?: (pt: LatLon, zoom: number) => void;
  robot?: LatLon | null;
  gridCells?: GridCell[];
  showGrid?: boolean;
  /** bump to recenter on the active lake */
  focus?: number;
  /** serpentine coverage path (Mission Planner) */
  plannedPath?: LatLon[];
  showLegend?: boolean;
  backTo?: string | null;
  /** outline of a clicked-but-not-yet-selected water body (highlighted amber) */
  previewPoints?: LatLon[] | null;
  /** islands of the previewed water body */
  previewHoles?: LatLon[][];
  /** islands kept while the outline is being edited */
  workingHoles?: LatLon[][];
  /** the user's other saved lakes, drawn faintly for context */
  otherLakes?: Array<{ id: string; points: LatLon[] }>;
  /** rerouted stretches of the mission path (amber) */
  detours?: LatLon[][];
  /** straight legs that would cross land and could not be routed (red) */
  blockedLegs?: Array<[LatLon, LatLon]>;
  /** dashed reference outline while editing; undefined = the active lake's OSM outline, null = none */
  referencePoints?: LatLon[] | null;
  /** pan/zoom the map to a place; a new `nonce` triggers a new move */
  flyTo?: { lat: number; lon: number; zoom: number; nonce: number } | null;
  expanded?: boolean;
  /** when given, the map shows an expand / collapse control */
  onToggleExpand?: () => void;
  /** short user-facing map messages (tiles not loading, location denied, ...) */
  onNotice?: (text: string) => void;
  /** when true, clicking the map triggers a water-body pick (crosshair cursor) */
  addLakeMode?: boolean;
  /** heatmap overlay: color each grid cell by a value */
  heatmapCells?: Array<{ gridCode: string; color: string; value: number | null }>;
  /** grid cell IDs that have been visited (completed session) */
  visitedGridIds?: Set<string>;
}) {
  const { lake } = useLake();
  const { theme } = useTheme();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const expandLinkRef = useRef<HTMLAnchorElement | null>(null);
  const pointsRef = useRef(workingPoints);
  const modeRef = useRef(mode);
  const lakeRef = useRef(lake);
  pointsRef.current = workingPoints;
  modeRef.current = mode;
  lakeRef.current = lake;
  const pickRef = useRef(onPickPoint);
  pickRef.current = onPickPoint;
  const changeRef = useRef(onWorkingChange);
  changeRef.current = onWorkingChange;
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const toggleRef = useRef(onToggleExpand);
  const youRef = useRef<L.LayerGroup | null>(null);
  const justDraggedRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const hasExpand = !!onToggleExpand;

  // Create map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const start = startView();
    const map = L.map(elRef.current, {
      center: start.center,
      zoom: start.zoom,
      worldCopyJump: true,
      zoomControl: false,
      preferCanvas: true,
    });
    mapRef.current = map;

    const makeControl = (title: string, svg: string, onClick: () => void) => {
      const Ctl = L.Control.extend({
        onAdd() {
          const bar = L.DomUtil.create('div', 'leaflet-bar');
          const a = L.DomUtil.create('a', '', bar) as HTMLAnchorElement;
          a.href = '#';
          a.title = title;
          a.setAttribute('role', 'button');
          a.setAttribute('aria-label', title);
          a.innerHTML = svg;
          L.DomEvent.disableClickPropagation(bar);
          L.DomEvent.on(a, 'click', (e) => {
            L.DomEvent.preventDefault(e);
            onClick();
          });
          return bar;
        },
      });
      return new Ctl({ position: 'bottomright' });
    };

      // Bottom-right stack, top to bottom: my-location, zoom, expand.
    // Leaflet inserts newest controls on top in bottom corners, so add in reverse.
    const myLocCtl = makeControl('My location', MYLOC_SVG, () => {
      if (!navigator.geolocation) { noticeRef.current?.('Geolocation not supported'); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const pt: LatLon = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          map.flyTo([pt.lat, pt.lon], Math.max(map.getZoom(), 14), { duration: 0.7 });
          if (youRef.current) youRef.current.clearLayers();
          else { youRef.current = L.layerGroup().addTo(map); }
          L.circleMarker([pt.lat, pt.lon], {
            radius: 7, color: '#3b82f6', weight: 3, fillColor: '#60a5fa', fillOpacity: 1,
          }).addTo(youRef.current).bindTooltip('You are here');
        },
        () => noticeRef.current?.('Location access denied.'),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });
    myLocCtl.addTo(map);

    if (toggleRef.current) {
      const expandCtl = makeControl('Expand map', EXPAND_SVG, () => toggleRef.current?.());
      expandCtl.addTo(map);
      expandLinkRef.current = (expandCtl as L.Control).getContainer()?.querySelector('a') ?? null;
    }
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    overlayRef.current = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (justDraggedRef.current) return;
      const pt = { lat: e.latlng.lat, lon: e.latlng.lng };
      if (modeRef.current === 'edit' || modeRef.current === 'draw') {
        changeRef.current?.([...pointsRef.current, pt]);
      } else {
        // A double-click (zoom) fires two clicks first: wait briefly and drop the pick if it becomes a dblclick.
        if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = window.setTimeout(() => {
          clickTimerRef.current = null;
          pickRef.current?.(pt, map.getZoom());
        }, 260);
      }
    });
    const cancelPendingPick = () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
    };
    map.on('dblclick', cancelPendingPick);
    map.on('movestart', cancelPendingPick);

    // The container is sized by CSS after mount; keep Leaflet in sync.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(elRef.current);

    return () => {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      ro.disconnect();
      youRef.current = null;
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
      tileRef.current = null;
      expandLinkRef.current = null;
    };
  }, []);

  // Editing affordances: crosshair cursor, and no double-click zoom while placing points or picking.
  useEffect(() => {
    const map = mapRef.current;
    const el = elRef.current;
    if (!map || !el) return;
    const editing = mode === 'edit' || mode === 'draw';
    el.classList.toggle('drawing', editing);
    el.classList.toggle('picking', !editing && addLakeMode);
    if (editing || addLakeMode) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [mode, addLakeMode]);

  // Expand / collapse control label follows the state.
  useEffect(() => {
    const a = expandLinkRef.current;
    if (!a) return;
    a.innerHTML = expanded ? COLLAPSE_SVG : EXPAND_SVG;
    a.title = expanded ? 'Exit full screen' : 'Expand map';
    a.setAttribute('aria-label', a.title);
    mapRef.current?.invalidateSize();
  }, [expanded, hasExpand]);

  // Swap tiles without recreating the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const p = mapProviders[style];
    if (tileRef.current) {
      tileRef.current.remove();
      tileRef.current = null;
    }
    const layer = L.tileLayer(p.url, { attribution: p.attribution, maxZoom: 19 });
    let errors = 0;
    let loaded = false;
    layer.on('tileload', () => {
      loaded = true;
      errors = 0;
    });
    layer.on('tileerror', () => {
      errors += 1;
      if (errors === 4 && !loaded) {
        noticeRef.current?.("Map tiles aren't loading. Check your connection or an ad blocker.");
      }
    });
    tileRef.current = layer.addTo(map);
  }, [style, theme]);

  // Frame the lake when it changes (or when `focus` is bumped).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    fitLake(map, lake, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id, focus]);

  // Move to a searched place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    map.flyTo([flyTo.lat, flyTo.lon], flyTo.zoom, { duration: 0.9 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.nonce]);

  // Redraw overlays: boundaries, grid, path, robot, edit handles.
  useEffect(() => {
    const map = mapRef.current;
    const group = overlayRef.current;
    if (!map || !group) return;
    group.clearLayers();

    const onImagery = style !== 'light';
    const ink = onImagery ? '#ffffff' : '#0f5c33';
    const water = onImagery ? '#0d3a29' : '#1d6b3c';
    const halo = onImagery ? ink : '#ffffff';

    if (!(mode === 'edit' || mode === 'draw')) {
      for (const o of otherLakes) {
        if (o.id === lake?.id || o.points.length < 3) continue;
        L.polygon(o.points.map(toLeaflet), {
          color: onImagery ? '#cfe3d6' : '#5b7f6a',
          weight: 1.5,
          dashArray: '4 4',
          fillColor: '#5b7f6a',
          fillOpacity: 0.06,
          interactive: false,
        }).addTo(group);
      }
    }

    const osm = referencePoints === undefined ? lake?.osmBoundary?.points ?? null : referencePoints;
    const saved = lake?.scrubBoundary?.points ?? null;
    const editing = mode === 'edit' || mode === 'draw';

    // Reference outline is only useful when it differs from the saved one.
    if (osm && osm.length >= 2 && (editing || (referencePoints === undefined && !saved))) {
      L.polyline(osm.map(toLeaflet), { color: '#8a978d', weight: 2, dashArray: '6 5', interactive: false })
        .addTo(group)
        .bindTooltip('OSM reference boundary');
    }

    const savedHoles = lake?.scrubBoundary ? lake.scrubBoundary.holes ?? [] : lake?.osmBoundary?.holes ?? [];
    const displayHoles = editing ? workingHoles : savedHoles;
    const displayBoundary = editing ? workingPoints : saved ?? (lake?.osmBoundary?.points ?? null);
    if (displayBoundary && displayBoundary.length >= 2) {
      const shape =
        displayBoundary.length >= 3
          ? L.polygon(ringsToLeaflet(displayBoundary, displayHoles), {
              color: ink,
              weight: onImagery ? 2 : 2.5,
              fillColor: water,
              fillOpacity: onImagery ? 0.55 : 0.1,
              interactive: false,
            })
          : L.polyline(displayBoundary.map(toLeaflet), { color: ink, weight: 2 });
      shape.addTo(group);
    }

    // Point-only lake (OSM has no polygon yet): mark where it is so it can be outlined.
    if (lake && !editing && (!displayBoundary || displayBoundary.length < 3)) {
      L.circleMarker(toLeaflet(lake.center), {
        radius: 9,
        color: '#ffffff',
        weight: 3,
        fillColor: '#0f5c33',
        fillOpacity: 1,
      })
        .addTo(group)
        .bindTooltip(`${lake.name ?? 'Lake'} — no outline yet`);
    }

    if (showGrid && gridCells.length > 0) {
      for (const cell of gridCells) {
        L.polygon(cell.polygon.map(toLeaflet), {
          color: '#2f7f8f',
          weight: 1,
          fillColor: '#2f7f8f',
          fillOpacity: 0.06,
          interactive: false,
        }).addTo(group);
      }
    }

    // Heatmap overlay: color each grid cell by a sensor value.
    // Visited cells get a distinct green overlay; unvisited get the sensor color.
    if (heatmapCells.length > 0 && gridCells.length > 0) {
      const cellByCode = new Map(gridCells.map((c) => [c.id, c]));
      const VISITED_COLOR = '#16a34a';
      const VISITED_WEIGHT = 2;
      for (const hc of heatmapCells) {
        const cell = cellByCode.get(hc.gridCode);
        if (!cell) continue;
        const visited = visitedGridIds.has(hc.gridCode);
        const fillColor = visited ? VISITED_COLOR : hc.color;
        const fillOp = visited ? 0.35 : 0.45;
        const w = visited ? VISITED_WEIGHT : 1;
        const border = visited ? '#15803d' : hc.color;
        L.polygon(cell.polygon.map(toLeaflet), {
          color: border,
          weight: w,
          fillColor,
          fillOpacity: fillOp,
          interactive: false,
        })
          .addTo(group)
          .bindTooltip(
            visited
              ? `${hc.gridCode} visited${hc.value !== null ? ` — ${hc.value.toFixed(1)}` : ''}`
              : hc.value !== null ? `${hc.gridCode}: ${hc.value.toFixed(1)}` : hc.gridCode,
            { sticky: true },
          );
      }
    }

    // A clicked water body waiting for "Select": highlighted so it is clearly not yet chosen.
    if (previewPoints && previewPoints.length >= 3 && !editing) {
      L.polygon(ringsToLeaflet(previewPoints, previewHoles), {
        color: '#f59e0b',
        weight: 3,
        dashArray: '9 6',
        fillColor: '#f59e0b',
        fillOpacity: 0.22,
        interactive: false,
      }).addTo(group);
    }

    if (plannedPath.length >= 2) {
      L.polyline(plannedPath.map(toLeaflet), { color: ink, weight: 2.5, opacity: 0.9, interactive: false }).addTo(group);
      for (const pt of plannedPath) {
        L.circleMarker(toLeaflet(pt), {
          radius: 3.5,
          color: halo,
          fillColor: ink,
          fillOpacity: 1,
          weight: onImagery ? 1 : 1.5,
          interactive: false,
        }).addTo(group);
      }
      for (const d of detours) {
        L.polyline(d.map(toLeaflet), { color: '#f59e0b', weight: 4, opacity: 0.95, interactive: false })
          .addTo(group)
          .bindTooltip('Detour around land');
      }
      for (const [a, b] of blockedLegs) {
        L.polyline([toLeaflet(a), toLeaflet(b)], { color: '#ef4444', weight: 3.5, dashArray: '6 6', interactive: false })
          .addTo(group)
          .bindTooltip('Blocked: crosses land');
      }
      L.marker(toLeaflet(plannedPath[0]), {
        interactive: false,
        icon: L.divIcon({ className: 'base-marker', html: '<span>A</span>', iconSize: [24, 24], iconAnchor: [12, 12] }),
      })
        .addTo(group)
        .bindTooltip('Base — path start');
    }

    if (editing) {
      workingPoints.forEach((pt, i) => {
        const marker = L.circleMarker(toLeaflet(pt), {
          radius: 6,
          color: '#1d6b3c',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 2,
          bubblingMouseEvents: false,
        }).addTo(group);
        marker.bindTooltip(`Point ${i + 1} — drag to move, right-click to remove`);
        marker.on('contextmenu', () => {
          changeRef.current?.(pointsRef.current.filter((_, j) => j !== i));
        });
        marker.on('mousedown', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          map.dragging.disable();
          const move = (me: L.LeafletMouseEvent) => marker.setLatLng(me.latlng);
          const up = (ue: L.LeafletMouseEvent) => {
            map.off('mousemove', move as never);
            map.off('mouseup', up as never);
            map.dragging.enable();
            justDraggedRef.current = true;
            window.setTimeout(() => {
              justDraggedRef.current = false;
            }, 0);
            changeRef.current?.(
              pointsRef.current.map((p, j) => (j === i ? { lat: ue.latlng.lat, lon: ue.latlng.lng } : p)),
            );
          };
          map.on('mousemove', move as never);
          map.on('mouseup', up as never);
        });
      });
    }

    if (robot) {
      L.circleMarker(toLeaflet(robot), {
        radius: 15,
        color: '#22c55e',
        weight: 0,
        fillColor: '#22c55e',
        fillOpacity: 0.25,
        interactive: false,
      }).addTo(group);
      L.circleMarker(toLeaflet(robot), {
        radius: 7,
        color: '#ffffff',
        weight: 3,
        fillColor: '#22c55e',
        fillOpacity: 1,
      })
        .addTo(group)
        .bindTooltip('Robot — live GPS');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake, workingPoints, workingHoles, mode, gridCells, showGrid, robot, plannedPath, style, previewPoints, previewHoles, referencePoints, otherLakes, detours, blockedLegs, heatmapCells, visitedGridIds]);

  return (
    <>
      {backTo ? (
        <Link to={backTo} className="map-back" aria-label="Back to home">
          <ChevronLeft size={14} /> Back
        </Link>
      ) : null}
      {showLegend ? (
        <div className="map-legend" aria-label="Map legend">
          <span><i className="lg-dot" style={{ background: '#2f7bf6' }} /> Base</span>
          <span><i className="lg-dot" style={style === 'light' ? { background: '#0f5c33', boxShadow: '0 0 0 2px #fff' } : { background: '#fff' }} /> Waypoint</span>
          <span><i className="lg-line" style={style === 'light' ? { background: '#0f5c33', boxShadow: '0 0 0 1.5px #fff' } : undefined} /> Planned Path</span>
          <span><i className="lg-ring" /> Current Position</span>
          {detours.length > 0 ? <span><i className="lg-line" style={{ background: '#f59e0b', height: 3 }} /> Detour around land</span> : null}
          {blockedLegs.length > 0 ? <span><i className="lg-line" style={{ background: '#ef4444', height: 3 }} /> Blocked leg</span> : null}
        </div>
      ) : null}
      <div ref={elRef} className="leaflet-map" role="application" aria-label="Lake map" />
    </>
  );
}
