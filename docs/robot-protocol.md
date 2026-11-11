# Dashboard ↔ robot protocol

The dashboard (Vercel) talks to the **Raspberry Pi 5**, never to the STM32.
Navigation is based entirely on GPS waypoints generated from the lake polygon
(boustrophedon / zigzag). Grids are only for later data analysis, never for navigation.

```
STM32 ──UART (every 2 s)──> Raspberry Pi 5 ──REST + WebSocket──> Dashboard
STM32 <──UART (every 2 s)── Raspberry Pi 5           └──> Supabase (missions, sensor history)
```

| What | Direction | How |
|---|---|---|
| Mission plan (polygon, GCS, waypoints) | dashboard → Pi | `POST /api/missions` |
| Start, pause, resume, abort, return to GCS, emergency stop | dashboard → Pi | `POST /api/missions/{id}/...`, `POST /api/emergency-stop` |
| Live telemetry + navigation state (every 2 s) | Pi → dashboard | WebSocket `/ws/telemetry` |
| Sensor history (one record every 10 s) | Pi → Supabase → dashboard | `sensor_readings` rows |
| Mission records, waypoints and status | dashboard + Pi → Supabase | `missions`, `mission_waypoints` rows |

**No fallback.** Commands only ever go to the Pi. When `VITE_API_BASE_URL` is not set
the dashboard refuses to send anything and shows "Robot backend not configured".
Live telemetry comes from the Pi WebSocket; Supabase Realtime Broadcast is used only
with `VITE_TELEMETRY_SOURCE=supabase` (section 7).

The robot id is `BOT001` unless the dashboard sets `VITE_ROBOT_ID`.
All timestamps are ISO-8601 UTC (`...Z`).

### Supabase tables

Both repositories use the shared schema in `supabase/schema.sql`; table and column
names, status values and who writes what are in [`supabase-schema.md`](supabase-schema.md).
There is no command table, so commands always go to the Pi backend (set
`VITE_API_BASE_URL`). `supabase/legacy/` holds the previous project's migrations.

## 1. REST API (Raspberry Pi backend)

Base URL: `VITE_API_BASE_URL` (HTTPS in production). JSON in and out. If the operator
is signed in (`VITE_REQUIRE_LOGIN=1`) every request carries
`Authorization: Bearer <Supabase access token>`, which the Pi can verify.

| Method and path | Body | Success answer |
|---|---|---|
| `POST /api/missions` | mission payload (section 2) | `201` `{"mission_id", "status": "LOADED", "waypoint_count", "checksum", "stored_at"}` |
| `POST /api/missions/{id}/start` | `{}` | `200` `{"mission_id", "state": "NAVIGATING"}` |
| `POST /api/missions/{id}/pause` | `{}` | `200` `{"mission_id", "state": "PAUSED"}` |
| `POST /api/missions/{id}/resume` | `{}` | `200` `{"mission_id", "state": "NAVIGATING"}` |
| `POST /api/missions/{id}/abort` | `{}` | `200` `{"mission_id", "state": "ABORTED"}` |
| `POST /api/missions/{id}/return-home` | `{}` | `200` `{"mission_id", "state": "RETURNING"}` |
| `POST /api/emergency-stop` | `{"mission_id": "…" or null}` | `200` `{"state": "EMERGENCY_STOP"}` |
| `GET /api/missions/{id}` | – | `200` `{"mission_id", "state", "current_waypoint", "total_waypoints", "completed_waypoints"}`; `404` if unknown |
| `GET /api/health` | – | `200` `{"ok": true, "device_id": "BOT001"}` |

Rules:

1. **Answer only after acting.** `POST /api/missions` must validate the payload,
   commit the waypoints to the local SQLite database, and only then answer `201`
   with the waypoint count and checksum **recomputed from what was stored**. The
   dashboard enables *Start* only when both match what it sent. It never starts a
   mission just because a request went through.
2. **Refuse with a reason.** Any 4xx/5xx with `{"detail": "human-readable reason"}`
   (FastAPI's default shape works). Example: `409 {"detail": "No mission loaded"}`
   for `start` without a stored plan for that `mission_id`.
3. **`start` is separate** and only allowed for a stored, verified mission with the
   same id.
4. **Emergency stop is always accepted**, in any state, stops the motors first and
   answers afterwards. The physical kill switch remains the real emergency stop.
5. The dashboard gives up waiting after 30 s for `/api/missions` and 15 s for the
   rest, then shows "no answer" and asks the operator to check the robot's state.
   A late answer must therefore be safe: never start motors for a request older
   than 60 s.

CORS: allow only the dashboard's origin (e.g. `https://<project>.vercel.app`),
methods `GET, POST, OPTIONS`, headers `Content-Type, Authorization`. Check the
WebSocket `Origin` header against the same list.

## 2. Mission payload (`POST /api/missions`)

This is the mission API contract, not the STM32 UART packet.

```json
{
  "format": "scrub-mission/2",
  "mission_id": "7d1c2b9e-…",
  "device_id": "BOT001",
  "created_at": "2026-11-05T10:40:00.000Z",
  "lake_id": "a3f0…",
  "lake_name": "Kengeri Lake",
  "ground_control": { "latitude": 12.91686, "longitude": 77.48698 },
  "polygon": [
    { "latitude": 12.9169, "longitude": 77.487 },
    { "latitude": 12.917, "longitude": 77.4872 },
    …
  ],
  "islands": [],
  "sweep_spacing_m": 10,
  "shore_margin_m": 0,
  "acceptance_radius_m": 3,
  "waypoint_count": 42,
  "checksum": "5e88…",
  "waypoints": [
    { "sequence_order": 0, "latitude": 12.91686, "longitude": 77.48698, "type": "GCS" },
    { "sequence_order": 1, "latitude": 12.9169, "longitude": 77.48705, "type": "COVERAGE" },
    { "sequence_order": 2, "latitude": 12.9169, "longitude": 77.48781, "type": "COVERAGE" },
    { "sequence_order": 3, "latitude": 12.91697, "longitude": 77.48790, "type": "TRANSIT" },
    …
    { "sequence_order": 41, "latitude": 12.91686, "longitude": 77.48698, "type": "GCS" }
  ]
}
```

- `waypoints` are in visiting order, `sequence_order` from 0. The first and the
  last waypoint are always the GCS: GCS → polygon traversal → GCS.
- `type`: `GCS` = ground control station; `COVERAGE` = end of a sweep line (the
  robot drives straight between consecutive waypoints, so the sweeps are the legs
  between `COVERAGE` points); `TRANSIT` = extra point so the robot stays in the
  water around a concave shore or an island, or on the way back to the GCS.
- The route is built by the dashboard (`src/utils/coverage.ts`): sweep lines along
  the lake's long axis, `sweep_spacing_m` apart, alternating direction; every leg
  that is not a sweep is checked against the shore and islands and rerouted
  through the water when needed. Just follow the waypoints in order.
- `polygon` is the lake outline (open ring), `islands` are areas inside it the
  robot never enters. They are informational: navigation uses `waypoints`.
- The legs to and from the GCS are straight lines from/to the bank (the GCS is on
  land). While driving the last leg(s) home report state `RETURNING`; report
  `COMPLETED` only after reaching the GCS.
- Latitude/longitude have at most 7 decimals. Keep `acceptance_radius_m` below
  half of `sweep_spacing_m`.

### Checksum

`checksum` is the SHA-256 (lowercase hex) of one line per waypoint, each ending in `\n`:

```
{sequence_order},{latitude:.7f},{longitude:.7f},{type}\n
```

```python
import hashlib
def waypoint_checksum(wps):
    text = "".join(f"{w['sequence_order']},{w['latitude']:.7f},{w['longitude']:.7f},{w['type']}\n" for w in wps)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
```

The Pi must check: `format` is known, `waypoint_count == len(waypoints)`,
`sequence_order` is 0..count-1, the first and last waypoints are type `GCS`, every
latitude/longitude is a finite number in range, and the recomputed checksum equals
`checksum`. Then commit to SQLite and answer with the **recomputed** count and checksum.

## 3. Live telemetry: WebSocket `/ws/telemetry`

URL: `VITE_WS_BASE_URL` + `/ws/telemetry` (WSS in production). The Pi sends one
JSON frame about every 2 s, as soon as it has processed the STM32 packet. The
dashboard may send the text `ping` every 20 s; ignore it or answer `pong`.

The frame is the STM32 packet (section 6) forwarded unchanged, plus the Pi's own fields:

```json
{
  "device_id": "BOT001",
  "timestamp": "2026-11-05T10:41:00.000Z",
  "motors": { "left": 100, "right": 100 },
  "gps": { "latitude": 12.91686, "longitude": 77.48698 },
  "compass": { "heading": 87.5 },
  "sensors": { "ph": 7.2, "tds": 305, "turbidity": 11, "temperature_c": 27.9, "humidity_percent": 64 },
  "battery_percent": 76,
  "navigation": {
    "mission_id": "7d1c2b9e-…",
    "state": "NAVIGATING",
    "current_waypoint": 5,
    "total_waypoints": 42,
    "completed_waypoints": 4,
    "target": { "latitude": 12.9169, "longitude": 77.48781 },
    "distance_to_target_m": 6.4,
    "progress": 0.1
  }
}
```

- `navigation.state`: `IDLE`, `MISSION_RECEIVED` / `READY`, `NAVIGATING`, `PAUSED`,
  `RETURNING`, `COMPLETED`, `ABORTED`, `EMERGENCY_STOP`, `FAULT` (any case).
- `current_waypoint` is the `sequence_order` the robot is heading to.
- Any field may be missing or null when unknown. GPS `0, 0` is treated as "no fix".
  Optional extra GPS fields: `gps.fix`, `gps.satellites`, `gps.speed_mps`.
- The live view never depends on Supabase or on the local database.

The older flat format (`lat`, `lon`, `heading_deg`, `ph`, `mission_state`,
`waypoint_index`, …) is still accepted.

## 4. Sensor history: `sensor_readings`, every 10 s

Store every 2 s STM32 packet in SQLite. Every 10 s create **one** sensor reading,
locally and in Supabase `sensor_readings`:

| column | value |
|---|---|
| `reading_id` | new uuid |
| `local_record_id` | the SQLite record's uuid; upload with upsert on it so a retry never duplicates |
| `device_id` | `BOT001` |
| `mission_id` | current mission, or null |
| `recorded_at` | time of the reading (not of the upload) |
| `latitude`, `longitude` | GPS position of the reading |
| `position_geom` | the same position as `SRID=4326;POINT(lon lat)` |
| `heading` | compass heading, degrees |
| `ph`, `tds`, `turbidity`, `temperature_c`, `humidity_percent` | sensor values |

Keep a "not yet uploaded" flag in SQLite and retry in order until it succeeds.

The dashboard's **History** page reads these rows by mission and time range
(charts, map of positions, individual records); the Telemetry page shows the
last 30 minutes.

## 5. Mission status in Supabase

See [`supabase-schema.md`](supabase-schema.md), "Who writes what". In short:
`PENDING` → `LOADING_WAYPOINTS` (dashboard) → `READY` with `waypoint_load_ack = true`
(Pi, after SQLite storage) → `ACTIVE` ↔ `PAUSED` → `COMPLETED`, or `ABORTED` / `FAILED`.
The Pi keeps `current_waypoint_index`, `progress_percent`, `started_at`, `completed_at`
and each `mission_waypoints.status` (`ACTIVE`, `COMPLETED`, `SKIPPED`) current.
Use the service-role key on the Pi only.

## 6. Hardware packets (handled by the Pi, unchanged)

Defined in the SOFTWARE ARCHITECTURE document; do not rename keys, change nesting,
add or remove fields, or change the 2 s rate.

STM32 → Raspberry Pi, every 2 s:

```json
{
  "device_id": "BOT001",
  "timestamp": "2026-11-05T10:41:00.000Z",
  "motors": { "left": L, "right": R },
  "gps": { "latitude": lat, "longitude": lon },
  "compass": { "heading": hdg },
  "sensors": { "ph": ph, "tds": tds, "turbidity": turb, "temperature_c": temp, "humidity_percent": hum }
}
```

Raspberry Pi → STM32, every 2 s:

```json
{ "left": "+100", "right": "+100", "mode": "auto" }
```

## 7. Authentication and optional Supabase telemetry

- REST: every request carries `Authorization: Bearer <Supabase access token>` when an
  operator is signed in.
- WebSocket: browsers cannot set headers, so the token is sent as a query parameter:
  `/ws/telemetry?token=<access token>`. The dashboard reconnects with a fresh token when
  Supabase refreshes it. Without a session it connects without `token`.
- A 401/403 answer is shown as "Not signed in / not authorised for the robot".
- Errors: `{"detail": "reason"}`, or `{"errors": ["reason", ...]}`.
- Optional, off by default: with `VITE_TELEMETRY_SOURCE=supabase` the dashboard listens
  on Supabase Realtime Broadcast, channel `robot:BOT001`, event `telemetry` (same frame
  as section 3) instead of the WebSocket. There is no Supabase command table.

## 8. Future: geographical grid analysis

Grids are reserved for analysing the stored records, never for navigation. Because
every record keeps its GPS position, time and mission, the lake polygon can later be
divided into cells and each reading assigned to the cell containing it
(`src/utils/gridAnalysis.ts`: `classifyByPosition`, `averageByCell`), then averaged
per cell for a colour-coded water-quality heatmap. The Analytics page already does
this from `sensor_readings`.
