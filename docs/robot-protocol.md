# Dashboard ↔ robot protocol (Supabase only)

The dashboard and the Raspberry Pi never talk directly. Everything goes through
Supabase: tables for commands and data, Realtime for instant updates.
Apply `supabase/migrations/20261105000000_mission_control.sql` first.

| What | Direction | How |
|---|---|---|
| Waypoints, start, pause, resume, stop, emergency stop | dashboard → Pi | row in `robot_commands` |
| Acknowledgement of each command | Pi → dashboard | Pi updates that same row |
| Live telemetry (every 2 s) | Pi → dashboard | Realtime **Broadcast**, nothing stored |
| Sensor history (every 10 s) | Pi → cloud → dashboard | row in `sensor_samples` |
| Mission status | Pi → dashboard | `missions.status`, `mission_grids.status` |

The robot's id is `BOT001` unless the dashboard sets `VITE_ROBOT_ID`.
All timestamps are ISO-8601 with an offset; prefer UTC (`...Z`).

## 1. Commands: `robot_commands`

The dashboard inserts:

| column | value |
|---|---|
| `command_id` | uuid, made by the dashboard |
| `device_id` | `BOT001` |
| `mission_id` | the mission it is about |
| `command` | `LOAD_WAYPOINTS`, `START`, `PAUSE`, `RESUME`, `STOP` or `EMERGENCY_STOP` |
| `payload` | `waypoints.json` (below) for `LOAD_WAYPOINTS`, otherwise null |
| `status` | `PENDING` |

The Pi listens for new rows (Realtime `postgres_changes`, `INSERT` on
`robot_commands`, filter `device_id=eq.BOT001`). Also query
`status = 'PENDING'` on start-up and after every reconnect, so nothing is missed.

The Pi answers by updating the same row, **once**:

- accepted: `status = 'ACKED'`, `acked_at = now`, `ack = {...}` (below)
- refused: `status = 'REJECTED'`, `acked_at = now`, `detail = 'human-readable reason'`

Rules the Pi must enforce itself (never rely on the dashboard):

1. **Ignore commands that are not `PENDING`.** The dashboard marks a command
   `EXPIRED` when it gave up waiting (30 s for `LOAD_WAYPOINTS`, 15 s for the
   rest). Only update a row `where status = 'PENDING'`, so an expired command is
   never acted on.
2. **Ignore commands older than 60 s** (`created_at`), even if still `PENDING`.
   An old `START` must never move the motors.
3. **`START` only with a stored, verified plan for that same `mission_id`.**
   Otherwise reject with a reason.
4. **`EMERGENCY_STOP` is always accepted**, in any state, and stops the motors
   before anything else, including before the acknowledgement. It must not
   depend on the network: the physical kill switch stays the real emergency stop.

### `ack` contents

| command | `ack` |
|---|---|
| `LOAD_WAYPOINTS` | `{"count": 240, "sha256": "<hex>", "stored_at": "<time>"}` |
| others | `{"mission_state": "transit"}` (state after the command) |

## 2. `waypoints.json` (payload of `LOAD_WAYPOINTS`)

```json
{
  "format": "scrub-waypoints/1",
  "mission_id": "7d1c…",
  "device_id": "BOT001",
  "lake_id": "a3f0…",
  "lake_name": "Kengeri Lake",
  "generated_at": "2026-11-05T09:12:00.000Z",
  "cell_size_m": 20,
  "gcs": { "lat": 12.9139000, "lon": 77.4812000 },
  "count": 242,
  "sha256": "5e88…",
  "waypoints": [
    { "seq": 1, "lat": 12.9139000, "lon": 77.4812000, "type": "gcs", "grid_id": null },
    { "seq": 2, "lat": 12.9145123, "lon": 77.4820456, "type": "lane", "grid_id": "c0ffee…" },
    { "seq": 3, "lat": 12.9146921, "lon": 77.4820456, "type": "detour", "grid_id": "beef…" },
    …
    { "seq": 242, "lat": 12.9139000, "lon": 77.4812000, "type": "gcs", "grid_id": null }
  ]
}
```

- `waypoints` are in visiting order (the zigzag route), `seq` from 1.
- `type`: `gcs` = ground control station, `lane` = sampling cell on the zigzag,
  `detour` = extra point to stay in water.
- `gcs` is where the robot is launched. The first and the last waypoint are
  always the GCS: the robot leaves from it, covers the polygon, then drives back
  to it. Do not sample at `gcs` waypoints. The legs to and from the GCS are
  straight lines and are not checked against the shore (the GCS is usually on
  the bank), so place it where the robot can reach the water directly.
- While driving from the last sampling cell back to the GCS, report
  `mission_state: "returning"`; report `completed` only after reaching the GCS.
- `grid_id`: the `grids` row of the cell, or null.
- `lat`/`lon` have at most 7 decimals.

### Checksum

`sha256` is the SHA-256 (lowercase hex) of one line per waypoint, each ending in `\n`:

```
{seq},{lat:.7f},{lon:.7f},{type},{grid_id or empty}\n
```

Python:

```python
import hashlib
def waypoint_checksum(wps):
    text = "".join(f"{w['seq']},{w['lat']:.7f},{w['lon']:.7f},{w['type']},{w.get('grid_id') or ''}\n" for w in wps)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
```

The Pi must check: `format` is known, `count == len(waypoints)`, seq is 1..count,
every lat/lon is a finite number in range, and the recomputed checksum equals
`sha256`. Then save `waypoints.json` and the SQLite copy, and only then `ACK`
with the **recomputed** count and checksum. The dashboard enables *Start* only
when those match what it sent.

GPS tolerance: keep it below half the cell size (`cell_size_m / 2`), or the
robot may skip or circle waypoints. The smallest cell is 8 m.

## 3. Live telemetry: Realtime Broadcast

Channel `robot:BOT001`, event `telemetry`, about every 2 s. Not stored. Payload
(flat; any field may be null or missing when unknown):

```json
{
  "ts": "2026-11-05T09:12:04Z", "seq": 1234,
  "ph": 7.1, "tds": 310, "turbidity": 12.4, "temperature_c": 28.2, "humidity_percent": 61, "aqi": 42,
  "lat": 12.9145, "lon": 77.482, "fix": true, "satellites": 9, "speed_mps": 0.8, "heading_deg": 142,
  "battery_percent": 82,
  "mission_id": "7d1c…", "mission_state": "transit", "waypoint_index": 12, "waypoint_total": 240
}
```

`mission_state`: `idle`, `loaded`, `transit`, `sampling`, `returning`, `paused`,
`completed`, `emergency_stop`, `error`. `waypoint_index` is the waypoint the robot
is heading to (1-based).

Python (supabase-py, async realtime client):

```python
channel = client.channel("robot:BOT001")
await channel.subscribe()
await channel.send_broadcast("telemetry", payload)
```

## 4. Sensor history: `sensor_samples`, every 10 s

Store every 2 s STM32 packet in SQLite. Upload **one** record every 10 s to
`sensor_samples`, with `device_id = 'BOT001'`, the `mission_id`, `recorded_at`
(time of the reading, not of the upload), `latitude`, `longitude` and the sensor
columns (`ph`, `tds`, `turbidity`, `temperature_c`, `humidity_percent`).
`grid_id` and `session_id` may be null when the robot is between cells.

Make `sample_id` a uuid generated **on the Pi** and use upsert, so retrying a
failed upload never creates a duplicate. Keep a local "not yet uploaded" flag in
SQLite and retry in order until it succeeds.

The dashboard's Telemetry page shows the last 30 minutes for `BOT001`, refreshed
every 10 s.

## 5. Mission status

The Pi keeps `missions.status` current: `PENDING` (created / loaded) → `ACTIVE`
→ `PAUSED` ↔ `ACTIVE` → `COMPLETED`, or `ABORTED` after `STOP` /
`EMERGENCY_STOP` (put the reason in `notes`). It sets each `mission_grids` row
to `COMPLETED` when it has sampled that cell. The dashboard shows this
progress next to the live `waypoint_index / waypoint_total`.
