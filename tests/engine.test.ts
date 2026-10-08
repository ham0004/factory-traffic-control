import { describe, expect, it } from 'vitest';
import { DEFAULT_JUNCTION_CONFIG as config } from '../src/domain/config';
import { createInitialState, decide, queueLengths } from '../src/domain/engine';
import { allRed, isLegalTransition, isSafe, signalsFor } from '../src/domain/signals';
import type { Decision, Direction, Effect, Input, JunctionState, Stage, VehicleType } from '../src/domain/types';

const SECOND = 1000;

// Small driver around decide(): keeps the clock, the state and every effect produced so far.
class Sim {
  now = 0;
  state: JunctionState = createInitialState('A', config, 0);
  effects: Effect[] = [];
  private seq = 0;

  constructor() {
    this.apply({ type: 'RECOVER' });
    this.ack();
  }

  apply(input: Input): Decision {
    const decision = decide(this.state, input, this.now, config);
    this.state = decision.state;
    this.effects.push(...decision.effects);
    return decision;
  }

  ack() {
    const pending = this.state.pendingCommand;
    if (pending) {
      this.apply({ type: 'CONTROLLER_ACK', commandId: pending.commandId, status: 'ACK', actualSignals: pending.desiredSignals });
    }
  }

  run(ms: number, autoAck = true) {
    for (let t = 0; t < ms; t += SECOND) {
      this.now += SECOND;
      this.apply({ type: 'TICK' });
      if (autoAck) this.ack();
    }
  }

  arrive(vehicleId: string, direction: Direction, vehicleType: VehicleType, sensorTime = this.now) {
    return this.apply({ type: 'VEHICLE_ARRIVED', vehicleId, direction, vehicleType, sequenceNo: ++this.seq, sensorTime });
  }

  clear(vehicleId: string, direction: Direction, sequenceNo = ++this.seq) {
    return this.apply({ type: 'VEHICLE_CLEARED', vehicleId, direction, sequenceNo, sensorTime: this.now });
  }

  auditTypes(): string[] {
    return this.effects.flatMap((e) => (e.type === 'AUDIT' ? [e.entry.eventType] : []));
  }

  transitions(): string[] {
    return this.effects.flatMap((e) =>
      e.type === 'AUDIT' && e.entry.eventType === 'SIGNAL_TRANSITION' ? [e.entry.newState!] : [],
    );
  }

  clearHistory() {
    this.effects = [];
  }
}

function greenSim(): Sim {
  const sim = new Sim();
  sim.run(2 * SECOND);
  expect(sim.state.stage).toMatchObject({ kind: 'GREEN', phase: 'NORTH_SOUTH' });
  return sim;
}

// Deterministic PRNG so a failing random run can be reproduced.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('safety', () => {
  it('never produces conflicting greens across 500 random inputs', () => {
    const random = mulberry32(42);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const directions: Direction[] = ['NORTH', 'SOUTH', 'EAST', 'WEST'];
    const types: VehicleType[] = ['EMPLOYEE_VEHICLE', 'FORKLIFT', 'TRUCK', 'EMERGENCY'];
    const sim = new Sim();

    for (let i = 0; i < 500; i++) {
      const before: Stage = sim.state.stage;
      const vehicleId = `VH-${Math.floor(random() * 30)}`;
      const roll = random();

      if (roll < 0.25) sim.arrive(vehicleId, pick(directions), pick(types));
      else if (roll < 0.4) sim.clear(vehicleId, pick(directions));
      else if (roll < 0.45) sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: pick(directions) });
      else if (roll < 0.5) sim.apply({ type: 'RETURN_TO_AUTOMATIC' });
      else if (roll < 0.53) sim.apply({ type: 'CONTROLLER_STATUS', status: pick(['ONLINE', 'OFFLINE'] as const) });
      else if (roll < 0.55 && sim.state.pendingCommand) {
        // Controller lies about its state.
        sim.apply({
          type: 'CONTROLLER_ACK',
          commandId: sim.state.pendingCommand.commandId,
          status: 'ACK',
          actualSignals: { NORTH: 'GREEN', SOUTH: 'GREEN', EAST: 'GREEN', WEST: 'GREEN' },
        });
      } else if (roll < 0.75) sim.ack();
      else {
        sim.now += Math.floor(random() * 8 * SECOND);
        sim.apply({ type: 'TICK' });
      }

      const after = sim.state.stage;
      expect(isSafe(signalsFor(after, config), config)).toBe(true);
      if (after !== before && after.kind !== before.kind) {
        // Any change is either a legal step or the fail-safe drop to ALL_RED.
        expect(isLegalTransition(before, after) || after.kind === 'ALL_RED').toBe(true);
      }
    }
  });

  it('starts in ALL_RED and only goes green once the controller confirmed it', () => {
    const sim = new Sim();
    expect(sim.state.stage.kind).toBe('ALL_RED');
    sim.run(2 * SECOND);
    expect(sim.state.stage).toMatchObject({ kind: 'GREEN', phase: 'NORTH_SOUTH' });
  });
});

describe('manual control', () => {
  it('goes through YELLOW and ALL_RED before the requested green', () => {
    const sim = greenSim();
    sim.clearHistory();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'WEST' });
    expect(sim.state.mode).toBe('MANUAL');

    sim.run(20 * SECOND);
    expect(sim.transitions()).toEqual(['YELLOW NORTH_SOUTH', 'ALL_RED (next EAST_WEST)', 'GREEN EAST_WEST']);
    expect(sim.state.stage).toMatchObject({ kind: 'GREEN', phase: 'EAST_WEST' });
  });

  it('holds the manual green even when the other side has traffic', () => {
    const sim = greenSim();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'NORTH' });
    sim.arrive('VH-1', 'EAST', 'TRUCK');
    sim.run(100 * SECOND);
    expect(sim.state.stage).toMatchObject({ kind: 'GREEN', phase: 'NORTH_SOUTH' });
  });

  it('expires after the TTL and returns to automatic', () => {
    const sim = greenSim();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'NORTH' });
    sim.run(config.manualTtlMs + SECOND);
    expect(sim.state.mode).toBe('AUTOMATIC');
    expect(sim.state.manual).toBeNull();
    expect(sim.auditTypes()).toContain('MANUAL_EXPIRED');
  });

  it('RETURN_TO_AUTOMATIC hands control back to the scheduler', () => {
    const sim = greenSim();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'NORTH' });
    sim.apply({ type: 'RETURN_TO_AUTOMATIC' });
    expect(sim.state.mode).toBe('AUTOMATIC');
  });

  it('is rejected during an emergency without touching state', () => {
    const sim = greenSim();
    sim.arrive('AMB-1', 'EAST', 'EMERGENCY');
    const before = sim.state;
    const decision = sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'NORTH' });
    expect(decision.error?.code).toBe('EMERGENCY_ACTIVE');
    expect(sim.state).toBe(before);
  });
});

describe('emergency preemption', () => {
  it('preempts NS green via YELLOW and ALL_RED without waiting for min green', () => {
    const sim = greenSim();
    sim.clearHistory();
    sim.arrive('AMB-1', 'EAST', 'EMERGENCY');
    expect(sim.state.mode).toBe('EMERGENCY');
    expect(sim.state.stage).toMatchObject({ kind: 'YELLOW', phase: 'NORTH_SOUTH' });

    sim.run(10 * SECOND);
    expect(sim.transitions()).toEqual(['YELLOW NORTH_SOUTH', 'ALL_RED (next EAST_WEST)', 'GREEN EAST_WEST']);
  });

  it('makes a conflicting second emergency wait until the first clears', () => {
    const sim = greenSim();
    sim.arrive('AMB-1', 'EAST', 'EMERGENCY');
    sim.arrive('AMB-2', 'NORTH', 'EMERGENCY');
    sim.run(30 * SECOND);
    expect(sim.state.stage).toMatchObject({ kind: 'GREEN', phase: 'EAST_WEST' });

    sim.clear('AMB-1', 'EAST');
    expect(sim.state.mode).toBe('EMERGENCY');
    sim.run(10 * SECOND);
    expect(sim.state.stage).toMatchObject({ kind: 'GREEN', phase: 'NORTH_SOUTH' });

    sim.clear('AMB-2', 'NORTH');
    expect(sim.state.mode).toBe('AUTOMATIC');
  });

  it('times out an emergency that never clears', () => {
    const sim = greenSim();
    sim.arrive('AMB-1', 'EAST', 'EMERGENCY');
    sim.run(config.emergencyTimeoutMs + SECOND);
    expect(sim.state.mode).toBe('AUTOMATIC');
    expect(sim.auditTypes()).toContain('EMERGENCY_TIMEOUT');
  });

  it('ignores a stale emergency for preemption but still queues the vehicle', () => {
    const sim = greenSim();
    sim.now = 200 * SECOND;
    sim.arrive('AMB-1', 'EAST', 'EMERGENCY', sim.now - 2 * 60 * SECOND);
    expect(sim.state.mode).toBe('AUTOMATIC');
    expect(queueLengths(sim.state).EAST).toBe(1);
    expect(sim.auditTypes()).toContain('EMERGENCY_STALE');
  });

  it('returns to a still-valid manual override after the emergency', () => {
    const sim = greenSim();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'NORTH' });
    sim.arrive('AMB-1', 'EAST', 'EMERGENCY');
    sim.run(10 * SECOND);
    sim.clear('AMB-1', 'EAST');
    expect(sim.state.mode).toBe('MANUAL');
  });
});

describe('controller acknowledgements', () => {
  it('does not advance a stage until it is acknowledged', () => {
    const sim = greenSim();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'WEST' });
    sim.run(10 * SECOND); // min green passes, YELLOW is requested and acked
    expect(sim.state.stage.kind).toBe('YELLOW');

    sim.run(5 * SECOND, false); // yellow finishes, ALL_RED is requested but never acked
    expect(sim.state.stage.kind).toBe('ALL_RED');
    expect(sim.state.pendingCommand).not.toBeNull();

    sim.run(2 * SECOND, false); // all-red time has passed, but without an ACK we must not go green
    expect(sim.state.stage.kind).toBe('ALL_RED');
    expect(sim.state.mode).toBe('MANUAL');
  });

  it('retries once, then fails safe to ALL_RED in DEGRADED', () => {
    const sim = greenSim();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'WEST' });
    sim.run(8 * SECOND);
    sim.clearHistory();
    sim.run(10 * SECOND, false);

    expect(sim.auditTypes()).toContain('COMMAND_RETRY');
    expect(sim.auditTypes()).toContain('CONTROLLER_TIMEOUT');
    expect(sim.state.mode).toBe('DEGRADED');
    expect(signalsFor(sim.state.stage, config)).toEqual(allRed());
    expect(sim.state.actualSignals.NORTH).toBe('UNKNOWN');
  });

  it('recovers once the controller confirms ALL_RED', () => {
    const sim = greenSim();
    sim.apply({ type: 'CONTROLLER_STATUS', status: 'OFFLINE' });
    expect(sim.state.mode).toBe('DEGRADED');

    sim.ack(); // ignored while offline
    expect(sim.state.mode).toBe('DEGRADED');

    sim.apply({ type: 'CONTROLLER_STATUS', status: 'ONLINE' });
    sim.ack();
    expect(sim.state.mode).toBe('AUTOMATIC');
  });

  it('treats an ACK with the wrong state as a mismatch', () => {
    const sim = greenSim();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'WEST' });
    sim.run(8 * SECOND);
    sim.now += 2 * SECOND;
    sim.apply({ type: 'TICK' });
    const pending = sim.state.pendingCommand!;
    sim.apply({ type: 'CONTROLLER_ACK', commandId: pending.commandId, status: 'ACK', actualSignals: { ...pending.desiredSignals, EAST: 'GREEN' } });
    expect(sim.state.mode).toBe('DEGRADED');
    expect(sim.state.degradedReason).toBe('STATE_MISMATCH');
  });

  it('ignores a duplicate ACK', () => {
    const sim = greenSim();
    const lastCommand = `cmd-A-${sim.state.commandCounter}`;
    const before = sim.state;
    sim.apply({ type: 'CONTROLLER_ACK', commandId: lastCommand, status: 'ACK', actualSignals: allRed() });
    expect(sim.state.mode).toBe(before.mode);
    expect(sim.state.stage).toEqual(before.stage);
    expect(sim.auditTypes()).toContain('DUPLICATE_ACK');
  });
});

describe('vehicle events', () => {
  it('counts arrivals and clearances per direction', () => {
    const sim = greenSim();
    sim.arrive('VH-1', 'NORTH', 'TRUCK');
    sim.arrive('VH-2', 'NORTH', 'FORKLIFT');
    expect(queueLengths(sim.state).NORTH).toBe(2);
    sim.clear('VH-1', 'NORTH');
    expect(queueLengths(sim.state).NORTH).toBe(1);
  });

  it('does not count the same vehicle twice', () => {
    const sim = greenSim();
    sim.arrive('VH-1', 'NORTH', 'TRUCK');
    sim.arrive('VH-1', 'NORTH', 'TRUCK');
    expect(queueLengths(sim.state).NORTH).toBe(1);
  });

  it('never goes negative when a clear arrives without an arrival', () => {
    const sim = greenSim();
    sim.clear('VH-9', 'EAST', 100);
    sim.clear('VH-9', 'EAST', 101);
    expect(queueLengths(sim.state).EAST).toBe(0);
    expect(sim.auditTypes()).toContain('CLEAR_WITHOUT_ARRIVAL');
  });

  it('ignores an arrival that is older than the clear we already saw', () => {
    const sim = greenSim();
    sim.clear('VH-9', 'EAST', 100);
    sim.apply({ type: 'VEHICLE_ARRIVED', vehicleId: 'VH-9', direction: 'EAST', vehicleType: 'TRUCK', sequenceNo: 99, sensorTime: sim.now });
    expect(queueLengths(sim.state).EAST).toBe(0);
    expect(sim.auditTypes()).toContain('OUT_OF_ORDER');
  });

  it('rejects a timestamp far in the future', () => {
    const sim = greenSim();
    const decision = sim.arrive('VH-1', 'NORTH', 'TRUCK', sim.now + 5 * 60 * SECOND);
    expect(decision.error?.code).toBe('TIMESTAMP_IN_FUTURE');
    expect(queueLengths(sim.state).NORTH).toBe(0);
  });
});

describe('restart recovery', () => {
  it('goes to ALL_RED with unknown actual state and asks the controller again', () => {
    const sim = greenSim();
    sim.apply({ type: 'MANUAL_GREEN_REQUEST', direction: 'WEST' });
    sim.run(11 * SECOND); // somewhere in the middle of the transition
    const oldCommand = sim.state.pendingCommand?.commandId;

    sim.clearHistory();
    sim.apply({ type: 'RECOVER' });

    expect(sim.state.stage.kind).toBe('ALL_RED');
    expect(sim.state.actualSignals).toEqual({ NORTH: 'UNKNOWN', SOUTH: 'UNKNOWN', EAST: 'UNKNOWN', WEST: 'UNKNOWN' });
    expect(sim.state.pendingCommand?.commandId).not.toBe(oldCommand);
    expect(sim.state.mode).toBe('MANUAL');
    expect(sim.auditTypes()).toContain('RECOVERY_STARTED');
  });
});
