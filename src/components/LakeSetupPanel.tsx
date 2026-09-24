import type { LatLon } from '../types';
import { useLake, MIN_CELL_SIZE_M, MAX_CELL_SIZE_M } from '../stores/lake';
import { MAX_GRID_CELLS, openRing, polygonAreaSqM } from '../utils/geo';
import { fmtArea } from '../utils/format';
import type { MapMode } from './ObservatoryMap';

function sameRing(a: LatLon[], b: LatLon[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].lat - b[i].lat) > 1e-9 || Math.abs(a[i].lon - b[i].lon) > 1e-9) return false;
  }
  return true;
}

export function LakeSetupPanel({
  editMode,
  onEdit,
  onDraw,
  onResetToOsm,
}: {
  editMode: MapMode;
  onEdit: () => void;
  onDraw: () => void;
  onResetToOsm: () => void;
}) {
  const { lake, boundary, holes, cellSizeM, setCellSize, cells, gridTooFine } = useLake();

  if (!lake) return null;

  const osm = lake.osmBoundary?.points ?? null;
  const hasBoundary = !!boundary && boundary.length >= 3;
  const custom = hasBoundary && (!osm || !sameRing(boundary as LatLon[], osm));
  const vertices = boundary ? openRing(boundary).length : 0;
  const busy = editMode !== 'browse';
  const area = boundary ? polygonAreaSqM(boundary) : null;

  const source = !hasBoundary ? 'No outline yet' : custom ? 'Custom outline' : 'OpenStreetMap outline';

  return (
    <section className="setup" aria-label="Lake boundary and grid">
      <div className="setup-block">
        <div className="setup-head">
          <h3>Boundary</h3>
          <span className={`tag${hasBoundary ? '' : ' warn'}`}>{source}</span>
        </div>
        {hasBoundary ? (
          <p className="setup-meta">
            {vertices} points · {fmtArea(area)}
            {holes.length > 0 ? ` · ${holes.length} island${holes.length === 1 ? '' : 's'} avoided` : ''}
          </p>
        ) : (
          <p className="setup-meta">
            OpenStreetMap has no polygon for this water body. Draw its outline on the map to build the grid.
          </p>
        )}
        <div className="setup-actions">
          {hasBoundary ? (
            <>
              <button type="button" className="btn btn-sm" onClick={onEdit} disabled={busy}>Edit outline</button>
              <button type="button" className="btn btn-sm" onClick={onDraw} disabled={busy}>Redraw</button>
              {custom && osm ? (
                <button type="button" className="btn btn-sm" onClick={onResetToOsm} disabled={busy}>Reset to OSM</button>
              ) : null}
            </>
          ) : (
            <button type="button" className="btn-primary btn-sm" onClick={onDraw} disabled={busy}>Draw boundary</button>
          )}
        </div>
      </div>

      <div className="setup-block">
        <div className="setup-head">
          <h3>Sampling grid</h3>
          <span className="tag">{hasBoundary && !gridTooFine ? `${cells.length} cells` : '—'}</span>
        </div>

        <div className="grid-slider-row">
          <label className="grid-slider-label" htmlFor="grid-size-slider">
            {cellSizeM} m
          </label>
          <input
            id="grid-size-slider"
            type="range"
            className="grid-slider"
            min={MIN_CELL_SIZE_M}
            max={MAX_CELL_SIZE_M}
            step={1}
            value={cellSizeM}
            onChange={(e) => setCellSize(Number(e.target.value))}
            disabled={!hasBoundary}
          />
          <span className="grid-slider-min">{MIN_CELL_SIZE_M} m</span>
          <span className="grid-slider-max">{MAX_CELL_SIZE_M} m</span>
        </div>

        {gridTooFine ? (
          <div className="notice error" role="alert">
            Over {MAX_GRID_CELLS.toLocaleString()} cells. Try a larger cell size.
          </div>
        ) : hasBoundary ? (
          <p className="setup-meta">
            Each cell is {cellSizeM} m × {cellSizeM} m; the robot samples its centre.
          </p>
        ) : (
          <p className="setup-meta">
            Add a boundary to generate the grid.
          </p>
        )}
      </div>
    </section>
  );
}
