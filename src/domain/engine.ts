import { directionsOf, phaseIds, phaseOf } from './config';
import { pickNextPhase } from './scheduler';
import {
  allRed,
  describeStage,
  isLegalTransition,
  isSafe,
  sameSignals,
  signalsFor,
  unknownSignals,
} from './signals';
import type {
  AuditEntry,
  Decision,
  Direction,
  DomainError,
  Input,
  JunctionConfig,
  JunctionState,
  Mode,
  PhaseId,
  Stage,
} from './types';

// Everything a single decision works on. `s` is a private copy, so decide() stays pure from the outside.
interface Ctx {
  s: JunctionState;
  effects: Decision['effects'];
  now: number;
  config: JunctionConfig;
}

export function createInitialState(junctionId: string, config: JunctionConfig, now: number): JunctionState {
  const firstPhase = phaseIds(config)[0];
  return {
    junctionId,
    mode: 'AUTOMATIC',
    stage: { kind: 'ALL_RED', nextPhase: firstPhase, enteredAt: now },
    lastGreenPhase: firstPhase,
    controllerStatus: 'UNKNOWN',
    sensorStatus: { NORTH: 'ONLINE', SOUTH: 'ONLINE', EAST: 'ONLINE', WEST: 'ONLINE' },
    actualSignals: unknownSignals(),
    pendingCommand: null,
    commandCounter: 0,
    degradedReason: null,
    emergencies: [],
    manual: null,
    lastSequenceNo: null,
    vehicles: {},
  };
}

export function decide(state: JunctionState, input: Input, now: number, config: JunctionConfig): Decision {
  const ctx: Ctx = { s: structuredClone(state), effects: [], now, config };

  const error = handleInput(ctx, input);
  if (error) {
    // Rejected input never changes state, but the rejection itself is still audited.
    return { state, effects: ctx.effects.filter((e) => e.type === 'AUDIT'), error };
  }

  advanceStage(ctx);

  // Defence in depth: signalsFor() can't produce conflicting greens, but a bad config could.
  if (!isSafe(signalsFor(ctx.s.stage, config), config)) {
    enterDegraded(ctx, 'UNSAFE_SIGNALS');
  }

  return { state: ctx.s, effects: ctx.effects };
}

export function queueLengths(state: JunctionState): Record<Direction, number> {
  const queues: Record<Direction, number> = { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 };
  for (const vehicle of Object.values(state.vehicles)) {
    if (vehicle.status === 'WAITING') queues[vehicle.direction] += 1;
  }
  return queues;
}

// The controller has confirmed exactly what we asked for and nothing is in flight.
export function isConfirmed(state: JunctionState, config: JunctionConfig): boolean {
  return state.pendingCommand === null && sameSignals(state.actualSignals, signalsFor(state.stage, config));
}

function handleInput(ctx: Ctx, input: Input): DomainError | void {
  switch (input.type) {
    case 'VEHICLE_ARRIVED':
      return onVehicleArrived(ctx, input);
    case 'VEHICLE_CLEARED':
      return onVehicleCleared(ctx, input);
    case 'MANUAL_GREEN_REQUEST':
      return onManualRequest(ctx, input);
    case 'RETURN_TO_AUTOMATIC':
      return onReturnToAutomatic(ctx, input);
    case 'CONTROLLER_ACK':
      return onControllerAck(ctx, input);
    case 'CONTROLLER_STATUS':
      return onControllerStatus(ctx, input.status);
    case 'SENSOR_STATUS':
      return onSensorStatus(ctx, input.direction, input.status);
    case 'TICK':
      return onTick(ctx);
    case 'RECOVER':
      return onRecover(ctx);
  }
}

// ---- helpers ----

function audit(ctx: Ctx, eventType: string, extra: Omit<AuditEntry, 'eventType'> = {}) {
  ctx.effects.push({ type: 'AUDIT', entry: { eventType, ...extra } });
}

function invalid(code: string, message: string): DomainError {
  return { kind: 'INVALID', code, message };
}

function conflict(code: string, message: string): DomainError {
  return { kind: 'CONFLICT', code, message };
}

function setMode(ctx: Ctx, mode: Mode, reason: string) {
  if (ctx.s.mode === mode) return;
  audit(ctx, 'MODE_CHANGED', { previousState: ctx.s.mode, newState: mode, details: { reason } });
  ctx.s.mode = mode;
}

function manualStillValid(ctx: Ctx): boolean {
  return ctx.s.manual !== null && ctx.s.manual.expiresAt > ctx.now;
}

// The mode the junction should be in when nothing is broken.
function normalMode(ctx: Ctx): Mode {
  if (ctx.s.emergencies.length > 0) return 'EMERGENCY';
  if (manualStillValid(ctx)) return 'MANUAL';
  return 'AUTOMATIC';
}

function emergencyPhase(ctx: Ctx): PhaseId | null {
  const head = ctx.s.emergencies[0];
  return head ? phaseOf(ctx.config, head.direction) : null;
}

// Phase that manual or emergency mode insists on, if any.
function forcedPhase(ctx: Ctx): PhaseId | null {
  if (ctx.s.mode === 'EMERGENCY') return emergencyPhase(ctx);
  if (ctx.s.mode === 'MANUAL' && ctx.s.manual) return ctx.s.manual.phase;
  return null;
}

function knowsDirection(ctx: Ctx, direction: Direction): boolean {
  return directionsOf(ctx.config).includes(direction);
}

function trackSequence(ctx: Ctx, sequenceNo: number) {
  const last = ctx.s.lastSequenceNo;
  if (last !== null && sequenceNo > last + 1) {
    audit(ctx, 'SEQUENCE_GAP', { details: { expected: last + 1, received: sequenceNo } });
  } else if (last !== null && sequenceNo <= last) {
    audit(ctx, 'SEQUENCE_OUT_OF_ORDER', { details: { last, received: sequenceNo } });
  }
  ctx.s.lastSequenceNo = Math.max(last ?? sequenceNo, sequenceNo);
}

// ---- controller commands ----

function sendDesired(ctx: Ctx, reason: string) {
  const { s, now, config } = ctx;
  if (s.pendingCommand) {
    ctx.effects.push({ type: 'COMMAND_RESULT', commandId: s.pendingCommand.commandId, result: 'STALE' });
  }
  s.commandCounter += 1;
  const desiredSignals = signalsFor(s.stage, config);
  const commandId = `cmd-${s.junctionId}-${s.commandCounter}`;
  s.pendingCommand = { commandId, desiredSignals, sentAt: now, attempts: 1 };

  ctx.effects.push({ type: 'SEND_COMMAND', command: { commandId, junctionId: s.junctionId, desiredSignals }, attempt: 1 });
  audit(ctx, 'SIGNAL_REQUESTED', { commandId, newState: describeStage(s.stage), details: { reason, desiredSignals } });
}

function enterStage(ctx: Ctx, next: Stage, reason: string) {
  if (!isLegalTransition(ctx.s.stage, next)) {
    throw new Error(`illegal transition ${describeStage(ctx.s.stage)} -> ${describeStage(next)}`);
  }
  audit(ctx, 'SIGNAL_TRANSITION', {
    previousState: describeStage(ctx.s.stage),
    newState: describeStage(next),
    details: { reason, mode: ctx.s.mode },
  });
  ctx.s.stage = next;
  if (next.kind === 'GREEN') ctx.s.lastGreenPhase = next.phase;
  sendDesired(ctx, reason);
}

// Fail-safe: drop straight to ALL_RED and keep asking the controller for it until it confirms.
function enterDegraded(ctx: Ctx, reason: string) {
  const { s, now } = ctx;
  s.degradedReason = reason;
  setMode(ctx, 'DEGRADED', reason);

  if (s.stage.kind !== 'ALL_RED') {
    const resumePhase = s.stage.kind === 'GREEN' ? s.stage.phase : s.stage.nextPhase;
    const forced: Stage = { kind: 'ALL_RED', nextPhase: resumePhase, enteredAt: now };
    audit(ctx, 'SIGNAL_TRANSITION', {
      previousState: describeStage(s.stage),
      newState: describeStage(forced),
      details: { reason, failSafe: true },
    });
    s.stage = forced;
  }

  if (!s.pendingCommand || !sameSignals(s.pendingCommand.desiredSignals, allRed())) {
    sendDesired(ctx, `fail-safe: ${reason}`);
  }
}

function recoverFromDegraded(ctx: Ctx) {
  const { s, now } = ctx;
  s.degradedReason = null;
  // Restart the all-red clearance from the moment the controller confirmed it.
  if (s.stage.kind === 'ALL_RED') s.stage = { ...s.stage, enteredAt: now };
  audit(ctx, 'RECOVERED', { details: { confirmedAllRed: true } });
  setMode(ctx, normalMode(ctx), 'controller confirmed ALL_RED');
}

// ---- stage machine ----

function advanceStage(ctx: Ctx) {
  const { s, now, config } = ctx;
  // A stage we haven't seen confirmed must never be followed by the next one.
  if (!isConfirmed(s, config)) return;

  const elapsed = now - s.stage.enteredAt;
  switch (s.stage.kind) {
    case 'GREEN': {
      const target = phaseToSwitchTo(ctx, s.stage.phase, elapsed);
      if (target) {
        enterStage(ctx, { kind: 'YELLOW', phase: s.stage.phase, nextPhase: target, enteredAt: now }, `switch to ${target}`);
      }
      return;
    }
    case 'YELLOW':
      if (elapsed >= config.timings.yellowMs) {
        const next = forcedPhase(ctx) ?? s.stage.nextPhase;
        enterStage(ctx, { kind: 'ALL_RED', nextPhase: next, enteredAt: now }, 'yellow finished');
      }
      return;
    case 'ALL_RED':
      if (s.mode === 'DEGRADED') return;
      if (elapsed >= config.timings.allRedMs) {
        const next = forcedPhase(ctx) ?? s.stage.nextPhase;
        enterStage(ctx, { kind: 'GREEN', phase: next, enteredAt: now }, 'clearance finished');
      }
      return;
  }
}

function phaseToSwitchTo(ctx: Ctx, current: PhaseId, elapsed: number): PhaseId | null {
  const { s, now, config } = ctx;
  switch (s.mode) {
    case 'EMERGENCY': {
      // Emergency may cut min green short, but still goes through YELLOW and ALL_RED.
      const target = emergencyPhase(ctx);
      return target && target !== current ? target : null;
    }
    case 'MANUAL': {
      const target = s.manual?.phase ?? null;
      return target && target !== current && elapsed >= config.timings.minGreenMs ? target : null;
    }
    case 'AUTOMATIC':
      return pickNextPhase(s, now, config);
    case 'DEGRADED':
      return null;
  }
}

// ---- inputs ----

function onVehicleArrived(ctx: Ctx, e: Extract<Input, { type: 'VEHICLE_ARRIVED' }>): DomainError | void {
  const { s, now, config } = ctx;
  if (!knowsDirection(ctx, e.direction)) {
    audit(ctx, 'REJECTED_EVENT', { direction: e.direction, details: { reason: 'UNKNOWN_DIRECTION' } });
    return invalid('UNKNOWN_DIRECTION', `direction ${e.direction} is not part of junction ${s.junctionId}`);
  }
  if (e.sensorTime - now > config.futureToleranceMs) {
    audit(ctx, 'REJECTED_EVENT', { direction: e.direction, details: { reason: 'TIMESTAMP_IN_FUTURE' } });
    return invalid('TIMESTAMP_IN_FUTURE', 'sensor timestamp is too far in the future');
  }

  trackSequence(ctx, e.sequenceNo);
  const existing = s.vehicles[e.vehicleId];

  if (existing?.status === 'WAITING') {
    audit(ctx, 'DUPLICATE_VEHICLE', { direction: e.direction, details: { vehicleId: e.vehicleId } });
    return;
  }
  // e.g. the CLEARED for this vehicle already arrived with a higher sequence number.
  if (existing?.lastSequenceNo != null && e.sequenceNo <= existing.lastSequenceNo) {
    audit(ctx, 'OUT_OF_ORDER', {
      direction: e.direction,
      details: { vehicleId: e.vehicleId, sequenceNo: e.sequenceNo, lastSequenceNo: existing.lastSequenceNo },
    });
    return;
  }

  s.vehicles[e.vehicleId] = {
    vehicleId: e.vehicleId,
    direction: e.direction,
    vehicleType: e.vehicleType,
    status: 'WAITING',
    arrivedAt: now,
    clearedAt: null,
    lastSequenceNo: e.sequenceNo,
  };
  audit(ctx, 'VEHICLE_DETECTED', {
    direction: e.direction,
    details: {
      vehicleId: e.vehicleId,
      vehicleType: e.vehicleType,
      sequenceNo: e.sequenceNo,
      sensorTime: new Date(e.sensorTime).toISOString(),
    },
  });

  if (e.vehicleType === 'EMERGENCY') onEmergencyArrived(ctx, e.vehicleId, e.direction, e.sensorTime);
}

function onEmergencyArrived(ctx: Ctx, vehicleId: string, direction: Direction, sensorTime: number) {
  const { s, now, config } = ctx;
  if (now - sensorTime > config.staleEventMs) {
    audit(ctx, 'EMERGENCY_STALE', { direction, details: { vehicleId, ageMs: now - sensorTime } });
    return;
  }

  // First come, first served. A conflicting second emergency waits for the first to clear.
  s.emergencies.push({ vehicleId, direction, detectedAt: now });
  audit(ctx, 'EMERGENCY_DETECTED', { direction, details: { vehicleId, queuePosition: s.emergencies.length } });

  // In DEGRADED we can't serve it yet; recovery picks EMERGENCY mode up from the queue.
  if (s.mode !== 'DEGRADED') setMode(ctx, 'EMERGENCY', `emergency vehicle ${vehicleId} from ${direction}`);
}

function onVehicleCleared(ctx: Ctx, e: Extract<Input, { type: 'VEHICLE_CLEARED' }>): DomainError | void {
  const { s, now } = ctx;
  if (!knowsDirection(ctx, e.direction)) {
    audit(ctx, 'REJECTED_EVENT', { direction: e.direction, details: { reason: 'UNKNOWN_DIRECTION' } });
    return invalid('UNKNOWN_DIRECTION', `direction ${e.direction} is not part of junction ${s.junctionId}`);
  }

  trackSequence(ctx, e.sequenceNo);
  const existing = s.vehicles[e.vehicleId];

  if (existing?.status === 'WAITING') {
    existing.status = 'CLEARED';
    existing.clearedAt = now;
    existing.lastSequenceNo = Math.max(existing.lastSequenceNo ?? e.sequenceNo, e.sequenceNo);
    audit(ctx, 'VEHICLE_CLEARED', { direction: existing.direction, details: { vehicleId: e.vehicleId } });
    removeEmergency(ctx, e.vehicleId, 'EMERGENCY_CLEARED');
    return;
  }

  // Nothing to remove. Keep a tombstone so a late ARRIVED for the same vehicle is recognised as out of order.
  audit(ctx, 'CLEAR_WITHOUT_ARRIVAL', { direction: e.direction, details: { vehicleId: e.vehicleId } });
  if (existing) {
    existing.lastSequenceNo = Math.max(existing.lastSequenceNo ?? e.sequenceNo, e.sequenceNo);
  } else {
    s.vehicles[e.vehicleId] = {
      vehicleId: e.vehicleId,
      direction: e.direction,
      vehicleType: null,
      status: 'TOMBSTONE',
      arrivedAt: null,
      clearedAt: now,
      lastSequenceNo: e.sequenceNo,
    };
  }
}

function removeEmergency(ctx: Ctx, vehicleId: string, eventType: 'EMERGENCY_CLEARED' | 'EMERGENCY_TIMEOUT') {
  const { s } = ctx;
  const index = s.emergencies.findIndex((em) => em.vehicleId === vehicleId);
  if (index === -1) return;

  const [removed] = s.emergencies.splice(index, 1);
  audit(ctx, eventType, { direction: removed.direction, details: { vehicleId } });
  if (s.emergencies.length === 0 && s.mode === 'EMERGENCY') {
    setMode(ctx, normalMode(ctx), 'emergency finished');
  }
}

function onManualRequest(ctx: Ctx, e: Extract<Input, { type: 'MANUAL_GREEN_REQUEST' }>): DomainError | void {
  const { s, now, config } = ctx;
  const phase = phaseOf(config, e.direction);
  if (!phase) return invalid('UNKNOWN_DIRECTION', `direction ${e.direction} is not part of junction ${s.junctionId}`);

  if (s.mode === 'EMERGENCY') {
    audit(ctx, 'MANUAL_REJECTED', { direction: e.direction, details: { reason: 'EMERGENCY_ACTIVE', issuedBy: e.issuedBy } });
    return conflict('EMERGENCY_ACTIVE', 'an emergency preemption is in progress');
  }
  if (s.mode === 'DEGRADED') {
    audit(ctx, 'MANUAL_REJECTED', { direction: e.direction, details: { reason: 'JUNCTION_DEGRADED', issuedBy: e.issuedBy } });
    return conflict('JUNCTION_DEGRADED', 'junction is in fail-safe mode until the controller recovers');
  }

  s.manual = { phase, direction: e.direction, expiresAt: now + config.manualTtlMs, issuedBy: e.issuedBy ?? null };
  audit(ctx, 'MANUAL_OVERRIDE', {
    direction: e.direction,
    newState: phase,
    details: { issuedBy: e.issuedBy ?? null, expiresAt: new Date(s.manual.expiresAt).toISOString() },
  });
  setMode(ctx, 'MANUAL', `manual green requested for ${e.direction}`);
}

function onReturnToAutomatic(ctx: Ctx, e: Extract<Input, { type: 'RETURN_TO_AUTOMATIC' }>) {
  // In EMERGENCY or DEGRADED this just drops the override so it isn't resumed afterwards.
  ctx.s.manual = null;
  audit(ctx, 'RETURN_TO_AUTOMATIC', { details: { issuedBy: e.issuedBy ?? null, mode: ctx.s.mode } });
  if (ctx.s.mode === 'MANUAL') setMode(ctx, 'AUTOMATIC', 'operator returned junction to automatic');
}

function onControllerAck(ctx: Ctx, e: Extract<Input, { type: 'CONTROLLER_ACK' }>) {
  const { s } = ctx;
  const pending = s.pendingCommand;

  if (!pending || pending.commandId !== e.commandId) {
    audit(ctx, 'DUPLICATE_ACK', { commandId: e.commandId, details: { status: e.status } });
    return;
  }
  if (s.controllerStatus === 'OFFLINE') {
    audit(ctx, 'ACK_IGNORED', { commandId: e.commandId, details: { reason: 'controller reported OFFLINE' } });
    return;
  }

  s.pendingCommand = null;
  s.controllerStatus = 'ONLINE';

  if (e.status === 'NACK') {
    s.actualSignals = e.actualSignals ?? unknownSignals();
    ctx.effects.push({ type: 'COMMAND_RESULT', commandId: e.commandId, result: 'FAILED', actualSignals: s.actualSignals });
    audit(ctx, 'COMMAND_FAILED', { commandId: e.commandId });
    enterDegraded(ctx, 'COMMAND_FAILED');
    return;
  }

  s.actualSignals = e.actualSignals;
  ctx.effects.push({ type: 'COMMAND_RESULT', commandId: e.commandId, result: 'ACKED', actualSignals: e.actualSignals });
  audit(ctx, 'CONTROLLER_ACK', { commandId: e.commandId, details: { attempts: pending.attempts } });

  if (!sameSignals(e.actualSignals, pending.desiredSignals)) {
    audit(ctx, 'STATE_MISMATCH', {
      commandId: e.commandId,
      details: { desired: pending.desiredSignals, actual: e.actualSignals },
    });
    enterDegraded(ctx, 'STATE_MISMATCH');
    return;
  }

  audit(ctx, 'SIGNAL_CONFIRMED', { commandId: e.commandId, newState: describeStage(s.stage) });
  if (s.mode === 'DEGRADED' && sameSignals(e.actualSignals, allRed())) recoverFromDegraded(ctx);
}

function onControllerStatus(ctx: Ctx, status: 'ONLINE' | 'OFFLINE') {
  const { s } = ctx;
  if (s.controllerStatus === status) return;

  if (status === 'OFFLINE') {
    s.controllerStatus = 'OFFLINE';
    s.actualSignals = unknownSignals();
    audit(ctx, 'DEVICE_FAILURE', { details: { device: 'SIGNAL_CONTROLLER' } });
    enterDegraded(ctx, 'CONTROLLER_OFFLINE');
    return;
  }

  s.controllerStatus = 'ONLINE';
  audit(ctx, 'DEVICE_ONLINE', { details: { device: 'SIGNAL_CONTROLLER' } });
  // Don't wait for the next resend interval: ask for ALL_RED now, recovery happens on its ACK.
  if (s.mode === 'DEGRADED') sendDesired(ctx, 'controller reconnected');
}

function onSensorStatus(ctx: Ctx, direction: Direction, status: 'ONLINE' | 'OFFLINE'): DomainError | void {
  if (!knowsDirection(ctx, direction)) {
    return invalid('UNKNOWN_DIRECTION', `direction ${direction} is not part of junction ${ctx.s.junctionId}`);
  }
  if (ctx.s.sensorStatus[direction] === status) return;
  ctx.s.sensorStatus[direction] = status;
  audit(ctx, status === 'OFFLINE' ? 'SENSOR_FAILURE' : 'SENSOR_ONLINE', { direction });
}

function onTick(ctx: Ctx) {
  expireManual(ctx);
  expireEmergencies(ctx);
  checkCommandTimeout(ctx);
}

function expireManual(ctx: Ctx) {
  const { s, now } = ctx;
  if (!s.manual || s.manual.expiresAt > now) return;
  audit(ctx, 'MANUAL_EXPIRED', { direction: s.manual.direction });
  s.manual = null;
  if (s.mode === 'MANUAL') setMode(ctx, 'AUTOMATIC', 'manual override expired');
}

function expireEmergencies(ctx: Ctx) {
  const { s, now, config } = ctx;
  const expired = s.emergencies.filter((em) => now - em.detectedAt >= config.emergencyTimeoutMs);
  for (const em of expired) {
    const vehicle = s.vehicles[em.vehicleId];
    if (vehicle?.status === 'WAITING') {
      vehicle.status = 'CLEARED';
      vehicle.clearedAt = now;
    }
    removeEmergency(ctx, em.vehicleId, 'EMERGENCY_TIMEOUT');
  }
}

function checkCommandTimeout(ctx: Ctx) {
  const { s, now, config } = ctx;
  const pending = s.pendingCommand;
  if (!pending) return;

  const waited = now - pending.sentAt;

  if (s.mode === 'DEGRADED') {
    if (waited >= config.timings.degradedResendMs) {
      ctx.effects.push({ type: 'COMMAND_RESULT', commandId: pending.commandId, result: 'TIMEOUT' });
      s.pendingCommand = null;
      sendDesired(ctx, 'fail-safe resend');
    }
    return;
  }

  if (waited < config.timings.ackTimeoutMs) return;

  if (pending.attempts < config.maxCommandAttempts) {
    pending.attempts += 1;
    pending.sentAt = now;
    ctx.effects.push({
      type: 'SEND_COMMAND',
      command: { commandId: pending.commandId, junctionId: s.junctionId, desiredSignals: pending.desiredSignals },
      attempt: pending.attempts,
    });
    audit(ctx, 'COMMAND_RETRY', { commandId: pending.commandId, details: { attempt: pending.attempts } });
    return;
  }

  ctx.effects.push({ type: 'COMMAND_RESULT', commandId: pending.commandId, result: 'TIMEOUT' });
  audit(ctx, 'CONTROLLER_TIMEOUT', { commandId: pending.commandId, details: { attempts: pending.attempts } });
  s.pendingCommand = null;
  s.actualSignals = unknownSignals();
  enterDegraded(ctx, 'ACK_TIMEOUT');
}

// Called once per junction on boot. We never trust that the controller is still where we left it.
function onRecover(ctx: Ctx) {
  const { s, now, config } = ctx;
  audit(ctx, 'RECOVERY_STARTED', { previousState: describeStage(s.stage), details: { previousMode: s.mode } });

  if (s.pendingCommand) {
    ctx.effects.push({ type: 'COMMAND_RESULT', commandId: s.pendingCommand.commandId, result: 'STALE' });
    s.pendingCommand = null;
  }
  s.actualSignals = unknownSignals();
  s.controllerStatus = 'UNKNOWN';

  expireManual(ctx);
  expireEmergencies(ctx);

  // Timers restart from here; previously elapsed green time is deliberately forgotten.
  const resumePhase = s.stage.kind === 'GREEN' ? s.stage.phase : s.stage.nextPhase;
  s.stage = { kind: 'ALL_RED', nextPhase: config.phases[resumePhase] ? resumePhase : s.lastGreenPhase, enteredAt: now };

  if (s.mode !== 'DEGRADED') setMode(ctx, normalMode(ctx), 'recovery');
  sendDesired(ctx, 'recovery');
}
