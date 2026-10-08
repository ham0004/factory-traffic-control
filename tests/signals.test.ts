import { describe, expect, it } from 'vitest';
import { DEFAULT_JUNCTION_CONFIG as config } from '../src/domain/config';
import { allRed, isLegalTransition, isSafe, signalsFor } from '../src/domain/signals';
import type { Stage } from '../src/domain/types';

describe('signalsFor', () => {
  it('lights only the directions of the green phase', () => {
    const signals = signalsFor({ kind: 'GREEN', phase: 'NORTH_SOUTH', enteredAt: 0 }, config);
    expect(signals).toEqual({ NORTH: 'GREEN', SOUTH: 'GREEN', EAST: 'RED', WEST: 'RED' });
  });

  it('shows yellow on the phase being cleared', () => {
    const signals = signalsFor({ kind: 'YELLOW', phase: 'EAST_WEST', nextPhase: 'NORTH_SOUTH', enteredAt: 0 }, config);
    expect(signals).toEqual({ NORTH: 'RED', SOUTH: 'RED', EAST: 'YELLOW', WEST: 'YELLOW' });
  });

  it('is all red during clearance', () => {
    expect(signalsFor({ kind: 'ALL_RED', nextPhase: 'EAST_WEST', enteredAt: 0 }, config)).toEqual(allRed());
  });
});

describe('isSafe', () => {
  it('rejects greens on conflicting phases', () => {
    expect(isSafe({ NORTH: 'GREEN', SOUTH: 'RED', EAST: 'GREEN', WEST: 'RED' }, config)).toBe(false);
  });

  it('rejects yellow on one phase while the other is green', () => {
    expect(isSafe({ NORTH: 'YELLOW', SOUTH: 'YELLOW', EAST: 'GREEN', WEST: 'RED' }, config)).toBe(false);
  });

  it('accepts a single lit phase and all red', () => {
    expect(isSafe({ NORTH: 'GREEN', SOUTH: 'GREEN', EAST: 'RED', WEST: 'RED' }, config)).toBe(true);
    expect(isSafe(allRed(), config)).toBe(true);
  });
});

describe('isLegalTransition', () => {
  const greenNS: Stage = { kind: 'GREEN', phase: 'NORTH_SOUTH', enteredAt: 0 };
  const yellowNS: Stage = { kind: 'YELLOW', phase: 'NORTH_SOUTH', nextPhase: 'EAST_WEST', enteredAt: 0 };
  const allRedToEW: Stage = { kind: 'ALL_RED', nextPhase: 'EAST_WEST', enteredAt: 0 };
  const greenEW: Stage = { kind: 'GREEN', phase: 'EAST_WEST', enteredAt: 0 };

  it('allows the safe sequence', () => {
    expect(isLegalTransition(greenNS, yellowNS)).toBe(true);
    expect(isLegalTransition(yellowNS, allRedToEW)).toBe(true);
    expect(isLegalTransition(allRedToEW, greenEW)).toBe(true);
  });

  it('never allows green straight into another green or skipping yellow', () => {
    expect(isLegalTransition(greenNS, greenEW)).toBe(false);
    expect(isLegalTransition(greenNS, allRedToEW)).toBe(false);
    expect(isLegalTransition(yellowNS, greenEW)).toBe(false);
  });
});
