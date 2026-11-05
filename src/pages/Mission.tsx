import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BatteryMedium,
  ChevronRight,
  Clock,
  Crosshair,
  Download,
  House,
  LocateFixed,
  MoveHorizontal,
  OctagonX,
  Pause,
  Play,
  Ruler,
  Send,
  Square,
  Undo2,
  Waypoints,
  X,
} from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { ObservatoryMap } from '../components/ObservatoryMap';
import { PageHeader } from '../components/PageHeader';
import { useLake } from '../stores/lake';
import { useTelemetry } from '../stores/telemetry';
import { DEMO } from '../demo/demo';
import { pathLengthM, polygonAreaSqM } from '../utils/geo';
import { MIN_SPACING_M, planMissionRoute } from '../utils/coverage';
import { estimateMission, fmtMinutes, startProblems } from '../utils/readiness';
import { ACCEPTANCE_RADIUS_M, ROBOT_SPEED_MPS, SWEEP_SPACING_M } from '../config/robot';
import { downloadText, planFileName, planToCsv, planToGeoJson } from '../utils/exportPlan';
import { ackMismatch, buildMissionPayload, canonicalWaypointText, toMissionWaypoints } from '../utils/missionPayload';
import { loadGcs, loadSweepSpacing, rememberMissionId, saveGcs, saveSweepSpacing, supabaseLakeKey } from '../services/storage/lakeStorage';
import type { LatLon, MissionState } from '../types';
import { fmtMissionState } from '../utils/format';
import { abandonMission, createMission, fetchLatestMission, markMissionLoading, pushLake } from '../services/supabase/supabaseService';
import type { LatestMission } from '../services/supabase/supabaseService';
import { ROBOT_ID } from '../services/supabase/robotService';
import { describeAnswer, robotLink } from '../services/robot/robotLink';
import type { MissionCommand } from '../services/robot/robotLink';
import type { PiMissionStatus } from '../services/robot/piApi';
import { normaliseMissionState } from '../services/realtime/telemetryParser';
import { supabaseConfigured } from '../services/supabase/supabaseClient';

const NO_MISSION: LatestMission = { missionId: null, status: null, currentWaypoint: null, totalWaypoints: null, progressPercent: null, loadAck: false };

/** A plan the robot confirmed it validated and stored, with the exact waypoints it confirmed. */
interface LoadedPlan {
  lakeId: string;
  missionId: string;
  planSig: string;
  count: number;
}

type Notice = { tone: 'ok' | 'error' | 'info'; text: string };

const ACTIVE_STATES: MissionState[] = ['transit', 'sampling', 'returning', 'paused'];
const FINAL_STATES: MissionState[] = ['completed', 'aborted', 'emergency_stop'];

export function MissionPage() {
  const { lake, shoreMarginM, boundary, holes } = useLake();
  const { telemetry, live, trail } = useTelemetry();
  const useCloud = supabaseConfigured && !DEMO;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [loaded, setLoaded] = useState<LoadedPlan | null>(null);
  const [startedMissionId, setStartedMissionId] = useState<string | null>(null);
  const [lastAckState, setLastAckState] = useState<MissionState | null>(null);
  const [latest, setLatest] = useState<LatestMission>(NO_MISSION);
  const [piStatus, setPiStatus] = useState<PiMissionStatus | null>(null);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [gcs, setGcs] = useState<LatLon | null>(null);
  const [placingGcs, setPlacingGcs] = useState(false);
  const [spacingM, setSpacingM] = useState(SWEEP_SPACING_M);
  const [spacingText, setSpacingText] = useState(String(SWEEP_SPACING_M));

  // One GCS and one sweep spacing per real lake (sample polygons use their lake's), kept in
  // this browser. The GCS also travels with every mission (payload ground_control).
  useEffect(() => {
    setPlacingGcs(false);
    if (!lake) {
      setGcs(null);
      return;
    }
    const key = supabaseLakeKey(lake);
    const sp = loadSweepSpacing(key) ?? SWEEP_SPACING_M;
    setSpacingM(sp);
    setSpacingText(String(sp));
    setGcs(loadGcs(key) ?? loadGcs(lake.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id, lake?.parentLakeId]);

  const changeGcs = (p: LatLon | null) => {
    if (!lake) return;
    saveGcs(supabaseLakeKey(lake), p);
    if (lake.parentLakeId) saveGcs(lake.id, null);
    setGcs(p);
    setPlacingGcs(false);
  };

  const commitSpacing = (text: string) => {
    const v = Number(text);
    if (!Number.isFinite(v) || v < MIN_SPACING_M) {
      setSpacingText(String(spacingM));
      return;
    }
    const rounded = Math.round(v * 10) / 10;
    setSpacingM(rounded);
    setSpacingText(String(rounded));
    if (lake) saveSweepSpacing(supabaseLakeKey(lake), rounded);
  };

  // Mission status as stored in Supabase (kept by the robot), every 8 s.
  useEffect(() => {
    setLatest(NO_MISSION);
    if (!lake || !useCloud) return;
    let cancelled = false;
    const load = () =>
      fetchLatestMission(lake).then(
        (m) => !cancelled && setLatest(m),
        () => undefined, // silent background poll; the next tick retries
      );
    load();
    const id = window.setInterval(load, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lake?.id, lake?.parentLakeId, pollKey]);

  const loadedHere = loaded && lake && loaded.lakeId === lake.id ? loaded : null;
  const missionId = loadedHere?.missionId ?? latest.missionId;

  // Robot-side state straight from the Pi backend, every 5 s; also tells us whether the backend is reachable.
  useEffect(() => {
    setPiStatus(null);
    if (robotLink.kind !== 'pi') return;
    let cancelled = false;
    const load = async () => {
      const up = await robotLink.health();
      if (cancelled) return;
      setBackendUp(up);
      if (!missionId || !up) return;
      try {
        const st = await robotLink.missionStatus(missionId);
        if (!cancelled) setPiStatus(st);
      } catch {
        /* next tick retries */
      }
    };
    void load();
    const id = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [missionId, pollKey]);

  /** GCS -> zigzag over the polygon -> GCS; every leg checked against the shore and islands. */
  const route = useMemo(
    () => planMissionRoute({ boundary, holes, spacingM, marginM: shoreMarginM, gcs }),
    [boundary, holes, spacingM, shoreMarginM, gcs],
  );
  const hasPlan = route.path.length > 0;
  const estimate = useMemo(() => (hasPlan ? estimateMission(pathLengthM(route.path)) : null), [hasPlan, route]);
  const areaHa = useMemo(() => (boundary ? (polygonAreaSqM(boundary) ?? 0) / 10_000 : null), [boundary]);
  /** Identifies the route on screen; a loaded plan only counts while the route is unchanged. */
  const planSig = useMemo(() => canonicalWaypointText(toMissionWaypoints(route.path, route.kinds)), [route]);
  const loadedValid = loadedHere !== null && loadedHere.planSig === planSig;

  const lat = telemetry?.gps.latitude ?? null;
  const lon = telemetry?.gps.longitude ?? null;
  const robot = useMemo(() => (lat !== null && lon !== null ? { lat, lon } : null), [lat, lon]);

  // What the robot says it is doing for this mission: live telemetry, then the Pi's mission
  // status, then its last acknowledgement. Never assumed from a request having been sent.
  const liveForMission = live && telemetry && (!missionId || telemetry.missionId === missionId) ? telemetry : null;
  const piState = piStatus ? normaliseMissionState(piStatus.state) : 'unknown';
  const robotState: MissionState | null = liveForMission
    ? liveForMission.missionState
    : piState !== 'unknown'
      ? piState
      : lastAckState;
  const cloud = latest.missionId === missionId ? latest.status : null;
  const started =
    (missionId !== null && startedMissionId === missionId) ||
    cloud === 'ACTIVE' ||
    cloud === 'PAUSED' ||
    (robotState !== null && ACTIVE_STATES.includes(robotState));
  const paused = robotState === 'paused' || cloud === 'PAUSED';
  const finished =
    (robotState !== null && FINAL_STATES.includes(robotState)) || cloud === 'COMPLETED' || cloud === 'ABORTED' || cloud === 'FAILED';

  const exportInput = {
    lake,
    boundary,
    holes,
    plan: route,
    sweepSpacingM: spacingM,
    shoreMarginM,
    speedMps: ROBOT_SPEED_MPS,
    seconds: estimate ? estimate.minutes * 60 : null,
  };
  const problems = startProblems(telemetry, live, estimate);
  const exportGeoJson = () =>
    downloadText(planFileName(lake, 'geojson'), JSON.stringify(planToGeoJson(exportInput), null, 2), 'application/geo+json');
  const exportCsv = () => downloadText(planFileName(lake, 'csv'), planToCsv(exportInput), 'text/csv');

  /**
   * Generate a mission id, record the mission, send polygon + GCS + ordered waypoints and
   * wait until the robot confirms it validated them and stored them in its local SQLite.
   * Returns the mission id once confirmed (count and checksum match), else null.
   */
  const handleSend = async (): Promise<string | null> => {
    if (!lake || !boundary || !hasPlan) {
      setNotice({ tone: 'error', text: route.error ?? 'Select a lake with an outline before sending a plan.' });
      return null;
    }
    if (!gcs) {
      setNotice({ tone: 'error', text: 'Set the GCS (start and return point) before sending the plan.' });
      return null;
    }
    if (route.blocked.length > 0 || route.warnings.length > 0) {
      setNotice({ tone: 'error', text: route.warnings[0] ?? 'Part of the route crosses land. Fix the plan before sending it.' });
      return null;
    }
    const sentSig = planSig;
    setNotice(null);
    setLoaded(null);
    setStartedMissionId(null);
    setLastAckState(null);
    const missionId = crypto.randomUUID();
    let recorded = false;
    try {
      let supaLakeId: string | null = null;
      if (useCloud) {
        setBusy('Saving the mission to Supabase…');
        supaLakeId = await pushLake(lake);
      }
      const payload = await buildMissionPayload({
        missionId,
        deviceId: ROBOT_ID,
        lakeId: supaLakeId,
        lakeName: lake.name ?? null,
        gcs,
        polygon: boundary,
        islands: holes,
        sweepSpacingM: spacingM,
        shoreMarginM,
        acceptanceRadiusM: ACCEPTANCE_RADIUS_M,
        path: route.path,
        kinds: route.kinds,
      });
      if (useCloud && supaLakeId) {
        await createMission(lake.id, supaLakeId, payload);
        recorded = true;
        setPollKey((k) => k + 1);
      } else {
        rememberMissionId(lake.id, missionId);
      }

      if (recorded) void markMissionLoading(missionId);
      setBusy(`Sent ${payload.waypoint_count} waypoints. Waiting for the robot to validate and store them…`);
      const answer = await robotLink.loadMission(payload);
      if (answer.status !== 'ACKED') {
        const why = describeAnswer('LOAD', answer);
        if (recorded) await abandonMission(missionId, why);
        setNotice({ tone: 'error', text: why });
        return null;
      }
      const mismatch = ackMismatch(payload, answer.ack);
      if (mismatch) {
        if (recorded) await abandonMission(missionId, mismatch);
        setNotice({ tone: 'error', text: mismatch });
        return null;
      }
      setLoaded({ lakeId: lake.id, missionId, planSig: sentSig, count: payload.waypoint_count });
      setLastAckState('loaded');
      setNotice({ tone: 'ok', text: `Robot stored all ${payload.waypoint_count} waypoints (checksum verified). You can start the mission.` });
      return missionId;
    } catch (e) {
      if (recorded) await abandonMission(missionId, 'Sending the waypoints failed.');
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : 'Could not send the plan.' });
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** Send a mission command and report the robot's answer. */
  const run = async (cmd: Exclude<MissionCommand, 'EMERGENCY_STOP'>, label: string, forMission: string | null = missionId) => {
    if (!forMission) return;
    if (cmd === 'STOP' && !window.confirm('Abort the mission? The robot stops and stays where it is. Use "Return to GCS" to bring it back.')) return;
    if (cmd === 'RETURN_HOME' && !window.confirm('End the mission and send the robot back to the GCS?')) return;
    setNotice(null);
    setBusy(label);
    try {
      const answer = await robotLink.command(cmd, forMission);
      setNotice({ tone: answer.status === 'ACKED' ? 'ok' : 'error', text: describeAnswer(cmd, answer) });
      if (answer.status === 'ACKED') {
        const reported = normaliseMissionState(answer.ack?.mission_state ?? answer.ack?.state);
        const fallback: Record<typeof cmd, MissionState> = { START: 'transit', PAUSE: 'paused', RESUME: 'transit', STOP: 'aborted', RETURN_HOME: 'returning' };
        setLastAckState(reported !== 'unknown' ? reported : fallback[cmd]);
        if (cmd === 'START') setStartedMissionId(forMission);
      }
      setPollKey((k) => k + 1);
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : `Could not send ${cmd}.` });
    } finally {
      setBusy(null);
    }
  };

  /**
   * START MISSION: check the robot is ready, send the plan unless the robot already
   * confirmed this exact plan, and only then send the separate start command.
   */
  const sendAndStart = async () => {
    if (problems.length > 0) {
      const ok = window.confirm(`The robot may not be ready:\n\n- ${problems.join('\n- ')}\n\nStart anyway?`);
      if (!ok) return;
    }
    const id = loadedValid && loadedHere && !finished ? loadedHere.missionId : await handleSend();
    if (id) await run('START', 'Starting the mission…', id);
  };

  /** Never blocked by other commands in flight. The robot's physical kill switch remains the real emergency stop. */
  const emergencyStop = async () => {
    setStopping(true);
    try {
      const answer = await robotLink.command('EMERGENCY_STOP', missionId);
      setNotice({ tone: answer.status === 'ACKED' ? 'ok' : 'error', text: describeAnswer('EMERGENCY_STOP', answer) });
      if (answer.status === 'ACKED') setLastAckState('emergency_stop');
      setPollKey((k) => k + 1);
    } catch (e) {
      setNotice({ tone: 'error', text: `Emergency stop could not be sent: ${e instanceof Error ? e.message : String(e)}. Use the robot's kill switch.` });
    } finally {
      setStopping(false);
    }
  };

  /** The GCS and the sweep spacing cannot change while the robot is running a mission. */
  const locked = (started && !finished) || busy !== null;

  const cloudWp = latest.missionId === missionId ? latest : null;
  const wpNow = liveForMission?.currentWaypoint ?? piStatus?.currentWaypoint ?? cloudWp?.currentWaypoint ?? null;
  const wpIndex = typeof wpNow === 'number' ? wpNow : null;
  const wpTotal = liveForMission?.waypointTotal ?? piStatus?.totalWaypoints ?? cloudWp?.totalWaypoints ?? loadedHere?.count ?? null;
  const wpDone = liveForMission?.navigation?.completedWaypoints ?? piStatus?.completedWaypoints ?? null;
  const distToTarget = liveForMission?.navigation?.distanceToTargetM ?? null;
  const target = liveForMission?.navigation?.target ?? null;
  const cloudPct = cloudWp?.progressPercent ?? null;
  const pct = (done: number, total: number) =>
    `${cloudPct !== null && !liveForMission ? Math.round(cloudPct) : total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0}%`;
  const gcsStatus =
    robotState === 'returning' ? 'Returning to GCS' : robotState === 'completed' ? 'Back at GCS' : started && !finished ? 'Not yet' : null;
  const canReach = robotLink.configured;

  return (
    <>
      <Navbar />
      <main className="page">
        <PageHeader title="Mission Planner" sub="Plan and run polygon coverage missions: GCS → zigzag over the lake → GCS." />

        <div className="mission-layout">
          <section className="panel" aria-label="Mission summary">
            <div className="panel-head">
              <h3>{missionId ? `Mission ${missionId.slice(0, 8)}` : 'New mission'}</h3>
              <span className="chev"><ChevronRight size={18} /></span>
            </div>
            <p className="panel-sub">
              {lake ? `${lake.name ?? 'Unnamed lake'} · robot ${ROBOT_ID}` : 'No lake selected'}
              {robotLink.kind === 'pi' && (
                <span className={backendUp === false ? 'text-bad' : undefined}>
                  {' · '}backend {backendUp === null ? 'checking…' : backendUp ? 'reachable' : 'unreachable'}
                </span>
              )}
            </p>

            <dl className="kv-rows">
              {areaHa !== null && <div><dt><Ruler size={18} />Area</dt><dd>{areaHa < 10 ? areaHa.toFixed(2) : areaHa.toFixed(1)} ha</dd></div>}
              <div>
                <dt><MoveHorizontal size={18} /><label htmlFor="sweep-spacing">Sweep spacing</label></dt>
                <dd>
                  <input
                    id="sweep-spacing"
                    className="num-input"
                    type="number"
                    min={MIN_SPACING_M}
                    step={0.5}
                    value={spacingText}
                    disabled={locked || !lake}
                    onChange={(e) => setSpacingText(e.target.value)}
                    onBlur={(e) => commitSpacing(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && commitSpacing((e.target as HTMLInputElement).value)}
                    title="Distance between sweep lines: the robot's effective cleaning width"
                  />{' '}m
                </dd>
              </div>
              <div><dt><Waypoints size={18} />Waypoints</dt><dd>{hasPlan ? `${route.path.length} · ${route.sweeps} sweeps` : '—'}</dd></div>
              <div><dt><House size={18} />GCS</dt><dd>{gcs ? 'Set' : 'Not set'}</dd></div>
              {estimate && (
                <div title={`At ${ROBOT_SPEED_MPS} m/s`}>
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
              {gcsStatus && <div><dt>Return to GCS</dt><dd>{gcsStatus}</dd></div>}
            </dl>

            {wpIndex !== null && wpTotal ? (
              <div className="mission-progress" aria-label="Waypoint progress">
                <div className="mission-progress-head">
                  <span>Waypoint {wpIndex} of {wpTotal}{wpDone !== null ? ` · ${wpDone} reached` : ''}</span>
                  <span>{distToTarget !== null ? `${distToTarget.toFixed(1)} m to target` : pct(wpDone ?? wpIndex, wpTotal)}</span>
                </div>
                <div className="mission-progress-bar"><div className="mission-progress-fill" style={{ width: pct(wpDone ?? wpIndex, wpTotal) }} /></div>
              </div>
            ) : null}

            {lake && (
              <>
                {gcs && <p className="gcs-coords">GCS {gcs.lat.toFixed(6)}, {gcs.lon.toFixed(6)} · robot starts here and returns here</p>}
                <div className="gcs-row" role="group" aria-label="Ground control station">
                  <button type="button" className="btn" onClick={() => setPlacingGcs((v) => !v)} disabled={locked} aria-pressed={placingGcs}>
                    <Crosshair size={15} /> {placingGcs ? 'Click the map…' : gcs ? 'Move GCS' : 'Set GCS on map'}
                  </button>
                  {robot && (
                    <button type="button" className="btn" onClick={() => changeGcs(robot)} disabled={locked} title="Use the robot's current GPS position">
                      <LocateFixed size={15} /> Robot here
                    </button>
                  )}
                  {gcs && (
                    <button type="button" className="btn" onClick={() => changeGcs(null)} disabled={locked} aria-label="Clear GCS" title="Clear GCS">
                      <X size={15} />
                    </button>
                  )}
                </div>
              </>
            )}

            {lake && route.error && <div className="notice error" role="alert">{route.error}</div>}
            {route.warnings.map((w) => (
              <div key={w} className="notice error" role="alert">{w}</div>
            ))}
            {(!started || finished) && hasPlan && problems.length > 0 && (
              <div className="notice warn" role="status">
                <strong>Robot not ready</strong>
                <ul className="notice-list">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            )}

            {loadedHere && !loadedValid && !started && (
              <div className="notice" role="status">The plan changed after the robot stored it. Send it again before starting.</div>
            )}

            {!started || finished ? (
              <>
                <button
                  type="button"
                  className="btn-primary btn-block mission-start"
                  onClick={sendAndStart}
                  disabled={busy !== null || !hasPlan || !gcs || !canReach}
                  title={gcs ? undefined : 'Set the GCS first'}
                >
                  <Play size={15} /> {loadedValid && !finished ? 'Start mission' : 'Send plan & start mission'}
                </button>
                <button type="button" className="btn btn-block" onClick={() => void handleSend()} disabled={busy !== null || !hasPlan || !gcs || !canReach}>
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
                <button type="button" className="btn" onClick={() => run('STOP', 'Aborting…')} disabled={busy !== null}>
                  <Square size={15} /> Abort
                </button>
              </div>
            )}

            {missionId && gcs && (started || finished) && robotState !== 'returning' && robotState !== 'completed' && (
              <button type="button" className="btn btn-block" onClick={() => run('RETURN_HOME', 'Sending the robot back to the GCS…')} disabled={busy !== null}>
                <Undo2 size={15} /> Return to GCS
              </button>
            )}

            <button type="button" className="btn-danger btn-block" onClick={emergencyStop} disabled={stopping || !canReach}>
              <OctagonX size={16} /> {stopping ? 'Sending emergency stop…' : 'Emergency stop'}
            </button>

            {busy && <div className="notice" role="status">{busy}</div>}
            {notice && (
              <div className={`notice${notice.tone === 'info' ? '' : ` ${notice.tone}`}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
                {notice.text}
              </div>
            )}
            {!canReach && !DEMO && (
              <div className="notice" role="status">No robot connection is configured (VITE_API_BASE_URL or Supabase), so the robot cannot be reached.</div>
            )}

            <Link to="/observatory" className="btn btn-block">Edit lake polygon</Link>
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
              showGrid={false}
              plannedPath={route.coverage}
              seqOffset={gcs ? 1 : 0}
              gcs={gcs}
              returnLeg={route.returnLeg}
              addLakeMode={placingGcs}
              onPickPoint={placingGcs ? (p) => changeGcs(p) : undefined}
              detours={route.transits}
              blockedLegs={route.blocked}
              robot={robot}
              trail={trail}
              target={target}
              showLegend
              backTo="/"
            />
            {!lake && (
              <div className="map-hint"><span>Select a lake in the Observatory to plan a mission.</span></div>
            )}
            {placingGcs && (
              <div className="map-hint"><span>Click the map where the robot is launched. It starts here and returns here after the last sweep.</span></div>
            )}
            {lake && !boundary && !placingGcs && (
              <div className="map-hint"><span>No outline yet. Draw the lake polygon in the Observatory.</span></div>
            )}
          </div>
        </div>
        {DEMO && <p className="demo-note">Demo data — set VITE_DEMO=0 to use live sources.</p>}
      </main>
    </>
  );
}
