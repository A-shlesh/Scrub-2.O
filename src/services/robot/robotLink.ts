/**
 * How the dashboard reaches the robot: REST calls to the Raspberry Pi backend
 * (VITE_API_BASE_URL). There is no other command path: the shared Supabase schema has
 * no command table. Without VITE_API_BASE_URL every command is refused up front and the
 * Mission page shows "Robot backend not configured".
 * Every answer only counts as success after the robot itself confirmed.
 */
import { API_BASE_URL, apiConfigured, insecureUrlProblem } from '../../config/backend';
import type { MissionPayload } from '../../utils/missionPayload';
import { getDemoDefaults, getMissionStatus, health, post } from './piApi';
import type { DemoDefaults } from '../../utils/demoPath';
import type { PiMissionStatus } from './piApi';

export type MissionCommand = 'START' | 'PAUSE' | 'RESUME' | 'STOP' | 'RETURN_HOME' | 'EMERGENCY_STOP';

export interface RobotAnswer {
  /** ACKED = robot confirmed; REJECTED = robot refused (see detail); EXPIRED = no answer in time */
  status: 'ACKED' | 'REJECTED' | 'EXPIRED';
  detail: string | null;
  /** the robot's answer body, e.g. {"waypoint_count", "checksum", "state"} */
  ack: Record<string, unknown> | null;
  /** HTTP status of the answer, when there was one */
  httpStatus?: number | null;
}

/** How long to wait for the robot before giving up. */
export const ACK_TIMEOUT_MS: Record<MissionCommand | 'LOAD', number> = {
  LOAD: 30_000,
  START: 15_000,
  PAUSE: 15_000,
  RESUME: 15_000,
  STOP: 15_000,
  RETURN_HOME: 15_000,
  EMERGENCY_STOP: 15_000,
};

export const NOT_CONFIGURED = 'Robot backend not configured (VITE_API_BASE_URL).';

export interface RobotLink {
  configured: boolean;
  /** base URL of the Pi backend, '' when not configured */
  baseUrl: string;
  /** why the browser cannot use the configured URL (e.g. http:// on an https:// page), or null */
  problem: string | null;
  /** Send the mission; resolves once the robot validated and stored the waypoints (or refused). */
  loadMission(payload: MissionPayload): Promise<RobotAnswer>;
  command(cmd: MissionCommand, missionId: string | null): Promise<RobotAnswer>;
  /** Robot-side mission state. */
  missionStatus(missionId: string): Promise<PiMissionStatus | null>;
  /** true when GET /api/health answers 2xx; false when unreachable; null when not configured */
  health(): Promise<boolean | null>;
  /** the Pi's demo calibration and limits, or null when unavailable */
  demoDefaults(fallback: DemoDefaults): Promise<DemoDefaults | null>;
}

const PI_PATH: Record<Exclude<MissionCommand, 'EMERGENCY_STOP'>, string> = {
  START: 'start',
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP: 'abort',
  RETURN_HOME: 'return-home',
};

function makeLink(): RobotLink {
  const problem = apiConfigured ? insecureUrlProblem(API_BASE_URL) : null;
  if (!apiConfigured || problem) {
    const why = problem ?? NOT_CONFIGURED;
    return {
      configured: false,
      baseUrl: API_BASE_URL,
      problem,
      loadMission: () => Promise.reject(new Error(why)),
      command: () => Promise.reject(new Error(why)),
      missionStatus: async () => null,
      health: async () => null,
      demoDefaults: async () => null,
    };
  }
  return {
    configured: true,
    baseUrl: API_BASE_URL,
    problem: null,
    loadMission: (payload) => post('/api/missions', payload, ACK_TIMEOUT_MS.LOAD),
    command: (cmd, missionId) => {
      if (cmd === 'EMERGENCY_STOP') return post('/api/emergency-stop', { mission_id: missionId }, ACK_TIMEOUT_MS.EMERGENCY_STOP);
      if (!missionId) return Promise.reject(new Error('No mission selected.'));
      return post(`/api/missions/${encodeURIComponent(missionId)}/${PI_PATH[cmd]}`, {}, ACK_TIMEOUT_MS[cmd]);
    },
    missionStatus: (id) => getMissionStatus(id),
    health: () => health(),
    demoDefaults: (fallback) => getDemoDefaults(fallback),
  };
}

export const robotLink: RobotLink = makeLink();

/** One-line description of the robot's answer, for the UI. */
export function describeAnswer(cmd: MissionCommand | 'LOAD', a: RobotAnswer): string {
  const name =
    cmd === 'LOAD' ? 'the mission plan' : cmd === 'RETURN_HOME' ? 'return to GCS' : cmd === 'STOP' ? 'abort' : cmd.replace('_', ' ').toLowerCase();
  const http = a.httpStatus ? ` (HTTP ${a.httpStatus})` : '';
  if (a.status === 'ACKED') return `Robot confirmed ${name}.`;
  if (a.status === 'REJECTED') return `Robot refused ${name}${a.detail ? `: ${a.detail}` : `${http}.`}`;
  return a.detail ?? `No answer from the robot for ${name}${http}.`;
}
