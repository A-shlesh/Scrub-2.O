# SCRUB dashboard

Lake-monitoring dashboard for the SCRUB robot: live telemetry, lake selection on
OpenStreetMap, boundaries and a configurable sampling grid, mission planning,
and analytics.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/
```

Node 18+ (20+ recommended).

## Demo data vs. real data

`.env.local` ships with `VITE_DEMO=1`, which fills every page with fake telemetry,
three sample lakes and sample charts so you can review the design.
Delete the file (or set `VITE_DEMO=0`) and restart `npm run dev` to see the real,
honest empty states ("—", "System Offline") until a backend is connected.
See `.env.example` for all variables.

## Tests

```bash
npm test          # unit tests (vitest): grid, islands, path planner, OSM parsing, export, alerts
```

## Photos (`public/`)

| File | Used by |
|---|---|
| `scrub-hero.jpg` | Home hero (and fallback for the two below) |
| `scrub-mission.jpg` | Home "Our Mission" band |
| `scrub-robot.jpg` | Telemetry photo |

The ones included are low-resolution stand-ins. Replace them with your own
photos using the same file names.

## Using the Observatory

- **Navigate:** the map opens on Bengaluru (change it in `.env.local`, see below).
  Drag to pan, scroll / double-click / `+` `-` to zoom, the arrow button jumps to
  your location, and the corner button expands the map to full screen (Esc exits).
- **Pick a lake:** click a lake on the map. Its OpenStreetMap boundary is
  highlighted and a card offers **Select this lake**, **Adjust outline** or
  **Cancel**. Nothing is selected until you press Select.
- **Or search:** type a lake name to select it directly, or a place name
  (a city, a suburb) to fly the map there.
- **Resize / reshape the boundary:** *Adjust outline* (before selecting) or
  *Edit outline* (after) lets you drag points, right-click to remove, click to
  add, and **Resize -10% / +10%** for the whole outline. Undo steps back through
  every change. *Reset to OSM* restores the original. If OSM has no polygon for a
  lake you can draw one.
- **Islands:** islands in the OSM outline are kept. No sampling point is placed on
  one, and the robot path is routed around them.
- **Grid size:** slider, number field (10-1000 m) or presets. Each lake remembers
  its own size. Mission Planner follows the same grid.
- **Keep away from shore:** 0-100 m. Sampling points stay at least this far from the
  shore *and* from islands. Remembered per lake. Default is off (0).
- **Map styles:** *Map* is OpenStreetMap, *Dark* is OSM data styled by CARTO,
  *Satellite* is Esri imagery (not OSM).

## Mission Planner

- **Path check:** every leg of the serpentine path is tested against the shore and
  islands. A leg that would cross land is rerouted through neighbouring grid cells
  (amber on the map). A leg that cannot be routed is drawn red, reported, and
  *Start Mission* refuses to proceed until the plan is fixed (change the grid
  size, shore margin or boundary).
- **Export:** *GeoJSON* (boundary with islands, path, numbered waypoints tagged
  `lane` / `detour`, any blocked legs, planning parameters) and *CSV*
  (`seq,latitude,longitude,type`) for the robot team.

## Telemetry alerts

Readings turn amber near a limit and red outside it (pH 6.5-8.5, turbidity 0-50
NTU, TDS 0-1000 ppm, air-quality bands, battery under 35% / 20%). A banner lists
what is wrong. Alerts are only raised for fresh (live) data. Thresholds live in
`src/utils/thresholds.ts`. To see alerts in demo mode:

```js
localStorage.setItem('scrub:demoOverride', JSON.stringify({ ph: 9.1, batteryPercent: 15 }))
localStorage.removeItem('scrub:demoOverride')   // back to normal
```

## Project layout

```
src/
  pages/        Home, Observatory, Mission, Telemetry, Analytics
  components/   Navbar, PageHeader, SensorCard, ChartCard, ObservatoryMap,
                LakeSearch, LakeSetupPanel, LakeThumb
  stores/       lake (selection, boundary, grid), telemetry, theme
  services/     osm (Nominatim/Overpass/tiles), realtime, analytics, storage
  utils/        geo (grid, islands, land-safe path), exportPlan, thresholds, format
  demo/         demo data, only active with VITE_DEMO=1
  types/        shared data model
  styles/       global.css
```

## Notes

- OpenStreetMap's public tile server and Nominatim/Overpass are for light use.
  For a deployed product, use a tile provider (or your own server) and follow the
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
  Search and locality lookups are already rate-limited to 1 request/second.
  If tiles fail to load, the map says so instead of showing a blank grey box.
- Realtime telemetry (AWS IoT) and historical analytics (InfluxDB via an API) are
  not connected yet; the app shows honest empty states for them.
