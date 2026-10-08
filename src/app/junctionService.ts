import { createHash } from 'node:crypto';
import { createInitialState, decide } from '../domain/engine';
import type { Decision, Input, JunctionConfig } from '../domain/types';
import type { Repository } from '../infra/repository';
import type { ControllerPort } from '../ports/controllerPort';
import { buildStatus } from './statusView';

export class NotFoundError extends Error {}

export interface SensorEvent {
  eventId: string;
  junctionId: string;
  input: Extract<Input, { type: 'VEHICLE_ARRIVED' | 'VEHICLE_CLEARED' }>;
  rawTimestamp: string;
  payload: unknown;
}

export type SensorResult =
  | { outcome: 'APPLIED'; decision: Decision }
  | { outcome: 'REJECTED'; decision: Decision }
  | { outcome: 'DUPLICATE' }
  | { outcome: 'ID_CONFLICT' };

// Every input for a junction goes through here:
//   wait for the junction's queue -> load -> decide -> save + audit in ONE transaction -> send commands.
// The per-junction promise chain means two requests for the same junction can never interleave.
export class JunctionService {
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repo: Repository,
    private readonly controller: ControllerPort,
    private readonly clock: () => number = Date.now,
  ) {}

  private serialize<T>(junctionId: string, work: () => T): Promise<T> {
    const previous = this.queues.get(junctionId) ?? Promise.resolve();
    const result = previous.then(work);
    // A failed job must not block the jobs queued behind it.
    this.queues.set(junctionId, result.catch(() => undefined));
    return result;
  }

  private requireJunction(junctionId: string) {
    const junction = this.repo.getJunction(junctionId);
    if (!junction) throw new NotFoundError(`junction ${junctionId} not found`);
    return junction;
  }

  // Must run inside a transaction.
  private decideAndSave(junctionId: string, input: Input, now: number): Decision {
    const junction = this.requireJunction(junctionId);
    const before = this.repo.loadState(junctionId);
    const decision = decide(before ?? createInitialState(junctionId, junction.config, now), input, now, junction.config);
    this.repo.saveState(before, decision.state, now);
    this.repo.recordEffects(junctionId, decision.effects, now);
    return decision;
  }

  // Commands only leave the process after the transaction committed.
  private dispatch(decision: Decision) {
    for (const effect of decision.effects) {
      if (effect.type !== 'SEND_COMMAND') continue;
      try {
        this.controller.send(effect.command);
      } catch (err) {
        // The ACK timeout will notice and fail safe; nothing else to do here.
        console.error(`failed to send ${effect.command.commandId}:`, err);
      }
    }
  }

  private apply(junctionId: string, input: Input): Promise<Decision> {
    return this.serialize(junctionId, () => {
      const now = this.clock();
      const decision = this.repo.transaction(() => this.decideAndSave(junctionId, input, now));
      this.dispatch(decision);
      return decision;
    });
  }

  junctionIds(): string[] {
    return this.repo.listJunctions().map((j) => j.id);
  }

  listJunctions() {
    return this.repo.listJunctions();
  }

  getJunction(junctionId: string) {
    return this.requireJunction(junctionId);
  }

  async createJunction(id: string, name: string, config: JunctionConfig): Promise<boolean> {
    if (!this.repo.createJunction(id, name, config, this.clock())) return false;
    await this.recover(id);
    return true;
  }

  // On boot: never trust what the controller was doing before we went down.
  async recover(junctionId: string): Promise<Decision> {
    this.repo.markPendingCommandsStale(junctionId);
    return this.apply(junctionId, { type: 'RECOVER' });
  }

  async recoverAll() {
    for (const id of this.junctionIds()) await this.recover(id);
  }

  tick(junctionId: string) {
    return this.apply(junctionId, { type: 'TICK' });
  }

  sendCommand(junctionId: string, input: Extract<Input, { type: 'MANUAL_GREEN_REQUEST' | 'RETURN_TO_AUTOMATIC' }>) {
    return this.apply(junctionId, input);
  }

  controllerEvent(junctionId: string, input: Extract<Input, { type: 'CONTROLLER_ACK' }>) {
    return this.apply(junctionId, input);
  }

  deviceStatus(junctionId: string, input: Extract<Input, { type: 'CONTROLLER_STATUS' | 'SENSOR_STATUS' }>) {
    return this.apply(junctionId, input);
  }

  // event_id is the dedup key, recorded in the same transaction as the state change it caused.
  submitSensorEvent(event: SensorEvent): Promise<SensorResult> {
    const payloadHash = hashPayload(event.payload);
    return this.serialize(event.junctionId, () => {
      const now = this.clock();
      const result = this.repo.transaction((): SensorResult => {
        this.requireJunction(event.junctionId);
        const seen = this.repo.findProcessedEvent(event.eventId);
        if (seen) {
          const sameEvent = seen.payloadHash === payloadHash;
          this.repo.insertAudit(
            event.junctionId,
            { eventType: sameEvent ? 'DUPLICATE_EVENT' : 'EVENT_ID_CONFLICT', details: { eventId: event.eventId } },
            now,
          );
          return { outcome: sameEvent ? 'DUPLICATE' : 'ID_CONFLICT' };
        }

        const decision = this.decideAndSave(event.junctionId, event.input, now);
        if (decision.error) return { outcome: 'REJECTED', decision };

        this.repo.insertProcessedEvent(
          { eventId: event.eventId, junctionId: event.junctionId, payloadHash, sensorTs: event.rawTimestamp, outcome: 'APPLIED' },
          now,
        );
        return { outcome: 'APPLIED', decision };
      });
      if ('decision' in result) this.dispatch(result.decision);
      return result;
    });
  }

  auditRejectedEvent(junctionId: string, details: Record<string, unknown>) {
    if (!this.repo.getJunction(junctionId)) return;
    this.repo.insertAudit(junctionId, { eventType: 'REJECTED_EVENT', details }, this.clock());
  }

  status(junctionId: string) {
    const junction = this.requireJunction(junctionId);
    const now = this.clock();
    const state = this.repo.loadState(junctionId) ?? createInitialState(junctionId, junction.config, now);
    return buildStatus(state, junction.config, now);
  }

  history(junctionId: string, limit: number) {
    this.requireJunction(junctionId);
    return this.repo.history(junctionId, limit);
  }
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
