import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight, Download, Waypoints } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { ObservatoryMap } from '../components/ObservatoryMap';
import { PageHeader } from '../components/PageHeader';
import { useLake } from '../stores/lake';
import { useTelemetry } from '../stores/telemetry';
import { DEMO } from '../demo/demo';
import { planCoverage } from '../utils/geo';
import { downloadText, planFileName, planToCsv, planToGeoJson } from '../utils/exportPlan';
import { pushLakeAndGrids, createMission, fetchMissionProgress } from '../services/supabase/supabaseService';

/** Cruise speed used ONLY to estimate mission time (m/s). */
const PLANNING_SPEED_MPS = 0.8;

export function MissionPage() {
  const { lake, cells, cellSizeM, shoreMarginM, boundary, holes, gridTooFine } = useLake();
  const { telemetry } = useTelemetry();
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{ missionId: string | null; done: number; total: number; status: string | null }>({ missionId: null, done: 0, total: 0, status: null });

  // Poll mission progress every 8 seconds while a lake is selected.
  useEffect(() => {
    if (!lake) return;
    const load = async () => {
      try {
        const p = await fetchMissionProgress(lake.id);
        setProgress(p);
      } catch { /* silent background poll */ }
    };
    load();
    const id = window.setInterval(load, 8000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id]);

  // Every leg is checked against the shore and islands; legs that would cross land are rerouted.
  const plan = useMemo(() => planCoverage(cells, boundary, holes), [cells, boundary, holes]);
  const path = plan.path;
  const blockedLegs = plan.blocked.length;

  const lat = telemetry?.gps.latitude ?? null;
  const lon = telemetry?.gps.longitude ?? null;
  const robot = useMemo(() => (lat !== null && lon !== null ? { lat, lon } : null), [lat, lon]);

  const hasPlan = path.length > 0;

  const exportInput = { lake, boundary, holes, plan, cellSizeM, shoreMarginM, speedMps: PLANNING_SPEED_MPS, seconds: null };
  const exportGeoJson = () =>
    downloadText(planFileName(lake, 'geojson'), JSON.stringify(planToGeoJson(exportInput), null, 2), 'application/geo+json');
  const exportCsv = () => downloadText(planFileName(lake, 'csv'), planToCsv(exportInput), 'text/csv');

  const handleStartMission = async () => {
    if (blockedLegs > 0) {
      setNotice(`${blockedLegs} leg${blockedLegs === 1 ? ' of this plan crosses' : 's of this plan cross'} land and cannot be routed. Fix the plan before starting.`);
      return;
    }
    if (!lake || cells.length === 0) {
      setNotice('Select a lake with a grid before starting a mission.');
      return;
    }
    setSyncing(true);
    setNotice(null);
    try {
      const { lakeId, gridIds } = await pushLakeAndGrids(lake, cells, cellSizeM);
      // Visit order: map each coverage-path waypoint to its nearest grid cell.
      const remaining = new Set(cells.map((c) => c.id));
      const ordered: string[] = [];
      for (const wp of path) {
        let best: string | null = null;
        let bestD = Infinity;
        for (const c of cells) {
          if (!remaining.has(c.id)) continue;
          const d = (c.center.lat - wp.lat) ** 2 + (c.center.lon - wp.lon) ** 2;
          if (d < bestD) { bestD = d; best = c.id; }
        }
        if (best) {
          remaining.delete(best);
          ordered.push(best);
        }
      }
      for (const c of cells) if (remaining.has(c.id)) ordered.push(c.id);
      const missionId = await createMission(lakeId, gridIds, ordered);
      setNotice(`Mission created (${ordered.length} cells). Mission ID: ${missionId.slice(0, 8)}… The robot command channel (MQTT) is not connected yet, so the mission itself cannot be started from here.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not sync to Supabase.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <Navbar />
      <main className="page">
        <PageHeader title="Mission Planner" sub="Plan and execute autonomous cleaning missions." />

        <div className="mission-layout">
          <section className="panel" aria-label="Mission summary">
            <div className="panel-head">
              <h3>Mission 01</h3>
              <span className="chev"><ChevronRight size={18} /></span>
            </div>
            <p className="panel-sub">{lake ? `${lake.name ?? 'Unnamed lake'} · ${cellSizeM} m grid` : 'No lake selected'}</p>

            <dl className="kv-rows">
  <div><dt><Waypoints size={18} />Waypoints</dt><dd>{hasPlan ? path.length : '—'}</dd></div>
</dl>

            {progress.total > 0 && (
              <div className="mission-progress">
                <div className="mission-progress-head">
                  <span>{progress.status ?? 'PENDING'}</span>
                  <span>{progress.done} / {progress.total} cells</span>
                </div>
                <div className="mission-progress-bar">
                  <div
                    className="mission-progress-fill"
                    style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            )}

            <button type="button" className="btn-primary btn-block" onClick={handleStartMission} disabled={syncing}>
              {syncing ? 'Syncing to Supabase…' : <>Start Mission <ArrowRight size={15} /></>}
            </button>
            <Link to="/observatory" className="btn btn-block">Edit Plan</Link>
            <div className="export-row" role="group" aria-label="Export plan">
              <button type="button" className="btn" onClick={exportGeoJson} disabled={!hasPlan}>
                <Download size={15} /> GeoJSON
              </button>
              <button type="button" className="btn" onClick={exportCsv} disabled={!hasPlan}>
                <Download size={15} /> CSV
              </button>
            </div>
            {notice && <div className="notice" role="status">{notice}</div>}
          </section>

          <div className="map-wrap tall">
            <ObservatoryMap
              mode="browse"
              style="light"
              gridCells={cells}
              showGrid={false}
              plannedPath={path}
              detours={plan.detours}
              blockedLegs={plan.blocked}
              robot={robot}
              showLegend
              backTo="/"
            />
            {!lake && (
              <div className="map-hint"><span>Select a lake in the Observatory to plan a mission.</span></div>
            )}
            {lake && !hasPlan && (
              <div className="map-hint">
                <span>
                  {gridTooFine
                    ? 'The grid is too fine to plan. Increase the grid size in the Observatory.'
                    : 'No grid yet. Add a boundary for this lake in the Observatory.'}
                </span>
              </div>
            )}
          </div>
        </div>
        {DEMO && <p className="demo-note">Demo data — set VITE_DEMO=0 to use live sources.</p>}
      </main>
    </>
  );
}
