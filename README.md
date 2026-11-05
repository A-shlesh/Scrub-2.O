# SCRUB dashboard

Lake-monitoring dashboard for the SCRUB robot: live telemetry, lake selection on
OpenStreetMap, lake polygons, polygon coverage missions (GCS → zigzag → GCS),
sensor history and analytics. Robot contract: `docs/robot-protocol.md`.
Shared Supabase schema (same in the Pi backend): `supabase/schema.sql`, `docs/supabase-schema.md`.

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
npm test          # unit tests (vitest): coverage route, islands, mission payload, Pi API, telemetry parsing, OSM, export, alerts
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
- **Islands:** islands in the OSM outline are kept. The robot route goes around them.
- **Grid size:** slider, 8-80 m. The grid is only for analysing stored readings
  (heatmap); the robot does not navigate by it.
- **Keep away from shore:** 0-100 m. Sweep ends stay at least this far from the
  shore *and* from islands. Remembered per lake. Default is off (0).
- **Map styles:** *Map* is OpenStreetMap, *Dark* is OSM data styled by CARTO,
  *Satellite* is Esri imagery (not OSM).

## Mission Planner

1. Select or draw the lake polygon in the Observatory.
2. Set the **GCS** (ground control station) on the map, or use the robot's position.
3. Set the **sweep spacing** (effective cleaning width). The zigzag route is drawn:
   sweeps along the lake's long axis, alternating direction, inside the polygon.
4. **Send plan & start mission:** the dashboard creates a mission id, records the
   mission in Supabase, sends polygon + GCS + ordered waypoints to the Pi and waits
   until the Pi confirms it validated and stored them (count and checksum must
   match). Only then does it send the separate start command.
5. Progress, current waypoint, distance to target and the return to GCS come from
   the robot; nothing is marked active or completed until the robot says so.

- **Path check:** every turn and connection is tested against the shore and islands.
  A leg that would cross land is rerouted through the water (amber). A leg that
  cannot be routed is drawn red and the plan cannot be sent until it is fixed.
  The return to the GCS is drawn purple.
- **Export:** *GeoJSON* and *CSV* (`sequence_order,latitude,longitude,type`).

## Robot connection

- `VITE_API_BASE_URL` set: missions and commands go to the Pi's REST API and live
  telemetry comes from its WebSocket (`/ws/telemetry`). Use HTTPS/WSS on Vercel.
- Not set: commands go through the Supabase `robot_commands` table and telemetry
  through Supabase Realtime.
- Supabase always stores missions and the sensor history (History page).

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
  pages/        Home, Observatory, Mission, Telemetry, History, Analytics
  components/   Navbar, PageHeader, SensorCard, ChartCard, ObservatoryMap,
                LakeSearch, LakeSetupPanel, LakeThumb
  stores/       lake (selection, boundary, grid), telemetry, theme
  services/     osm (Nominatim/Overpass/tiles), realtime (WebSocket, Supabase), robot (Pi REST API),
                supabase, analytics, storage
  utils/        coverage (zigzag route), missionPayload, geo, gridAnalysis, exportPlan, thresholds, format
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
