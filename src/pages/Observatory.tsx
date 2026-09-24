import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, X } from 'lucide-react';
import { LakeSearch } from '../components/LakeSearch';
import { LakeSetupPanel } from '../components/LakeSetupPanel';
import { LakeThumb } from '../components/LakeThumb';
import { Navbar } from '../components/Navbar';
import { ObservatoryMap } from '../components/ObservatoryMap';
import type { MapMode } from '../components/ObservatoryMap';
import { PageHeader } from '../components/PageHeader';
import { useLake, isSampleId } from '../stores/lake';
import { useTelemetry } from '../stores/telemetry';
import { identifyWaterAt, reverseLocality } from '../services/osm/osmService';
import type { MapStyle } from '../services/osm/osmService';
import { getOrCreateSupabaseLakeId } from '../services/storage/lakeStorage';
import { DEMO, demoLocality, isDemoId } from '../demo/demo';
import { fmtArea } from '../utils/format';
import { openRing, polygonAreaSqM, ringCenter, scaleRing, simplifyRing, cellsToCsv, downloadCsv } from '../utils/geo';
import type { Lake, LatLon } from '../types';

/** Below this zoom a click covers far too much ground to mean one lake. */
const MIN_PICK_ZOOM = 10;

/** Click tolerance at the shoreline: about 4 screen pixels of ground, kept within 20-120 m. */
function pickToleranceM(lat: number, zoom: number): number {
  const metresPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  return Math.round(Math.min(120, Math.max(20, metresPerPixel * 4)));
}

/** "Map" is OpenStreetMap; "Dark" is OSM data in a dark style; "Satellite" is Esri imagery. */
const STYLES: Array<{ label: string; value: MapStyle }> = [
  { label: 'Map', value: 'light' },
  { label: 'Satellite', value: 'satellite' },
  { label: 'Dark', value: 'dark' },
];

/** the editable outline plus its (uneditable, but scaled-with-it) islands */
interface Shape {
  points: LatLon[];
  holes: LatLon[][];
}

interface Preview {
  lake: Lake;
  /** true when this water body is already in the user's lake list */
  known: boolean;
}

export function ObservatoryPage() {
  const { lake, recent, selectLake, removeLake, snapshots, cells, boundary, holes, saveBoundary, gridTooFine, addPolygon, cellSizeM } = useLake();
  const { telemetry } = useTelemetry();
  const [mapStyle, setMapStyle] = useState<MapStyle>('light');
  const [localities, setLocalities] = useState<Record<string, string>>({});
  const [editMode, setEditMode] = useState<MapMode>('browse');
  const [editTarget, setEditTarget] = useState<'selected' | 'preview' | 'newPolygon'>('selected');
  const [working, setWorking] = useState<LatLon[]>([]);
  const [workingHoles, setWorkingHoles] = useState<LatLon[][]>([]);
  const [history, setHistory] = useState<Shape[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picking, setPicking] = useState(false);
  const [addLakeMode, setAddLakeMode] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [flyTo, setFlyTo] = useState<{ lat: number; lon: number; zoom: number; nonce: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'busy' | 'warn' } | null>(null);
  const workingRef = useRef<LatLon[]>([]);
  workingRef.current = working;
  const holesRef = useRef<LatLon[][]>([]);
  holesRef.current = workingHoles;

  const editing = editMode !== 'browse';

  // Selecting a different lake (search, list, or Select) discards any edit or preview in progress.
  useEffect(() => {
    setEditMode('browse');
    setEditTarget('selected');
    setWorking([]);
    setWorkingHoles([]);
    setHistory([]);
    setPreview(null);
    setAddLakeMode(false);
  }, [lake?.id]);

  useEffect(() => {
    const targets = [...recent];
    if (lake && !targets.some((l) => l.id === lake.id)) targets.push(lake);
    for (const l of targets) {
      if (localities[l.id]) continue;
      if (isDemoId(l.id)) {
        setLocalities((p) => ({ ...p, [l.id]: demoLocality[l.id] ?? '—' }));
        continue;
      }
      void reverseLocality(l.center).then((label) => {
        if (label) setLocalities((p) => (p[l.id] ? p : { ...p, [l.id]: label }));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, lake?.id]);

  // Warnings fade on their own; the "finding" state stays until the lookup ends.
  useEffect(() => {
    if (toast?.tone !== 'warn') return;
    const id = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Full-screen map: lock page scroll while open.
  useEffect(() => {
    if (!expanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  const lat = telemetry?.gps.latitude ?? null;
  const lon = telemetry?.gps.longitude ?? null;
  const robot = useMemo(() => (lat !== null && lon !== null ? { lat, lon } : null), [lat, lon]);

  const previewPoints = preview ? preview.lake.scrubBoundary?.points ?? preview.lake.osmBoundary?.points ?? null : null;
  const previewArea = previewPoints ? polygonAreaSqM(previewPoints) : null;
  const previewHoles = preview ? (preview.lake.scrubBoundary ? preview.lake.scrubBoundary.holes : preview.lake.osmBoundary?.holes) ?? [] : [];
  const otherLakes = useMemo(
    () =>
      recent
        .filter((l) => l.id !== lake?.id)
        .map((l) => ({ id: l.id, points: l.scrubBoundary?.points ?? l.osmBoundary?.points ?? [] }))
        .filter((o) => o.points.length >= 3),
    [recent, lake?.id],
  );

  // ── boundary editor (with undo history) ───────────────────────────────
  const applyWorking = (next: LatLon[], nextHoles?: LatLon[][]) => {
    // Capture the previous shape NOW: React runs the updater later, after the refs below change.
    const previous: Shape = { points: workingRef.current, holes: holesRef.current };
    setHistory((h) => [...h, previous]);
    workingRef.current = next;
    setWorking(next);
    if (nextHoles) {
      holesRef.current = nextHoles;
      setWorkingHoles(nextHoles);
    }
  };
  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    workingRef.current = prev.points;
    holesRef.current = prev.holes;
    setWorking(prev.points);
    setWorkingHoles(prev.holes);
    setHistory(history.slice(0, -1));
  };
  const resetEditor = () => {
    setEditMode('browse');
    setEditTarget('selected');
    setWorking([]);
    setWorkingHoles([]);
    setHistory([]);
  };

  // A 600-vertex OSM outline is unusable by hand, so editing starts from a simplified copy.
  // Islands are kept as they are (and scale with the outline).
  const startEdit = () => {
    setEditTarget('selected');
    setHistory([]);
    setWorking(simplifyRing(boundary ?? [], 60));
    setWorkingHoles(holes);
    setEditMode('edit');
  };

    const startDrawPolygon = () => {
    setEditTarget('newPolygon');
    setHistory([]);
    setWorking([]);
    setWorkingHoles([]);
    setEditMode('draw');
  };
  const startDraw = () => {
    setEditTarget('selected');
    setHistory([]);
    setWorking([]);
    setWorkingHoles([]);
    setEditMode('draw');
  };
  const startEditPreview = () => {
    if (!previewPoints) return;
    setEditTarget('preview');
    setHistory([]);
    setWorking(simplifyRing(previewPoints, 60));
    setWorkingHoles(previewHoles);
    setEditMode('edit');
  };
    const saveEdit = () => {
    if (working.length < 3) return;
    if (editTarget === 'preview' && preview) {
      selectLake({ ...preview.lake, scrubBoundary: { points: working, holes: workingHoles }, updatedAt: new Date().toISOString() });
      return; // the lake-id change effect clears the rest
    }
    if (editTarget === 'newPolygon') {
      addPolygon(working, workingHoles);
      return; // the lake-id change effect clears the rest
    }
    saveBoundary(working, workingHoles);
    resetEditor();
  };
  const resetToOsm = () => {
    if (lake?.osmBoundary) saveBoundary(lake.osmBoundary.points, lake.osmBoundary.holes ?? []);
  };
  const resize = (factor: number) => {
    if (working.length < 3) return;
    const about = ringCenter(openRing(working));
    applyWorking(scaleRing(openRing(working), factor, about), workingHoles.map((h) => scaleRing(h, factor, about)));
  };

  // ── click a water body: preview its boundary, then Select ─────────────
  const pickAt = async (pt: LatLon, zoom: number) => {
    if (editing || picking || !addLakeMode) return;
    if (zoom < MIN_PICK_ZOOM) {
      setToast({ text: 'Zoom in closer, then click a lake.', tone: 'warn' });
      return;
    }
    setPicking(true);
    setToast({ text: 'Finding water body…', tone: 'busy' });
    try {
      const found = await identifyWaterAt(pt, pickToleranceM(pt.lat, zoom));
      if (!found) {
        setPreview(null);
        setToast({ text: 'No water body in OpenStreetMap at that spot. Click on the water, or search by name.', tone: 'warn' });
        return;
      }
      // A lake we already know keeps its edited boundary and grid size.
      const known = recent.find((l) => l.id === found.id);
      const candidate: Lake = known ?? {
        ...found,
        name: found.name ?? 'Unnamed water body',
        scrubBoundary: found.osmBoundary ? { points: found.osmBoundary.points, holes: found.osmBoundary.holes ?? [] } : null,
      };
      setPreview({ lake: candidate, known: !!known });
      setToast(null);
    } catch {
      setToast({ text: "Couldn't reach OpenStreetMap. Check your connection and try again.", tone: 'warn' });
    } finally {
      setPicking(false);
    }
  };
  const confirmPreview = () => {
    if (!preview) return;
    selectLake(preview.lake);
    setPreview(null);
    setAddLakeMode(false);
  };

  // Esc backs out one level: edit -> preview -> full screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) {
        if (editTarget === 'preview') setEditMode('browse');
        else resetEditor();
        setEditTarget('selected');
        setWorking([]);
        setWorkingHoles([]);
        setHistory([]);
      } else if (preview) setPreview(null);
      else if (addLakeMode) setAddLakeMode(false);
      else if (expanded) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, editTarget, preview, expanded, addLakeMode]);

  const cancelEdit = () => {
    if (editTarget === 'preview') {
      // back to the preview card, nothing selected
      setEditMode('browse');
      setEditTarget('selected');
      setWorking([]);
      setWorkingHoles([]);
      setHistory([]);
    } else {
      resetEditor();
    }
  };

  return (
    <>
      <Navbar />
      <main className="page">
        <div className="obs-layout">
          <div className="obs-side">
            <PageHeader title="Lake Observatory" sub="Select a lake to view real-time data and analysis." />
            <LakeSearch onGoTo={(la, lo) => setFlyTo({ lat: la, lon: lo, zoom: 14, nonce: Date.now() })} />

                        <button
              type="button"
              className={addLakeMode ? 'btn-primary btn-block' : 'btn btn-block'}
              style={{ marginTop: 12 }}
              onClick={() => setAddLakeMode((v) => !v)}
            >
              {addLakeMode ? 'Cancel adding' : 'Add Lake'}
            </button>
            <button
              type="button"
              className="btn btn-block"
              style={{ marginTop: 8 }}
              onClick={startDrawPolygon}
              disabled={editing || addLakeMode}
            >
              Add Polygon
            </button>

              <LakeSetupPanel
                editMode={editMode}
                onEdit={startEdit}
                onDraw={startDraw}
                onResetToOsm={resetToOsm}
              />

            {recent.length > 0 && (
              <ul className="lake-list">
                {recent.map((l) => {
                  const active = lake?.id === l.id;
                  const snap = snapshots[l.id];
                  return (
                    <li key={l.id}>
                      <button type="button" className={`lake-card${active ? ' active' : ''}`} onClick={() => selectLake(l)}>
                        <LakeThumb
                          points={l.scrubBoundary?.points ?? l.osmBoundary?.points ?? null}
                          holes={(l.scrubBoundary ? l.scrubBoundary.holes : l.osmBoundary?.holes) ?? []}
                        />
                        <span className="lake-card-body">
                          <strong>{l.name ?? '—'}</strong>
                          <span className="lake-card-sub">{localities[l.id] ?? '—'}</span>
                          <span className="lake-card-status">
                            <span className={`dot${active ? ' live' : ''}`} aria-hidden="true" />
                            {active ? (gridTooFine || cells.length === 0 ? '— grids' : `${cells.length} grids`) : snap ? `${snap.cellCount} grids` : '— grids'} · {active ? 'Active' : 'Inactive'}
                          </span>
                        </span>
                        <span className="lake-card-chevron"><ChevronRight size={18} /></span>
                      </button>
                      <button
                        type="button"
                        className="lake-card-remove"
                        title="Remove lake"
                        onClick={(e) => { e.stopPropagation(); removeLake(l.id); }}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className={`map-wrap tall${expanded ? ' expanded' : ''}`}>
            <ObservatoryMap
              mode={editMode}
              style={mapStyle}
              workingPoints={working}
              onWorkingChange={applyWorking}
              onPickPoint={(pt, zoom) => void pickAt(pt, zoom)}
              gridCells={cells}
              showGrid={!editing}
              robot={robot}
              previewPoints={editing ? null : previewPoints}
              previewHoles={previewHoles}
              workingHoles={workingHoles}
              otherLakes={otherLakes}
              referencePoints={editing && editTarget === 'preview' ? preview?.lake.osmBoundary?.points ?? null : undefined}
              flyTo={flyTo}
              expanded={expanded}
              onToggleExpand={() => setExpanded((v) => !v)}
              onNotice={(text) => setToast({ text, tone: 'warn' })}
              addLakeMode={addLakeMode}
            />

            {toast && (
              <div className={`map-toast ${toast.tone}`} role="status">
                {toast.tone === 'busy' ? <i className="spinner" aria-hidden="true" /> : null}
                {toast.text}
              </div>
            )}

            {!editing && !toast && !preview && (
              <div className="map-tip">
                {addLakeMode
                  ? 'Click on a water body to add it'
                  : 'Click "Add Lake", then click a water body'}
              </div>
            )}

            {editing && (
              <div className="map-edit" role="group" aria-label="Boundary editor">
                <span>
                  {editMode === 'draw' ? 'Click the map to place points' : 'Drag points · right-click removes · click adds'}
                  {' · '}
                  <strong>{working.length} point{working.length === 1 ? '' : 's'}</strong>
                </span>
                <div>
                  {working.length >= 3 && (
                    <span className="me-group" role="group" aria-label="Resize outline">
                      Resize
                      <button type="button" onClick={() => resize(0.9)} title="Shrink the outline by 10%">−10%</button>
                      <button type="button" onClick={() => resize(1.1)} title="Grow the outline by 10%">+10%</button>
                    </span>
                  )}
                  <button type="button" onClick={undo} disabled={history.length === 0}>Undo</button>
                  <button type="button" onClick={cancelEdit}>Cancel</button>
                  <button type="button" className="save" onClick={saveEdit} disabled={working.length < 3}>
                    {editTarget === 'preview' ? 'Select lake' : 'Save boundary'}
                  </button>
                </div>
              </div>
            )}

            {preview && !editing && (
              <div className="map-preview" role="dialog" aria-label="Water body found">
                <span className="mp-eyebrow">Water body found</span>
                <strong>{preview.lake.name ?? 'Unnamed water body'}</strong>
                <span className="lake-detail-sub">
                  {fmtArea(previewArea)}
                  {previewPoints ? ` · ${openRing(previewPoints).length} points` : ''}
                  {previewHoles.length > 0 ? ` · ${previewHoles.length} island${previewHoles.length === 1 ? '' : 's'}` : ''}
                  {preview.known ? ' · already in your lakes' : ''}
                </span>
                <button type="button" className="btn-primary btn-block" onClick={confirmPreview} autoFocus>Select this lake</button>
                <div className="mp-row">
                  <button type="button" className="btn btn-sm" onClick={startEditPreview}>Adjust outline</button>
                  <button type="button" className="btn btn-sm" onClick={() => setPreview(null)}>Cancel</button>
                </div>
              </div>
            )}

            {lake && !editing && !preview && (
              <div className="lake-detail">
                <strong>{lake.name ?? '—'}</strong>
                <span className="lake-detail-sub">{localities[lake.id] ?? '—'}</span>
                <dl>
                  <div><dt>Grids</dt><dd>{gridTooFine || cells.length === 0 ? '—' : String(cells.length)}</dd></div>
                </dl>
                <Link to="/analytics" className="btn-primary btn-block">View Details</Link>
                {cells.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-block"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      const supabaseLakeId = getOrCreateSupabaseLakeId(lake.id);
                      const csv = cellsToCsv(cells, { lakeId: supabaseLakeId, cellSizeM });
                      const tag = (lake.name ?? 'lake').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                      downloadCsv(csv, `${tag}_grid.csv`);
                    }}
                  >
                    Download Grid CSV
                  </button>
                )}
              </div>
            )}

            <div className="map-seg" role="group" aria-label="Map style">
              {STYLES.map((s) => (
                <button key={s.value} type="button" aria-pressed={mapStyle === s.value} onClick={() => setMapStyle(s.value)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {DEMO && <p className="demo-note">Demo data — set VITE_DEMO=0 to use live sources.</p>}
      </main>
    </>
  );
}
