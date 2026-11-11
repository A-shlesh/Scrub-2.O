import { describe, expect, it } from 'vitest';
import { withToken } from './wsRealtimeService';

describe('WebSocket token', () => {
  it('appends ?token= (or &token=) only when there is a session token', () => {
    expect(withToken('wss://pi.example.com/ws/telemetry', null)).toBe('wss://pi.example.com/ws/telemetry');
    expect(withToken('wss://pi.example.com/ws/telemetry', 'a.b+c')).toBe('wss://pi.example.com/ws/telemetry?token=a.b%2Bc');
    expect(withToken('wss://pi.example.com/ws/telemetry?x=1', 'tok')).toBe('wss://pi.example.com/ws/telemetry?x=1&token=tok');
  });
});
