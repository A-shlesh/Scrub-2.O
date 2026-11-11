import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, OctagonX, Pause, Play, Redo2, RotateCcw, Settings2, Square, Trash2, Undo2 } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { PageHeader } from '../components/PageHeader';
import { DemoCanvas } from '../components/DemoCanvas';
import { useTelemetry } from '../stores/telemetry';
import { DEMO } from '../demo/demo';
import { ROBOT_ID } from '../config/robot';
import { describeAnswer, NOT_CONFIGURED, robotLink } from '../services/robot/robotLink';
import type { MissionCommand } from '../services/robot/robotLink';
import { supabaseConfigured } from '../services/supabase/supabaseClient';
import {
  abandonMission,
  createMission,
  fetchDemoMissions,
  fetchMissionWaypoints,
  fetchNextDemoNumber,
  markMissionLoading,
  pushDemoLake,
} from '../services/supabase/supabaseService';
import type { DemoMissionItem } from '../services/supabase/supabaseService';
import { normaliseMissionState } from '../services/realtime/telemetryParser';
import { ackMismatch, buildMissionPayload } from '../utils/missionPayload';
import {
  addPoint,
  commit,
  extrapolate,
  FALLBACK_DEMO_DEFAULTS,
  movePoint,
  newHistory,
  planSteps,
  poseAt,
  redo,
  removePoint,
  segmentLengths,
  simulate,
  START,
  toLatLon,
  toMetres,
  totalLength,
  totalSeconds,
  undo,
  validatePath,
} from '../utils/demoPath';
import type { DemoDefaults, DemoPoint, DemoPose, DemoSettings, PathHistory } from '../utils/demoPath';
import { fmtMinutes } from '../utils/readiness';
import { fmtMissionState } from '../utils/format';
import type { MissionState } from '../types';

const SETTINGS_KEY = 'scrub:demoSettings';
const ACTIVE: MissionState[] = ['transit', 'sampling', 'returning', 'paused'];
const FINAL: MissionState[] = ['completed', 'aborted', 'emergency_stop', 'error'];

function loadOverrides(): Partial<DemoSettings> {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Partial<DemoSettings>) : {};
  } catch {
    return {};
  }
}

function saveOverrides(s: Partial<DemoSettings>) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings just are not remembered */
  }
}

type Notice = { tone: 'ok' | 'error' | 'info'; text: string };

interface RunInfo {
  missionId: string;
  name: string;
  saved: boolean;
  path: DemoPoint[];
}

export function DemoPage() {
  const { telemetry, live } = useTelemetry();
  const useCloud = supabaseConfigured && !DEMO;
  const [defaults, setDefaults] = useState<DemoDefaults>(FALLBACK_DEMO_DEFAULTS);
  const [defaultsFromPi, setDefaultsFromPi] = useState(false);
  const [overrides, setOverrides] = useState<Partial<DemoSettings>>(loadOverrides);
  const [hist, setHist] = useState<PathHistory>(() => newHistory());
  const [selected, setSelected] = useState<number | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [run, setRun] = useState<RunInfo | null>(null);
  const [ackState, setAckState] = useState<MissionState | null>(null);
  const [trail, setTrail] = useState<DemoPoint[]>([]);
  const [previewPose, setPreviewPose] = useState<DemoPose | null>(null);
  const [previewSeg, setPreviewSeg] = useState<number | null>(null);
  const [livePose, setLivePose] = useState<DemoPose | null>(null);
  const [demos, setDemos] = useState<DemoMissionItem[]>([]);
  const [demosError, setDemosError] = useState<string | null>(null);
  const previewRaf = useRef<number | null>(null);

  const path = hist.present;
  const settings: DemoSettings = {
    drive_mps_per_power: overrides.drive_mps_per_power ?? defaults.drive_mps_per_power,
    turn_dps_per_power: overrides.turn_dps_per_power ?? defaults.turn_dps_per_power,
    max_power: overrides.max_power ?? defaults.max_power,
    start_heading_deg: overrides.start_heading_deg ?? 0,
  };

  // Backend health and the Pi's demo defaults (calibration, limits, virtual origin).
  useEffect(() => {
    if (!robotLink.configured) return;
    let cancelled = false;
    const check = async () => {
      const up = await robotLink.health();
      if (cancelled) return;
      setBackendUp(up);
      if (up && !defaultsFromPi) {
        const d = await robotLink.demoDefaults(FALLBACK_DEMO_DEFAULTS);
        if (!cancelled && d) {
          setDefaults(d);
          setDefaultsFromPi(true);
        }
      }
    };
    void check();
    const id = window.setInterval(check, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [defaultsFromPi]);

  const loadDemos = useCallback(() => {
    if (!useCloud) return;
    fetchDemoMissions(ROBOT_ID).then(
      (d) => {
        setDemos(d);
        setDemosError(null);
      },
      (e) => setDemosError(e instanceof Error ? e.message : String(e)),
    );
  }, [useCloud]);
  useEffect(loadDemos, [loadDemos]);

  // ── Path editing ─────────────────────────────────────────────────────
  const edit = (next: DemoPoint[]) => setHist((h) => commit(h, next));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null && selected > 0 && !locked) {
        e.preventDefault();
        edit(removePoint(path, selected));
        setSelected(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !locked) {
        e.preventDefault();
        setHist((h) => (e.shiftKey ? redo(h) : undo(h)));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !locked) {
        e.preventDefault();
        setHist(redo);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const lens = useMemo(() => segmentLengths(path), [path]);
  const total = useMemo(() => totalLength(path), [path]);
  const errors = useMemo(() => validatePath(path, defaults), [path, defaults]);
  const steps = useMemo(
    () => planSteps(path, settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, settings.drive_mps_per_power, settings.turn_dps_per_power, settings.max_power, settings.start_heading_deg],
  );
  const etaS = totalSeconds(steps);

  // ── Preview (local only, never contacts the robot) ───────────────────
  const stopPreview = () => {
    if (previewRaf.current !== null) cancelAnimationFrame(previewRaf.current);
    previewRaf.current = null;
    setPreviewPose(null);
    setPreviewSeg(null);
  };
  const preview = () => {
    stopPreview();
    const frames = simulate(steps, settings);
    const end = frames[frames.length - 1]?.t ?? 0;
    if (end === 0) return;
    // Real time, sped up so long paths stay watchable (at most ~20 s).
    const speed = Math.max(1, end / 20);
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = ((now - t0) / 1000) * speed;
      const f = poseAt(frames, t);
      setPreviewPose(f);
      setPreviewSeg(f.segment);
      if (t < end) previewRaf.current = requestAnimationFrame(tick);
      else previewRaf.current = null;
    };
    previewRaf.current = requestAnimationFrame(tick);
  };
  useEffect(() => stopPreview, []);

  // ── Live view from the Pi's telemetry (frame.demo) ───────────────────
  const demoT = telemetry?.demo ?? null;
  const liveForRun = run && telemetry && (!telemetry.missionId || telemetry.missionId === run.missionId) ? telemetry : null;
  const liveDemo = liveForRun && demoT && demoT.x_m !== null && demoT.y_m !== null ? demoT : null;
  const lastFrame = useRef<{ pose: DemoPose; at: number; left: number; right: number; step: 'TURN' | 'DRIVE' | 'SETTLE' | null; segment: number | null } | null>(null);

  useEffect(() => {
    if (!liveDemo || liveDemo.x_m === null || liveDemo.y_m === null) return;
    const pose = { x_m: liveDemo.x_m, y_m: liveDemo.y_m, heading_deg: liveDemo.heading_deg ?? 0 };
    lastFrame.current = { pose, at: performance.now(), left: liveDemo.left ?? 0, right: liveDemo.right ?? 0, step: liveDemo.step, segment: liveDemo.segment };
    setLivePose(pose);
    setTrail((t) => {
      const last = t[t.length - 1];
      return last && last.x_m === pose.x_m && last.y_m === pose.y_m ? t : [...t, { x_m: pose.x_m, y_m: pose.y_m }].slice(-2000);
    });
  }, [liveDemo?.x_m, liveDemo?.y_m, liveDemo?.heading_deg, liveDemo?.step, liveDemo?.segment]); // eslint-disable-line react-hooks/exhaustive-deps

  // Smooth motion between 2 s frames; frozen when telemetry is stale.
  useEffect(() => {
    if (!run || !live) return;
    let raf = 0;
    const tick = () => {
      const f = lastFrame.current;
      if (f) {
        const tgt = f.segment && f.segment < run.path.length ? run.path[f.segment] : null;
        setLivePose(extrapolate(f.pose, f.left, f.right, (performance.now() - f.at) / 1000, settings, tgt, f.step));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, live]);

  function robotStateFor(): MissionState | null {
    if (liveForRun && liveForRun.missionState !== 'unknown') return liveForRun.missionState;
    return ackState;
  }
  function isFinal(s: MissionState | null) {
    return s !== null && FINAL.includes(s);
  }
  const robotState = robotStateFor();
  /** no editing while a command is in flight or a demo is running */
  const locked = busy !== null || (run !== null && !isFinal(robotState));
  const running = run !== null && robotState !== null && ACTIVE.includes(robotState);
  const paused = robotState === 'paused';
  const finished = isFinal(robotState);
  const segment = liveDemo?.segment ?? null;
  const stepName = liveDemo?.step ?? null;
  const canReach = robotLink.configured && backendUp !== false;

  // ── Run flow ─────────────────────────────────────────────────────────
  const runDemo = async () => {
    stopPreview();
    if (errors.length > 0) {
      setNotice({ tone: 'error', text: errors[0] });
      return;
    }
    const ok = window.confirm(
      'Before running the demo, check:\n\n' +
        '- The robot is in a safe open area, or its wheels are lifted off the ground.\n' +
        '- It is at the start point, facing the direction of the arrow (up on the canvas).\n' +
        '- The kill switch is within reach.\n\n' +
        'The robot drives open loop (no GPS or compass), so it will drift. Run the demo?',
    );
    if (!ok) return;

    setNotice(null);
    setTrail([]);
    setLivePose(null);
    lastFrame.current = null;
    setAckState(null);
    const missionId = crypto.randomUUID();
    const drawn = path.map((p) => ({ ...p }));
    let name = 'Demo (not saved)';
    let lakeId: string | null = null;
    let recorded = false;
    let saveProblem: string | null = null;
    try {
      if (useCloud) {
        try {
          setBusy('Saving the demo to Supabase…');
          name = `Demo ${await fetchNextDemoNumber()}`;
          lakeId = await pushDemoLake(name);
        } catch (e) {
          name = 'Demo (not saved)';
          lakeId = null;
          saveProblem = e instanceof Error ? e.message : String(e);
        }
      } else {
        saveProblem = 'Supabase is not configured.';
      }

      const ll = drawn.map((p) => toLatLon(p, defaults.origin));
      const payload = await buildMissionPayload({
        missionId,
        deviceId: ROBOT_ID,
        lakeId,
        lakeName: name,
        gcs: ll[0],
        polygon: [],
        islands: [],
        sweepSpacingM: 0,
        shoreMarginM: 0,
        acceptanceRadiusM: 0.5,
        path: ll,
        kinds: ll.map((_, i) => (i === 0 ? 'GCS' : 'COVERAGE')),
        demo: {
          path_m: drawn,
          start_heading_deg: settings.start_heading_deg,
          calibration: { drive_mps_per_power: settings.drive_mps_per_power, turn_dps_per_power: settings.turn_dps_per_power },
          max_power: settings.max_power,
        },
      });

      if (lakeId) {
        await createMission(`demo:${lakeId}`, lakeId, payload);
        recorded = true;
        void markMissionLoading(missionId);
      }
      setRun({ missionId, name, saved: recorded, path: drawn });

      setBusy(`Sent ${payload.waypoint_count} points. Waiting for the robot to store them…`);
      const answer = await robotLink.loadMission(payload);
      if (answer.status !== 'ACKED') {
        const why = describeAnswer('LOAD', answer);
        if (recorded) await abandonMission(missionId, why);
        setNotice({ tone: 'error', text: why });
        setAckState('error');
        return;
      }
      const mismatch = ackMismatch(payload, answer.ack);
      if (mismatch) {
        if (recorded) await abandonMission(missionId, mismatch);
        setNotice({ tone: 'error', text: mismatch });
        setAckState('error');
        return;
      }
      setAckState('loaded');

      setBusy('Starting the demo…');
      const start = await robotLink.command('START', missionId);
      if (start.status !== 'ACKED') {
        setNotice({ tone: 'error', text: describeAnswer('START', start) });
        return;
      }
      setAckState('transit');
      setNotice({
        tone: saveProblem ? 'info' : 'ok',
        text: saveProblem ? `${name} is running. It was not saved: ${saveProblem}` : `${name} is running.`,
      });
      loadDemos();
    } catch (e) {
      if (recorded) await abandonMission(missionId, 'Sending the demo failed.');
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : 'Could not run the demo.' });
    } finally {
      setBusy(null);
    }
  };

  const control = async (cmd: Exclude<MissionCommand, 'EMERGENCY_STOP' | 'RETURN_HOME'>, label: string) => {
    if (!run) return;
    if (cmd === 'STOP' && !window.confirm('Abort the demo? The motors stop and the robot stays where it is.')) return;
    setBusy(label);
    try {
      const a = await robotLink.command(cmd, run.missionId);
      setNotice({ tone: a.status === 'ACKED' ? 'ok' : 'error', text: describeAnswer(cmd, a) });
      if (a.status === 'ACKED') {
        const st = normaliseMissionState(a.ack?.mission_state ?? a.ack?.state);
        setAckState(st !== 'unknown' ? st : cmd === 'PAUSE' ? 'paused' : cmd === 'STOP' ? 'aborted' : 'transit');
      }
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : `Could not send ${cmd}.` });
    } finally {
      setBusy(null);
    }
  };

  const [stopping, setStopping] = useState(false);
  const emergencyStop = async () => {
    setStopping(true);
    try {
      const a = await robotLink.command('EMERGENCY_STOP', run?.missionId ?? null);
      setNotice({ tone: a.status === 'ACKED' ? 'ok' : 'error', text: describeAnswer('EMERGENCY_STOP', a) });
      if (a.status === 'ACKED') setAckState('emergency_stop');
    } catch (e) {
      setNotice({ tone: 'error', text: `Emergency stop could not be sent: ${e instanceof Error ? e.message : String(e)}. Use the robot's kill switch.` });
    } finally {
      setStopping(false);
    }
  };

  /** Load a previous demo's path back onto the canvas (to edit or re-run as a NEW demo). */
  const openDemo = async (d: DemoMissionItem) => {
    if (locked) return;
    try {
      const ll = await fetchMissionWaypoints(d.missionId);
      if (ll.length < 2) {
        setNotice({ tone: 'error', text: `${d.name} has no stored path.` });
        return;
      }
      const pts = ll.map((p) => toMetres(p, defaults.origin)).map((p) => ({ x_m: Number(p.x_m.toFixed(3)), y_m: Number(p.y_m.toFixed(3)) }));
      pts[0] = START;
      edit(pts);
      setSelected(null);
      stopPreview();
      setRun(null);
      setTrail([]);
      setNotice({ tone: 'info', text: `${d.name} loaded. Running it creates a new demo.` });
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const setSetting = (key: keyof DemoSettings, value: string) => {
    const v = Number(value);
    const next = { ...overrides };
    if (value === '' || !Number.isFinite(v)) delete next[key];
    else next[key] = v;
    setOverrides(next);
    saveOverrides(next);
  };

  const robotPose = previewPose ?? (run ? livePose : null);
  const stale = run !== null && !live && livePose !== null && !finished;
  const currentSegment = previewPose ? previewSeg : run ? segment : null;
  const progress = run && segment ? Math.min(100, Math.round(((segment - 1) / Math.max(1, run.path.length - 1)) * 100)) : null;

  return (
    <>
      <Navbar />
      <main className="page">
        <PageHeader
          title="Demo mission"
          sub="Draw a path; the robot turns and drives along it using motor commands only (no GPS or compass)."
        />

        {!robotLink.configured && !DEMO && (
          <div className="notice error" role="alert">
            <strong>{robotLink.problem ? 'Robot backend URL is not usable' : NOT_CONFIGURED}</strong>
            <br />
            {robotLink.problem ?? 'Set VITE_API_BASE_URL in Vercel and redeploy without the build cache. You can still draw and preview a path.'}
          </div>
        )}
        {robotLink.configured && backendUp === false && (
          <div className="notice error" role="alert">
            <strong>Robot backend not reachable</strong> at <code>{robotLink.baseUrl}</code>. You can still draw and preview a path.
          </div>
        )}

        <div className="demo-layout">
          <section className="panel demo-panel" aria-label="Demo controls">
            <div className="demo-tools" role="toolbar" aria-label="Edit path">
              <button type="button" className="btn" onClick={() => setHist(undo)} disabled={locked || hist.past.length === 0} title="Undo (Ctrl+Z)">
                <Undo2 size={15} />
              </button>
              <button type="button" className="btn" onClick={() => setHist(redo)} disabled={locked || hist.future.length === 0} title="Redo (Ctrl+Y)">
                <Redo2 size={15} />
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (selected !== null && selected > 0) {
                    edit(removePoint(path, selected));
                    setSelected(null);
                  }
                }}
                disabled={locked || selected === null || selected === 0}
                title="Remove the selected point (Delete)"
              >
                <Trash2 size={15} />
              </button>
              <button type="button" className="btn" onClick={() => { edit([START]); setSelected(null); stopPreview(); }} disabled={locked || path.length < 2} title="Clear the path">
                <RotateCcw size={15} /> Clear
              </button>
              <label className="demo-snap">
                <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> Snap 0.5 m
              </label>
              <button type="button" className="btn" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings} title="Calibration and limits">
                <Settings2 size={15} />
              </button>
            </div>

            {showSettings && (
              <div className="demo-settings">
                <label>
                  Drive speed (m/s per power unit)
                  <input type="number" step="0.0005" min="0" placeholder={String(defaults.drive_mps_per_power)} value={overrides.drive_mps_per_power ?? ''} onChange={(e) => setSetting('drive_mps_per_power', e.target.value)} />
                </label>
                <label>
                  Turn rate (deg/s per power unit)
                  <input type="number" step="0.05" min="0" placeholder={String(defaults.turn_dps_per_power)} value={overrides.turn_dps_per_power ?? ''} onChange={(e) => setSetting('turn_dps_per_power', e.target.value)} />
                </label>
                <label>
                  Max power (1–999)
                  <input type="number" step="1" min="1" max="999" placeholder={String(defaults.max_power)} value={overrides.max_power ?? ''} onChange={(e) => setSetting('max_power', e.target.value)} />
                </label>
                <label>
                  Start heading (°, 0 = up)
                  <input type="number" step="1" placeholder="0" value={overrides.start_heading_deg ?? ''} onChange={(e) => setSetting('start_heading_deg', e.target.value)} />
                </label>
                <p className="panel-sub">
                  {defaultsFromPi ? 'Defaults from the robot.' : 'Defaults built in (robot not reached).'} Empty = default. Limits: {defaults.max_points} points,{' '}
                  {defaults.max_path_m} m, segments ≥ {defaults.min_segment_m} m.
                </p>
                <p className="panel-sub">
                  Calibrate: drive straight 10 s at power 100 and measure the distance (m ÷ 10 ÷ 100 = m/s per power unit); spin in place 10 s at
                  power 100 and measure the angle (° ÷ 10 ÷ 100 = deg/s per power unit).
                </p>
              </div>
            )}

            <dl className="kv-rows">
              <div><dt>Points</dt><dd>{path.length - 1}</dd></div>
              <div><dt>Length</dt><dd>{total.toFixed(1)} m</dd></div>
              <div><dt>Est. time</dt><dd>{etaS > 0 ? fmtMinutes(etaS / 60) : '—'}</dd></div>
              {run && <div><dt>Demo</dt><dd>{run.name}{run.saved ? '' : ' · not saved'}</dd></div>}
              {run && <div><dt>State</dt><dd>{robotState ? fmtMissionState(robotState) : 'Waiting…'}</dd></div>}
              {run && segment !== null && (
                <div><dt>Segment</dt><dd>{segment} of {run.path.length - 1}{stepName ? ` · ${stepName}` : ''}</dd></div>
              )}
            </dl>
            {progress !== null && (
              <div className="mission-progress" aria-label="Demo progress">
                <div className="mission-progress-bar"><div className="mission-progress-fill" style={{ width: `${progress}%` }} /></div>
              </div>
            )}

            {lens.length > 0 && (
              <ol className="demo-segs" aria-label="Segments">
                {lens.map((l, i) => (
                  <li key={i} className={l < defaults.min_segment_m ? 'text-bad' : undefined}>
                    {i === 0 ? 'Start' : `Point ${i}`} → point {i + 1}: {l.toFixed(2)} m
                  </li>
                ))}
              </ol>
            )}

            {errors.length > 0 && path.length > 1 && (
              <div className="notice error" role="alert">
                <ul className="notice-list">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
              </div>
            )}

            {!running ? (
              <>
                <button type="button" className="btn btn-block" onClick={previewPose ? stopPreview : preview} disabled={path.length < 2 || busy !== null}>
                  <Eye size={15} /> {previewPose ? 'Stop preview' : 'Preview'}
                </button>
                <button type="button" className="btn-primary btn-block" onClick={runDemo} disabled={busy !== null || errors.length > 0 || !canReach}>
                  <Play size={15} /> Run demo
                </button>
              </>
            ) : (
              <div className="mission-controls" role="group" aria-label="Demo controls">
                {paused ? (
                  <button type="button" className="btn" onClick={() => control('RESUME', 'Resuming…')} disabled={busy !== null}>
                    <Play size={15} /> Resume
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => control('PAUSE', 'Pausing…')} disabled={busy !== null}>
                    <Pause size={15} /> Pause
                  </button>
                )}
                <button type="button" className="btn" onClick={() => control('STOP', 'Aborting…')} disabled={busy !== null}>
                  <Square size={15} /> Abort
                </button>
              </div>
            )}

            <button type="button" className="btn-danger btn-block demo-estop" onClick={emergencyStop} disabled={stopping || !robotLink.configured}>
              <OctagonX size={18} /> {stopping ? 'Sending emergency stop…' : 'Emergency stop'}
            </button>

            {busy && <div className="notice" role="status">{busy}</div>}
            {notice && (
              <div className={`notice${notice.tone === 'info' ? '' : ` ${notice.tone}`}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
                {notice.text}
              </div>
            )}

            {useCloud && (
              <div className="demo-saved">
                <h3>Previous demos</h3>
                {demosError && <div className="notice error" role="alert">{demosError}</div>}
                {demos.length === 0 && !demosError ? (
                  <p className="panel-sub">No demos yet.</p>
                ) : (
                  <ul>
                    {demos.map((d) => (
                      <li key={d.missionId}>
                        <button type="button" className="demo-saved-row" onClick={() => void openDemo(d)} disabled={locked}>
                          <span className="badge">Demo</span>
                          <strong>{d.name}</strong>
                          <span>{d.status}</span>
                          <span>{new Date(d.createdAt).toLocaleString()}</span>
                          <span>{d.points !== null ? `${d.points} pts` : ''}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <div className="map-wrap tall demo-wrap">
            <DemoCanvas
              path={run && !finished ? run.path : path}
              editable={!locked && !previewPose}
              selected={selected}
              onSelect={setSelected}
              onAdd={(p) => edit(addPoint(path, p))}
              onMove={(i, p) => edit(movePoint(path, i, p))}
              snapStep={snapOn ? 0.5 : 0}
              startHeading={settings.start_heading_deg}
              robot={robotPose}
              robotStale={stale}
              trail={run ? trail : []}
              currentSegment={currentSegment}
            />
            {path.length < 2 && !run && (
              <div className="map-hint"><span>Click the canvas to add points. The robot starts at the arrow, facing up.</span></div>
            )}
          </div>
        </div>
        {DEMO && <p className="demo-note">Design-review data is on (VITE_DEMO=1); Demo missions still talk to the real robot backend.</p>}
      </main>
    </>
  );
}
