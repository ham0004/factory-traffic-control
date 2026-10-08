import type { Direction, JunctionConfig, PhaseId } from './types';

// Junction config is plain data so a new junction (or a weight change) never needs an engine change.
export const DEFAULT_JUNCTION_CONFIG: JunctionConfig = {
  phases: {
    NORTH_SOUTH: ['NORTH', 'SOUTH'],
    EAST_WEST: ['EAST', 'WEST'],
  },
  timings: {
    minGreenMs: 10_000,
    normalGreenMs: 30_000,
    maxGreenMs: 90_000,
    yellowMs: 5_000,
    allRedMs: 2_000,
    ackTimeoutMs: 3_000,
    degradedResendMs: 5_000,
  },
  vehicleWeights: {
    EMPLOYEE_VEHICLE: 1,
    FORKLIFT: 2,
    TRUCK: 3,
    // Only used for scoring when an emergency is stale and did not trigger preemption.
    EMERGENCY: 10,
  },
  waitWeightPerSecond: 0.1,
  switchHysteresis: 1.2,
  starvationMs: 120_000,
  emergencyTimeoutMs: 90_000,
  staleEventMs: 60_000,
  futureToleranceMs: 60_000,
  manualTtlMs: 5 * 60_000,
  maxCommandAttempts: 2,
};

export function phaseIds(config: JunctionConfig): PhaseId[] {
  return Object.keys(config.phases);
}

export function phaseOf(config: JunctionConfig, direction: Direction): PhaseId | null {
  return phaseIds(config).find((phase) => config.phases[phase].includes(direction)) ?? null;
}

export function directionsOf(config: JunctionConfig): Direction[] {
  return phaseIds(config).flatMap((phase) => config.phases[phase]);
}
