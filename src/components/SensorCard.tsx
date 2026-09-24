import type { ReactNode } from 'react';
import type { ReadingStatus } from '../utils/thresholds';

export type ChipTone = 'blue' | 'slate' | 'amber' | 'teal' | 'rose' | 'green';

/**
 * One live reading. `value` is null when the sensor has no data, which
 * renders "—" (never 0). The unit is real markup, not an HTML string.
 */
export function SensorCard({
  icon,
  tone,
  label,
  value,
  unit,
  hint,
  status = 'none',
}: {
  icon: ReactNode;
  tone: ChipTone;
  label: string;
  value: string | null;
  unit?: string;
  hint?: ReactNode;
  /** colours the card when the reading is near / outside its acceptable range */
  status?: ReadingStatus;
}) {
  return (
    <div className="sensor-card" data-status={status}>
      <div className="sensor-top">
        <span className={`icon-chip chip-${tone}`} aria-hidden="true">{icon}</span>
        {label}
      </div>
      <div className="sensor-value">
        {value ?? '—'}
        {value !== null && unit ? <span className="unit">{unit}</span> : null}
      </div>
      <div className="sensor-hint">
        {status === 'bad' ? <strong className="hint-flag">Out of range · </strong> : status === 'warn' ? <strong className="hint-flag">Near limit · </strong> : null}
        {hint ?? ''}
      </div>
    </div>
  );
}
