/**
 * Commands to the robot through Supabase (`robot_commands`), each acknowledged by the robot.
 * Protocol: docs/robot-protocol.md.
 */
import { supabase, supabaseConfigured } from './supabaseClient';

/** The robot this dashboard controls. */
export const ROBOT_ID = (import.meta.env.VITE_ROBOT_ID as string | undefined)?.trim() || 'BOT001';

export type RobotCommand = 'LOAD_WAYPOINTS' | 'START' | 'PAUSE' | 'RESUME' | 'STOP' | 'EMERGENCY_STOP';
export type CommandStatus = 'PENDING' | 'ACKED' | 'REJECTED' | 'EXPIRED';

export interface CommandRow {
  command_id: string;
  device_id: string;
  mission_id: string | null;
  command: RobotCommand;
  status: CommandStatus;
  detail: string | null;
  ack: Record<string, unknown> | null;
  created_at: string;
  acked_at: string | null;
}

/** How long to wait for the robot before giving up (and expiring the command). */
export const ACK_TIMEOUT_MS: Record<RobotCommand, number> = {
  LOAD_WAYPOINTS: 30_000,
  START: 15_000,
  PAUSE: 15_000,
  RESUME: 15_000,
  STOP: 15_000,
  EMERGENCY_STOP: 15_000,
};

const POLL_MS = 2000;
const COLUMNS = 'command_id, device_id, mission_id, command, status, detail, ack, created_at, acked_at';

function client() {
  if (!supabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured — missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.');
  }
  return supabase;
}

/** Insert a PENDING command for the robot. Returns its id. */
export async function sendCommand(command: RobotCommand, missionId: string | null, payload: unknown = null): Promise<string> {
  const sb = client();
  const commandId = crypto.randomUUID();
  const { error } = await sb.from('robot_commands').insert({
    command_id: commandId,
    device_id: ROBOT_ID,
    mission_id: missionId,
    command,
    payload,
    status: 'PENDING',
  });
  if (error) throw new Error(`Could not send ${command} to the robot: ${error.message}`);
  return commandId;
}

async function readCommand(commandId: string): Promise<CommandRow | null> {
  const { data, error } = await client().from('robot_commands').select(COLUMNS).eq('command_id', commandId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CommandRow | null) ?? null;
}

/**
 * Wait until the robot answers the command (ACKED / REJECTED). Listens through
 * Realtime and also polls, so it works even if Realtime is not enabled for the table.
 * On timeout the command is marked EXPIRED (only if still PENDING) so the robot never
 * acts on it late; if the robot answered at the last moment, that answer is returned.
 */
export function waitForAck(commandId: string, timeoutMs: number): Promise<CommandRow> {
  const sb = client();
  return new Promise<CommandRow>((resolve, reject) => {
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(timer);
      void sb.removeChannel(channel);
      settle();
    };
    const consider = (row: CommandRow | null) => {
      if (row && row.status !== 'PENDING') finish(() => resolve(row));
    };

    const channel = sb
      .channel(`command:${commandId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'robot_commands', filter: `command_id=eq.${commandId}` },
        (change) => consider(change.new as CommandRow),
      )
      .subscribe();

    const poll = setInterval(() => {
      readCommand(commandId).then(consider, () => { /* keep waiting; the timeout decides */ });
    }, POLL_MS);

    const timer = setTimeout(async () => {
      try {
        const { data, error } = await sb
          .from('robot_commands')
          .update({ status: 'EXPIRED', detail: 'The robot did not answer in time.' })
          .eq('command_id', commandId)
          .eq('status', 'PENDING')
          .select(COLUMNS)
          .maybeSingle();
        if (error) throw new Error(error.message);
        const row = (data as CommandRow | null) ?? (await readCommand(commandId));
        if (!row) throw new Error('The command disappeared before the robot answered.');
        finish(() => resolve(row));
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    }, timeoutMs);
  });
}

/** Send a command and wait for the robot's answer. */
export async function command(cmd: RobotCommand, missionId: string | null, payload: unknown = null): Promise<CommandRow> {
  const id = await sendCommand(cmd, missionId, payload);
  return waitForAck(id, ACK_TIMEOUT_MS[cmd]);
}

/** One-line description of the robot's answer, for the UI. */
export function describeAnswer(cmd: RobotCommand, row: CommandRow): string {
  const name = cmd.replace('_', ' ').toLowerCase();
  if (row.status === 'ACKED') return `Robot confirmed ${name}.`;
  if (row.status === 'REJECTED') return `Robot refused ${name}${row.detail ? `: ${row.detail}` : '.'}`;
  if (row.status === 'EXPIRED') return `No answer from the robot for ${name}. The command was cancelled, so the robot will not act on it.`;
  return `Waiting for the robot (${name})…`;
}
