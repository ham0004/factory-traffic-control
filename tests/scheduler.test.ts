import { describe, expect, it } from 'vitest';
import { DEFAULT_JUNCTION_CONFIG as config } from '../src/domain/config';
import { pickNextPhase, scorePhase } from '../src/domain/scheduler';
import { unknownSignals } from '../src/domain/signals';
import type { Direction, JunctionState, VehicleType } from '../src/domain/types';

const SECOND = 1000;

function greenState(phase: string, enteredAt = 0): JunctionState {
  return {
    junctionId: 'A',
    mode: 'AUTOMATIC',
    stage: { kind: 'GREEN', phase, enteredAt },
    lastGreenPhase: phase,
    phaseServedAt: { [phase]: enteredAt },
    controllerStatus: 'ONLINE',
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

let nextId = 1;
function addVehicle(state: JunctionState, direction: Direction, vehicleType: VehicleType, arrivedAt: number) {
  const vehicleId = `VH-${nextId++}`;
  state.vehicles[vehicleId] = {
    vehicleId,
    direction,
    vehicleType,
    status: 'WAITING',
    arrivedAt,
    clearedAt: null,
    lastSequenceNo: null,
  };
}

describe('scheduler', () => {
  it('weights trucks above a larger number of employee vehicles', () => {
    const state = greenState('NORTH_SOUTH');
    for (let i = 0; i < 3; i++) addVehicle(state, 'NORTH', 'EMPLOYEE_VEHICLE', 20 * SECOND);
    addVehicle(state, 'EAST', 'TRUCK', 20 * SECOND);
    addVehicle(state, 'WEST', 'TRUCK', 20 * SECOND);

    const now = 30 * SECOND;
    expect(scorePhase(state, 'EAST_WEST', now, config)).toBeGreaterThan(scorePhase(state, 'NORTH_SOUTH', now, config));
    expect(pickNextPhase(state, now, config)).toBe('EAST_WEST');
  });

  it('keeps the green when the other side is only slightly busier (hysteresis)', () => {
    const state = greenState('NORTH_SOUTH');
    for (let i = 0; i < 5; i++) addVehicle(state, 'NORTH', 'EMPLOYEE_VEHICLE', 25 * SECOND);
    for (let i = 0; i < 3; i++) addVehicle(state, 'EAST', 'FORKLIFT', 25 * SECOND);
    expect(pickNextPhase(state, 30 * SECOND, config)).toBeNull();
  });

  it('never switches before minimum green', () => {
    const state = greenState('NORTH_SOUTH');
    addVehicle(state, 'EAST', 'TRUCK', 0);
    expect(pickNextPhase(state, 5 * SECOND, config)).toBeNull();
  });

  it('switches early once min green has passed if the current phase is empty', () => {
    const state = greenState('NORTH_SOUTH');
    addVehicle(state, 'EAST', 'EMPLOYEE_VEHICLE', 0);
    expect(pickNextPhase(state, 10 * SECOND, config)).toBe('EAST_WEST');
  });

  it('stays green when nobody else is waiting', () => {
    const state = greenState('NORTH_SOUTH');
    addVehicle(state, 'NORTH', 'TRUCK', 0);
    expect(pickNextPhase(state, 200 * SECOND, config)).toBeNull();
  });

  it('serves a starved phase after 120s even if the current phase scores higher', () => {
    // Green started recently (a long-running green would hit the 90s cap instead).
    const state = greenState('NORTH_SOUTH', 100 * SECOND);
    for (let i = 0; i < 20; i++) addVehicle(state, 'NORTH', 'TRUCK', 100 * SECOND);
    addVehicle(state, 'WEST', 'EMPLOYEE_VEHICLE', 0);

    expect(pickNextPhase(state, 115 * SECOND, config)).toBeNull();
    expect(pickNextPhase(state, 121 * SECOND, config)).toBe('EAST_WEST');
  });

  it('does not treat a vehicle that was never cleared as starving', () => {
    // EAST_WEST had a green that ended at 295s; the EAST vehicle from t=0 never sent VEHICLE_CLEARED.
    const state = greenState('NORTH_SOUTH', 300 * SECOND);
    state.phaseServedAt = { EAST_WEST: 295 * SECOND, NORTH_SOUTH: 300 * SECOND };
    addVehicle(state, 'EAST', 'EMPLOYEE_VEHICLE', 0);
    addVehicle(state, 'NORTH', 'EMPLOYEE_VEHICLE', 290 * SECOND);

    expect(pickNextPhase(state, 311 * SECOND, config)).toBeNull();
  });

  it('caps green at 90s when the other phase has demand', () => {
    const state = greenState('NORTH_SOUTH');
    for (let i = 0; i < 20; i++) addVehicle(state, 'NORTH', 'TRUCK', 85 * SECOND);
    addVehicle(state, 'EAST', 'EMPLOYEE_VEHICLE', 85 * SECOND);
    expect(pickNextPhase(state, 89 * SECOND, config)).toBeNull();
    expect(pickNextPhase(state, 90 * SECOND, config)).toBe('EAST_WEST');
  });

  it('treats an offline sensor as demand', () => {
    const state = greenState('NORTH_SOUTH');
    state.sensorStatus.EAST = 'OFFLINE';
    expect(pickNextPhase(state, 10 * SECOND, config)).toBe('EAST_WEST');
  });
});
