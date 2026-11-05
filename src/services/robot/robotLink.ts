/**
 * How the dashboard reaches the robot. One interface, two transports:
 * - `pi`: REST calls to the Raspberry Pi backend (VITE_API_BASE_URL is set);
 * - `supabase`: rows in the `robot_commands` table that the Pi answers.
 * Both only report success after the robot itself confirmed.
 */
import { apiConfigured } from '../../config/backend';
import type { MissionPayload } from '../../utils/missionPayload';
import { supabaseConfigured } from '../supabase/supabaseClient';
import { ACK_TIMEOUT_MS, command as supabaseCommand } from '../supabase/robotService';
import { getMissionStatus, health, post } from './piApi';
import type { PiMissionStatus } from './piApi';

export type MissionCommand = 'START' | 'PAUSE' | 'RESUME' | 'STOP' | 'RETURN_HOME' | 'EMERGENCY_STOP';

export interface RobotAnswer {
  /** ACKED = robot confirmed; REJECTED = robot refused (see detail); EXPIRED = no answer in time */
  status: 'ACKED' | 'REJECTED' | 'EXPIRED';
  detail: string | null;
  /** the robot's answer body, e.g. {"waypoint_count", "checksum", "state"} */
  ack: Record<string, unknown> | null;
}

export interface RobotLink {
  kind: 'pi' | 'supabase' | 'none';
  configured: boolean;
  /** Send the mission; resolves once the robot validated and stored the waypoints (or refused). */
  loadMission(payload: MissionPayload): Promise<RobotAnswer>;
  command(cmd: MissionCommand, missionId: string | null): Promise<RobotAnswer>;
  /** Robot-side mission state, when the transport can ask for it. */
  missionStatus(missionId: string): Promise<PiMissionStatus | null>;
  health(): Promise<boolean | null>;
}

const PI_PATH: Record<Exclude<MissionCommand, 'EMERGENCY_STOP'>, string> = {
  START: 'start',
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP: 'abort',
  RETURN_HOME: 'return-home',
};

const piLink: RobotLink = {
  kind: 'pi',
  configured: true,
  loadMission: (payload) => post('/api/missions', payload, ACK_TIMEOUT_MS.LOAD_WAYPOINTS),
  command: (cmd, missionId) => {
    if (cmd === 'EMERGENCY_STOP') return post('/api/emergency-stop', { mission_id: missionId }, ACK_TIMEOUT_MS.EMERGENCY_STOP);
    if (!missionId) return Promise.reject(new Error('No mission selected.'));
    return post(`/api/missions/${encodeURIComponent(missionId)}/${PI_PATH[cmd]}`, {}, ACK_TIMEOUT_MS[cmd]);
  },
  missionStatus: (id) => getMissionStatus(id),
  health: () => health(),
};

const asAnswer = (row: { status: string; detail: string | null; ack: Record<string, unknown> | null }): RobotAnswer => ({
  status: row.status === 'ACKED' || row.status === 'REJECTED' ? row.status : 'EXPIRED',
  detail: row.detail,
  ack: row.ack,
});

const supabaseLink: RobotLink = {
  kind: 'supabase',
  configured: true,
  loadMission: async (payload) => asAnswer(await supabaseCommand('LOAD_WAYPOINTS', payload.mission_id, payload)),
  command: async (cmd, missionId) => asAnswer(await supabaseCommand(cmd, missionId)),
  missionStatus: async () => null,
  health: async () => null,
};

const noLink: RobotLink = {
  kind: 'none',
  configured: false,
  loadMission: () => Promise.reject(new Error('No robot connection is configured (VITE_API_BASE_URL or Supabase).')),
  command: () => Promise.reject(new Error('No robot connection is configured (VITE_API_BASE_URL or Supabase).')),
  missionStatus: async () => null,
  health: async () => null,
};

export const robotLink: RobotLink = apiConfigured ? piLink : supabaseConfigured ? supabaseLink : noLink;

/** One-line description of the robot's answer, for the UI. */
export function describeAnswer(cmd: MissionCommand | 'LOAD', a: RobotAnswer): string {
  const name =
    cmd === 'LOAD' ? 'the mission plan' : cmd === 'RETURN_HOME' ? 'return to GCS' : cmd === 'STOP' ? 'abort' : cmd.replace('_', ' ').toLowerCase();
  if (a.status === 'ACKED') return `Robot confirmed ${name}.`;
  if (a.status === 'REJECTED') return `Robot refused ${name}${a.detail ? `: ${a.detail}` : '.'}`;
  if (robotLink.kind === 'pi') return a.detail ?? `No answer from the robot for ${name}.`;
  return `No answer from the robot for ${name}. The command was cancelled, so the robot will not act on it.`;
}
