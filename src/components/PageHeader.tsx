import type { ReactNode } from 'react';

/** Title + subtitle (+ optional right-hand controls). Same spacing on every page. */
export function PageHeader({ title, sub, right }: { title: string; sub: string; right?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">{sub}</p>
      </div>
      {right ? <div className="page-head-right">{right}</div> : null}
    </div>
  );
}
