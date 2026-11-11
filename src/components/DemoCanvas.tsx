import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { segmentLengths, snap } from '../utils/demoPath';
import type { DemoPoint, DemoPose } from '../utils/demoPath';

/**
 * Blank metre canvas for drawing a demo path (no map tiles). x = east, y = north (up).
 * - click / tap empty space: add a point (when editable)
 * - drag a point: move it (not the start); click a point: select it
 * - drag empty space: pan; wheel, pinch or the +/- buttons: zoom
 */
export function DemoCanvas({
  path,
  editable,
  selected,
  onSelect,
  onAdd,
  onMove,
  snapStep,
  startHeading,
  robot,
  robotStale = false,
  trail = [],
  currentSegment = null,
}: {
  path: DemoPoint[];
  editable: boolean;
  selected: number | null;
  onSelect: (index: number | null) => void;
  onAdd: (p: DemoPoint) => void;
  /** called once at the end of a drag */
  onMove: (index: number, p: DemoPoint) => void;
  snapStep: number;
  startHeading: number;
  /** simulated robot pose (preview or live), or null */
  robot: DemoPose | null;
  robotStale?: boolean;
  /** where the robot has actually been (live) */
  trail?: DemoPoint[];
  /** segment the robot is on (1 = start -> point 1); earlier segments are drawn as done */
  currentSegment?: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  const [view, setView] = useState({ cx: 0, cy: 0, scale: 30 }); // px per metre
  const [drag, setDrag] = useState<{ index: number; p: DemoPoint } | null>(null);
  const gesture = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    mode: 'none' | 'pan' | 'point' | 'pinch';
    startX: number;
    startY: number;
    moved: boolean;
    view0: { cx: number; cy: number; scale: number };
    pinch0: { d: number; mx: number; my: number } | null;
    index: number;
  }>({ pointers: new Map(), mode: 'none', startX: 0, startY: 0, moved: false, view0: view, pinch0: null, index: -1 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(240, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toScreen = (p: DemoPoint) => ({ x: size.w / 2 + (p.x_m - view.cx) * view.scale, y: size.h / 2 - (p.y_m - view.cy) * view.scale });
  const toWorld = (x: number, y: number, v = view): DemoPoint => ({ x_m: v.cx + (x - size.w / 2) / v.scale, y_m: v.cy - (y - size.h / 2) / v.scale });

  const zoomAt = (factor: number, sx: number, sy: number, v = view) => {
    const scale = Math.max(2, Math.min(400, v.scale * factor));
    const before = toWorld(sx, sy, v);
    // keep the world point under the cursor fixed
    const cx = before.x_m - (sx - size.w / 2) / scale;
    const cy = before.y_m + (sy - size.h / 2) / scale;
    return { cx, cy, scale };
  };

  // Wheel zoom (non-passive so the page does not scroll).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, v));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const local = (e: ReactPointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: ReactPointerEvent, index = -1) => {
    e.stopPropagation();
    const g = gesture.current;
    const pt = local(e);
    g.pointers.set(e.pointerId, pt);
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* pointer already gone; the gesture still works without capture */
    }
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.mode = 'pinch';
      g.pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      g.view0 = view;
      setDrag(null);
      return;
    }
    g.startX = pt.x;
    g.startY = pt.y;
    g.moved = false;
    g.view0 = view;
    g.index = index;
    g.mode = index >= 0 ? 'point' : 'pan';
    if (index >= 0) onSelect(index);
  };

  const onMovePtr = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g.pointers.has(e.pointerId)) return;
    const pt = local(e);
    g.pointers.set(e.pointerId, pt);
    if (g.mode === 'pinch' && g.pointers.size === 2 && g.pinch0) {
      const [a, b] = [...g.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setView(zoomAt(d / Math.max(1, g.pinch0.d), g.pinch0.mx, g.pinch0.my, g.view0));
      return;
    }
    const dx = pt.x - g.startX;
    const dy = pt.y - g.startY;
    if (Math.hypot(dx, dy) > 4) g.moved = true;
    if (!g.moved) return;
    if (g.mode === 'pan') {
      setView({ ...g.view0, cx: g.view0.cx - dx / g.view0.scale, cy: g.view0.cy + dy / g.view0.scale });
    } else if (g.mode === 'point' && editable && g.index > 0) {
      setDrag({ index: g.index, p: snap(toWorld(pt.x, pt.y), snapStep) });
    }
  };

  const onUp = (e: ReactPointerEvent) => {
    const g = gesture.current;
    const pt = g.pointers.get(e.pointerId) ?? local(e);
    g.pointers.delete(e.pointerId);
    if (g.mode === 'pinch') {
      if (g.pointers.size === 0) g.mode = 'none';
      return;
    }
    if (g.mode === 'point' && drag && g.moved) onMove(drag.index, drag.p);
    if (g.mode === 'pan' && !g.moved) {
      if (editable) onAdd(snap(toWorld(pt.x, pt.y), snapStep));
      else onSelect(null);
    }
    setDrag(null);
    g.mode = 'none';
  };

  const shown = drag ? path.map((p, i) => (i === drag.index ? drag.p : p)) : path;
  const lens = useMemo(() => segmentLengths(shown), [shown]);

  // Grid step that keeps lines ~40 px apart.
  const gridStep = [0.5, 1, 2, 5, 10, 20, 50, 100, 200].find((s) => s * view.scale >= 36) ?? 200;
  const tl = toWorld(0, 0);
  const br = toWorld(size.w, size.h);
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number; axis: boolean }> = [];
  for (let x = Math.floor(tl.x_m / gridStep) * gridStep; x <= br.x_m; x += gridStep) {
    const sx = toScreen({ x_m: x, y_m: 0 }).x;
    lines.push({ x1: sx, y1: 0, x2: sx, y2: size.h, axis: Math.abs(x) < 1e-9 });
  }
  for (let y = Math.floor(br.y_m / gridStep) * gridStep; y <= tl.y_m; y += gridStep) {
    const sy = toScreen({ x_m: 0, y_m: y }).y;
    lines.push({ x1: 0, y1: sy, x2: size.w, y2: sy, axis: Math.abs(y) < 1e-9 });
  }

  const target = currentSegment && currentSegment < shown.length ? shown[currentSegment] : null;
  const robotPose = robot ?? (shown.length > 0 ? { x_m: 0, y_m: 0, heading_deg: startHeading } : null);
  const rs = robotPose ? toScreen(robotPose) : null;
  const bar = gridStep * view.scale;

  return (
    <div className="demo-canvas" ref={wrapRef}>
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        role="application"
        aria-label="Demo path canvas"
        onPointerDown={(e) => onDown(e)}
        onPointerMove={onMovePtr}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{ touchAction: 'none', cursor: editable ? 'crosshair' : 'grab' }}
      >
        <rect width={size.w} height={size.h} className="dc-bg" />
        {lines.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className={l.axis ? 'dc-axis' : 'dc-grid'} />
        ))}

        {trail.length >= 2 && (
          <polyline className="dc-trail" points={trail.map((p) => { const s = toScreen(p); return `${s.x},${s.y}`; }).join(' ')} />
        )}

        {shown.slice(1).map((p, i) => {
          const a = toScreen(shown[i]);
          const b = toScreen(p);
          const seg = i + 1;
          const done = currentSegment !== null && seg < currentSegment;
          return (
            <g key={`s${i}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={done ? 'dc-seg done' : 'dc-seg'} />
              {Math.hypot(b.x - a.x, b.y - a.y) > 44 && (
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} className="dc-len">{lens[i].toFixed(1)} m</text>
              )}
            </g>
          );
        })}

        {target && (() => { const s = toScreen(target); return <circle cx={s.x} cy={s.y} r={13} className="dc-target" />; })()}

        {shown.map((p, i) => {
          if (i === 0) return null;
          const s = toScreen(p);
          return (
            <g key={`p${i}`} onPointerDown={(e) => onDown(e, i)} style={{ cursor: editable ? 'move' : 'pointer' }}>
              <circle cx={s.x} cy={s.y} r={selected === i ? 10 : 8} className={selected === i ? 'dc-pt sel' : 'dc-pt'} />
              <text x={s.x} y={s.y + 3.5} className="dc-pt-n">{i}</text>
            </g>
          );
        })}

        {rs && robotPose && (
          <g transform={`translate(${rs.x} ${rs.y}) rotate(${robotPose.heading_deg})`} className={robotStale ? 'dc-robot stale' : 'dc-robot'}>
            <path d="M0,-15 L10,11 L0,6 L-10,11 Z" />
          </g>
        )}
        {!robot && rs && (
          <text x={rs.x + 16} y={rs.y + 4} className="dc-hint">Place the robot facing this way</text>
        )}

        <g transform={`translate(14 ${size.h - 18})`} className="dc-scale">
          <line x1={0} y1={0} x2={bar} y2={0} />
          <line x1={0} y1={-4} x2={0} y2={4} />
          <line x1={bar} y1={-4} x2={bar} y2={4} />
          <text x={bar / 2} y={-7}>{gridStep} m</text>
        </g>
      </svg>
      <div className="dc-zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => setView((v) => zoomAt(1.25, size.w / 2, size.h / 2, v))} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => setView((v) => zoomAt(0.8, size.w / 2, size.h / 2, v))} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setView({ cx: 0, cy: 0, scale: 30 })} aria-label="Centre on start" title="Centre on start">⌖</button>
      </div>
      {robotStale && <div className="dc-stale" role="status">No telemetry</div>}
    </div>
  );
}
