import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { GridCell, GridConfiguration, Lake, LatLon } from '../types';
import {
  clearSavedLake,
  loadDeletedDemoIds,
  loadDeletedIds,
  loadGridConfigs,
  loadGridSnapshots,
  loadRecentLakes,
  loadSavedLake,
  nextPolygonNumber,
  rememberLake,
  removeLake as removeLakeFromStorage,
  saveGridConfig,
  saveGridSnapshot,
  saveLake,
} from '../services/storage/lakeStorage';
import type { GridSnapshot } from '../services/storage/lakeStorage';
import { DEMO, demoLakes, isDemoId } from '../demo/demo';
import { generateGrid, gridExceedsLimit, ringCenter, suggestCellSizeM } from '../utils/geo';
/** Sampling cell edge in metres, used until a lake has its own grid config. */
export const DEFAULT_CELL_SIZE_M = 20;
export const MIN_CELL_SIZE_M = 8;
export const MAX_CELL_SIZE_M = 80;
export const MAX_SHORE_MARGIN_M = 100;
/** Sample polygons (drawn for testing, not real lakes) never collide with lake or demo ids. */
export const isSampleId = (id: string) => id.startsWith('sam:');

interface LakeCtx {
  lake: Lake | null;
  /** previously selected lakes, most recent first */
  recent: Lake[];
  selectLake: (lake: Lake) => void;
  clearLake: () => void;
  clearAll: () => void;
  removeLake: (lakeId: string) => void;
  /** Persist an edited or hand-drawn SCRUB boundary (with its islands, if any). */
  saveBoundary: (points: LatLon[], holes?: LatLon[][]) => void;
  /** Create and select a new sample polygon (SAM1, SAM2, ...) from hand-drawn points — for testing outside real lakes. */
  addPolygon: (points: LatLon[], holes?: LatLon[][], name?: string) => void;
  boundary: LatLon[] | null;
  /** islands inside the active outline; the grid and path avoid them */
  holes: LatLon[][];
  gridConfig: GridConfiguration | null;
  /** cell size actually used for `cells` (this lake's config or the default) */
  cellSizeM: number;
  /** change the active lake's grid size in metres (clamped, remembered per lake) */
  setCellSize: (cellSizeM: number) => void;
  /** keep sampling points at least this far (m) from the shore and islands; 0 = off */
  shoreMarginM: number;
  setShoreMargin: (metres: number) => void;
  cells: GridCell[];
  /** true when the cell size is so small the grid would exceed the cell limit */
  gridTooFine: boolean;
  regenerate: () => void;
  /** real generated grid counts per lake id */
  snapshots: Record<string, GridSnapshot>;
}

const Ctx = createContext<LakeCtx>({
  lake: null,
  recent: [],
  selectLake: () => undefined,
  clearLake: () => undefined,
  clearAll: () => undefined,
  removeLake: () => undefined,
  saveBoundary: () => undefined,
  addPolygon: () => undefined,
  boundary: null,
  holes: [],
  gridConfig: null,
  cellSizeM: DEFAULT_CELL_SIZE_M,
  setCellSize: () => undefined,
  shoreMarginM: 0,
  setShoreMargin: () => undefined,
  cells: [],
  gridTooFine: false,
  regenerate: () => undefined,
  snapshots: {},
});


function boundaryOf(lake: Lake | null): LatLon[] | null {
  return lake?.scrubBoundary?.points ?? lake?.osmBoundary?.points ?? null;
}

function holesOf(lake: Lake | null): LatLon[][] {
  if (!lake) return [];
  return (lake.scrubBoundary ? lake.scrubBoundary.holes : lake.osmBoundary?.holes) ?? [];
}

/** Demo lakes only exist in demo mode; they never leak into a real session. */
function initialLake(): Lake | null {
  const saved = loadSavedLake();
  if (saved && !loadDeletedIds().has(saved.id) && (DEMO || !isDemoId(saved.id))) return saved;
  if (DEMO) {
    const deleted = loadDeletedDemoIds();
    return demoLakes.find((l) => !deleted.has(l.id)) ?? null;
  }
  return null;
}

function initialRecent(): Lake[] {
  const allDeleted = loadDeletedIds();
  const saved = loadRecentLakes().filter((l) => !allDeleted.has(l.id) && (DEMO || !isDemoId(l.id)));
  if (DEMO) {
    const deleted = loadDeletedDemoIds();
    const ids = new Set(saved.map((l) => l.id));
    return [...saved, ...demoLakes.filter((l) => !ids.has(l.id) && !deleted.has(l.id) && !allDeleted.has(l.id))].slice(0, 20);
  }
  return saved;
}

function initialSnapshots(): Record<string, GridSnapshot> {
  const all = loadGridSnapshots();
  if (!DEMO) return all;
  for (const l of demoLakes) {
    const b = boundaryOf(l);
    if (b) {
      all[l.id] = {
        lakeId: l.id,
        cellSizeM: DEFAULT_CELL_SIZE_M,
        cellCount: generateGrid(b, DEFAULT_CELL_SIZE_M).length,
        updatedAt: l.updatedAt,
      };
    }
  }
  return all;
}

export function LakeProvider({ children }: { children: ReactNode }) {
  const [lake, setLake] = useState<Lake | null>(initialLake);
  const [recent, setRecent] = useState<Lake[]>(initialRecent);
  const [gridConfigs, setGridConfigs] = useState<Record<string, GridConfiguration>>(() => loadGridConfigs());
  const [snapshots, setSnapshots] = useState<Record<string, GridSnapshot>>(initialSnapshots);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (lake && !isDemoId(lake.id)) saveLake(lake);
  }, [lake]);

  /** First-time grid sizing for a lake that doesn't have a saved config yet. Never overwrites a user's own choice. */
  const autoConfigureGrid = useCallback((lakeId: string, boundary: LatLon[] | null) => {
    if (!boundary || boundary.length < 3) return;
    setGridConfigs((all) => {
      if (all[lakeId]) return all; // respect an existing config
      const cfg: GridConfiguration = {
        cellSizeM: suggestCellSizeM(boundary),
        shoreMarginM: 0,
        lakeId,
        updatedAt: new Date().toISOString(),
      };
      if (!isDemoId(lakeId)) saveGridConfig(cfg);
      return { ...all, [lakeId]: cfg };
    });
  }, []);

  const selectLake = useCallback(
    (next: Lake) => {
      setLake(next);
      saveLake(next);
      setRecent(rememberLake(next));
      autoConfigureGrid(next.id, boundaryOf(next));
    },
    [autoConfigureGrid],
  );

  const addPolygon = useCallback(
    (points: LatLon[], holes: LatLon[][] = [], name?: string) => {
      if (points.length < 3) return;
      const n = nextPolygonNumber();
      const next: Lake = {
        id: `sam:${n}`,
        name: name?.trim() || `Sample Polygon ${n}`,
        waterType: 'sample',
        center: ringCenter(points),
        osmBoundary: null,
        scrubBoundary: { points, holes },
        updatedAt: new Date().toISOString(),
      };
      selectLake(next);
    },
    [selectLake],
  );

  const clearLake = useCallback(() => {
    setLake(null);
    clearSavedLake();
  }, []);

  const clearAll = useCallback(() => {
    setLake(null);
    setRecent([]);
    localStorage.removeItem('scrub:lakes');
    localStorage.removeItem('scrub:recent');
    localStorage.removeItem('scrub:savedLake');
    localStorage.removeItem('scrub:gridConfigs');
    localStorage.removeItem('scrub:gridSnapshots');
    localStorage.removeItem('scrub:deletedDemos');
    localStorage.removeItem('scrub:deletedIds');
  }, []);

  const removeLake = useCallback((lakeId: string) => {
    removeLakeFromStorage(lakeId);
    setRecent((prev) => prev.filter((l) => l.id !== lakeId));
    setLake((prev) => (prev && prev.id === lakeId ? null : prev));
  }, []);

  const saveBoundary = useCallback(
    (points: LatLon[], holes: LatLon[][] = []) => {
      setLake((prev) => {
        if (!prev) return prev;
        const next: Lake = { ...prev, scrubBoundary: { points, holes }, updatedAt: new Date().toISOString() };
        if (!isDemoId(next.id)) {
          saveLake(next);
          setRecent(rememberLake(next));
        }
        return next;
      });
      if (lake) autoConfigureGrid(lake.id, points);
    },
    [lake, autoConfigureGrid],
  );

  const commitConfig = useCallback(
    (patch: Partial<Pick<GridConfiguration, 'cellSizeM' | 'shoreMarginM'>>) => {
      if (!lake) return;
      const prev = gridConfigs[lake.id];
      const cfg: GridConfiguration = {
        cellSizeM: prev?.cellSizeM ?? DEFAULT_CELL_SIZE_M,
        shoreMarginM: prev?.shoreMarginM ?? 0,
        ...patch,
        lakeId: lake.id,
        updatedAt: new Date().toISOString(),
      };
      setGridConfigs((all) => ({ ...all, [lake.id]: cfg }));
      if (!isDemoId(lake.id)) saveGridConfig(cfg);
    },
    [lake, gridConfigs],
  );

  const setCellSize = useCallback(
    (requested: number) => {
      if (!Number.isFinite(requested)) return;
      commitConfig({ cellSizeM: Math.min(MAX_CELL_SIZE_M, Math.max(MIN_CELL_SIZE_M, Math.round(requested))) });
    },
    [commitConfig],
  );

  const setShoreMargin = useCallback(
    (requested: number) => {
      if (!Number.isFinite(requested)) return;
      commitConfig({ shoreMarginM: Math.min(MAX_SHORE_MARGIN_M, Math.max(0, Math.round(requested))) });
    },
    [commitConfig],
  );

  const regenerate = useCallback(() => setGeneration((g) => g + 1), []);

  const gridConfig = lake ? gridConfigs[lake.id] ?? null : null;
  const cellSizeM = gridConfig?.cellSizeM ?? DEFAULT_CELL_SIZE_M;
  const boundary = useMemo(() => boundaryOf(lake), [lake]);
  const holes = useMemo(() => holesOf(lake), [lake]);
  const shoreMarginM = gridConfig?.shoreMarginM ?? 0;
  const gridTooFine = useMemo(
    () => (boundary && boundary.length >= 3 ? gridExceedsLimit(boundary, cellSizeM) : false),
    [boundary, cellSizeM],
  );

  const cells = useMemo(() => {
    void generation;
    if (!boundary || boundary.length < 3) return [];
    let lakePrefix: string;
    if (lake && isSampleId(lake.id)) {
      // sam:3 -> "SAM3" -> grid ids SAM3001, SAM3002, ...
      lakePrefix = `SAM${lake.id.split(':')[1] ?? ''}`;
    } else {
      const name = (lake?.name ?? '').trim();
      lakePrefix = name
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .split(/\s+/)
        .map((w) => w[0] ?? '')
        .join('')
        .toUpperCase()
        .slice(0, 3);
    }
    return generateGrid(boundary, cellSizeM, { holes, shoreMarginM, lakePrefix });
  }, [boundary, holes, cellSizeM, shoreMarginM, generation, lake?.name, lake?.id]);
  // Keep the per-lake grid count in sync with the grid actually generated.
  useEffect(() => {
    if (!lake || cells.length === 0) return;
    const cur = snapshots[lake.id];
    if (cur && cur.cellSizeM === cellSizeM && cur.cellCount === cells.length) return;
    const snap: GridSnapshot = {
      lakeId: lake.id,
      cellSizeM,
      cellCount: cells.length,
      updatedAt: new Date().toISOString(),
    };
    setSnapshots(isDemoId(lake.id) ? { ...snapshots, [lake.id]: snap } : saveGridSnapshot(snap));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake, cells.length, cellSizeM]);

  const value = useMemo<LakeCtx>(
    () => ({
      lake,
      recent,
      selectLake,
      clearLake,
      clearAll,
      removeLake,
      saveBoundary,
      boundary,
      holes,
      gridConfig,
      cellSizeM,
      setCellSize,
      shoreMarginM,
      setShoreMargin,
      cells,
      gridTooFine,
      regenerate,
      snapshots,
      addPolygon,
    }),
    [lake, recent, selectLake, clearLake, clearAll, removeLake, saveBoundary, boundary, holes, gridConfig, cellSizeM, setCellSize, shoreMarginM, setShoreMargin, cells, gridTooFine, regenerate, snapshots, addPolygon],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLake(): LakeCtx {
  return useContext(Ctx);
}