import { describe, expect, it } from 'vitest';
import { describeAnswer, NOT_CONFIGURED, robotLink } from './robotLink';

describe('robot link without VITE_API_BASE_URL', () => {
  it('refuses every command instead of falling back to Supabase', async () => {
    expect(robotLink.configured).toBe(false);
    await expect(robotLink.command('START', 'm1')).rejects.toThrow(NOT_CONFIGURED);
    await expect(robotLink.command('EMERGENCY_STOP', null)).rejects.toThrow(NOT_CONFIGURED);
    expect(await robotLink.health()).toBeNull();
  });

  it('describes answers, with the HTTP status when there is no reason', () => {
    expect(describeAnswer('START', { status: 'ACKED', detail: null, ack: null })).toBe('Robot confirmed start.');
    expect(describeAnswer('LOAD', { status: 'REJECTED', detail: null, ack: null, httpStatus: 502 })).toBe('Robot refused the mission plan (HTTP 502).');
    expect(describeAnswer('RETURN_HOME', { status: 'REJECTED', detail: 'busy', ack: null })).toBe('Robot refused return to GCS: busy');
  });
});
