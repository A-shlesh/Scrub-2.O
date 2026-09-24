import { useId, useMemo } from 'react';
import type { SeriesPoint } from '../types';

/**
 * Minimal readable area chart. Renders an honest empty state when the
 * backend provides no points — never a fabricated line.
 */
export function ChartCard({
  title,
  unit,
  points,
  emptyHint = 'No historical data for this metric yet.',
}: {
  title: string;
  unit: string;
  points: SeriesPoint[];
  emptyHint?: string;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const W = 520;
  const H = 160;
  const PX = 34;
  const PY = 12;

  const chart = useMemo(() => {
    const valid = points.filter((p) => Number.isFinite(p.v));
    if (valid.length < 2) return null;
    const vs = valid.map((p) => p.v);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const span = max - min || 1;
    const xy = valid.map((p, i) => ({
      x: PX + (i / (valid.length - 1)) * (W - PX - 6),
      y: H - PY - ((p.v - min) / span) * (H - PY * 2),
    }));
    const line = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return { line, last: xy[xy.length - 1], min, max };
  }, [points]);

  return (
    <div className="chart-card">
      <h4>
        {title}
        <span className="unit-tag">{unit}</span>
      </h4>
      {chart ? (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="160" role="img" aria-label={`${title} trend`}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={PX}
              x2={W - 6}
              y1={PY + f * (H - PY * 2)}
              y2={PY + f * (H - PY * 2)}
              stroke="var(--border)"
              strokeDasharray="3 4"
            />
          ))}
          <text className="chart-axis" x={PX - 6} y={PY + 4} textAnchor="end">{chart.max.toFixed(1)}</text>
          <text className="chart-axis" x={PX - 6} y={H - PY + 4} textAnchor="end">{chart.min.toFixed(1)}</text>
          <path d={`${chart.line} L${W - 6},${H - PY} L${PX},${H - PY} Z`} fill={`url(#${gid})`} stroke="none" />
          <path d={chart.line} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
          <circle cx={chart.last.x} cy={chart.last.y} r="4" fill="var(--surface)" stroke="var(--primary)" strokeWidth="2" />
        </svg>
      ) : (
        <div className="chart-empty">
          —<div style={{ marginTop: 6 }}>{emptyHint}</div>
        </div>
      )}
    </div>
  );
}
