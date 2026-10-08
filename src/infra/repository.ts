import type { AuditEntry, Effect, JunctionConfig, JunctionState, Vehicle } from '../domain/types';
import type { Db } from './db';

export interface JunctionRecord {
  id: string;
  name: string;
  config: JunctionConfig;
  createdAt: string;
}

export interface ProcessedEvent {
  eventId: string;
  payloadHash: string;
  outcome: string;
}

export interface AuditRow {
  id: number;
  junction_id: string;
  event_type: string;
  direction: string | null;
  previous_state: string | null;
  new_state: string | null;
  command_id: string | null;
  details: unknown;
  created_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const toMs = (value: string | null) => (value === null ? null : Date.parse(value));

// All SQL lives here. The engine never sees a query, the repository never makes a traffic decision.
export class Repository {
  constructor(private readonly db: Db) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  listJunctions(): JunctionRecord[] {
    const rows = this.db.prepare('SELECT * FROM junctions ORDER BY id').all() as any[];
    return rows.map(toJunctionRecord);
  }

  getJunction(id: string): JunctionRecord | null {
    const row = this.db.prepare('SELECT * FROM junctions WHERE id = ?').get(id);
    return row ? toJunctionRecord(row) : null;
  }

  createJunction(id: string, name: string, config: JunctionConfig, now: number): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO junctions (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, JSON.stringify(config), iso(now));
    return result.changes > 0;
  }

  loadState(junctionId: string): JunctionState | null {
    const row = this.db.prepare('SELECT state_json FROM junction_state WHERE junction_id = ?').get(junctionId) as
      | { state_json: string }
      | undefined;
    if (!row) return null;

    const vehicles: Record<string, Vehicle> = {};
    const vehicleRows = this.db.prepare('SELECT * FROM vehicles WHERE junction_id = ?').all(junctionId) as any[];
    for (const v of vehicleRows) {
      vehicles[v.vehicle_id] = {
        vehicleId: v.vehicle_id,
        direction: v.direction,
        vehicleType: v.vehicle_type,
        status: v.status,
        arrivedAt: toMs(v.arrived_at),
        clearedAt: toMs(v.cleared_at),
        lastSequenceNo: v.last_sequence_no,
      };
    }
    return { ...JSON.parse(row.state_json), vehicles };
  }

  // Vehicles go to their own table (queue = COUNT of WAITING rows); everything else is one JSON blob.
  saveState(before: JunctionState | null, after: JunctionState, now: number) {
    const { vehicles, ...rest } = after;
    const json = JSON.stringify(rest);

    if (!before || json !== JSON.stringify({ ...before, vehicles: undefined })) {
      this.db
        .prepare(
          `INSERT INTO junction_state (junction_id, state_json, version, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(junction_id) DO UPDATE SET state_json = excluded.state_json,
             version = junction_state.version + 1, updated_at = excluded.updated_at`,
        )
        .run(after.junctionId, json, iso(now));
    }

    const upsertVehicle = this.db.prepare(
      `INSERT INTO vehicles (junction_id, vehicle_id, direction, vehicle_type, status, arrived_at, cleared_at, last_sequence_no)
       VALUES (@junctionId, @vehicleId, @direction, @vehicleType, @status, @arrivedAt, @clearedAt, @lastSequenceNo)
       ON CONFLICT(junction_id, vehicle_id) DO UPDATE SET direction = excluded.direction,
         vehicle_type = excluded.vehicle_type, status = excluded.status, arrived_at = excluded.arrived_at,
         cleared_at = excluded.cleared_at, last_sequence_no = excluded.last_sequence_no`,
    );
    for (const vehicle of Object.values(vehicles)) {
      const previous = before?.vehicles[vehicle.vehicleId];
      if (previous && JSON.stringify(previous) === JSON.stringify(vehicle)) continue;
      upsertVehicle.run({
        ...vehicle,
        junctionId: after.junctionId,
        arrivedAt: vehicle.arrivedAt === null ? null : iso(vehicle.arrivedAt),
        clearedAt: vehicle.clearedAt === null ? null : iso(vehicle.clearedAt),
      });
    }
  }

  recordEffects(junctionId: string, effects: Effect[], now: number) {
    for (const effect of effects) {
      if (effect.type === 'AUDIT') {
        this.insertAudit(junctionId, effect.entry, now);
      } else if (effect.type === 'SEND_COMMAND') {
        this.db
          .prepare(
            `INSERT INTO controller_commands (command_id, junction_id, desired_json, status, attempts, sent_at)
             VALUES (?, ?, ?, 'PENDING', ?, ?)
             ON CONFLICT(command_id) DO UPDATE SET attempts = excluded.attempts, sent_at = excluded.sent_at`,
          )
          .run(effect.command.commandId, junctionId, JSON.stringify(effect.command.desiredSignals), effect.attempt, iso(now));
      } else {
        this.db
          .prepare('UPDATE controller_commands SET status = ?, acked_at = ?, actual_json = ? WHERE command_id = ?')
          .run(
            effect.result,
            effect.result === 'ACKED' ? iso(now) : null,
            effect.actualSignals ? JSON.stringify(effect.actualSignals) : null,
            effect.commandId,
          );
      }
    }
  }

  // Belt and braces for restart: nothing that was in flight before the crash is still trusted.
  markPendingCommandsStale(junctionId: string) {
    this.db
      .prepare(`UPDATE controller_commands SET status = 'STALE' WHERE junction_id = ? AND status = 'PENDING'`)
      .run(junctionId);
  }

  insertAudit(junctionId: string, entry: AuditEntry, now: number) {
    this.db
      .prepare(
        `INSERT INTO audit_log (junction_id, event_type, direction, previous_state, new_state, command_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        junctionId,
        entry.eventType,
        entry.direction ?? null,
        entry.previousState ?? null,
        entry.newState ?? null,
        entry.commandId ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        iso(now),
      );
  }

  history(junctionId: string, limit: number): AuditRow[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE junction_id = ? ORDER BY id DESC LIMIT ?')
      .all(junctionId, limit) as any[];
    return rows.map(({ details_json, ...row }) => ({ ...row, details: details_json ? JSON.parse(details_json) : null }));
  }

  findProcessedEvent(eventId: string): ProcessedEvent | null {
    const row = this.db
      .prepare('SELECT event_id, payload_hash, outcome FROM processed_events WHERE event_id = ?')
      .get(eventId) as any;
    return row ? { eventId: row.event_id, payloadHash: row.payload_hash, outcome: row.outcome } : null;
  }

  insertProcessedEvent(e: { eventId: string; junctionId: string; payloadHash: string; sensorTs: string; outcome: string }, now: number) {
    this.db
      .prepare(
        `INSERT INTO processed_events (event_id, junction_id, payload_hash, sensor_ts, received_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.eventId, e.junctionId, e.payloadHash, e.sensorTs, iso(now), e.outcome);
  }
}

function toJunctionRecord(row: any): JunctionRecord {
  return { id: row.id, name: row.name, config: JSON.parse(row.config_json), createdAt: row.created_at };
}
