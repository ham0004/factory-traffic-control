import { isConfirmed, queueLengths } from '../domain/engine';
import { sameSignals, signalsFor } from '../domain/signals';
import { DIRECTIONS } from '../domain/types';
import type { JunctionConfig, JunctionState } from '../domain/types';

export interface Alert {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

// Read model for the API and dashboard. Everything here is derived from backend state.
export function buildStatus(state: JunctionState, config: JunctionConfig, now: number) {
  const { stage, pendingCommand } = state;
  const desired = signalsFor(stage, config);

  return {
    junction_id: state.junctionId,
    mode: state.mode,
    phase: stage.kind === 'ALL_RED' ? 'ALL_RED' : stage.phase,
    stage: {
      kind: stage.kind,
      phase: stage.kind === 'ALL_RED' ? null : stage.phase,
      next_phase: stage.kind === 'GREEN' ? null : stage.nextPhase,
      entered_at: iso(stage.enteredAt),
      elapsed_ms: now - stage.enteredAt,
    },
    controller_status: state.controllerStatus,
    desired_signals: desired,
    actual_signals: state.actualSignals,
    signals_confirmed: isConfirmed(state, config),
    queues: queueLengths(state),
    sensors: state.sensorStatus,
    pending_command: pendingCommand && {
      command_id: pendingCommand.commandId,
      desired_signals: pendingCommand.desiredSignals,
      sent_at: iso(pendingCommand.sentAt),
      age_ms: now - pendingCommand.sentAt,
      attempts: pendingCommand.attempts,
    },
    emergency: {
      active: state.mode === 'EMERGENCY',
      queue: state.emergencies.map((e) => ({
        vehicle_id: e.vehicleId,
        direction: e.direction,
        detected_at: iso(e.detectedAt),
      })),
    },
    manual: state.manual && {
      direction: state.manual.direction,
      phase: state.manual.phase,
      issued_by: state.manual.issuedBy,
      expires_at: iso(state.manual.expiresAt),
    },
    degraded_reason: state.degradedReason,
    alerts: alertsFor(state, config, now),
  };
}

function alertsFor(state: JunctionState, config: JunctionConfig, now: number): Alert[] {
  const alerts: Alert[] = [];
  const desired = signalsFor(state.stage, config);
  const actualUnknown = DIRECTIONS.some((d) => state.actualSignals[d] === 'UNKNOWN');

  if (state.mode === 'EMERGENCY') {
    const head = state.emergencies[0];
    alerts.push({ level: 'error', code: 'EMERGENCY', message: `Emergency vehicle ${head?.vehicleId} from ${head?.direction}` });
  }
  if (state.mode === 'DEGRADED') {
    alerts.push({ level: 'error', code: 'DEGRADED', message: `Fail-safe ALL_RED: ${state.degradedReason}` });
  }
  if (state.controllerStatus === 'OFFLINE') {
    alerts.push({ level: 'error', code: 'CONTROLLER_OFFLINE', message: 'Signal controller is offline' });
  } else if (state.controllerStatus === 'UNKNOWN') {
    alerts.push({ level: 'warning', code: 'CONTROLLER_UNKNOWN', message: 'Waiting for the controller to confirm its state' });
  }
  if (actualUnknown) {
    alerts.push({ level: 'warning', code: 'UNKNOWN_SIGNAL_STATE', message: 'Physical signal state is unknown' });
  } else if (!state.pendingCommand && !sameSignals(state.actualSignals, desired)) {
    alerts.push({ level: 'error', code: 'STATE_MISMATCH', message: 'Confirmed signals differ from desired signals' });
  }
  if (state.pendingCommand && now - state.pendingCommand.sentAt > config.timings.ackTimeoutMs) {
    alerts.push({
      level: 'warning',
      code: 'COMMAND_TIMEOUT',
      message: `No ACK for ${state.pendingCommand.commandId} (attempt ${state.pendingCommand.attempts})`,
    });
  }
  for (const direction of DIRECTIONS) {
    if (state.sensorStatus[direction] === 'OFFLINE') {
      alerts.push({ level: 'warning', code: 'SENSOR_OFFLINE', message: `${direction} sensor offline, assuming traffic` });
    }
  }
  return alerts;
}
