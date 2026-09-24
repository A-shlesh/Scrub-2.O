import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ArrowRight, User } from 'lucide-react';
import { useTheme } from '../stores/theme';
import { useTelemetry } from '../stores/telemetry';

export function Navbar() {
  const { theme, toggle } = useTheme();
  const { connection, live, reconnect } = useTelemetry();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const statusLabel = live ? 'System Online' : connection.status === 'connecting' ? 'Connecting' : 'System Offline';
  const statusDot = live ? 'live' : connection.status === 'connecting' ? 'working' : 'error';
  const onHome = pathname === '/';

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link to="/" className="brand">SCRUB</Link>
        <nav className="nav-links" aria-label="Primary">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/observatory">Observatory</NavLink>
          <NavLink to="/mission">Mission</NavLink>
          <NavLink to="/analytics">Analytics</NavLink>
        </nav>
        <div className="nav-right">
          <span className="status-text" role="status">
            <span className={`dot ${statusDot}`} aria-hidden="true" />
            {statusLabel}
          </span>
          {onHome ? (
            <Link to="/telemetry" className="nav-cta">
              Open Dashboard <ArrowRight size={15} />
            </Link>
          ) : (
            <div className="profile-wrap" ref={menuRef}>
              <button
                type="button"
                className="avatar-btn"
                aria-label="Menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <User size={18} strokeWidth={1.8} />
              </button>
              {menuOpen && (
                <div className="profile-menu">
                  <button type="button" onClick={toggle}>
                    Theme: {theme === 'light' ? 'Light' : 'Dark'} → {theme === 'light' ? 'Dark' : 'Light'}
                  </button>
                  <button type="button" onClick={() => { reconnect(); setMenuOpen(false); }}>
                    Retry connection
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
