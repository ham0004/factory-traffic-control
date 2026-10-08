import { phaseIds } from './config';
import { DIRECTIONS } from './types';
import type { JunctionConfig, ObservedSignals, Signals, Stage } from './types';

export function allRed(): Signals {
  return { NORTH: 'RED', SOUTH: 'RED', EAST: 'RED', WEST: 'RED' };
}

export function unknownSignals(): ObservedSignals {
  return { NORTH: 'UNKNOWN', SOUTH: 'UNKNOWN', EAST: 'UNKNOWN', WEST: 'UNKNOWN' };
}

// The only place desired signals come from. One stage value maps to one phase being lit,
// so two conflicting greens cannot even be represented.
export function signalsFor(stage: Stage, config: JunctionConfig): Signals {
  const signals = allRed();
  if (stage.kind === 'ALL_RED') return signals;

  const color = stage.kind === 'GREEN' ? 'GREEN' : 'YELLOW';
  for (const direction of config.phases[stage.phase]) {
    signals[direction] = color;
  }
  return signals;
}

// Safe = at most one phase shows anything other than RED.
export function isSafe(signals: ObservedSignals, config: JunctionConfig): boolean {
  const litPhases = phaseIds(config).filter((phase) =>
    config.phases[phase].some((d) => signals[d] === 'GREEN' || signals[d] === 'YELLOW'),
  );
  return litPhases.length <= 1;
}

export function assertSafe(signals: ObservedSignals, config: JunctionConfig): void {
  if (!isSafe(signals, config)) {
    throw new Error(`unsafe signal combination: ${JSON.stringify(signals)}`);
  }
}

// GREEN(p) -> YELLOW(p) -> ALL_RED -> GREEN(next). Nothing else is a normal transition.
// The fail-safe jump to ALL_RED on failure is handled separately in the engine.
export function isLegalTransition(from: Stage, to: Stage): boolean {
  switch (from.kind) {
    case 'GREEN':
      return to.kind === 'YELLOW' && to.phase === from.phase;
    case 'YELLOW':
      return to.kind === 'ALL_RED';
    case 'ALL_RED':
      return to.kind === 'GREEN';
  }
}

export function sameSignals(a: ObservedSignals, b: ObservedSignals): boolean {
  return DIRECTIONS.every((d) => a[d] === b[d]);
}

export function describeStage(stage: Stage): string {
  switch (stage.kind) {
    case 'GREEN':
      return `GREEN ${stage.phase}`;
    case 'YELLOW':
      return `YELLOW ${stage.phase}`;
    case 'ALL_RED':
      return `ALL_RED (next ${stage.nextPhase})`;
  }
}
