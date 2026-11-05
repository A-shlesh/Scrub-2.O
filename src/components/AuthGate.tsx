import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { supabase, supabaseConfigured } from '../services/supabase/supabaseClient';

/** Operators must sign in (Supabase Auth) when VITE_REQUIRE_LOGIN=1. */
export const LOGIN_REQUIRED = import.meta.env.VITE_REQUIRE_LOGIN === '1' && supabaseConfigured;

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

/** Shows a sign-in form until an operator is signed in; renders the app as-is when login is not required. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'out' | 'in'>(LOGIN_REQUIRED ? 'checking' : 'in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!LOGIN_REQUIRED || !supabase) return;
    supabase.auth.getSession().then(({ data }) => setState(data.session ? 'in' : 'out'));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setState(session ? 'in' : 'out'));
    return () => data.subscription.unsubscribe();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(err.message);
  };

  if (state === 'in') return <>{children}</>;
  if (state === 'checking') return <main className="auth-page"><p className="auth-sub">Checking sign-in…</p></main>;
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>SCRUB</h1>
        <p className="auth-sub">Sign in to control the robot.</p>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="notice error" role="alert">{error}</div>}
        <button type="submit" className="btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="auth-sub">Accounts are created by the admin in Supabase (Authentication → Users).</p>
      </form>
    </main>
  );
}
