import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BatteryMedium, ChevronRight, Clock, Crosshair, Download, House, LocateFixed, OctagonX, Pause, Play, Send, Square, Undo2, Waypoints, X } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { ObservatoryMap } from '../components/ObservatoryMap';
import { PageHeader } from '../components/PageHeader';
import { useLake } from '../stores/lake';
import { useTelemetry } from '../stores/telemetry';
import { DEMO } from '../demo/demo';
import { pathLengthM, planCoverage } from '../utils/geo';
import { estimateMission, fmtMinutes, startProblems } from '../utils/readiness';
import { ROBOT_SPEED_MPS } from '../config/robot';
import { downloadText, planFileName, planToCsv, planToGeoJson } from '../utils/exportPlan';
import { buildWaypointsFile, canonicalWaypointText, cellIdsForPath, planWaypoints, routeWithGcs } from '../utils/waypoints';
import { loadGcs, saveGcs, supabaseLakeKey } from '../services/storage/lakeStorage';
import type { LatLon } from '../types';
import { fmtMissionState } from '../utils/format';
import {
  abandonMission,
  createMission,
  fetchCompletedMissionGrids,
  fetchGcs,
  fetchLakeGrids,
  fetchMissionProgress,
  matchGridsToCells,
  pushLakeAndGrids,
  saveGcsRemote,
} from '../services/supabase/supabaseService';
import type { MissionProgress } from '../services/supabase/supabaseService';
import { command, describeAnswer, ROBOT_ID } from '../services/supabase/robotService';
import type { RobotCommand } from '../services/supabase/robotService';
import { supabaseConfigured } from '../services/supabase/supabaseClient';

const NO_PROGRESS: MissionProgress = { missionId: null, done: 0, total: 0, status: null };
const DONE_COLOR = '#16a34a';

/** A plan the robot confirmed it stored, with the exact waypoints it confirmed. */
interface LoadedPlan {
  lakeId: string;
  missionId: string;
  planSig: string;
  count: number;
  sha256: string;
}

type Notice = { tone: 'ok' | 'error' | 'info'; text: string };

export function MissionPage() {
  const { lake, cells, cellSizeM, shoreMarginM, boundary, holes, gridTooFine } = useLake();
  const { telemetry, live } = useTelemetry();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [loaded, setLoaded] = useState<LoadedPlan | null>(null);
  const [startedMissionId, setStartedMissionId] = useState<string | null>(null);
  const [lastAckState, setLastAckState] = useState<string | null>(null);
  const [progress, setProgress] = useState<MissionProgress>(NO_PROGRESS);
  const [progressKey, setProgressKey] = useState(0);
  const [gcs, setGcs] = useState<LatLon | null>(null);
  const [placingGcs, setPlacingGcs] = useState(false);

  // One GCS per real lake (sample polygons use their lake's). Supabase is the shared copy,
  // so every device sees the same point; this browser keeps a copy for offline use.
  useEffect(() => {
    setPlacingGcs(false);
    if (!lake) {
      setGcs(null);
      return;
    }
    const key = supabaseLakeKey(lake);
    setGcs(loadGcs(key) ?? loadGcs(lake.id));
    let cancelled = false;
    fetchGcs(lake).then((remote) => {
      if (cancelled || remote === undefined) return;
      saveGcs(key, remote);
      setGcs(remote);
    }, () => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id, lake?.parentLakeId]);

  const changeGcs = async (p: LatLon | null) => {
    if (!lake) return;
    saveGcs(supabaseLakeKey(lake), p);
    if (lake.parentLakeId) saveGcs(lake.id, null);
    setGcs(p);
    setPlacingGcs(false);
    if (supabaseConfigured && !DEMO && !(await saveGcsRemote(lake, p))) {
      setNotice({ tone: 'info', text: 'GCS saved in this browser. It is shared with other devices once the plan has been sent to the robot.' });
    }
  };

  // Poll mission progress every 8 seconds while a lake is selected.
  useEffect(() => {
    setProgress(NO_PROGRESS);
    if (!lake) return;
    let cancelled = false;
    const load = async () => {
      try {
        const p = await fetchMissionProgress(lake);
        if (!cancelled) setProgress(p);
      } catch { /* silent background poll; the next tick retries */ }
    };
    load();
    const id = window.setInterval(load, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id, lake?.parentLakeId, progressKey]);

  // Every leg is checked against the shore and islands; legs that would cross land are rerouted.
  const plan = useMemo(() => planCoverage(cells, boundary, holes), [cells, boundary, holes]);
  const path = plan.path;
  const blockedLegs = plan.blocked.length;
  const hasPlan = path.length > 0;
  /** Full route: GCS -> coverage path -> GCS. */
  const route = useMemo(() => routeWithGcs(plan, gcs, { cells, boundary, holes }), [plan, gcs, cells, boundary, holes]);
  const mapDetours = useMemo(() => (route.returnDetour ? [...plan.detours, route.returnDetour] : plan.detours), [plan.detours, route]);
  const estimate = useMemo(
    () => (hasPlan ? estimateMission(pathLengthM(route.path), route.kinds.filter((k) => k === 'lane').length) : null),
    [hasPlan, route],
  );
  /** Coverage part of the route (in the direction the robot drives it), for the map. */
  const mapPath = useMemo(() => (gcs && route.path.length > 2 ? route.path.slice(1, -1) : path), [gcs, route, path]);
  /** Identifies the route on screen; a loaded plan only counts while the route is unchanged. */
  const planSig = useMemo(() => canonicalWaypointText(planWaypoints(route, cells, new Map())), [route, cells]);

  const lat = telemetry?.gps.latitude ?? null;
  const lon = telemetry?.gps.longitude ?? null;
  const robot = useMemo(() => (lat !== null && lon !== null ? { lat, lon } : null), [lat, lon]);

  const loadedHere = loaded && lake && loaded.lakeId === lake.id ? loaded : null;
  const loadedValid = loadedHere !== null && loadedHere.planSig === planSig;
  const missionId = loadedHere?.missionId ?? progress.missionId;

  // What the robot says it is doing for this mission: live telemetry first, else its last acknowledgement.
  const liveForMission = live && telemetry && (!missionId || telemetry.missionId === missionId) ? telemetry : null;
  const robotState = liveForMission ? liveForMission.missionState : lastAckState;
  const started =
    (missionId !== null && startedMissionId === missionId) || progress.status === 'ACTIVE' || progress.status === 'PAUSED';
  const paused = robotState === 'paused' || progress.status === 'PAUSED';
  const finished =
    robotState === 'completed' || robotState === 'emergency_stop' || progress.status === 'COMPLETED' || progress.status === 'ABORTED';

  const exportInput = { lake, boundary, holes, plan, cellSizeM, shoreMarginM, speedMps: ROBOT_SPEED_MPS, seconds: null };
  const problems = startProblems(telemetry, live, estimate);
  const exportGeoJson = () =>
    downloadText(planFileName(lake, 'geojson'), JSON.stringify(planToGeoJson(exportInput), null, 2), 'application/geo+json');
  const exportCsv = () => downloadText(planFileName(lake, 'csv'), planToCsv(exportInput), 'text/csv');

  /**
   * Save the plan, create the mission, send waypoints.json and wait for the robot to confirm
   * it stored them. Returns the mission id once the robot confirmed, else null.
   */
  const handleSend = async (): Promise<string | null> => {
    if (blockedLegs > 0) {
      setNotice({ tone: 'error', text: `${blockedLegs} leg${blockedLegs === 1 ? ' of this plan crosses' : 's of this plan cross'} land and cannot be routed. Fix the plan before sending it.` });
      return null;
    }
    if (!lake || cells.length === 0 || !hasPlan) {
      setNotice({ tone: 'error', text: 'Select a lake with a grid before sending a plan.' });
      return null;
    }
    if (!gcs) {
      setNotice({ tone: 'error', text: 'Set the GCS (start and return point) before sending the plan.' });
      return null;
    }
    if (route.gcsWarnings.length > 0) {
      setNotice({ tone: 'error', text: route.gcsWarnings[0] });
      return null;
    }
    const sentSig = planSig;
    setNotice(null);
    setLoaded(null);
    setStartedMissionId(null);
    setLastAckState(null);
    let newMissionId: string | null = null;
    try {
      setBusy('Saving the plan to Supabase…');
      const { lakeId, gridIds } = await pushLakeAndGrids(lake, cells, cellSizeM);
      void saveGcsRemote(lake, gcs); // the lake row exists now, so the GCS can be shared
      // Visit order for mission_grids: lane cells in path order, then any cell not on the path.
      const pathCells = cellIdsForPath(route.path, cells).filter((id, i): id is string => id !== null && route.kinds[i] === 'lane');
      newMissionId = await createMission(lake.id, lakeId, gridIds, pathCells, ROBOT_ID);
      setProgressKey((k) => k + 1);

      const file = await buildWaypointsFile({
        missionId: newMissionId,
        deviceId: ROBOT_ID,
        supabaseLakeId: lakeId,
        lakeName: lake.name ?? null,
        cellSizeM,
        gcs,
        waypoints: planWaypoints(route, cells, gridIds),
      });

      setBusy(`Sent ${file.count} waypoints. Waiting for the robot to confirm…`);
      const answer = await command('LOAD_WAYPOINTS', newMissionId, file);
      if (answer.status !== 'ACKED') {
        await abandonMission(newMissionId, describeAnswer('LOAD_WAYPOINTS', answer));
        setNotice({ tone: 'error', text: describeAnswer('LOAD_WAYPOINTS', answer) });
        return null;
      }
      const ackCount = Number(answer.ack?.count);
      const ackSha = String(answer.ack?.sha256 ?? '');
      if (ackCount !== file.count || ackSha !== file.sha256) {
        const why = `Robot confirmed, but reported ${Number.isFinite(ackCount) ? ackCount : 'no'} waypoints${ackSha !== file.sha256 ? ' and a different checksum' : ''} (sent ${file.count}). Not safe to start: send the plan again.`;
        await abandonMission(newMissionId, why);
        setNotice({ tone: 'error', text: why });
        return null;
      }
      setLoaded({ lakeId: lake.id, missionId: newMissionId, planSig: sentSig, count: file.count, sha256: file.sha256 });
      setLastAckState('loaded');
      setNotice({ tone: 'ok', text: `Robot loaded all ${file.count} waypoints (checksum verified). You can start the mission.` });
      return newMissionId;
    } catch (e) {
      if (newMissionId) await abandonMission(newMissionId, 'Sending the waypoints failed.');
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : 'Could not send the plan.' });
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** Send a mission command and report the robot's answer. */
  const run = async (cmd: Exclude<RobotCommand, 'LOAD_WAYPOINTS' | 'EMERGENCY_STOP'>, label: string, forMission: string | null = missionId) => {
    if (!forMission) return;
    if (cmd === 'STOP' && !window.confirm('Stop the mission? The robot will end it and stay where it is. Use "Return to GCS" to bring it back.')) return;
    if (cmd === 'RETURN_HOME' && !window.confirm('End the mission and send the robot back to the GCS?')) return;
    setNotice(null);
    setBusy(label);
    try {
      const answer = await command(cmd, forMission);
      setNotice({ tone: answer.status === 'ACKED' ? 'ok' : 'error', text: describeAnswer(cmd, answer) });
      if (answer.status === 'ACKED') {
        const state = typeof answer.ack?.mission_state === 'string' ? answer.ack.mission_state : null;
        setLastAckState(state ?? (cmd === 'PAUSE' ? 'paused' : cmd === 'STOP' ? 'completed' : cmd === 'RETURN_HOME' ? 'returning' : 'transit'));
        if (cmd === 'START') setStartedMissionId(forMission);
        setProgressKey((k) => k + 1);
      }
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : `Could not send ${cmd}.` });
    } finally {
      setBusy(null);
    }
  };

  /**
   * One click: check the robot is ready, send the plan if the robot has not confirmed
   * this exact plan yet, then start.
   */
  const sendAndStart = async () => {
    if (problems.length > 0) {
      const ok = window.confirm(`The robot may not be ready:\n\n- ${problems.join('\n- ')}\n\nStart anyway?`);
      if (!ok) return;
    }
    const id = loadedValid && loadedHere ? loadedHere.missionId : await handleSend();
    if (id) await run('START', 'Starting the mission…', id);
  };

  /** Never blocked by other commands in flight. The robot's physical kill switch remains the real emergency stop. */
  const emergencyStop = async () => {
    setStopping(true);
    try {
      const answer = await command('EMERGENCY_STOP', missionId);
      setNotice({ tone: answer.status === 'ACKED' ? 'ok' : 'error', text: describeAnswer('EMERGENCY_STOP', answer) });
      if (answer.status === 'ACKED') setLastAckState('emergency_stop');
      setProgressKey((k) => k + 1);
    } catch (e) {
      setNotice({ tone: 'error', text: `Emergency stop could not be sent: ${e instanceof Error ? e.message : String(e)}. Use the robot's kill switch.` });
    } finally {
      setStopping(false);
    }
  };

  const doneCells = useDoneCells(lake, cells, cellSizeM, missionId, progressKey, progress.done);

  /** The GCS cannot move while the robot is running a mission. */
  const gcsLocked = (started && !finished) || busy !== null;

  const liveWaypoint = liveForMission && typeof liveForMission.currentWaypoint === 'number' ? liveForMission.currentWaypoint : null;
  const liveTotal = liveForMission?.waypointTotal ?? loadedHere?.count ?? null;
  const pct = (done: number, total: number) => `${total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0}%`;

  return (
    <>
      <Navbar />
      <main className="page">
        <PageHeader title="Mission Planner" sub="Plan and execute autonomous cleaning missions." />

        <div className="mission-layout">
          <section className="panel" aria-label="Mission summary">
            <div className="panel-head">
              <h3>{missionId ? `Mission ${missionId.slice(0, 8)}` : 'New mission'}</h3>
              <span className="chev"><ChevronRight size={18} /></span>
            </div>
            <p className="panel-sub">{lake ? `${lake.name ?? 'Unnamed lake'} · ${cellSizeM} m grid · robot ${ROBOT_ID}` : 'No lake selected'}</p>

            <dl className="kv-rows">
              <div><dt><Waypoints size={18} />Waypoints</dt><dd>{hasPlan ? route.path.length : '—'}</dd></div>
              <div><dt><House size={18} />GCS</dt><dd>{gcs ? 'Set' : 'Not set'}</dd></div>
              {estimate && (
                <div title={`At ${ROBOT_SPEED_MPS} m/s, including sampling stops`}>
                  <dt><Clock size={18} />Est. time</dt>
                  <dd>{fmtMinutes(estimate.minutes)} · {(estimate.distanceM / 1000).toFixed(1)} km</dd>
                </div>
              )}
              {estimate && (
                <div title="Battery now / battery this mission needs, including a reserve">
                  <dt><BatteryMedium size={18} />Battery</dt>
                  <dd className={typeof telemetry?.batteryPercent === 'number' && telemetry.batteryPercent < estimate.batteryNeededPct ? 'text-bad' : undefined}>
                    {typeof telemetry?.batteryPercent === 'number' ? `${Math.round(telemetry.batteryPercent)}%` : '—'} / needs {estimate.batteryNeededPct}%
                  </dd>
                </div>
              )}
              <div><dt>Robot</dt><dd>{robotState ? fmtMissionState(robotState) : live ? 'Online' : 'No live data'}</dd></div>
            </dl>

            {liveWaypoint !== null && liveTotal ? (
              <div className="mission-progress" aria-label="Waypoint progress">
                <div className="mission-progress-head">
                  <span>Waypoint</span>
                  <span>{liveWaypoint} / {liveTotal}</span>
                </div>
                <div className="mission-progress-bar"><div className="mission-progress-fill" style={{ width: pct(liveWaypoint, liveTotal) }} /></div>
              </div>
            ) : null}

            {progress.total > 0 && (
              <div className="mission-progress" aria-label="Cells sampled">
                <div className="mission-progress-head">
                  <span>{progress.status ?? 'PENDING'}</span>
                  <span>{progress.done} / {progress.total} cells</span>
                </div>
                <div className="mission-progress-bar"><div className="mission-progress-fill" style={{ width: pct(progress.done, progress.total) }} /></div>
              </div>
            )}

            {lake && (
              <>
                {gcs && <p className="gcs-coords">GCS {gcs.lat.toFixed(6)}, {gcs.lon.toFixed(6)} · robot starts here and returns here</p>}
                <div className="gcs-row" role="group" aria-label="Ground control station">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setPlacingGcs((v) => !v)}
                    disabled={gcsLocked}
                    aria-pressed={placingGcs}
                  >
                    <Crosshair size={15} /> {placingGcs ? 'Click the map…' : gcs ? 'Move GCS' : 'Set GCS on map'}
                  </button>
                  {robot && (
                    <button type="button" className="btn" onClick={() => changeGcs(robot)} disabled={gcsLocked} title="Use the robot's current GPS position">
                      <LocateFixed size={15} /> Robot here
                    </button>
                  )}
                  {gcs && loadGcs(lake.id) && (
                    <button type="button" className="btn" onClick={() => changeGcs(null)} disabled={gcsLocked} aria-label="Clear GCS" title="Clear GCS">
                      <X size={15} />
                    </button>
                  )}
                </div>
              </>
            )}

            {route.gcsWarnings.map((w) => (
              <div key={w} className="notice error" role="alert">{w}</div>
            ))}
            {(!started || finished) && hasPlan && problems.length > 0 && (
              <div className="notice warn" role="status">
                <strong>Robot not ready</strong>
                <ul className="notice-list">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            )}

            {loadedHere && !loadedValid && !started && (
              <div className="notice" role="status">The plan changed after the robot loaded it. Send it again before starting.</div>
            )}

            {!started || finished ? (
              <>
                <button
                  type="button"
                  className="btn-primary btn-block mission-start"
                  onClick={sendAndStart}
                  disabled={busy !== null || !hasPlan || !gcs || !supabaseConfigured}
                  title={gcs ? undefined : 'Set the GCS first'}
                >
                  <Play size={15} /> {loadedValid && !finished ? 'Start mission' : 'Send plan & start'}
                </button>
                <button
                  type="button"
                  className="btn btn-block"
                  onClick={() => void handleSend()}
                  disabled={busy !== null || !hasPlan || !gcs || !supabaseConfigured}
                >
                  <Send size={15} /> {loadedValid && !finished ? 'Send plan again' : 'Send plan only'}
                </button>
              </>
            ) : (
              <div className="mission-controls" role="group" aria-label="Mission controls">
                {paused ? (
                  <button type="button" className="btn" onClick={() => run('RESUME', 'Resuming…')} disabled={busy !== null}>
                    <Play size={15} /> Resume
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => run('PAUSE', 'Pausing…')} disabled={busy !== null}>
                    <Pause size={15} /> Pause
                  </button>
                )}
                <button type="button" className="btn" onClick={() => run('STOP', 'Stopping…')} disabled={busy !== null}>
                  <Square size={15} /> Stop
                </button>
              </div>
            )}

            {missionId && gcs && (started || robotState === 'completed') && robotState !== 'returning' && (
              <button type="button" className="btn btn-block" onClick={() => run('RETURN_HOME', 'Sending the robot back to the GCS…')} disabled={busy !== null}>
                <Undo2 size={15} /> Return to GCS
              </button>
            )}

            <button
              type="button"
              className="btn-danger btn-block"
              onClick={emergencyStop}
              disabled={stopping || !supabaseConfigured}
            >
              <OctagonX size={16} /> {stopping ? 'Sending emergency stop…' : 'Emergency stop'}
            </button>

            {busy && <div className="notice" role="status">{busy}</div>}
            {notice && (
              <div className={`notice${notice.tone === 'info' ? '' : ` ${notice.tone}`}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
                {notice.text}
              </div>
            )}
            {!supabaseConfigured && !DEMO && (
              <div className="notice" role="status">Supabase is not configured, so the robot cannot be reached.</div>
            )}

            <Link to="/observatory" className="btn btn-block">Edit Plan</Link>
            <div className="export-row" role="group" aria-label="Export plan">
              <button type="button" className="btn" onClick={exportGeoJson} disabled={!hasPlan}>
                <Download size={15} /> GeoJSON
              </button>
              <button type="button" className="btn" onClick={exportCsv} disabled={!hasPlan}>
                <Download size={15} /> CSV
              </button>
            </div>
          </section>

          <div className="map-wrap tall">
            <ObservatoryMap
              mode="browse"
              style="light"
              gridCells={cells}
              showGrid={false}
              plannedPath={mapPath}
              gcs={gcs}
              addLakeMode={placingGcs}
              onPickPoint={placingGcs ? (p) => changeGcs(p) : undefined}
              detours={mapDetours}
              heatmapCells={doneCells.heat}
              visitedGridIds={doneCells.ids}
              blockedLegs={plan.blocked}
              robot={robot}
              showLegend
              backTo="/"
            />
            {!lake && (
              <div className="map-hint"><span>Select a lake in the Observatory to plan a mission.</span></div>
            )}
            {placingGcs && (
              <div className="map-hint"><span>Click the map where the robot is launched. It starts here and returns here after the last waypoint.</span></div>
            )}
            {lake && !hasPlan && !placingGcs && (
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

type HeatCell = { gridCode: string; color: string; value: number | null };
const NO_DONE: { heat: HeatCell[]; ids: Set<string> } = { heat: [], ids: new Set() };

/** Cells of the mission the robot has finished sampling, for colouring the map; refreshed as progress changes. */
function useDoneCells(
  lake: ReturnType<typeof useLake>['lake'],
  cells: ReturnType<typeof useLake>['cells'],
  cellSizeM: number,
  missionId: string | null,
  refreshKey: number,
  doneCount: number,
) {
  const [cellByGrid, setCellByGrid] = useState<Map<string, string> | null>(null);
  const [done, setDone] = useState(NO_DONE);

  // grid_id -> cell id for this lake, read once per lake and grid.
  useEffect(() => {
    setCellByGrid(null);
    if (!lake || !supabaseConfigured || DEMO || cells.length === 0) return;
    let cancelled = false;
    fetchLakeGrids(lake).then((grids) => {
      if (cancelled) return;
      const toGrid = matchGridsToCells(grids, cells, cellSizeM);
      setCellByGrid(new Map([...toGrid].map(([cellId, gridId]) => [gridId, cellId])));
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [lake, cells, cellSizeM]);

  useEffect(() => {
    setDone(NO_DONE);
    if (!missionId || !cellByGrid || !supabaseConfigured || DEMO) return;
    let cancelled = false;
    fetchCompletedMissionGrids(missionId).then((gridIds) => {
      if (cancelled) return;
      const ids = new Set<string>();
      for (const g of gridIds) {
        const cellId = cellByGrid.get(g);
        if (cellId) ids.add(cellId);
      }
      setDone(ids.size === 0 ? NO_DONE : { heat: [...ids].map((id) => ({ gridCode: id, color: DONE_COLOR, value: null })), ids });
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [missionId, cellByGrid, refreshKey, doneCount]);

  return done;
}
