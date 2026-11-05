import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A tiny in-memory stand-in for the parts of the Supabase client robotService uses. */
const fake = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  function builder() {
    let patch: Record<string, unknown> | null = null;
    const filters: Array<[string, unknown]> = [];
    const b = {
      insert(row: Record<string, unknown>) {
        rows.set(row.command_id as string, { detail: null, ack: null, acked_at: null, created_at: 'now', ...row });
        return Promise.resolve({ error: null });
      },
      select() { return b; },
      update(p: Record<string, unknown>) { patch = p; return b; },
      eq(k: string, v: unknown) { filters.push([k, v]); return b; },
      maybeSingle() {
        const row = [...rows.values()].find((r) => filters.every(([k, v]) => r[k] === v));
        if (row && patch) Object.assign(row, patch);
        return Promise.resolve({ data: row ? { ...row } : null, error: null });
      },
    };
    return b;
  }
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    rows,
    client: { from: () => builder(), channel: () => channel, removeChannel: () => Promise.resolve('ok') },
  };
});

vi.mock('./supabaseClient', () => ({ supabase: fake.client, supabaseConfigured: true }));

import { ACK_TIMEOUT_MS, command, describeAnswer, sendCommand, waitForAck } from './robotService';

/** What the Pi does: answer a pending command. */
function robotAnswers(commandId: string, status: 'ACKED' | 'REJECTED', extra: Record<string, unknown> = {}) {
  const row = fake.rows.get(commandId);
  if (row && row.status === 'PENDING') Object.assign(row, { status, acked_at: 'now', ...extra });
}

beforeEach(() => {
  fake.rows.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('robot commands', () => {
  it('sends a PENDING command for the robot', async () => {
    const id = await sendCommand('START', 'm1');
    expect(fake.rows.get(id)).toMatchObject({ command: 'START', mission_id: 'm1', device_id: 'BOT001', status: 'PENDING' });
  });

  it('returns the robot acknowledgement, with its ack data', async () => {
    const id = await sendCommand('LOAD_WAYPOINTS', 'm1', { count: 3 });
    const answer = waitForAck(id, ACK_TIMEOUT_MS.LOAD_WAYPOINTS);
    robotAnswers(id, 'ACKED', { ack: { count: 3, sha256: 'abc' } });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(answer).resolves.toMatchObject({ status: 'ACKED', ack: { count: 3, sha256: 'abc' } });
  });

  it('returns a refusal with the robot reason', async () => {
    const id = await sendCommand('START', 'm1');
    const answer = waitForAck(id, ACK_TIMEOUT_MS.START);
    robotAnswers(id, 'REJECTED', { detail: 'no waypoints loaded' });
    await vi.advanceTimersByTimeAsync(2000);
    const row = await answer;
    expect(row.status).toBe('REJECTED');
    expect(describeAnswer('START', row)).toBe('Robot refused start: no waypoints loaded');
  });

  it('expires an unanswered command so the robot can never act on it late', async () => {
    const answer = command('START', 'm1');
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS.START + 10);
    const row = await answer;
    expect(row.status).toBe('EXPIRED');
    expect(fake.rows.get(row.command_id)?.status).toBe('EXPIRED');
    // The robot answering afterwards changes nothing.
    robotAnswers(row.command_id, 'ACKED');
    expect(fake.rows.get(row.command_id)?.status).toBe('EXPIRED');
  });

  it('keeps a last-moment acknowledgement instead of expiring it', async () => {
    const id = await sendCommand('PAUSE', 'm1');
    const answer = waitForAck(id, 1000); // shorter than one poll, so only the timeout path sees the answer
    robotAnswers(id, 'ACKED');
    await vi.advanceTimersByTimeAsync(1010);
    await expect(answer).resolves.toMatchObject({ status: 'ACKED' });
  });
});
