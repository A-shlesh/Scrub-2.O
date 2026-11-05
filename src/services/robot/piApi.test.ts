import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/backend', () => ({
  API_BASE_URL: 'https://pi.example.com',
  insecureUrlProblem: () => null,
}));
vi.mock('../supabase/supabaseClient', () => ({ supabase: null, supabaseConfigured: false }));

import { getMissionStatus, post } from './piApi';

const reply = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('Pi REST client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('treats 2xx as the robot confirming, with its answer as ack', async () => {
    const fetchMock = reply(201, { mission_id: 'm1', status: 'LOADED', waypoint_count: 12, checksum: 'abc' });
    vi.stubGlobal('fetch', fetchMock);
    const a = await post('/api/missions', { mission_id: 'm1' }, 1000);
    expect(a).toEqual({ status: 'ACKED', detail: null, ack: { mission_id: 'm1', status: 'LOADED', waypoint_count: 12, checksum: 'abc' } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://pi.example.com/api/missions');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('treats 4xx/5xx as a refusal with the backend reason (also FastAPI validation errors)', async () => {
    vi.stubGlobal('fetch', reply(409, { detail: 'No mission loaded' }));
    expect(await post('/api/missions/m1/start', {}, 1000)).toMatchObject({ status: 'REJECTED', detail: 'No mission loaded' });
    vi.stubGlobal('fetch', reply(422, { detail: [{ msg: 'field required' }, { msg: 'bad latitude' }] }));
    expect(await post('/api/missions', {}, 1000)).toMatchObject({ status: 'REJECTED', detail: 'field required; bad latitude' });
    vi.stubGlobal('fetch', reply(200, { ok: false, message: 'Waypoints failed validation' }));
    expect(await post('/api/missions', {}, 1000)).toMatchObject({ status: 'REJECTED', detail: 'Waypoints failed validation' });
  });

  it('reports a timeout as EXPIRED and a network failure as an error', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const pending = post('/api/missions/m1/start', {}, 1000);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).status).toBe('EXPIRED');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(post('/api/health', {}, 1000)).rejects.toThrow(/Cannot reach the robot backend/);
  });

  it('reads the robot-side mission state', async () => {
    vi.stubGlobal('fetch', reply(200, { state: 'NAVIGATING', current_waypoint: 4, total_waypoints: 20, completed_waypoints: 3 }));
    expect(await getMissionStatus('m1')).toMatchObject({ state: 'NAVIGATING', currentWaypoint: 4, totalWaypoints: 20, completedWaypoints: 3 });
    vi.stubGlobal('fetch', reply(404, {}));
    expect(await getMissionStatus('m1')).toBeNull();
  });
});
