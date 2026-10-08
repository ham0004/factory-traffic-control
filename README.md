# Factory Traffic Control

A small event-driven backend that runs the traffic signals at internal factory junctions. It takes in vehicle sensor events, keeps a queue for each direction and picks a safe phase. It also handles emergency and manual priority, tracks what the physical controller has actually confirmed, and recovers safely after a restart. A plain HTML dashboard shows the backend state and lets you simulate sensors and the controller.

Live demo: _not deployed yet (see [Deploy](#deploy))_

## Run locally

Requires Node 22+.

```bash
npm install
npm run dev        # http://localhost:3000 (dashboard + API), restarts on change
npm test           # domain tests (vitest)
npm run typecheck
```

- The database is SQLite at `data/traffic.db`. Set `DB_PATH` to put it somewhere else.
- Junction A is created on first boot. Delete `data/` to start fresh.
- `bash scripts/demo.sh` walks through all 9 scenarios with curl. Run it against a fresh database.

## Architecture

```
HTTP (Express routes, zod)        REST simulator ACKs / later MQTT
            \                         /
             JunctionService  (per-junction queue, one transaction per input)
                   |
             domain/engine.ts  decide(state, input, now, config) -> { state, effects }
                   |
             ControllerPort    <- RestSimulatorController (today), MQTT adapter (later)
                   |
             Repository (better-sqlite3)
```

- `src/domain` is pure. It doesn't use Express, SQLite or `Date.now()`, and `now` is always passed in. That's why the whole state machine can be tested without HTTP, a browser or a controller.
- `decide()` returns a new state plus a list of effects (`AUDIT`, `SEND_COMMAND`, `COMMAND_RESULT`). The service writes the state and the audit/command rows in one transaction. Commands go to the controller only after the commit.
- Junction config (phases, timings, weights) is data in `domain/config.ts`, stored per junction. `POST /api/junctions` creates more junctions, and the same engine runs them.
- The domain never imports from `app/`, `infra/`, `http/` or `adapters/`.

## Traffic-state transitions

- Signal stage is one of `GREEN(phase)`, `YELLOW(phase -> next)` or `ALL_RED(next)`.
- Desired signals come only from `signalsFor(stage)`. One stage lights at most one phase, so conflicting greens can't be represented.
- Legal transitions are `GREEN(p) -> YELLOW(p) -> ALL_RED -> GREEN(next)` (`isLegalTransition`). `enterStage` throws on anything else.
- `isSafe()` runs on every decision as a second line of defence. A violation sends the junction to DEGRADED with ALL_RED.
- **ACK gating:** a stage only advances when its timer has elapsed and the controller has ACKed exactly the signals we asked for. A YELLOW that was never confirmed is never followed by a green elsewhere.
- Timings: min green 10s, normal green 30s, max green 90s, yellow 5s, all-red 2s.
- Modes are `AUTOMATIC`, `MANUAL`, `EMERGENCY` and `DEGRADED`. Manual and emergency only choose a target phase. They go through the same sequence and can't set signals directly.

## Scheduling algorithm (AUTOMATIC)

- `score(phase) = sum(vehicle weights) + 0.1 * oldest wait in seconds`. Weights are EMPLOYEE_VEHICLE 1, FORKLIFT 2, TRUCK 3.
- Nothing switches before min green (10s).
- **Starvation:** if anyone on another phase has waited more than 120s, switch (only emergencies can override this).
- If the current phase is empty and another phase has demand, switch early.
- After 30s, switch when `other > current * 1.2`. The 20% hysteresis stops the lights flapping when two sides are close.
- Hard cap is 90s of green if the other phase has demand.
- If nobody else is waiting, the green just stays.
- A direction whose sensor is OFFLINE counts as having traffic, so a dead sensor can't starve it.

## Event handling

- `event_id` is the dedup key. It's stored in `processed_events` in the same transaction as the state change it caused.
  - Same id and same payload returns `200 {duplicate: true}` and is audited as `DUPLICATE_EVENT`.
  - Same id with a different payload returns `409 EVENT_ID_CONFLICT`.
- The queue isn't a counter. It's the number of vehicles with status `WAITING`, so it can't go negative.
- The same vehicle arriving twice (with a different event_id) is counted once (`DUPLICATE_VEHICLE`).
- A `VEHICLE_CLEARED` with no arrival changes nothing (`CLEAR_WITHOUT_ARRIVAL`). It leaves a tombstone with its `sequence_no`.
- A later ARRIVED for that vehicle with a lower `sequence_no` is out of order and ignored (`OUT_OF_ORDER`).
- `sequence_no` is only used to detect gaps and reordering (audited). It is never used for dedup.
- **Server time is authoritative** for all timing (waits, timeouts, expiry). Sensor time is stored for audit.
  - A sensor time more than 60s in the future gets a 422.
  - Late events are still applied, because the vehicle is physically there.
  - An emergency more than 60s old is recorded but doesn't trigger preemption.

## Emergency and manual policy

- Emergencies are served first come, first served (ordered by server receive time). A conflicting second emergency waits for the first to clear.
- Preemption may cut min green short, but YELLOW and ALL_RED are never skipped.
- An emergency is cleared by `VEHICLE_CLEARED` for that vehicle, or by a 90s timeout (`EMERGENCY_TIMEOUT`).
- Emergency overrides manual. Afterwards the junction goes back to MANUAL if the override hasn't expired, otherwise to AUTOMATIC.
- Manual control holds the requested phase. It still respects min green and expires after 5 minutes, so an admin who disconnects doesn't matter.
- A manual request during an emergency returns `409 EMERGENCY_ACTIVE`. During DEGRADED it returns `409 JUNCTION_DEGRADED`. Both are audited.
- Simultaneous admin commands are serialized per junction. The last one wins and every one is audited (`issued_by`).

## Failure handling and restart recovery

- One command covers the whole junction: `{command_id, junction_id, desired_signals}`, with ids like `cmd-A-<n>`.
- If no ACK arrives within 3s, the same `command_id` is resent once. If there's still no ACK, the junction goes to DEGRADED with actual signals set to UNKNOWN.
- In DEGRADED, desired is ALL_RED and it's re-sent every 5s. An ACK confirming ALL_RED brings the junction back to its normal mode.
- A NACK, or an ACK whose `actual_signals` differ from what we asked for, also means DEGRADED (`COMMAND_FAILED` / `STATE_MISMATCH`).
- An ACK for an unknown or already-ACKed command is ignored (`DUPLICATE_ACK`).
- Controller `OFFLINE` means DEGRADED with actual UNKNOWN, and ACKs are ignored. `ONLINE` immediately re-sends ALL_RED, and recovery happens on its ACK.
- **Restart recovery:**
  1. Load the state.
  2. Mark pending commands `STALE`.
  3. Set actual signals to UNKNOWN.
  4. Drop an expired manual override or emergency.
  5. Go to `ALL_RED`, send a new command and wait for its ACK.
  6. Audit `RECOVERY_STARTED`.

  Elapsed green time is deliberately forgotten.

## Concurrency

- Every input for a junction (sensor event, command, ACK, tick) goes through a per-junction promise chain. Each one runs `load -> decide -> save (one SQLite transaction) -> dispatch` before the next starts.
- better-sqlite3 is synchronous, so that transaction is atomic. Signal timing comes from a 1s ticker using the same queue. No handler sleeps.
- **Assumption:** a single backend instance. Scaling out would need row locks or optimistic versioning on `junction_state.version`, or one leader per junction.

## API

| Method | Path | Notes |
|---|---|---|
| GET | /api/junctions | list |
| GET | /api/junctions/:id | config, 404 if unknown |
| POST | /api/junctions | `{id, name, config?}`. 201, 409 if it exists, 422 if invalid |
| GET | /api/junctions/:id/status | mode, phase, stage, desired/actual signals, queues, alerts, pending command, emergency, manual |
| POST | /api/sensor-events | 201 applied / 200 duplicate / 404 unknown junction / 409 id conflict / 422 invalid |
| POST | /api/junctions/:id/commands | `MANUAL_GREEN_REQUEST {direction}` or `RETURN_TO_AUTOMATIC`. 202 / 400 / 409 |
| POST | /api/controller-events | `{command_id, junction_id, status: ACK\|NACK, actual_signals}` |
| POST | /api/device-status | `{junction_id, device_type: SIGNAL_CONTROLLER\|SENSOR, direction?, status}` |
| GET | /api/junctions/:id/history?limit=50 | audit log, newest first |
| GET / POST | /api/simulator, /api/simulator/settings | `{auto_ack, ack_delay_ms}` (a demo setting on the adapter, not part of the domain) |
| GET | /health | |

```bash
curl -X POST localhost:3000/api/sensor-events -H 'Content-Type: application/json' -d '{"event_id":"evt-1","junction_id":"A","direction":"EAST","event_type":"VEHICLE_ARRIVED","vehicle_id":"AMB-1","vehicle_type":"EMERGENCY","sequence_no":1,"timestamp":"2026-10-08T10:00:00Z"}'
curl -X POST localhost:3000/api/junctions/A/commands -H 'Content-Type: application/json' -d '{"command":"MANUAL_GREEN_REQUEST","direction":"WEST"}'
curl localhost:3000/api/junctions/A/status
```

## Demo walkthrough

The dashboard is at `/`. It polls every 1s, which is simple, needs no extra infrastructure and is fast enough for a 1s ticker. `scripts/demo.sh` runs the same steps with curl.

1. **Normal traffic:** send arrivals from several directions and watch the scheduler switch after min green.
2. **Priority:** two trucks on EAST/WEST beat three employee vehicles on NORTH/SOUTH at the 30s check.
3. **Emergency:** send an EMERGENCY arrival on EAST while NS is green. You'll see YELLOW NS immediately, then ALL_RED, then GREEN EW.
4. **Manual:** press "Green WEST", then "Return to automatic". Manual is rejected with 409 while an emergency is active.
5. **Duplicate:** "Send same event again" returns 200 duplicate and the queue doesn't change.
6. **Clearance:** send a vehicle cleared event and the queue drops. Clearing an unknown vehicle leaves it at 0.
7. **Controller failure:** untick auto-ACK and request a phase change. You'll see a retry after 3s and DEGRADED with ALL_RED after 6s. Re-enable auto-ACK to recover. "Controller OFFLINE" / "ONLINE" and "ACK with wrong state" also work.
8. **Restart:** stop and start the server. The status shows ALL_RED and UNKNOWN actual signals until the new command is ACKed, and the history shows `RECOVERY_STARTED`.
9. **Concurrent:** the script fires truck, emergency, manual, duplicate emergency and ACK together. Result: one emergency, manual rejected, duplicate ignored, no conflicting green.

## Assumptions / Questions / Requirement Issues

- **Per-direction command vs whole junction:** the spec's command has one direction and one `requested_state`. Sending one command per direction means a half-applied phase change is possible (EAST green, WEST still red). I send one command with the full signal map, and the ACK returns the full `actual_signals` map instead of one `actual_state`.
- **"Approximately 30s" green:** I treat 30s as the point where the scheduler checks whether to switch. It extends while the current side is still busier, with a hard cap of 90s if anyone else is waiting and a min green of 10s.
- **Emergency vs manual:** the spec leaves this open. I chose emergency over manual. Manual is resumed afterwards if it hasn't expired. A manual request during an emergency is rejected with 409, not queued.
- **Conflicting emergencies:** first come, first served by server receive time. The second waits, and a 90s timeout stops a vehicle that never clears from holding the junction forever. The timeout counts from detection, so a long wait in the queue eats into it. That's a business decision to confirm.
- **Manual has no starvation protection:** an admin can hold one phase for the whole 5-minute TTL while the other side waits. This is flagged as a business risk and left as-is, because the admin is assumed to be on site.
- **Duplicate id, different payload:** treated as a client or sensor bug and rejected with 409, not silently applied or ignored.
- **sequence_no scope:** assumed to be monotonic per junction feed. Ordering is compared per vehicle, and gaps are only audited.
- **Controller local fail-safe:** I assume the physical controller has its own fail-safe (flashing red, minimum amber) when it loses the backend or gets ALL_RED in the middle of a green. After a restart the backend asks for ALL_RED without knowing what is lit, so it relies on the controller to clear amber locally.
- **Signal controller OFFLINE with a direction:** the spec example has `direction: SOUTH` on a controller status. I treat any controller OFFLINE as the whole junction being unsafe (DEGRADED), because one dead head can't be served safely.
- **No authentication on manual control:** this is unsafe in production. `issued_by` is only recorded for audit.
- **Single instance:** the per-junction queue only serializes inside one process (see Concurrency).
- **Stale emergency:** an emergency event more than 60s old is still queued as a vehicle but doesn't preempt.
- **Vehicle history:** cleared vehicles are kept so out-of-order events can be detected. A real system would prune them after a retention window.

## Deploy

1. On Railway, create a project and choose Deploy from GitHub repo.
2. Add a volume mounted at `/data`.
3. Set `DB_PATH=/data/traffic.db`.
4. Set the start command to `npm start`.
5. Check the current free/trial limits, then paste the public URL at the top of this README.

## Not done / next steps

- MQTT adapter implementing `ControllerPort`, plus an inbound handler calling `service.controllerEvent`. The domain wouldn't change.
- SSE instead of polling, Docker, and auth for manual control.
- Event replay from `processed_events` and the audit log, metrics, and pruning old vehicle rows.
- HTTP-level integration tests. The tests today cover the domain only, and the API was checked with `scripts/demo.sh`.

## AI / Tool Usage

I used Claude to break the spec down and plan the architecture (BUILD_PLAN), and Claude Code to generate most of the implementation, tests, demo script and a first draft of this README from that plan. I reviewed, ran and adjusted the code, made the design decisions above, and am responsible for explaining and changing any part of it.
