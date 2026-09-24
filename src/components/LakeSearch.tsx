import { useState } from 'react';
import { Search } from 'lucide-react';
import { lakeFromSearchResult, resolveBoundary, searchLakes } from '../services/osm/osmService';
import type { LakeSearchResult } from '../services/osm/osmService';
import type { Lake } from '../types';
import { useLake } from '../stores/lake';

export function LakeSearch({
  onSelected,
  onGoTo,
}: {
  onSelected?: (lake: Lake) => void;
  /** when given, results that are places (not water bodies) move the map there instead of becoming a lake */
  onGoTo?: (lat: number, lon: number) => void;
}) {
  const { selectLake, recent } = useLake();
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LakeSearchResult[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [resolving, setResolving] = useState(false);

  // Enter submits: the single-field search in the mockup has no button.
  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (query.trim().length < 2) return;
    setState('loading');
    setNote(null);
    try {
      setResults(await searchLakes(query.trim()));
      setState('idle');
    } catch {
      setState('error');
    }
  }

  async function pick(r: LakeSearchResult) {
    if (onGoTo && !r.isWater && !r.boundary) {
      onGoTo(r.lat, r.lon);
      setResults([]);
      setQuery('');
      return;
    }
    setResolving(true);
    setNote(null);
    try {
      // Re-selecting a lake we already know keeps its edited boundary and grid size.
      const known = recent.find((l) => l.id === r.id);
      if (known) {
        selectLake(known);
        setResults([]);
        setQuery('');
        onSelected?.(known);
        return;
      }
      const base = lakeFromSearchResult(r);
      let withBoundary: Lake = base;
      try {
        withBoundary = await resolveBoundary(base);
      } catch {
        setNote("Couldn't reach OpenStreetMap to fetch the outline. You can draw it on the map instead.");
      }
      // Default the SCRUB working boundary to the OSM geometry when present.
      const lake: Lake =
        withBoundary.osmBoundary && !withBoundary.scrubBoundary
          ? { ...withBoundary, scrubBoundary: { points: withBoundary.osmBoundary.points, holes: withBoundary.osmBoundary.holes ?? [] } }
          : withBoundary;
      selectLake(lake);
      setResults([]);
      setQuery('');
      onSelected?.(lake);
    } finally {
      setResolving(false);
    }
  }

  return (
    <div>
      <form onSubmit={runSearch} role="search" aria-label="Search lakes" className="search-field">
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search lakes…"
          aria-label="Search a lake or water body"
        />
      </form>
      {state === 'loading' ? <p className="search-status">Searching…</p> : null}
      {state === 'error' ? (
        <div className="notice error" role="alert">
          Search failed. Check your connection and try again.
        </div>
      ) : null}
      {results.length > 0 ? (
        <ul className="search-results">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => void pick(r)} disabled={resolving}>
                {r.displayName}
                <span className="meta">
                  {r.lat.toFixed(4)}, {r.lon.toFixed(4)}
                  {r.type ? ` · ${r.type}` : ''}
                  {r.boundary ? ' · outline' : onGoTo && !r.isWater ? ' · go to place' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {resolving ? <p className="search-status">Fetching outline from OpenStreetMap…</p> : null}
      {note ? <div className="notice" role="status">{note}</div> : null}
    </div>
  );
}
