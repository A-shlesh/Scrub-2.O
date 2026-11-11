/**
 * Startup check: prints which transport and URLs this build uses, so a build made with the
 * wrong environment (e.g. no VITE_API_BASE_URL on Vercel) is obvious in the browser console.
 * It makes no network call; the backend health is logged once, from the Mission page, after
 * sign-in.
 */
import { API_BASE_URL, WS_BASE_URL } from '../../config/backend';
import { ROBOT_ID } from '../../config/robot';
import { DEMO } from '../../demo/demo';
import { supabaseConfigured } from '../supabase/supabaseClient';
import { robotLink } from './robotLink';

export function logStartup(): void {
  const telemetry = DEMO
    ? 'demo'
    : (import.meta.env.VITE_TELEMETRY_SOURCE as string | undefined)?.trim().toLowerCase() === 'supabase'
      ? 'supabase'
      : WS_BASE_URL
        ? `${WS_BASE_URL}/ws/telemetry`
        : 'none';
  console.info('[SCRUB] build config', {
    robot: ROBOT_ID,
    commands: robotLink.configured ? API_BASE_URL : `NOT CONFIGURED (${robotLink.problem ?? 'VITE_API_BASE_URL missing'})`,
    telemetry,
    supabase: supabaseConfigured ? 'configured' : 'not configured',
    demo: DEMO,
    loginRequired: import.meta.env.VITE_REQUIRE_LOGIN === '1',
  });
  if (!robotLink.configured) console.warn(`[SCRUB] ${robotLink.problem ?? 'Robot backend not configured (VITE_API_BASE_URL).'}`);
}

let healthLogged = false;
/** Log the first health result of this page load. */
export function logHealthOnce(up: boolean | null): void {
  if (healthLogged || up === null) return;
  healthLogged = true;
  const msg = `[SCRUB] robot backend ${API_BASE_URL} health: ${up ? 'OK' : 'UNREACHABLE'}`;
  if (up) console.info(msg);
  else console.warn(msg);
}
