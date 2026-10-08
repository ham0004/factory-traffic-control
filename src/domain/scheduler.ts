import { phaseIds } from './config';
import type { JunctionConfig, JunctionState, PhaseId, Vehicle } from './types';

function waitingIn(state: JunctionState, phase: PhaseId, config: JunctionConfig): Vehicle[] {
  const directions = config.phases[phase];
  return Object.values(state.vehicles).filter(
    (v) => v.status === 'WAITING' && directions.includes(v.direction),
  );
}

function offlineSensorCount(state: JunctionState, phase: PhaseId, config: JunctionConfig): number {
  return config.phases[phase].filter((d) => state.sensorStatus[d] === 'OFFLINE').length;
}

function oldestWaitMs(vehicles: Vehicle[], now: number): number {
  return vehicles.reduce((oldest, v) => Math.max(oldest, now - (v.arrivedAt ?? now)), 0);
}

// A direction with a dead sensor counts as having traffic, so missing data can't starve it.
export function hasDemand(state: JunctionState, phase: PhaseId, config: JunctionConfig): boolean {
  return waitingIn(state, phase, config).length > 0 || offlineSensorCount(state, phase, config) > 0;
}

// score = sum of vehicle weights + waitWeightPerSecond * oldest wait in seconds.
// An offline sensor adds one employee-vehicle worth of assumed demand.
export function scorePhase(state: JunctionState, phase: PhaseId, now: number, config: JunctionConfig): number {
  const vehicles = waitingIn(state, phase, config);
  const weights = vehicles.reduce((sum, v) => sum + config.vehicleWeights[v.vehicleType ?? 'EMPLOYEE_VEHICLE'], 0);
  const assumed = offlineSensorCount(state, phase, config) * config.vehicleWeights.EMPLOYEE_VEHICLE;
  const waitBonus = (config.waitWeightPerSecond * oldestWaitMs(vehicles, now)) / 1000;
  return weights + assumed + waitBonus;
}

function mostStarvedPhase(state: JunctionState, candidates: PhaseId[], now: number, config: JunctionConfig): PhaseId | null {
  let starved: PhaseId | null = null;
  let longestWait = config.starvationMs;
  for (const phase of candidates) {
    const wait = oldestWaitMs(waitingIn(state, phase, config), now);
    if (wait > longestWait) {
      starved = phase;
      longestWait = wait;
    }
  }
  return starved;
}

// Called while a phase is GREEN in AUTOMATIC mode. Returns the phase to switch to, or null to keep green.
export function pickNextPhase(state: JunctionState, now: number, config: JunctionConfig): PhaseId | null {
  if (state.stage.kind !== 'GREEN') return null;

  const current = state.stage.phase;
  const elapsed = now - state.stage.enteredAt;
  const { minGreenMs, normalGreenMs, maxGreenMs } = config.timings;
  if (elapsed < minGreenMs) return null;

  const contenders = phaseIds(config).filter((p) => p !== current && hasDemand(state, p, config));
  if (contenders.length === 0) return null;

  const starved = mostStarvedPhase(state, contenders, now, config);
  if (starved) return starved;

  const scores = new Map(contenders.map((p) => [p, scorePhase(state, p, now, config)]));
  const best = contenders.reduce((a, b) => (scores.get(b)! > scores.get(a)! ? b : a));

  if (!hasDemand(state, current, config)) return best;
  if (elapsed >= maxGreenMs) return best;

  // Hysteresis: the other side has to be clearly busier, otherwise we keep the green and avoid flapping.
  const currentScore = scorePhase(state, current, now, config);
  if (elapsed >= normalGreenMs && scores.get(best)! > currentScore * config.switchHysteresis) return best;

  return null;
}
